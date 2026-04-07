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

// WCAG success criteria quick-reference for prompt enrichment — covers all WCAG 2.2 Level A & AA
const WCAG_GUIDANCE = {
  '1.1.1': { title: 'Non-text Content', level: 'A', technique: 'Provide text alternatives for non-text content so it can be changed into other forms (large print, braille, speech, symbols, simpler language).' },
  '1.2.1': { title: 'Audio-only and Video-only (Prerecorded)', level: 'A', technique: 'Provide an alternative for time-based media (transcript for audio, audio/text description for video).' },
  '1.2.2': { title: 'Captions (Prerecorded)', level: 'A', technique: 'Provide captions for all prerecorded audio content in synchronized media.' },
  '1.2.3': { title: 'Audio Description or Media Alternative (Prerecorded)', level: 'A', technique: 'Provide audio description or text alternative for prerecorded video content.' },
  '1.2.4': { title: 'Captions (Live)', level: 'AA', technique: 'Provide captions for all live audio content in synchronized media.' },
  '1.2.5': { title: 'Audio Description (Prerecorded)', level: 'AA', technique: 'Provide audio description for all prerecorded video content in synchronized media.' },
  '1.3.1': { title: 'Info and Relationships', level: 'A', technique: 'Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.' },
  '1.3.2': { title: 'Meaningful Sequence', level: 'A', technique: 'When the order of content affects meaning, a correct reading sequence can be programmatically determined.' },
  '1.3.3': { title: 'Sensory Characteristics', level: 'A', technique: 'Instructions for understanding content do not rely solely on sensory characteristics like shape, color, size, visual location, orientation, or sound.' },
  '1.3.4': { title: 'Orientation', level: 'AA', technique: 'Content does not restrict its view and operation to a single display orientation (portrait/landscape) unless essential.' },
  '1.3.5': { title: 'Identify Input Purpose', level: 'AA', technique: 'The purpose of each input field collecting user information can be programmatically determined using autocomplete attributes.' },
  '1.4.1': { title: 'Use of Color', level: 'A', technique: 'Color is not used as the only visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element.' },
  '1.4.3': { title: 'Contrast (Minimum)', level: 'AA', technique: 'Text must have a contrast ratio of at least 4.5:1 (normal text) or 3:1 (large text, >=18pt or >=14pt bold).' },
  '1.4.4': { title: 'Resize Text', level: 'AA', technique: 'Text can be resized without assistive technology up to 200% without loss of content or functionality.' },
  '1.4.10': { title: 'Reflow', level: 'AA', technique: 'Content can be presented without loss of information or functionality, and without requiring scrolling in two dimensions at 320px wide / 256px tall.' },
  '1.4.11': { title: 'Non-text Contrast', level: 'AA', technique: 'UI components and graphical objects must have a contrast ratio of at least 3:1 against adjacent colors.' },
  '1.4.12': { title: 'Text Spacing', level: 'AA', technique: 'No loss of content or functionality when overriding line height (1.5x), spacing after paragraphs (2x), letter spacing (0.12x), and word spacing (0.16x).' },
  '1.4.13': { title: 'Content on Hover or Focus', level: 'AA', technique: 'Additional content triggered by hover or focus is dismissible, hoverable, and persistent until dismissed or invalid.' },
  '2.1.1': { title: 'Keyboard', level: 'A', technique: 'All functionality must be operable through a keyboard interface without requiring specific timings for individual keystrokes.' },
  '2.1.2': { title: 'No Keyboard Trap', level: 'A', technique: 'If keyboard focus can be moved to a component, focus can be moved away from that component using only a keyboard interface.' },
  '2.1.4': { title: 'Character Key Shortcuts', level: 'A', technique: 'If a character key shortcut exists, it can be turned off, remapped, or is only active on focus.' },
  '2.2.1': { title: 'Timing Adjustable', level: 'A', technique: 'Time limits set by content can be turned off, adjusted, or extended by the user.' },
  '2.3.1': { title: 'Three Flashes or Below Threshold', level: 'A', technique: 'Content does not contain anything that flashes more than three times in any one second period.' },
  '2.4.1': { title: 'Bypass Blocks', level: 'A', technique: 'Provide a mechanism to bypass blocks of content that are repeated on multiple pages (skip links, landmarks).' },
  '2.4.2': { title: 'Page Titled', level: 'A', technique: 'Web pages have titles that describe topic or purpose.' },
  '2.4.3': { title: 'Focus Order', level: 'A', technique: 'Focusable components receive focus in an order that preserves meaning and operability.' },
  '2.4.4': { title: 'Link Purpose (In Context)', level: 'A', technique: 'The purpose of each link can be determined from the link text alone or from the link text together with its context.' },
  '2.4.5': { title: 'Multiple Ways', level: 'AA', technique: 'More than one way is available to locate a web page within a set of web pages (navigation, search, site map, table of contents).' },
  '2.4.6': { title: 'Headings and Labels', level: 'AA', technique: 'Headings and labels describe topic or purpose.' },
  '2.4.7': { title: 'Focus Visible', level: 'AA', technique: 'Any keyboard operable user interface has a mode of operation where the keyboard focus indicator is visible.' },
  '2.4.11': { title: 'Focus Not Obscured (Minimum)', level: 'AA', technique: 'When a user interface component receives keyboard focus, the component is not entirely hidden by author-created content.' },
  '2.5.1': { title: 'Pointer Gestures', level: 'A', technique: 'All functionality that uses multipoint or path-based gestures can be operated with a single pointer without a path-based gesture.' },
  '2.5.2': { title: 'Pointer Cancellation', level: 'A', technique: 'For functionality that can be operated using a single pointer, the down-event is not used to execute any part of the function, or completion is on the up-event with an abort/undo mechanism.' },
  '2.5.3': { title: 'Label in Name', level: 'A', technique: 'For UI components with labels that include text or images of text, the accessible name contains the text that is presented visually.' },
  '2.5.4': { title: 'Motion Actuation', level: 'A', technique: 'Functionality that can be operated by device motion or user motion can also be operated by user interface components, and motion response can be disabled.' },
  '3.2.3': { title: 'Consistent Navigation', level: 'AA', technique: 'Navigational mechanisms repeated on multiple pages occur in the same relative order each time, unless changed by the user.' },
  '3.2.4': { title: 'Consistent Identification', level: 'AA', technique: 'Components that have the same functionality within a set of web pages are identified consistently.' },
  '3.2.6': { title: 'Consistent Help', level: 'A', technique: 'If a web page contains help mechanisms, they occur in the same relative order on every page.' },
  '3.3.1': { title: 'Error Identification', level: 'A', technique: 'If an input error is automatically detected, the item that is in error is identified and the error is described to the user in text.' },
  '3.3.2': { title: 'Labels or Instructions', level: 'A', technique: 'Labels or instructions are provided when content requires user input.' },
  '3.3.3': { title: 'Error Suggestion', level: 'AA', technique: 'If an input error is automatically detected and suggestions are known, then the suggestions are provided to the user.' },
  '3.3.4': { title: 'Error Prevention (Legal, Financial, Data)', level: 'AA', technique: 'For pages that cause legal commitments or financial transactions, submissions are reversible, checked, or confirmed.' },
  '4.1.1': { title: 'Parsing', level: 'A', technique: 'Elements have complete start and end tags, are nested according to specs, do not contain duplicate attributes, and IDs are unique.' },
  '4.1.2': { title: 'Name, Role, Value', level: 'A', technique: 'For all UI components, the name and role can be programmatically determined; states, properties, and values can be programmatically set.' },
  '4.1.3': { title: 'Status Messages', level: 'AA', technique: 'Status messages can be programmatically determined through role or properties so they can be presented to the user by assistive technologies without receiving focus.' },
};

// Map WCAG criteria numbers to functional categories for wcag22-X_Y_Z format rule IDs
const WCAG_TO_CATEGORY = {
  '1_1_1': 'image-alt',
  '1_2_1': 'media', '1_2_2': 'media', '1_2_3': 'media', '1_2_4': 'media', '1_2_5': 'media',
  '1_3_1': 'structure', '1_3_2': 'structure', '1_3_3': 'sensory',
  '1_3_4': 'orientation', '1_3_5': 'autocomplete',
  '1_4_1': 'color-use', '1_4_3': 'color-contrast', '1_4_4': 'resize-text',
  '1_4_10': 'reflow', '1_4_11': 'color-contrast', '1_4_12': 'text-spacing', '1_4_13': 'hover-focus-content',
  '2_1_1': 'keyboard', '2_1_2': 'keyboard', '2_1_4': 'keyboard',
  '2_2_1': 'timing',
  '2_3_1': 'timing',
  '2_4_1': 'landmark', '2_4_2': 'document-title', '2_4_3': 'focus-order',
  '2_4_4': 'link-name', '2_4_5': 'navigation', '2_4_6': 'label',
  '2_4_7': 'focus-visible', '2_4_11': 'focus-visible',
  '2_5_1': 'pointer', '2_5_2': 'pointer', '2_5_3': 'label-in-name', '2_5_4': 'motion',
  '3_2_3': 'consistency', '3_2_4': 'consistency', '3_2_6': 'consistency',
  '3_3_1': 'error-handling', '3_3_2': 'label', '3_3_3': 'error-handling', '3_3_4': 'error-handling',
  '4_1_1': 'parsing', '4_1_2': 'aria-naming', '4_1_3': 'aria-live',
};

