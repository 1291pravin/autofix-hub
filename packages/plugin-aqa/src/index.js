'use strict';

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const url = require('url');

// AQA impact → normalized severity
const SEVERITY_MAP = {
  'critical': 'critical',
  'serious': 'high',
  'moderate': 'medium',
  'minor': 'low',
};

// Categorize by ruleId
function categorize(ruleId) {
  const id = (ruleId || '').toLowerCase();
  if (id.includes('color-contrast')) return 'color-contrast';
  if (id.includes('image-alt') || id.includes('img-alt')) return 'image-alt';
  if (id.includes('label') || id.includes('input-label')) return 'label';
  if (id.includes('heading-order') || id.includes('heading')) return 'heading-order';
  if (id.includes('html-has-lang') || id.includes('html-lang')) return 'html-has-lang';
  if (id.includes('tabindex')) return 'tabindex';
  if (id.includes('keyboard') || id.includes('focus')) return 'keyboard';
  if (id.includes('aria')) return 'aria';
  if (id.includes('link') || id.includes('anchor')) return 'link';
  if (id.includes('list')) return 'list';
  if (id.includes('table')) return 'table';
  if (id.includes('region') || id.includes('landmark')) return 'landmark';
  return ruleId || 'unknown';
}

/**
 * Make an HTTP(S) request to the AQA API.
 */
function apiRequest(baseUrl, path, apiKey) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${baseUrl.replace(/\/$/, '')}${path}`;
    const parsed = new url.URL(fullUrl);
    const mod = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'X-Team': apiKey,
        'Accept': 'application/json',
      },
    };

    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`AQA API error ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`AQA API returned invalid JSON: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('AQA API request timed out'));
    });
    req.end();
  });
}

/**
 * Normalize a CSS selector for clustering — strip nth-child, pseudo-elements, etc.
 */
function normalizeSelector(selector) {
  if (!selector) return 'unknown';
  return selector
    .replace(/:nth-child\(\d+\)/g, '')
    .replace(/:nth-of-type\(\d+\)/g, '')
    .replace(/\[\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate a stable hash for dedup/id purposes.
 */
function stableHash(parts) {
  return crypto.createHash('md5').update(parts.join('|')).digest('hex').slice(0, 12);
}

module.exports = {
  name: 'aqa',
  displayName: 'AQA Accessibility',

  checkInstalled: async () => {
    // AQA is a cloud API, always "installed" — just need credentials
    return { installed: true, message: 'AQA is a cloud service (no local install required)' };
  },

  checkAuth: async (creds) => {
    if (!creds || !creds.api_key || !creds.team_slug) {
      return { authenticated: false, message: 'AQA API key and team slug required. Run setup.' };
    }
    try {
      const baseUrl = `https://${creds.team_slug}.usablenet.com/api/v3`;
      await apiRequest(baseUrl, '/a11y/suites?limit=1', creds.api_key);
      return { authenticated: true, message: 'Authenticated' };
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized')) {
        return { authenticated: false, message: 'Invalid API key or team slug' };
      }
      return { authenticated: false, message: `Connection failed: ${msg}` };
    }
  },

  setupPrompts: () => [
    {
      type: 'input',
      name: 'team_slug',
      message: 'AQA team slug (the subdomain in your AQA URL):',
      validate: (v) => v.trim() ? true : 'Team slug is required',
    },
    {
      type: 'input',
      name: 'api_key',
      message: 'AQA API key (X-Team header value):',
      validate: (v) => v.trim() ? true : 'API key is required',
    },
  ],

  fetch: async (config) => {
    if (!config || !config.api_key || !config.team_slug) {
      throw new Error('AQA credentials not configured. Run autofix-hub setup.');
    }

    const baseUrl = `https://${config.team_slug}.usablenet.com/api/v3`;
    const suiteId = config.suite_id || process.env.AQA_SUITE_ID;
    const testId = config.test_id || process.env.AQA_TEST_ID;

    if (!testId) {
      throw new Error('AQA_TEST_ID not configured. Set it in .env or run setup.');
    }

    // Get the latest test run
    const testData = await apiRequest(baseUrl, `/a11y/tests/${testId}`, config.api_key);
    const latestRun = testData.latestRun || testData.lastRun || testData;
    const runId = latestRun.runId || latestRun.id || latestRun._id;

    if (!runId) {
      throw new Error('Could not find latest run for the configured test.');
    }

    const allIssues = [];

    // Fetch flow issues
    const flows = latestRun.flows || [];
    for (const flow of flows) {
      const flowId = flow.flowId || flow.id || flow._id;
      if (!flowId) continue;
      try {
        const flowIssues = await apiRequest(
          baseUrl,
          `/a11y/tests/runs/${runId}/flows/${flowId}/issues`,
          config.api_key
        );
        const issues = Array.isArray(flowIssues) ? flowIssues : (flowIssues.issues || flowIssues.results || []);
        for (const issue of issues) {
          issue._aqa_context = { type: 'flow', flowId, flowName: flow.name || flowId, runId };
        }
        allIssues.push(...issues);
      } catch (err) {
        // Log but continue fetching other flows
        console.error(`Warning: Failed to fetch issues for flow ${flowId}: ${err.message}`);
      }
    }

    // Fetch page issues
    const pages = latestRun.pages || [];
    for (const page of pages) {
      const pageId = page.pageId || page.id || page._id;
      if (!pageId) continue;
      try {
        const pageIssues = await apiRequest(
          baseUrl,
          `/a11y/tests/runs/${runId}/pages/${pageId}/issues`,
          config.api_key
        );
        const issues = Array.isArray(pageIssues) ? pageIssues : (pageIssues.issues || pageIssues.results || []);
        for (const issue of issues) {
          issue._aqa_context = { type: 'page', pageId, pageUrl: page.url || page.name || pageId, runId };
        }
        allIssues.push(...issues);
      } catch (err) {
        console.error(`Warning: Failed to fetch issues for page ${pageId}: ${err.message}`);
      }
    }

    return allIssues;
  },

  normalize: (raw) => {
    const ruleId = raw.ruleId || raw.rule || raw.id || 'unknown';
    const category = categorize(ruleId);
    const impact = (raw.impact || raw.severity || 'moderate').toLowerCase();
    const severity = SEVERITY_MAP[impact] || 'medium';
    const context = raw._aqa_context || {};
    const contextKey = context.type === 'flow'
      ? context.flowId
      : (context.pageId || 'unknown');

    const id = `aqa-${stableHash([ruleId, raw.selector || raw.target || '', contextKey])}`;

    // Build metadata for issue_metadata table
    const metadata = {
      wcag_criteria: raw.wcag || raw.tags || [],
      selector: raw.selector || raw.target || null,
      html: raw.html || raw.snippet || null,
      solutions: raw.solutions || raw.helpUrl || raw.help || null,
      context_type: context.type || null,
      context_id: contextKey,
      context_name: context.flowName || context.pageUrl || null,
      run_id: context.runId || null,
      impact: raw.impact || null,
    };

    return {
      id,
      source: 'aqa',
      rule_id: ruleId,
      severity,
      category,
      status: 'open',
      file_path: null, // AQA issues are web-based, not file-based
      line_number: null,
      description: raw.description || raw.message || raw.help || `Accessibility issue: ${ruleId}`,
      scanner_data: JSON.stringify(raw),
      metadata,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  },

  clusterKeys: (issue) => {
    const ruleId = issue.rule_id;
    const keys = [];

    // Parse context from scanner_data
    let context = {};
    try {
      const data = typeof issue.scanner_data === 'string' ? JSON.parse(issue.scanner_data) : issue.scanner_data;
      context = data._aqa_context || {};
    } catch (_) {}

    // Cluster by (ruleId, flowId/pageId)
    const contextId = context.flowId || context.pageId || 'unknown';
    keys.push(`${ruleId}:context:${contextId}`);

    // Also cluster by (ruleId, normalizedSelector)
    let selector = null;
    try {
      const data = typeof issue.scanner_data === 'string' ? JSON.parse(issue.scanner_data) : issue.scanner_data;
      selector = data.selector || data.target || null;
    } catch (_) {}

    if (selector) {
      const normalized = normalizeSelector(selector);
      keys.push(`${ruleId}:selector:${normalized}`);
    }

    return keys;
  },

  effortEstimate: (issue) => {
    try {
      const { loadEffortMap } = require('@autofix-hub/core/src/config');
      const effortMap = loadEffortMap();
      const sourceMap = effortMap.aqa || {};
      return sourceMap[issue.category] || sourceMap.__default__ || { level: 'small', minutes: 5 };
    } catch (_) {
      const defaults = {
        'color-contrast': { level: 'medium', minutes: 15 },
        'image-alt': { level: 'small', minutes: 5 },
        'label': { level: 'small', minutes: 5 },
        'heading-order': { level: 'medium', minutes: 15 },
        'html-has-lang': { level: 'trivial', minutes: 2 },
        'tabindex': { level: 'trivial', minutes: 2 },
      };
      return defaults[issue.category] || { level: 'small', minutes: 5 };
    }
  },

  reviewLevel: (issue) => {
    const category = issue.category;
    // Quick: trivial fixes with no judgment calls
    if (['html-has-lang', 'tabindex'].includes(category)) {
      return 'quick';
    }
    // Careful: content-related changes that need human judgment
    if (['image-alt', 'color-contrast', 'label', 'heading-order', 'aria', 'landmark'].includes(category)) {
      return 'careful';
    }
    // AQA is accessibility, never security_review
    return 'careful';
  },

  scoringFactors: (issue) => {
    let pageImportance = 3; // default
    let context = {};

    try {
      const data = typeof issue.scanner_data === 'string' ? JSON.parse(issue.scanner_data) : issue.scanner_data;
      context = data._aqa_context || {};
    } catch (_) {}

    // Try to match page URL against page_importance config
    const pageUrl = context.pageUrl || '';
    if (pageUrl) {
      try {
        const { loadScoringConfig } = require('@autofix-hub/core/src/config');
        const config = loadScoringConfig();
        const patterns = config.page_importance || {};
        for (const [pattern, weight] of Object.entries(patterns)) {
          if (pattern === '/*') continue; // check wildcard last
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*'));
          if (regex.test(pageUrl) || regex.test(new url.URL(pageUrl, 'http://localhost').pathname)) {
            pageImportance = weight;
            break;
          }
        }
      } catch (_) {
        // Use default
      }
    }

    // AQA scoring: severity_weight is handled externally, return page factor
    return pageImportance;
  },

  promptTemplate: (issue) => {
    const category = issue.category;
    const ruleId = issue.rule_id;
    const desc = issue.description;

    // Extract useful metadata
    let selector = '';
    let html = '';
    let solutions = '';
    let wcag = '';
    try {
      const data = typeof issue.scanner_data === 'string' ? JSON.parse(issue.scanner_data) : issue.scanner_data;
      selector = data.selector || data.target || '';
      html = data.html || data.snippet || '';
      solutions = data.solutions || data.helpUrl || data.help || '';
      const wcagTags = data.wcag || data.tags || [];
      wcag = Array.isArray(wcagTags) ? wcagTags.join(', ') : wcagTags;
    } catch (_) {}

    const context = [
      `**Rule:** ${ruleId}`,
      selector ? `**Selector:** \`${selector}\`` : '',
      html ? `**HTML:** \`${html}\`` : '',
      wcag ? `**WCAG:** ${wcag}` : '',
      solutions ? `**Reference:** ${solutions}` : '',
    ].filter(Boolean).join('\n');

    let template = '';

    switch (category) {
      case 'image-alt':
        template = [
          `## Fix Missing Image Alt Text`,
          ``,
          `**Issue:** ${desc}`,
          context,
          ``,
          `### Instructions:`,
          `1. Examine the image context to determine its purpose`,
          `2. If decorative: add \`alt=""\` and \`role="presentation"\``,
          `3. If informative: write descriptive alt text that conveys the image's meaning`,
          `4. If functional (button/link): describe the action, not the image`,
          `5. Keep alt text concise — under 125 characters`,
          ``,
          `**Important:** Preserve visual appearance. Follow existing component patterns. Fix only this issue.`,
        ].join('\n');
        break;

      case 'color-contrast':
        template = [
          `## Fix Color Contrast`,
          ``,
          `**Issue:** ${desc}`,
          context,
          ``,
          `### Instructions:`,
          `1. Adjust foreground or background color to meet WCAG AA contrast ratio (4.5:1 for normal text, 3:1 for large text)`,
          `2. Use colors from the existing design palette where possible`,
          `3. Prefer darkening the foreground over lightening the background`,
          `4. Verify the fix works for both light and dark themes if applicable`,
          ``,
          `**Important:** Preserve visual appearance. Follow existing component patterns. Fix only this issue.`,
        ].join('\n');
        break;

      case 'label':
        template = [
          `## Fix Missing Form Label`,
          ``,
          `**Issue:** ${desc}`,
          context,
          ``,
          `### Instructions:`,
          `1. Associate a \`<label>\` element with the input using matching \`for\`/\`id\` attributes`,
          `2. If a visible label exists but isn't associated: add the \`for\` attribute`,
          `3. If no visible label is appropriate: add \`aria-label\` or \`aria-labelledby\``,
          `4. Ensure the label text clearly describes the input's purpose`,
          ``,
          `**Important:** Preserve visual appearance. Follow existing component patterns. Fix only this issue.`,
        ].join('\n');
        break;

      case 'heading-order':
        template = [
          `## Fix Heading Order`,
          ``,
          `**Issue:** ${desc}`,
          context,
          ``,
          `### Instructions:`,
          `1. Restructure heading levels to follow a logical hierarchy (h1 → h2 → h3, no skipping)`,
          `2. Each page should have exactly one h1`,
          `3. Use CSS to maintain visual styling if heading level changes affect appearance`,
          `4. Preserve the semantic meaning of the content`,
          ``,
          `**Important:** Preserve visual appearance. Follow existing component patterns. Fix only this issue.`,
        ].join('\n');
        break;

      case 'html-has-lang':
        template = [
          `## Fix Missing Language Attribute`,
          ``,
          `**Issue:** ${desc}`,
          context,
          ``,
          `### Instructions:`,
          `1. Add \`lang\` attribute to the \`<html>\` element`,
          `2. Use the appropriate BCP 47 language tag (e.g., \`lang="en"\` for English)`,
          ``,
          `**Important:** Fix only this issue. Do not touch unrelated code.`,
        ].join('\n');
        break;

      case 'tabindex':
        template = [
          `## Fix Tabindex Issue`,
          ``,
          `**Issue:** ${desc}`,
          context,
          ``,
          `### Instructions:`,
          `1. Remove positive \`tabindex\` values (tabindex > 0) — they disrupt natural tab order`,
          `2. Use \`tabindex="0"\` only for custom interactive elements that need keyboard focus`,
          `3. Use \`tabindex="-1"\` for programmatically focusable elements not in tab order`,
          `4. Ensure the DOM order matches the visual order for natural tab flow`,
          ``,
          `**Important:** Fix only this issue. Do not touch unrelated code.`,
        ].join('\n');
        break;

      case 'keyboard':
        template = [
          `## Fix Keyboard Accessibility`,
          ``,
          `**Issue:** ${desc}`,
          context,
          ``,
          `### Instructions:`,
          `1. Ensure the element is focusable via keyboard (Tab key)`,
          `2. Add keyboard event handlers (Enter/Space for buttons, Enter for links)`,
          `3. If using a custom interactive element: add appropriate \`role\` and \`tabindex="0"\``,
          `4. Ensure focus is visible with a focus indicator style`,
          ``,
          `**Important:** Preserve visual appearance. Follow existing component patterns. Fix only this issue.`,
        ].join('\n');
        break;

      default:
        template = [
          `## Fix Accessibility Issue: ${ruleId}`,
          ``,
          `**Issue:** ${desc}`,
          context,
          ``,
          `### Instructions:`,
          `1. Analyze the reported accessibility violation`,
          `2. Apply the minimal fix that resolves the WCAG requirement`,
          `3. Follow WAI-ARIA best practices`,
          `4. Test with a screen reader if possible`,
          ``,
          `**Important:** Preserve visual appearance. Follow existing component patterns. Fix only this issue.`,
        ].join('\n');
    }

    return template;
  },

  batchPromptTemplate: (issues) => {
    if (!issues || issues.length === 0) return '';

    const ruleId = issues[0].rule_id;
    const category = issues[0].category;

    const locations = issues.map((i) => {
      let selector = '';
      let context = '';
      try {
        const data = typeof i.scanner_data === 'string' ? JSON.parse(i.scanner_data) : i.scanner_data;
        selector = data.selector || data.target || '';
        const ctx = data._aqa_context || {};
        context = ctx.flowName || ctx.pageUrl || '';
      } catch (_) {}
      return `- ${selector || i.id}${context ? ` (${context})` : ''}`;
    }).join('\n');

    return [
      `## Batch Fix: ${issues.length} instances of ${ruleId}`,
      ``,
      `**Category:** ${category}`,
      `**Description:** ${issues[0].description}`,
      ``,
      `### Affected elements:`,
      locations,
      ``,
      `### Instructions:`,
      `Fix all ${issues.length} instances of this accessibility issue.`,
      `Apply the same fix pattern consistently to each element.`,
      ``,
      `**Important:** Preserve visual appearance. Follow existing component patterns. Fix only these issues.`,
    ].join('\n');
  },
};