// Categorize by ruleId — handles both wcag22-X_Y_Z and descriptive (axe-like) rule ID formats
function categorize(ruleId) {
  const id = (ruleId || '').toLowerCase();

  // Handle wcag22-X_Y_Z format (e.g., "wcag22-1_3_1", "wcag22-2_4_6") — primary AQA format
  const wcagMatch = id.match(/^wcag\d*-(\d+_\d+_\d+)$/);
  if (wcagMatch) {
    const criteriaKey = wcagMatch[1];
    if (WCAG_TO_CATEGORY[criteriaKey]) return WCAG_TO_CATEGORY[criteriaKey];
  }

  // Fallback: string-matching for descriptive rule IDs (axe-style, e.g., "color-contrast")
  // Visual / color
  if (id.includes('color-contrast')) return 'color-contrast';
  if (id.includes('focus-visible') || id === 'focus-indicator') return 'focus-visible';
  // Images
  if (id.includes('image-alt') || id.includes('img-alt') || id.includes('input-image-alt') || id.includes('area-alt')) return 'image-alt';
  if (id.includes('svg') && (id.includes('title') || id.includes('label'))) return 'svg-label';
  // Forms
  if (id.includes('label') || id.includes('input-label') || id.includes('select-name') || id.includes('textarea-label')) return 'label';
  if (id.includes('autocomplete') || id.includes('input-purpose')) return 'autocomplete';
  // Structure
  if (id.includes('heading-order') || id.includes('heading') || id.includes('empty-heading')) return 'heading-order';
  if (id.includes('document-title') || id.includes('page-title')) return 'document-title';
  if (id.includes('html-has-lang') || id.includes('html-lang') || id.includes('valid-lang')) return 'html-has-lang';
  if (id.includes('region') || id.includes('landmark') || id.includes('bypass')) return 'landmark';
  // Keyboard / interaction
  if (id.includes('tabindex')) return 'tabindex';
  if (id.includes('keyboard') || id.includes('focus') || id.includes('scrollable')) return 'keyboard';
  // ARIA
  if (id.includes('aria-required') || id.includes('aria-valid') || id.includes('aria-allowed') || id.includes('aria-role')) return 'aria-attributes';
  if (id.includes('aria-label') || id.includes('aria-labelledby') || id.includes('aria-describedby')) return 'aria-naming';
  if (id.includes('aria-hidden') || id.includes('aria-presentation')) return 'aria-hidden';
  if (id.includes('aria')) return 'aria';
  // Links / buttons
  if (id.includes('link-name') || id.includes('link') || id.includes('anchor')) return 'link-name';
  if (id.includes('button-name') || id.includes('button')) return 'button-name';
  // Lists / tables
  if (id.includes('list') || id.includes('dl') || id.includes('definition')) return 'list';
  if (id.includes('table') || id.includes('th-has-data') || id.includes('td-has-header') || id.includes('scope')) return 'table';
  // Media
  if (id.includes('video') || id.includes('audio') || id.includes('caption') || id.includes('transcript')) return 'media';
  // Timing / motion
  if (id.includes('meta-refresh') || id.includes('auto-play') || id.includes('blink') || id.includes('marquee')) return 'timing';
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
  return crypto.createHash('md5').update(parts.join('|')).digest('hex').slice(0, 24);
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
      const baseUrl = `https://api-aqa.usablenet.com/v3.1/${creds.team_slug}`;
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
    {
      type: 'list',
      name: 'method',
      message: 'Choose the scanning method:',
      choices: [
        { name: 'API', value: 'api' },
        { name: 'Playwright', value: 'playwright' },
      ],
      default: 'api',
    },
  ],

  fetch: async (config) => {
    const method = config.method || process.env.AQA_METHOD || 'api';
    
    if (method === 'playwright') {
      return module.exports.scanWithPlaywright(config);
    }
    
    // Original API method
    return module.exports.fetchFromAPI(config);
  },

  scanWithPlaywright: async (config) => {
    try {
      const { scanWithPlaywright } = require('./playwright/index');
      return await scanWithPlaywright(config);
    } catch (error) {
      console.error('Playwright scanning failed:', error.message);
      // Fallback to API method if configured
      if (config.fallbackToAPI !== false && config.api_key && config.team_slug) {
        console.log('Falling back to API method...');
        return module.exports.fetchFromAPI(config);
      }
      throw error;
    }
  },

  fetchFromAPI: async (config) => {
    if (!config || !config.api_key || !config.team_slug) {
      throw new Error('AQA credentials not configured. Run autofix-hub setup.');
    }

    const baseUrl = `https://api-aqa.usablenet.com/v3.1/${config.team_slug}`;
    const testId = config.test_id || process.env.AQA_TEST_ID;

    if (!testId) {
      throw new Error('AQA_TEST_ID not configured. Set it in .env or run setup.');
    }

    // Get test details and its runs history
    const testData = await apiRequest(baseUrl, `/a11y/tests/${testId}`, config.api_key);
    // The API may nest test config under "definition" or at the top level
    const testDef = testData.definition || testData;
    const runs = testData.runs || testDef.runs || [];
    if (runs.length === 0) {
      throw new Error('No runs found for the configured test.');
    }

    // Use the most recent completed run, fall back to first run
    const latestRun = runs.find(r => r.status === 'ready') || runs[0];
    const runId = latestRun.id;
    if (!runId) {
      throw new Error('Could not find latest run for the configured test.');
    }

    // Extract test-level metadata
    const suiteId = testDef.suiteId || testData.suiteId || null;
    const rulesetId = testDef.rulesetId || testData.rulesetId || null;

    // Fetch suite name if we have suiteId
    let suiteName = testDef.suiteName || testData.suiteName || null;
    if (suiteId && !suiteName) {
      try {
        const suiteData = await apiRequest(baseUrl, `/a11y/suites/${suiteId}`, config.api_key);
        const suite = suiteData.suite || suiteData;
        suiteName = suite.name || null;
      } catch (_) {}
    }

    // Get run metadata
    const runMeta = await apiRequest(baseUrl, `/a11y/runs/${runId}`, config.api_key);
    const deviceInfo = runMeta.deviceInfo || null;
    const epoch = runMeta.epoch || null;

    const allIssues = [];

    // --- Flow-based issues ---
    const flowListData = await apiRequest(baseUrl, `/a11y/tests/runs/${runId}/flows`, config.api_key);
    const flows = flowListData.flows || [];

    for (const flow of flows) {
      const flowId = flow.id;
      if (!flowId) continue;
      try {
        // Get flow details for step count, pageUrls, and summary link
        const flowDetails = await apiRequest(baseUrl, `/a11y/tests/runs/${runId}/flows/${flowId}`, config.api_key);
        const flowDetail = flowDetails.flow || flowDetails;
        const numSteps = flowDetail.numSteps || 1;
        const partSummaryUrl = flowDetail.summaryUrl || flowDetails.partSummaryUrl || null;
        // Build step lookup: stepIndex+changeIndex → {stepName, stepUrl, summaryUrl}
        const stepsArr = flowDetail.steps || [];
        const stepLookup = {};
        for (const s of stepsArr) {
          const key = `${s.stepIndex}_${s.changeIndex}`;
          stepLookup[key] = { stepName: s.stepName, stepUrl: s.stepUrl, stepSummaryUrl: s.summaryUrl || null, stepNumber: s.stepNumber };
        }

        for (let stepIndex = 0; stepIndex < numSteps; stepIndex++) {
          try {
            // Fetch with changeIndex=-1 (initial state), include manual-review issues and comments
            const flowIssuesData = await apiRequest(
              baseUrl,
              `/a11y/tests/runs/${runId}/flows/${flowId}/issues?stepIndex=${stepIndex}&changeIndex=-1&manual=true&comments=true`,
              config.api_key
            );
            // v3.1 wraps issues inside issuesData
            const issuesPayload = flowIssuesData.issuesData || flowIssuesData;
            const issues = issuesPayload.issues || [];
            const propertyTitles = issuesPayload.propertyTitles || [];
            const descriptions = issuesPayload.descriptions || {};

            // Resolve step-level metadata
            const stepMeta = stepLookup[`${stepIndex}_-1`] || {};

            // Compute selector occurrence index: count how many issues share the same selector per step
            const selectorCount = {};
            for (const issue of issues) {
              const sel = (issue.selectors || [])[0] || issue.tagName || 'unknown';
              selectorCount[sel] = (selectorCount[sel] || 0) + 1;
            }
            const selectorSeen = {};

            for (const issue of issues) {
              const sel = (issue.selectors || [])[0] || issue.tagName || 'unknown';
              selectorSeen[sel] = (selectorSeen[sel] || 0) + 1;
              issue._aqa_context = {
                type: 'flow',
                flowId,
                flowName: flow.name || flowId,
                pageUrl: stepMeta.stepUrl || flow.url || '',
                stepIndex,
                numSteps,
                stepName: stepMeta.stepName || null,
                stepUrl: stepMeta.stepUrl || null,
                stepNumber: stepMeta.stepNumber || null,
                stepSummaryUrl: stepMeta.stepSummaryUrl || null,
                runId,
                testId,
                partSummaryUrl,
                suiteId,
                suiteName,
                rulesetId,
                runEpoch: runMeta.epoch || null,
                deviceInfo: runMeta.deviceInfo || null,
                // Element identification helpers
                issueAqaId: issue.id || null,
                selectorOccurrence: selectorSeen[sel],
                selectorTotal: selectorCount[sel],
              };
              // Attach shared descriptions / property titles from response
              if (!issue._propertyTitles) issue._propertyTitles = propertyTitles;
              if (!issue._descriptions) issue._descriptions = descriptions;
            }
            allIssues.push(...issues);
          } catch (stepErr) {
            console.error(`Warning: Failed to fetch issues for flow ${flowId} step ${stepIndex}: ${stepErr.message}`);
          }
        }
      } catch (err) {
        console.error(`Warning: Failed to fetch flow details for ${flowId}: ${err.message}`);
      }
    }

    // --- Crawler / page-based issues ---
    try {
      const pageListData = await apiRequest(baseUrl, `/a11y/tests/runs/${runId}/pages`, config.api_key);
      const pages = pageListData.pages || [];

      for (const page of pages) {
        const pageId = page.id;
        if (!pageId) continue;
        try {
          const pageIssuesData = await apiRequest(
            baseUrl,
            `/a11y/tests/runs/${runId}/pages/${pageId}/issues?manual=true&comments=true`,
            config.api_key
          );
          const issuesPayload = pageIssuesData.issuesData || pageIssuesData;
          const issues = issuesPayload.issues || [];
          const propertyTitles = issuesPayload.propertyTitles || [];
          const descriptions = issuesPayload.descriptions || {};

          // Get page-level step/summary info if available
          const stepMeta = issuesPayload.step || {};
          const pageMeta = issuesPayload.page || {};

          // Compute selector occurrence index for page issues
          const selectorCount = {};
          for (const issue of issues) {
            const sel = (issue.selectors || [])[0] || issue.tagName || 'unknown';
            selectorCount[sel] = (selectorCount[sel] || 0) + 1;
          }
          const selectorSeen = {};

          for (const issue of issues) {
            const sel = (issue.selectors || [])[0] || issue.tagName || 'unknown';
            selectorSeen[sel] = (selectorSeen[sel] || 0) + 1;
            issue._aqa_context = {
              type: 'page',
              pageId,
              pageName: pageMeta.name || page.name || page.url || pageId,
              pageUrl: stepMeta.stepUrl || page.url || '',
              stepName: stepMeta.stepName || null,
              stepUrl: stepMeta.stepUrl || null,
              stepNumber: stepMeta.stepNumber || null,
              stepSummaryUrl: stepMeta.summaryUrl || null,
              runId,
              testId,
              suiteId,
              suiteName,
              rulesetId,
              runEpoch: runMeta.epoch || null,
              deviceInfo: runMeta.deviceInfo || null,
              // Element identification helpers
              issueAqaId: issue.id || null,
              selectorOccurrence: selectorSeen[sel],
              selectorTotal: selectorCount[sel],
            };
            if (!issue._propertyTitles) issue._propertyTitles = propertyTitles;
            if (!issue._descriptions) issue._descriptions = descriptions;
          }
          allIssues.push(...issues);
        } catch (pageErr) {
          console.error(`Warning: Failed to fetch issues for page ${pageId}: ${pageErr.message}`);
        }
      }
    } catch (crawlerErr) {
      // No crawled pages in this run — that's fine, not every test uses crawlers
      if (!crawlerErr.message.includes('404')) {
        console.error(`Warning: Failed to fetch crawled pages: ${crawlerErr.message}`);
      }
    }

    return allIssues;
  },

  normalize: (raw) => {
    const ruleId = raw.ruleId || raw.rule || raw.id || 'unknown';
    const category = categorize(ruleId);

    // --- Helper: Strip HTML tags to plain text ---
    function stripHtml(html) {
      if (!html) return '';
      return html
        .replace(/<pre[^>]*>[\s\S]*?<\/pre>/gi, (match) => {
          // Extract code from <pre><code>...</code></pre> blocks as-is
          const code = match.replace(/<\/?[^>]+>/g, '');
          return '\n```\n' + code.trim() + '\n```\n';
        })
        .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    // --- Helper: Extract CSS classes and IDs from HTML snippet ---
    function extractCssContext(html) {
      if (!html) return null;
      const context = { nearbyClasses: [], nearbyIds: [] };
      try {
        const classMatches = html.match(/class="([^"]+)"/g) || [];
        const classSet = new Set();
        classMatches.forEach(m => {
          const cls = m.match(/class="([^"]+)"/)[1].split(/\s+/);
          cls.forEach(c => { if (c) classSet.add(c); });
        });
        context.nearbyClasses = Array.from(classSet).slice(0, 10);

        const idMatches = html.match(/id="([^"]+)"/g) || [];
        const idSet = new Set();
        idMatches.forEach(m => {
          const id = m.match(/id="([^"]+)"/)[1];
          if (id) idSet.add(id);
        });
        context.nearbyIds = Array.from(idSet).slice(0, 5);
        return (context.nearbyClasses.length > 0 || context.nearbyIds.length > 0) ? context : null;
      } catch (_) { return null; }
    }

    // --- Helper: Detect framework from HTML + URL ---
    function detectFramework(html, pageUrl) {
      const indicators = {
        shopify: { patterns: [/shopify/i, /cdn\.shopify\.com/i, /\{\{.*\}\}/, /\{%.*%\}/], score: 0 },
        react: { patterns: [/data-reactroot/i, /react-dom/i, /__reactFiber/i, /__next/i], score: 0 },
        vue: { patterns: [/data-v-[a-f0-9]{8}/i, /__vue__/i, /v-model/i], score: 0 },
        angular: { patterns: [/ng-app/i, /ng-controller/i, /_ngcontent/i], score: 0 },
        wordpress: { patterns: [/wp-content/i, /wp-includes/i, /wordpress/i], score: 0 },
      };
      if (html) {
        Object.keys(indicators).forEach(fw => {
          indicators[fw].patterns.forEach(p => { if (p.test(html)) indicators[fw].score += 1; });
        });
      }
      if (pageUrl) {
        if (/\.myshopify\.com|shopify/i.test(pageUrl)) indicators.shopify.score += 2;
        if (/wp-|wordpress/i.test(pageUrl)) indicators.wordpress.score += 2;
      }
      let best = null, bestScore = 0;
      Object.keys(indicators).forEach(fw => {
        if (indicators[fw].score > bestScore) { bestScore = indicators[fw].score; best = fw; }
      });
      return best ? { framework: best, confidence: Math.min(bestScore / 3, 1) } : null;
    }

    // --- Main normalization logic ---

    // Extract rich data from AQA's nested structure: _descriptions[ruleId][solutionId]
    // The solutionId on the issue matches a subKey in _descriptions[ruleId]
    let richData = {};
    if (raw._descriptions && raw._descriptions[ruleId]) {
      const descObj = raw._descriptions[ruleId];
      // Try matching by solutionId first (most accurate), then fall back to first subKey
      if (raw.solutionId && descObj[raw.solutionId]) {
        richData = descObj[raw.solutionId];
      } else {
        const subKeys = Object.keys(descObj);
        if (subKeys.length > 0) richData = descObj[subKeys[0]] || {};
      }
    }

    // AQA provides impact in the nested structure, fall back to top level
    const impact = richData.impact || raw.impact || 'moderate';
    const severity = SEVERITY_MAP[impact] || 'medium';

    const context = raw._aqa_context || {};
    const contextKey = context.type === 'flow'
      ? context.flowId
      : (context.pageId || 'unknown');

    const id = `aqa-${stableHash([ruleId, (raw.selectors && raw.selectors[0]) || '', contextKey])}`;

    // Extract solutions with HTML stripped to clean markdown
    let solutionsArr = [];
    if (Array.isArray(richData.solutions)) {
      solutionsArr = richData.solutions
        .filter(s => s.title || s.text || s.description)
        .map(s => ({
          title: stripHtml(s.title || ''),
          description: stripHtml(s.text || s.description || ''),
        }));
    }

    // Extract WCAG criteria — use ruleShortTitle (e.g., "1.1.1") which AQA always provides
    const wcagCriteria = Array.isArray(richData.wcagCriteria) ? richData.wcagCriteria
      : (raw.ruleShortTitle ? [raw.ruleShortTitle] : []);

    // Extract comments (from manual reviews or team annotations)
    let comments = [];
    if (Array.isArray(raw.comments)) {
      comments = raw.comments.map(c => ({
        author: c.author || 'unknown',
        text: c.text || c.comment || '',
        date: c.date || null,
      }));
    }

    // Extract severity/complexity from AQA's properties array + propertyTitles
    let aqaSeverity = null, aqaComplexity = null, aqaStatus = null;
    const propTitles = raw._propertyTitles || [];
    const props = raw.properties || [];
    for (let i = 0; i < propTitles.length && i < props.length; i++) {
      const title = (propTitles[i] || '').toLowerCase();
      if (title.includes('severity')) aqaSeverity = props[i];
      else if (title.includes('complexity')) aqaComplexity = props[i];
      else if (title.includes('status')) aqaStatus = props[i];
    }

    // --- Enhanced Context using real AQA data ---
    const pageUrl = context.pageUrl;
    const selector = (raw.selectors && raw.selectors[0]) || null;
    const tagName = raw.tagName || null;
    const htmlSnippet = raw.html || null;

    const cssContext = htmlSnippet ? extractCssContext(htmlSnippet) : null;
    const framework = detectFramework(htmlSnippet, pageUrl);

    const enhancedContext = {
      html_context: htmlSnippet || null,
      css_context: cssContext,
      framework,
      enhanced_selector: selector,
      tag_name: tagName,
    };

    // Build rich metadata
    const metadata = {
      // WCAG
      wcag_criteria: wcagCriteria,
      wcag_guidance: wcagCriteria.map(c => WCAG_GUIDANCE[c] || null).filter(Boolean),
      // Element info
      selector,
      all_selectors: raw.selectors || [],
      tag_name: tagName,
      html_snippet: htmlSnippet,
      // Enhanced context
      enhanced_context: enhancedContext,
      // AQA enrichment — problem is the detailed explanation from _descriptions
      description: stripHtml(richData.description || '') || null,
      problem: stripHtml(richData.problem || '') || null,
      solutions: solutionsArr,
      solution_id: raw.solutionId || null,
      comments,
      properties: props,
      property_titles: propTitles,
      aqa_severity: aqaSeverity,
      aqa_complexity: aqaComplexity,
      aqa_status: aqaStatus,
      // Ownership
      responsibility: richData.responsibility || raw.responsibility || null,
      technology: richData.technology || raw.technology || null,
      impact,
      check_manually: raw.auto === false,
      // Context
      context_type: context.type || null,
      context_id: contextKey,
      context_name: context.type === 'flow'
        ? (context.flowName || null)
        : (context.pageName || null),
      page_url: pageUrl || null,
      step_index: context.stepIndex != null ? context.stepIndex : null,
      num_steps: context.numSteps || null,
      step_name: context.stepName || null,
      step_url: context.stepUrl || null,
      step_number: context.stepNumber || null,
      step_summary_url: context.stepSummaryUrl || null,
      // Element identification
      issue_aqa_id: context.issueAqaId || null,
      selector_occurrence: context.selectorOccurrence || null,
      selector_total: context.selectorTotal || null,
      // Run / test / suite
      run_id: context.runId || null,
      test_id: context.testId || null,
      suite_id: context.suiteId || null,
      suite_name: context.suiteName || null,
      ruleset_id: context.rulesetId || null,
      run_epoch: context.runEpoch || null,
      summary_url: context.partSummaryUrl || null,
      device_info: context.deviceInfo || null,
    };

    return {
      id,
      source: 'aqa',
      rule_id: ruleId,
      severity,
      category,
      status: 'open',
      file_path: null,
      line_number: null,
      description: raw.needFixTitle || raw.checkManuallyTitle || raw.ruleTitle || `Accessibility issue: ${ruleId}`,
      scanner_data: JSON.stringify(raw),
      metadata,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  },

  clusterKeys: (issue) => {
    const ruleId = issue.rule_id;
    const meta = issue.metadata || {};
    const keys = [];

    // Cluster by (ruleId, flowId/pageId)
    const contextId = meta.context_id || 'unknown';
    keys.push(`${ruleId}:context:${contextId}`);

    // Cluster by (ruleId, normalizedSelector) — groups same pattern across pages
    const selector = meta.selector;
    if (selector) {
      keys.push(`${ruleId}:selector:${normalizeSelector(selector)}`);
    }

    // Cluster by (ruleId, page URL path) — groups all violations of same rule on a page
    const pageUrl = meta.page_url || '';
    if (pageUrl) {
      try {
        const pathname = new url.URL(pageUrl, 'http://localhost').pathname;
        keys.push(`${ruleId}:page:${pathname}`);
      } catch (_) {}
    }

    // Cluster by WCAG criterion — groups different rules targeting the same requirement
    if (meta.wcag_criteria && meta.wcag_criteria.length > 0) {
      for (const criterion of meta.wcag_criteria) {
        keys.push(`wcag:${criterion}:context:${contextId}`);
      }
    }

    return keys;
  },

  effortEstimate: (issue) => {
    // Use AQA's own complexity field if available for more accurate estimates
    const meta = issue.metadata || {};
    const aqaComplexity = (meta.aqa_complexity || '').toLowerCase();
    const complexityMap = {
      'easy': { level: 'small', minutes: 5 },
      'medium': { level: 'medium', minutes: 15 },
      'hard': { level: 'large', minutes: 30 },
    };

    try {
      const { loadEffortMap } = require('@autofix-hub/core/src/config');
      const effortMap = loadEffortMap();
      const sourceMap = effortMap.aqa || {};
      return sourceMap[issue.category] || complexityMap[aqaComplexity] || sourceMap.__default__ || { level: 'small', minutes: 5 };
    } catch (_) {
      const defaults = {
        'color-contrast': { level: 'medium', minutes: 15 },
        'focus-visible': { level: 'medium', minutes: 15 },
        'image-alt': { level: 'small', minutes: 5 },
        'svg-label': { level: 'small', minutes: 5 },
        'label': { level: 'small', minutes: 5 },
        'autocomplete': { level: 'trivial', minutes: 2 },
        'heading-order': { level: 'medium', minutes: 15 },
        'document-title': { level: 'trivial', minutes: 2 },
        'html-has-lang': { level: 'trivial', minutes: 2 },
        'landmark': { level: 'medium', minutes: 15 },
        'tabindex': { level: 'trivial', minutes: 2 },
        'keyboard': { level: 'medium', minutes: 20 },
        'aria-attributes': { level: 'small', minutes: 10 },
        'aria-naming': { level: 'small', minutes: 5 },
        'aria-hidden': { level: 'small', minutes: 5 },
        'aria': { level: 'small', minutes: 10 },
        'link-name': { level: 'small', minutes: 5 },
        'button-name': { level: 'small', minutes: 5 },
        'list': { level: 'small', minutes: 10 },
        'table': { level: 'medium', minutes: 20 },
        'media': { level: 'large', minutes: 30 },
        'timing': { level: 'small', minutes: 10 },
        // New categories from WCAG_TO_CATEGORY
        'structure': { level: 'medium', minutes: 15 },
        'sensory': { level: 'small', minutes: 10 },
        'orientation': { level: 'small', minutes: 5 },
        'color-use': { level: 'medium', minutes: 15 },
        'resize-text': { level: 'medium', minutes: 15 },
        'reflow': { level: 'large', minutes: 30 },
        'text-spacing': { level: 'medium', minutes: 15 },
        'hover-focus-content': { level: 'medium', minutes: 20 },
        'focus-order': { level: 'medium', minutes: 15 },
        'navigation': { level: 'medium', minutes: 20 },
        'label-in-name': { level: 'small', minutes: 5 },
        'pointer': { level: 'medium', minutes: 15 },
        'motion': { level: 'small', minutes: 10 },
        'consistency': { level: 'medium', minutes: 20 },
        'error-handling': { level: 'medium', minutes: 20 },
        'parsing': { level: 'small', minutes: 10 },
        'aria-live': { level: 'small', minutes: 10 },
      };
      return defaults[issue.category] || complexityMap[aqaComplexity] || { level: 'small', minutes: 5 };
    }
  },

  reviewLevel: (issue) => {
    const category = issue.category;
    const meta = issue.metadata || {};

    // If AQA flagged it as manual-review, always require careful review
    if (meta.check_manually) return 'careful';

    // Quick: deterministic fixes with no judgment calls
    if ([
      'html-has-lang', 'tabindex', 'document-title', 'autocomplete',
      'parsing', 'orientation', 'label-in-name',
    ].includes(category)) {
      return 'quick';
    }
    // Careful: content-related or design-related changes needing human judgment
    if ([
      'image-alt', 'color-contrast', 'color-use', 'focus-visible', 'focus-order',
      'label', 'heading-order', 'structure', 'sensory',
      'aria', 'aria-attributes', 'aria-naming', 'aria-live',
      'landmark', 'keyboard', 'link-name', 'button-name',
      'table', 'media', 'reflow', 'text-spacing', 'resize-text',
      'hover-focus-content', 'navigation', 'pointer', 'motion',
      'consistency', 'error-handling',
    ].includes(category)) {
      return 'careful';
    }
    return 'careful';
  },

  scoringFactors: (issue) => {
    let pageImportance = 3; // default
    const meta = issue.metadata || {};
    const pageUrl = meta.page_url || '';

    if (pageUrl) {
      try {
        const { loadScoringConfig } = require('@autofix-hub/core/src/config');
        const config = loadScoringConfig();
        const patterns = config.page_importance || {};
        const pathname = new url.URL(pageUrl, 'http://localhost').pathname;
        for (const [pattern, weight] of Object.entries(patterns)) {
          if (pattern === '/*') continue; // check wildcard last
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*'));
          if (regex.test(pageUrl) || regex.test(pathname)) {
            pageImportance = weight;
            break;
          }
        }
        // Fall back to wildcard if no specific match
        if (pageImportance === 3 && patterns['/*']) {
          pageImportance = patterns['/*'];
        }
      } catch (_) {
        // Use default
      }
    }

    return pageImportance;
  },

  promptTemplate: (issue) => {
    const category = issue.category;
    const ruleId = issue.rule_id;
    const desc = issue.description;
    const meta = issue.metadata || {};

    // --- Build rich context block from metadata ---
    const contextLines = [
      `| Field | Value |`,
      `|-------|-------|`,
      `| **Rule** | \`${ruleId}\` |`,
      `| **Category** | ${category} |`,
      `| **Impact** | ${meta.impact || 'unknown'} |`,
      `| **Severity** | ${issue.severity} |`,
    ];
    if (meta.aqa_severity) contextLines.push(`| **AQA Severity** | ${meta.aqa_severity} |`);
    if (meta.aqa_complexity) contextLines.push(`| **AQA Complexity** | ${meta.aqa_complexity} |`);
    if (meta.wcag_criteria && meta.wcag_criteria.length > 0) {
      contextLines.push(`| **WCAG Criteria** | ${meta.wcag_criteria.join(', ')} |`);
    }
    if (meta.selector) {
      contextLines.push(`| **CSS Selector** | \`${meta.selector}\` |`);
    }
    if (meta.all_selectors && meta.all_selectors.length > 1) {
      contextLines.push(`| **All Selectors** | ${meta.all_selectors.map(s => '`' + s + '`').join(', ')} |`);
    }
    if (meta.tag_name) contextLines.push(`| **Element** | \`<${meta.tag_name}>\` |`);
    if (meta.technology) contextLines.push(`| **Technology** | ${meta.technology} |`);
    if (meta.responsibility) contextLines.push(`| **Responsibility** | ${meta.responsibility} |`);
    if (meta.context_name) {
      const stepLabel = meta.step_index != null ? ` (Step ${meta.step_index + 1} of ${meta.num_steps || '?'})` : '';
      contextLines.push(`| **${meta.context_type === 'flow' ? 'Flow' : 'Page'}** | ${meta.context_name}${stepLabel} |`);
    }
    if (meta.page_url) contextLines.push(`| **Page URL** | ${meta.page_url} |`);
    if (meta.suite_name) contextLines.push(`| **Suite** | ${meta.suite_name} |`);
    if (meta.run_id) contextLines.push(`| **Run ID** | ${meta.run_id} |`);
    if (meta.summary_url) contextLines.push(`| **AQA Report** | ${meta.summary_url} |`);
    if (meta.check_manually) contextLines.push(`| **Manual Review** | Yes — AQA flagged this for human verification |`);

    const contextBlock = contextLines.join('\n');

    // --- Element Location block — helps identify WHICH specific element on the page ---
    let elementLocationBlock = '';
    {
      const locLines = [];
      // Selector occurrence: e.g., "2nd of 3 `h1` issues on this step"
      if (meta.selector_total && meta.selector_total > 1) {
        const ordinal = meta.selector_occurrence === 1 ? '1st' : meta.selector_occurrence === 2 ? '2nd' : meta.selector_occurrence === 3 ? '3rd' : `${meta.selector_occurrence}th`;
        locLines.push(`- **Selector Occurrence:** ${ordinal} of ${meta.selector_total} \`${meta.selector}\` issues on this page`);
      }
      // AQA issue ID — matches what the user sees in the AQA dashboard
      if (meta.issue_aqa_id) {
        locLines.push(`- **AQA Issue ID:** \`${meta.issue_aqa_id}\` *(use this to locate the exact element in the AQA dashboard)*`);
      }
      // Solution ID — gives semantic context about what's wrong with this specific element
      if (meta.solution_id) {
        locLines.push(`- **Solution Key:** \`${meta.solution_id}\` *(identifies the specific violation pattern)*`);
      }
      // Step-level context — which page/step this was found on
      if (meta.step_name) {
        const stepNum = meta.step_number ? ` (Step ${meta.step_number})` : '';
        locLines.push(`- **Page Section:** ${meta.step_name}${stepNum}`);
      }
      if (meta.step_url && meta.step_url !== meta.page_url) {
        locLines.push(`- **Step URL:** ${meta.step_url}`);
      }
      // Deep link to AQA dashboard
      if (meta.step_summary_url) {
        locLines.push(`- **AQA Dashboard:** [View issue in context](${meta.step_summary_url})`);
      } else if (meta.summary_url) {
        locLines.push(`- **AQA Dashboard:** [View flow results](${meta.summary_url})`);
      }

      if (locLines.length > 0) {
        elementLocationBlock = '\n### Element Location\n' + locLines.join('\n');
      }
    }

    // --- Problem description block (detailed explanation from AQA _descriptions) ---
    let problemBlock = '';
    if (meta.problem) {
      problemBlock = [
        ``,
        `### Problem`,
        `> ${meta.problem}`,
      ].join('\n');
    }

    // --- Enhanced Context Block ---
    let enhancedContextBlock = '';
    if (meta.enhanced_context) {
      const enhanced = meta.enhanced_context;
      const enhancedLines = [
        ``,
        `### Enhanced Context`,
      ];
      
      if (enhanced.enhanced_selector) {
        enhancedLines.push(`**Target Selector:** \`${enhanced.enhanced_selector}\``);
      }
      
      if (enhanced.framework) {
        enhancedLines.push(`**Detected Framework:** ${enhanced.framework.framework} (confidence: ${Math.round(enhanced.framework.confidence * 100)}%)`);
      }
      
      if (enhanced.html_context) {
        enhancedLines.push(`**HTML Context:**`);
        enhancedLines.push('```html');
        enhancedLines.push(enhanced.html_context);
        enhancedLines.push('```');
      }
      
      if (enhanced.css_context) {
        const css = enhanced.css_context;
        if (css.nearbyClasses.length > 0) {
          enhancedLines.push(`**Nearby CSS Classes:** ${css.nearbyClasses.join(', ')}`);
        }
        if (css.nearbyIds.length > 0) {
          enhancedLines.push(`**Nearby IDs:** ${css.nearbyIds.join(', ')}`);
        }
      }
      
      enhancedContextBlock = enhancedLines.join('\n');
    }

    // --- HTML snippet block ---
    let htmlBlock = '';
    if (meta.html_snippet) {
      htmlBlock = [
        ``,
        `### Offending HTML`,
        '```html',
        meta.html_snippet,
        '```',
      ].join('\n');
    }

    // --- AQA solutions block — the scanner's own recommended fixes ---
    let solutionsBlock = '';
    if (meta.solutions && meta.solutions.length > 0) {
      const solLines = meta.solutions.map((s, i) => {
        let line = `${i + 1}. **${s.title}**`;
        if (s.description) line += `\n   ${s.description}`;
        return line;
      });
      solutionsBlock = [
        ``,
        `### AQA Recommended Fix`,
        `> These are the scanner's own suggested solutions. Prefer these over generic guidance.`,
        ``,
        ...solLines,
      ].join('\n');
    }

    // --- WCAG guidance block ---
    let wcagBlock = '';
    if (meta.wcag_guidance && meta.wcag_guidance.length > 0) {
      const wcagLines = meta.wcag_guidance.map(g =>
        `- **WCAG ${meta.wcag_criteria[meta.wcag_guidance.indexOf(g)]} — ${g.title}** (Level ${g.level}): ${g.technique}`
      );
      wcagBlock = [
        ``,
        `### WCAG Requirement`,
        ...wcagLines,
      ].join('\n');
    }

    // --- Comments / annotations from AQA team ---
    let commentsBlock = '';
    if (meta.comments && meta.comments.length > 0) {
      const commentLines = meta.comments.map(c =>
        `- ${c.author}: "${c.text}"${c.date ? ` (${c.date})` : ''}`
      );
      commentsBlock = [
        ``,
        `### Team Notes`,
        ...commentLines,
      ].join('\n');
    }

    // --- Technology-adaptive preamble ---
    let techNote = '';
    const tech = (meta.technology || '').toLowerCase();
    if (tech.includes('react') || tech.includes('jsx')) {
      techNote = `\n> **Framework:** React — use JSX attributes (\`htmlFor\` instead of \`for\`, \`className\` instead of \`class\`, \`aria-*\` props). Check if the component accepts accessibility props.\n`;
    } else if (tech.includes('vue')) {
      techNote = `\n> **Framework:** Vue — use template syntax with \`:aria-label\`, \`v-bind\` for dynamic attributes. Check component prop interfaces.\n`;
    } else if (tech.includes('angular')) {
      techNote = `\n> **Framework:** Angular — use \`[attr.aria-label]\` binding syntax. Check component \`@Input()\" definitions.\n`;
    }

    // --- Category-specific instructions ---
    const CATEGORY_INSTRUCTIONS = {
      'image-alt': [
        `### Fix Instructions`,
        `1. **Determine image purpose** by examining the surrounding context:`,
        `   - **Decorative** (visual flair, redundant to adjacent text): add \`alt=""\` and \`role="presentation"\``,
        `   - **Informative** (conveys content): write concise descriptive alt text (<125 chars) describing what the image shows`,
        `   - **Functional** (inside a link/button): describe the *action*, not the image (e.g., "Go to homepage" not "Company logo")`,
        `   - **Complex** (chart/graph): provide brief alt + longer \`aria-describedby\` description`,
        `2. Do NOT use "image of" or "picture of" — screen readers already announce it as an image`,
        `3. If the image is an icon with adjacent text label, use \`alt=""\` to avoid duplication`,
        `4. For CSS background images that convey meaning: add \`role="img"\` and \`aria-label\` to the container`,
      ],
      'svg-label': [
        `### Fix Instructions`,
        `1. Add a \`<title>\` element as the first child of the \`<svg>\` with descriptive text`,
        `2. Add \`role="img"\` to the \`<svg>\` element`,
        `3. Link the title using \`aria-labelledby\`: \`<svg role="img" aria-labelledby="title-id"><title id="title-id">Description</title>...</svg>\``,
        `4. For decorative SVGs: add \`aria-hidden="true"\` and \`focusable="false"\``,
      ],
      'color-contrast': [
        `### Fix Instructions`,
        `1. **Identify the failing pair**: find the foreground text color and its background color in the CSS`,
        `2. **Required ratios** (WCAG AA):`,
        `   - Normal text (<18pt / <14pt bold): **4.5:1** minimum`,
        `   - Large text (>=18pt / >=14pt bold): **3:1** minimum`,
        `   - UI components & graphical objects: **3:1** minimum`,
        `3. **Fix strategy** (in order of preference):`,
        `   a. Adjust the foreground color to be darker — least visual disruption`,
        `   b. Adjust the background color if foreground is part of brand identity`,
        `   c. Update CSS custom properties / design tokens at \`:root\` if the color is reused`,
        `4. Check both light and dark theme if applicable`,
        `5. Use a contrast checker tool to verify the new ratio meets requirements`,
        `6. If the element has hover/focus states, verify those meet contrast too`,
      ],
      'focus-visible': [
        `### Fix Instructions`,
        `1. **Never remove** \`outline\` on \`:focus\` without providing an alternative focus indicator`,
        `2. Add a visible \`:focus-visible\` style with at least 3:1 contrast against adjacent colors:`,
        `   \`\`\`css`,
        `   :focus-visible { outline: 2px solid #005fcc; outline-offset: 2px; }`,
        `   \`\`\``,
        `3. If using \`:focus\` reset (\`outline: none\`), replace it with \`:focus:not(:focus-visible) { outline: none; }\``,
        `4. Ensure the focus indicator has sufficient area (at least 2px perimeter or equivalent)`,
      ],
      'label': [
        `### Fix Instructions`,
        `1. **Best option**: Associate a visible \`<label>\` element using matching \`for\`/\`id\`:`,
        `   \`\`\`html`,
        `   <label for="email">Email address</label>`,
        `   <input id="email" type="email" />`,
        `   \`\`\``,
        `2. If a visible label already exists but isn't linked: add the \`for\` attribute to point to the input's \`id\``,
        `3. If no visible label is appropriate (e.g., search box with placeholder):`,
        `   - Add \`aria-label="Search"\` directly on the input, OR`,
        `   - Add a visually-hidden label using a \`.sr-only\` class (not \`display:none\` — that hides from screen readers too)`,
        `4. For grouped inputs (radio buttons, checkboxes): use \`<fieldset>\` + \`<legend>\``,
        `5. The label text must clearly describe the input's purpose — avoid "Field 1" or "Enter value"`,
      ],
      'autocomplete': [
        `### Fix Instructions`,
        `1. Add the \`autocomplete\` attribute with the appropriate token for the input's purpose`,
        `2. Common tokens: \`name\`, \`email\`, \`tel\`, \`street-address\`, \`postal-code\`, \`cc-number\`, \`username\`, \`new-password\`, \`current-password\``,
        `3. Full list: https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofilling-form-controls:-the-autocomplete-attribute`,
      ],
      'heading-order': [
        `### Fix Instructions`,
        `1. **Headings must follow a logical hierarchy** — no skipping levels (e.g., h1 -> h3 is invalid)`,
        `2. Each page should have exactly **one \`<h1>\`** describing the primary content`,
        `3. Subsequent sections use \`<h2>\`, sub-sections use \`<h3>\`, etc.`,
        `4. If an \`<h3>\` follows an \`<h1>\` with no \`<h2>\` in between — either:`,
        `   a. Change it to \`<h2>\`, OR`,
        `   b. Add an intervening \`<h2>\` section heading`,
        `5. If changing heading level breaks the visual design: use CSS to restore appearance:`,
        `   \`\`\`css`,
        `   h2.looks-like-h3 { font-size: 1.17em; /* match h3 sizing */ }`,
        `   \`\`\``,
        `6. Empty headings: either add meaningful text or remove the element entirely`,
      ],
      'document-title': [
        `### Fix Instructions`,
        `1. Add or fix the \`<title>\` element in \`<head>\`:  \`<title>{Page Name} | {Site Name}</title>\``,
        `2. The title must describe the page's topic or purpose — it's the first thing screen readers announce`,
        `3. For SPAs: update \`document.title\` on route change`,
      ],
      'html-has-lang': [
        `### Fix Instructions`,
        `1. Add \`lang\` attribute to the \`<html>\` element: \`<html lang="en">\``,
        `2. Use a valid BCP 47 language tag (e.g., \`en\`, \`es\`, \`fr\`, \`zh-Hans\`)`,
        `3. For multi-language pages: use \`lang\` on specific elements that differ from the page language`,
      ],
      'landmark': [
        `### Fix Instructions`,
        `1. Wrap the main content area in \`<main>\` (only one per page)`,
        `2. Use semantic elements: \`<header>\`, \`<nav>\`, \`<main>\`, \`<aside>\`, \`<footer>\``,
        `3. If multiple \`<nav>\` elements exist: add \`aria-label\` to each (e.g., \`aria-label="Main navigation"\`, \`aria-label="Footer links"\`)`,
        `4. For skip navigation: add a visually-hidden link as the first focusable element:`,
        `   \`\`\`html`,
        `   <a href="#main-content" class="sr-only focus:not-sr-only">Skip to main content</a>`,
        `   \`\`\``,
        `5. Ensure all page content is within a landmark region`,
      ],
      'tabindex': [
        `### Fix Instructions`,
        `1. **Remove any positive \`tabindex\`** values (\`tabindex > 0\`) — they break natural tab order`,
        `2. Use \`tabindex="0"\` ONLY for custom interactive elements (custom buttons, clickable divs) that need keyboard focus`,
        `3. Use \`tabindex="-1"\` for elements that should be focusable programmatically but NOT in the tab order`,
        `4. Ensure DOM source order matches the visual reading order — that defines natural tab flow`,
        `5. Native interactive elements (\`<a>\`, \`<button>\`, \`<input>\`) are already focusable — don't add \`tabindex\``,
      ],
      'keyboard': [
        `### Fix Instructions`,
        `1. If using \`<div onClick>\` or \`<span onClick>\` — replace with \`<button>\` or \`<a href>\``,
        `2. If a semantic element isn't feasible, add ALL of:`,
        `   - \`role="button"\` (or appropriate role)`,
        `   - \`tabindex="0"\``,
        `   - \`onKeyDown\` handler for Enter (keyCode 13) and Space (keyCode 32)`,
        `3. For custom dropdowns/menus: implement arrow-key navigation per WAI-ARIA patterns`,
        `4. Ensure a visible focus indicator exists (see focus-visible guidance)`,
        `5. Scrollable regions must be keyboard-accessible: add \`tabindex="0"\` and \`role="region"\` with \`aria-label\``,
      ],
      'aria-attributes': [
        `### Fix Instructions`,
        `1. **Required attributes**: ensure the element's \`role\` has all required ARIA attributes (e.g., \`role="slider"\` needs \`aria-valuenow\`, \`aria-valuemin\`, \`aria-valuemax\`)`,
        `2. **Allowed attributes**: remove any ARIA attributes that are not supported by the element's role`,
        `3. **Valid values**: ensure attribute values match the spec (e.g., \`aria-expanded\` must be \`"true"\` or \`"false"\`, not \`"yes"\`)`,
        `4. Reference: https://www.w3.org/TR/wai-aria-1.2/#role_definitions`,
      ],
      'aria-naming': [
        `### Fix Instructions`,
        `1. Prefer visible text content or \`<label>\` over \`aria-label\` when possible`,
        `2. Use \`aria-label\` for icon-only buttons/links: \`<button aria-label="Close"><svg>...</svg></button>\``,
        `3. Use \`aria-labelledby\` to reference an existing visible element's ID`,
        `4. Use \`aria-describedby\` for supplementary descriptions (help text, error messages)`,
        `5. Avoid redundant labeling — don't duplicate visible text in \`aria-label\``,
      ],
      'aria-hidden': [
        `### Fix Instructions`,
        `1. \`aria-hidden="true"\` hides the element and ALL descendants from assistive tech — use only for truly decorative content`,
        `2. **Never** put \`aria-hidden="true"\` on a focusable element or ancestor of focusable elements`,
        `3. If content should be hidden from everyone: use \`display:none\` or \`visibility:hidden\` instead`,
        `4. For decorative icons next to text: \`aria-hidden="true"\` on the icon is correct`,
      ],
      'link-name': [
        `### Fix Instructions`,
        `1. Links must have discernible text. Fix options:`,
        `   - Add meaningful text content inside the \`<a>\` element`,
        `   - Add \`aria-label\` describing the link destination: \`<a href="/cart" aria-label="View shopping cart"><svg>...</svg></a>\``,
        `   - For SVG icons inside links: add \`<title>\` to the SVG`,
        `2. Avoid generic text like "Click here", "Read more", "Learn more" — add context: "Read more about accessibility testing"`,
        `3. If surrounding context provides meaning: ensure it's programmatically associated via \`aria-describedby\``,
      ],
      'button-name': [
        `### Fix Instructions`,
        `1. Buttons must have discernible text. Fix options:`,
        `   - Add visible text content inside the \`<button>\``,
        `   - Add \`aria-label\` for icon-only buttons: \`<button aria-label="Delete item"><svg>...</svg></button>\``,
        `   - For \`<input type="submit">\`: ensure the \`value\` attribute is set`,
        `2. The label should describe the **action**, not the icon (e.g., "Close dialog" not "X icon")`,
      ],
      'table': [
        `### Fix Instructions`,
        `1. Data tables need \`<th>\` elements with \`scope="col"\` or \`scope="row"\``,
        `2. Add a \`<caption>\` element describing the table's purpose`,
        `3. For complex tables with multi-level headers: use \`id\`/\`headers\` attributes`,
        `4. Layout tables (non-data): add \`role="presentation"\` to remove table semantics`,
        `5. Ensure tables are responsive — avoid horizontal scrolling traps on mobile`,
      ],
      'media': [
        `### Fix Instructions`,
        `1. **Video**: provide synchronized captions (\`<track kind="captions">\`) and audio descriptions if visual-only content is meaningful`,
        `2. **Audio**: provide a transcript`,
        `3. **Auto-playing media**: must have controls to pause/stop, OR auto-stop within 3 seconds`,
        `4. Add accessible controls with proper labels for play, pause, volume, etc.`,
      ],
      'timing': [
        `### Fix Instructions`,
        `1. Remove \`<meta http-equiv="refresh">\` auto-redirects — use server-side redirects instead`,
        `2. Remove \`<marquee>\` and \`<blink>\` elements — use CSS animations with \`prefers-reduced-motion\` media query`,
        `3. Auto-playing/scrolling content must have a visible pause/stop mechanism`,
        `4. Time limits must be adjustable, extendable, or removable`,
      ],
      'structure': [
        `### Fix Instructions`,
        `1. Ensure information, structure, and relationships conveyed visually are also expressed in markup`,
        `2. Use semantic HTML elements: \`<h1>-<h6>\` for headings, \`<ul>/<ol>\` for lists, \`<table>\` for tabular data`,
        `3. Don't use whitespace characters (spaces, tabs) to format text into columns — use proper table or grid markup`,
        `4. Use \`<label>\` elements for form controls, \`<fieldset>/<legend>\` for related groups`,
        `5. Ensure ARIA roles, properties, and relationships are valid and not prohibited for the element`,
        `6. If using ARIA attributes (e.g., \`aria-controls\`, \`aria-activedescendant\`), verify the referenced element IDs exist in the DOM`,
      ],
      'sensory': [
        `### Fix Instructions`,
        `1. Don't rely solely on sensory characteristics (shape, color, size, position, orientation, or sound) to convey information`,
        `2. Add text labels alongside visual cues: "Click the **Submit** button below" not "Click the round button"`,
        `3. Use multiple indicators: color + icon + text for status messages`,
      ],
      'orientation': [
        `### Fix Instructions`,
        `1. Don't lock the page to portrait or landscape orientation`,
        `2. Remove any CSS \`@media (orientation: ...)\` rules that hide content`,
        `3. Avoid JavaScript that forces \`screen.orientation.lock()\` unless orientation is essential (e.g., a piano app)`,
      ],
      'color-use': [
        `### Fix Instructions`,
        `1. Don't use color as the only means of conveying information (e.g., required fields, error states, active tabs)`,
        `2. Add a secondary visual indicator: text label, icon, underline, pattern, or border`,
        `3. For links within text: add underline or other non-color visual distinction`,
        `4. For form errors: pair the red color with an error icon and descriptive text message`,
      ],
      'resize-text': [
        `### Fix Instructions`,
        `1. Use relative units (\`em\`, \`rem\`, \`%\`, \`vw\`) instead of \`px\` for font sizes`,
        `2. Ensure the layout doesn't break when text is resized up to 200%`,
        `3. Don't use \`maximum-scale=1\` or \`user-scalable=no\` in the viewport meta tag`,
        `4. Test by zooming to 200% in the browser — all content should remain readable and functional`,
      ],
      'reflow': [
        `### Fix Instructions`,
        `1. Content must reflow to a single column at 320px viewport width without horizontal scrolling`,
        `2. Use responsive CSS: \`flexbox\`, \`grid\`, \`max-width: 100%\`, relative units`,
        `3. Avoid fixed-width containers — use \`max-width\` instead of \`width\``,
        `4. Exceptions: data tables, toolbars, and content where 2D layout is essential (maps, diagrams)`,
      ],
      'text-spacing': [
        `### Fix Instructions`,
        `1. Ensure no loss of content or functionality when users override text spacing:`,
        `   - Line height to 1.5× font size`,
        `   - Paragraph spacing to 2× font size`,
        `   - Letter spacing to 0.12× font size`,
        `   - Word spacing to 0.16× font size`,
        `2. Don't use fixed-height containers that clip text — use \`min-height\` or \`overflow: visible\``,
        `3. Avoid CSS that counteracts user spacing overrides`,
      ],
      'hover-focus-content': [
        `### Fix Instructions`,
        `1. Additional content shown on hover/focus (tooltips, dropdowns) must be:`,
        `   - **Dismissible**: user can close it (Esc key) without moving hover/focus`,
        `   - **Hoverable**: user can move pointer over the new content without it disappearing`,
        `   - **Persistent**: content remains visible until dismissed, hover/focus removed, or info becomes invalid`,
        `2. Don't use \`title\` attribute for essential information — it's inconsistently exposed`,
      ],
      'focus-order': [
        `### Fix Instructions`,
        `1. Ensure tab order follows a logical reading sequence (typically left-to-right, top-to-bottom)`,
        `2. Don't use positive \`tabindex\` values — they override natural DOM order`,
        `3. For modals: trap focus inside the dialog and return focus to the trigger when closed`,
        `4. For dynamically inserted content: manage focus so users don't lose their place`,
      ],
      'navigation': [
        `### Fix Instructions`,
        `1. Provide multiple ways to locate pages: navigation menu, search, sitemap, table of contents`,
        `2. At minimum, provide both a navigation menu and one other mechanism (search or sitemap)`,
      ],
      'label-in-name': [
        `### Fix Instructions`,
        `1. The accessible name of a control must contain the visible text label`,
        `2. If a button shows "Submit", \`aria-label\` should be "Submit" or "Submit form" — not "Send"`,
        `3. Don't override visible labels with completely different \`aria-label\` values`,
        `4. For controls with icons + visible text: ensure the accessible name starts with or contains the visible text`,
      ],
      'pointer': [
        `### Fix Instructions`,
        `1. Multipoint gestures (pinch, multi-finger swipe) must have single-pointer alternatives`,
        `2. Path-based gestures (drag) must have tap/click alternatives (e.g., increment buttons)`,
        `3. For pointer cancellation: use \`click\` (up-event), not \`mousedown\`/\`pointerdown\` (down-event)`,
        `4. Provide an undo mechanism if the action is triggered on the down-event`,
      ],
      'motion': [
        `### Fix Instructions`,
        `1. Provide UI controls as alternatives to device motion (e.g., shake-to-undo must also have a button)`,
        `2. Allow users to disable motion-triggered responses`,
        `3. Use \`prefers-reduced-motion\` media query to respect user preferences`,
      ],
      'consistency': [
        `### Fix Instructions`,
        `1. Navigation mechanisms (menus, breadcrumbs) must appear in the same relative order on every page`,
        `2. Components with the same function must be identified consistently (same label, icon, alt text)`,
        `3. Help mechanisms (chat, FAQ links, contact info) must appear in the same relative location on every page`,
      ],
      'error-handling': [
        `### Fix Instructions`,
        `1. **Error identification**: when an input error is detected, identify the field and describe the error in text`,
        `2. **Error suggestion**: if a correction is known, suggest it to the user (e.g., "Did you mean @example.com?")`,
        `3. **Error prevention**: for legal/financial/data-loss actions, provide confirmation, review, or undo`,
        `4. Associate error messages with their fields using \`aria-describedby\` or \`aria-errormessage\``,
        `5. Use \`aria-invalid="true"\` on the field and move focus to the first error`,
      ],
      'parsing': [
        `### Fix Instructions`,
        `1. Fix duplicate \`id\` attributes — every \`id\` must be unique within the page`,
        `2. Ensure all elements have complete start and end tags`,
        `3. Nest elements according to their specification (e.g., \`<li>\` only inside \`<ul>/<ol>\`)`,
        `4. Remove duplicate attributes from elements`,
      ],
      'aria-live': [
        `### Fix Instructions`,
        `1. Status messages must be announced by screen readers without receiving focus`,
        `2. Add \`role="status"\` (polite) or \`role="alert"\` (assertive) to the message container`,
        `3. Alternatively use \`aria-live="polite"\` for non-urgent updates, \`aria-live="assertive"\` for critical alerts`,
        `4. Ensure the live region exists in the DOM **before** the content is inserted into it`,
        `5. For loading indicators: use \`role="status"\` with \`aria-label="Loading"\` or equivalent`,
      ],
    };

    // --- Assemble the prompt ---
    const instructions = CATEGORY_INSTRUCTIONS[category] || [
      `### Fix Instructions`,
      `1. Examine the element(s) identified by the selector above`,
      `2. Determine the element's purpose, role, and relationship to surrounding content`,
      `3. Apply the minimal fix that resolves the WCAG requirement`,
      `4. Add appropriate ARIA attributes, semantic HTML, or labels as needed`,
      `5. Ensure the fix doesn't break existing functionality or visual appearance`,
      `6. Test with keyboard navigation (Tab, Enter, Space, Arrow keys)`,
    ];

    const parts = [
      `## Accessibility Fix: ${ruleId}`,
      ``,
      `**Issue:** ${desc}`,
      ``,
      `### Issue Details`,
      contextBlock,
      elementLocationBlock,
      problemBlock,
      enhancedContextBlock,
      htmlBlock,
      techNote,
      wcagBlock,
      solutionsBlock,
      commentsBlock,
      ``,
      ...instructions,
      ``,
      `### Constraints`,
      `- Fix ONLY this specific issue — do not refactor unrelated code`,
      `- Preserve visual appearance and existing component patterns`,
      `- Ensure the fix works across the supported browser matrix`,
      meta.check_manually ? `- **This issue is flagged for manual review** — verify the fix is semantically correct, not just syntactically valid` : '',
    ];

    return parts.filter(Boolean).join('\n');
  },

  batchPromptTemplate: (issues) => {
    if (!issues || issues.length === 0) return '';

    const ruleId = issues[0].rule_id;
    const category = issues[0].category;
    const desc = issues[0].description;
    const meta0 = issues[0].metadata || {};

    // Collect WCAG criteria, solutions, and problem descriptions across all issues
    const allWcag = new Set();
    const allSolutions = [];
    const allProblems = new Set();
    for (const iss of issues) {
      const m = iss.metadata || {};
      if (m.wcag_criteria) m.wcag_criteria.forEach(c => allWcag.add(c));
      if (m.solutions) allSolutions.push(...m.solutions);
      if (m.problem) allProblems.add(m.problem);
    }

    // Deduplicate solutions by title
    const uniqueSolutions = [];
    const seenTitles = new Set();
    for (const s of allSolutions) {
      if (!seenTitles.has(s.title)) {
        seenTitles.add(s.title);
        uniqueSolutions.push(s);
      }
    }

    // Build inventory table with enhanced context and element identification
    const inventoryLines = [
      `| # | AQA ID | Selector | Element | Occurrence | Page/Step | Solution Key |`,
      `|---|--------|----------|---------|------------|-----------|--------------|`,
    ];
    
    issues.forEach((issue, i) => {
      const m = issue.metadata || {};
      const selector = m.selector || issue.rule_id;
      const element = m.tag_name ? `<${m.tag_name}>` : '';
      const aqaId = m.issue_aqa_id || '—';
      const occurrence = (m.selector_total && m.selector_total > 1)
        ? `${m.selector_occurrence}/${m.selector_total}`
        : '—';
      const stepName = m.step_name || m.context_name || m.page_url || '';
      const solKey = m.solution_id || '—';
      
      inventoryLines.push(`| ${i + 1} | \`${aqaId}\` | \`${selector}\` | \`${element}\` | ${occurrence} | ${stepName} | \`${solKey}\` |`);
    });

    // WCAG guidance for the batch
    const wcagLines = [];
    for (const criterion of allWcag) {
      const g = WCAG_GUIDANCE[criterion];
      if (g) wcagLines.push(`- **WCAG ${criterion} — ${g.title}** (Level ${g.level}): ${g.technique}`);
    }

    // Solutions from AQA
    const solLines = uniqueSolutions.map((s, i) => {
      let line = `${i + 1}. **${s.title}**`;
      if (s.description) line += `\n   ${s.description}`;
      return line;
    });

    // Problem description block
    let problemBlock = '';
    if (allProblems.size > 0) {
      const problemLines = Array.from(allProblems).map(p => `> ${p}`);
      problemBlock = `\n### Problem\n${problemLines.join('\n')}`;
    }

    // Category-specific instructions (reuse same map from promptTemplate via reference)
    const BATCH_CATEGORY_INSTRUCTIONS = {
      'structure': `Use semantic HTML elements. Ensure ARIA roles/properties are valid and referenced IDs exist in the DOM.`,
      'image-alt': `Determine each image's purpose (decorative/informative/functional) and set appropriate alt text.`,
      'color-contrast': `Adjust foreground or background colors to meet WCAG AA ratios (4.5:1 normal text, 3:1 large text).`,
      'label': `Associate visible \`<label>\` elements with form controls using \`for\`/\`id\`. Use \`aria-label\` only when visible labels aren't feasible.`,
      'keyboard': `Replace non-semantic click handlers with \`<button>\`/\`<a>\`. Add \`tabindex="0"\`, proper \`role\`, and key event handlers for custom widgets.`,
      'aria-naming': `Ensure all interactive elements have programmatic names via visible labels, \`aria-label\`, or \`aria-labelledby\`.`,
      'focus-visible': `Add visible \`:focus-visible\` styles with at least 3:1 contrast. Never remove outline without an alternative.`,
      'link-name': `Add meaningful text or \`aria-label\` to every link. Avoid generic "Read more" without context.`,
      'error-handling': `Identify errors in text, suggest corrections, associate messages with fields via \`aria-describedby\`.`,
    };

    const categoryNote = BATCH_CATEGORY_INSTRUCTIONS[category]
      ? `\n> **Category guidance (${category}):** ${BATCH_CATEGORY_INSTRUCTIONS[category]}`
      : '';

    const parts = [
      `## Batch Fix: ${issues.length} instances of \`${ruleId}\``,
      ``,
      `**Category:** ${category}`,
      `**Description:** ${desc}`,
      `**Impact:** ${meta0.impact || 'unknown'} | **Severity:** ${issues[0].severity}`,
      meta0.aqa_severity ? `**AQA Severity:** ${meta0.aqa_severity} | **AQA Complexity:** ${meta0.aqa_complexity || 'unknown'}` : '',
      problemBlock,
      wcagLines.length > 0 ? `\n### WCAG Requirements\n${wcagLines.join('\n')}` : '',
      solLines.length > 0 ? `\n### AQA Recommended Fix\n> Apply this guidance consistently to all ${issues.length} instances.\n\n${solLines.join('\n')}` : '',
      categoryNote,
      ``,
      `### Affected Elements`,
      ...inventoryLines,
      ``,
      `### Instructions`,
      `1. Apply the **same fix pattern** consistently to every element listed above`,
      `2. If the fix involves adding attributes (e.g., \`aria-label\`): tailor the value to each element's context, not a generic string`,
      `3. Group changes by file/component where possible for clean diffs`,
      `4. Verify no regressions are introduced across the ${issues.length} locations`,
      ``,
      `### Constraints`,
      `- Fix ONLY these ${issues.length} instances — do not refactor unrelated code`,
      `- Preserve visual appearance and existing component patterns`,
      `- Ensure fixes work across the supported browser matrix`,
    ];

    return parts.filter(Boolean).join('\n');
  },
};
