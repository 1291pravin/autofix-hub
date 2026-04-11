'use strict';

const { execSync } = require('child_process');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const url = require('url');
const path = require('path');

// SonarQube severity → normalized severity
const SEVERITY_MAP = {
  'BLOCKER': 'critical',
  'CRITICAL': 'high',
  'MAJOR': 'medium',
  'MINOR': 'low',
  'INFO': 'info',
};

// SonarQube type → normalized category
const CATEGORY_MAP = {
  'BUG': 'bug',
  'VULNERABILITY': 'vulnerability',
  'SECURITY_HOTSPOT': 'security_hotspot',
  'CODE_SMELL': 'code_smell',
};

/**
 * Make an HTTP(S) request to the SonarQube API.
 */
function apiRequest(serverUrl, apiPath, token) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${serverUrl.replace(/\/$/, '')}${apiPath}`;
    const parsed = new url.URL(fullUrl);
    const mod = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    };

    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`SonarQube API error ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`SonarQube API returned invalid JSON: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('SonarQube API request timed out'));
    });
    req.end();
  });
}

/**
 * Fetch all pages of issues from SonarQube.
 */
async function fetchAllIssues(serverUrl, token, projectKey) {
  const allIssues = [];
  let page = 1;
  const pageSize = 500;

  while (true) {
    const params = new URLSearchParams({
      componentKeys: projectKey,
      statuses: 'OPEN',
      ps: String(pageSize),
      p: String(page),
    });

    const result = await apiRequest(
      serverUrl,
      `/api/issues/search?${params.toString()}`,
      token
    );

    const issues = result.issues || [];
    allIssues.push(...issues);

    const total = result.paging ? result.paging.total : result.total || 0;
    if (allIssues.length >= total || issues.length < pageSize) {
      break;
    }
    page++;
  }

  return allIssues;
}

/**
 * Extract file path from SonarQube component key.
 * Component key format: "projectKey:src/main/java/Foo.java"
 */
function extractFilePath(component) {
  if (!component) return null;
  const parts = component.split(':');
  return parts.length > 1 ? parts.slice(1).join(':') : component;
}

/**
 * Build effort map key from type and severity.
 */
function effortMapKey(type, severity) {
  const cat = CATEGORY_MAP[type] || 'code_smell';
  return `${cat}_${severity}`;
}

module.exports = {
  name: 'sonarqube',
  displayName: 'SonarQube',

  checkInstalled: async () => {
    try {
      const version = execSync('sonar-scanner --version', {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return { installed: true, message: version.split('\n')[0] };
    } catch (_) {
      return { installed: false, message: 'sonar-scanner CLI not found. API-only mode still available.' };
    }
  },

  checkAuth: async (creds) => {
    if (!creds || !creds.server_url || !creds.token) {
      return { authenticated: false, message: 'SonarQube server URL and token required. Run setup.' };
    }
    try {
      const result = await apiRequest(creds.server_url, '/api/system/status', creds.token);
      if (result.status === 'UP') {
        return { authenticated: true, message: `Connected to SonarQube (${result.version || 'unknown version'})` };
      }
      return { authenticated: false, message: `SonarQube status: ${result.status}` };
    } catch (err) {
      return { authenticated: false, message: `Connection failed: ${err.message}` };
    }
  },

  setupPrompts: () => [
    {
      type: 'input',
      name: 'server_url',
      message: 'SonarQube server URL (e.g., https://sonarqube.example.com):',
      validate: (v) => {
        if (!v.trim()) return 'Server URL is required';
        try { new url.URL(v); return true; } catch (_) { return 'Invalid URL'; }
      },
    },
    {
      type: 'input',
      name: 'token',
      message: 'SonarQube authentication token:',
      validate: (v) => v.trim() ? true : 'Token is required',
    },
    {
      type: 'input',
      name: 'project_key',
      message: 'SonarQube project key (or set SONARQUBE_PROJECT_KEY in .env):',
      default: '',
    },
  ],

  fetch: async (config) => {
    if (!config || !config.server_url || !config.token) {
      throw new Error('SonarQube credentials not configured. Run autofix-hub setup.');
    }

    const projectKey = config.project_key;
    if (!projectKey) {
      throw new Error('SonarQube project key not configured. Configure it in Settings.');
    }

    return await fetchAllIssues(config.server_url, config.token, projectKey);
  },

  normalize: (raw) => {
    const severity = SEVERITY_MAP[raw.severity] || 'medium';
    const category = CATEGORY_MAP[raw.type] || 'code_smell';
    const filePath = extractFilePath(raw.component);

    // Build metadata
    const metadata = {
      rule: raw.rule || null,
      tags: raw.tags || [],
      effort: raw.effort || raw.debt || null,
      flows: raw.flows || [],
      message: raw.message || null,
      type: raw.type || null,
      sonar_severity: raw.severity || null,
      project: raw.project || null,
      status: raw.status || null,
      resolution: raw.resolution || null,
      author: raw.author || null,
      creation_date: raw.creationDate || null,
    };

    return {
      id: `sonarqube-${raw.key}`,
      source: 'sonarqube',
      rule_id: raw.rule || 'unknown',
      severity,
      category,
      status: 'open',
      file_path: filePath,
      line_number: raw.line || raw.textRange?.startLine || null,
      description: raw.message || `SonarQube ${raw.type}: ${raw.rule}`,
      scanner_data: JSON.stringify(raw),
      metadata,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  },

  clusterKeys: (issue) => {
    const ruleId = issue.rule_id;
    const dir = issue.file_path ? path.dirname(issue.file_path) : 'unknown';
    const category = issue.category;

    return [
      `${ruleId}:dir:${dir}`,
      `${ruleId}:cat:${category}`,
    ];
  },

  effortEstimate: (issue) => {
    // Combine SonarQube's own effort estimate with effort-map config
    let sonarMinutes = 0;
    try {
      const data = typeof issue.scanner_data === 'string' ? JSON.parse(issue.scanner_data) : issue.scanner_data;
      const effort = data.effort || data.debt || '';
      // Parse SonarQube effort string like "30min", "2h", "1d"
      const match = effort.match(/(\d+)(min|h|d)/);
      if (match) {
        const val = parseInt(match[1], 10);
        if (match[2] === 'min') sonarMinutes = val;
        else if (match[2] === 'h') sonarMinutes = val * 60;
        else if (match[2] === 'd') sonarMinutes = val * 480;
      }
    } catch (_) {}

    try {
      const { loadEffortMap } = require('@autofix-hub/core/src/config');
      const effortMap = loadEffortMap();
      const sourceMap = effortMap.sonarqube || {};

      // Try type_SEVERITY key first (e.g., bug_BLOCKER)
      let sonarSeverity = 'MEDIUM';
      let sonarType = 'code_smell';
      try {
        const data = typeof issue.scanner_data === 'string' ? JSON.parse(issue.scanner_data) : issue.scanner_data;
        sonarSeverity = data.severity || 'MEDIUM';
        sonarType = CATEGORY_MAP[data.type] || 'code_smell';
      } catch (_) {}

      const key = `${sonarType}_${sonarSeverity}`;
      const mapped = sourceMap[key] || sourceMap.__default__ || { level: 'medium', minutes: 15 };

      // Use the larger of SonarQube's estimate vs our map
      if (sonarMinutes > mapped.minutes) {
        return { level: mapped.level, minutes: sonarMinutes };
      }
      return mapped;
    } catch (_) {
      return { level: 'medium', minutes: sonarMinutes || 15 };
    }
  },

  reviewLevel: (issue) => {
    const category = issue.category;
    const severity = issue.severity;

    // Vulnerabilities and security hotspots → always security_review
    if (category === 'vulnerability' || category === 'security_hotspot') {
      return 'security_review';
    }

    // BLOCKER/CRITICAL bugs → security_review
    if (category === 'bug' && (severity === 'critical' || severity === 'high')) {
      return 'security_review';
    }

    // INFO code smells → quick
    if (category === 'code_smell' && severity === 'info') {
      return 'quick';
    }

    // MINOR/MAJOR code smells, MINOR bugs → careful
    return 'careful';
  },

  scoringFactors: (issue) => {
    let blastRadius = 1;
    let pathCriticality = 3;
    let typeWeight = 3;

    // Blast radius: count files importing this file
    if (issue.file_path) {
      try {
        const basename = path.basename(issue.file_path, path.extname(issue.file_path));
        const result = execSync(
          `git grep -l "${basename}" -- "*.js" "*.ts" "*.jsx" "*.tsx" "*.java" "*.py" "*.go" 2>/dev/null | wc -l`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();
        blastRadius = Math.max(1, parseInt(result, 10) || 1);
      } catch (_) {
        blastRadius = 1;
      }

      // Path criticality matching
      try {
        const { loadScoringConfig } = require('@autofix-hub/core/src/config');
        const config = loadScoringConfig();
        const patterns = config.path_criticality || {};
        for (const [pattern, weight] of Object.entries(patterns)) {
          if (pattern === '__default__') continue;
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\//g, '\\/'));
          if (regex.test(issue.file_path)) {
            pathCriticality = weight;
            break;
          }
        }
      } catch (_) {}
    }

    // Type weight from scoring config
    try {
      const { loadScoringConfig } = require('@autofix-hub/core/src/config');
      const config = loadScoringConfig();
      typeWeight = (config.type_weights || {})[issue.category] || 3;
    } catch (_) {}

    const blastRadiusLog = Math.log2(blastRadius + 1);
    return blastRadiusLog * pathCriticality * typeWeight;
  },

  promptTemplate: (issue) => {
    const category = issue.category;
    const filePath = issue.file_path || 'unknown file';
    const desc = issue.description;
    const ruleId = issue.rule_id;

    // Extract rich context from scanner_data
    let sonarMessage = '';
    let tags = '';
    let textRange = null;
    let flows = [];
    let effort = '';
    let cleanCodeAttr = '';
    let cleanCodeCategory = '';
    let impacts = [];
    let quickFixAvailable = false;
    let scope = '';
    try {
      const data = typeof issue.scanner_data === 'string' ? JSON.parse(issue.scanner_data) : issue.scanner_data;
      sonarMessage = data.message || '';
      tags = (data.tags || []).join(', ');
      textRange = data.textRange || null;
      flows = data.flows || [];
      effort = data.effort || data.debt || '';
      cleanCodeAttr = data.cleanCodeAttribute || '';
      cleanCodeCategory = data.cleanCodeAttributeCategory || '';
      impacts = data.impacts || [];
      quickFixAvailable = data.quickFixAvailable || false;
      scope = data.scope || '';
    } catch (_) {}

    // Build location string with full range
    let locationStr = `**File:** ${filePath}`;
    if (textRange && textRange.startLine) {
      if (textRange.endLine && textRange.endLine !== textRange.startLine) {
        locationStr += ` (lines ${textRange.startLine}–${textRange.endLine})`;
      } else {
        locationStr += ` (line ${textRange.startLine})`;
      }
    } else if (issue.line_number) {
      locationStr += ` (line ${issue.line_number})`;
    }

    // Build rule link for standard RSPEC rules (lang:S1234 format)
    const ruleMatch = ruleId ? ruleId.match(/^([^:]+):S(\d+)$/) : null;
    const ruleLink = ruleMatch ? `https://rules.sonarsource.com/${ruleMatch[1]}/RSPEC-${ruleMatch[2]}` : '';

    // Build flows/secondary locations string
    let flowsStr = '';
    if (flows.length > 0) {
      const flowLines = [];
      for (const flow of flows) {
        const locations = flow.locations || [];
        for (const loc of locations) {
          const locFile = extractFilePath(loc.component) || filePath;
          const locRange = loc.textRange;
          const locMsg = loc.msg || '';
          if (locRange) {
            const lineRef = locRange.startLine === locRange.endLine
              ? `line ${locRange.startLine}`
              : `lines ${locRange.startLine}–${locRange.endLine}`;
            flowLines.push(`  - \`${locFile}\` ${lineRef}: ${locMsg}`);
          } else if (locMsg) {
            flowLines.push(`  - ${locMsg}`);
          }
        }
      }
      if (flowLines.length > 0) {
        flowsStr = `**Related locations:**\n${flowLines.join('\n')}`;
      }
    }

    // Build impacts string
    let impactsStr = '';
    if (impacts.length > 0) {
      impactsStr = impacts.map(i => `${i.softwareQuality} (${i.severity})`).join(', ');
    }

    // Build clean code attribute string
    let cleanCodeStr = '';
    if (cleanCodeAttr) {
      cleanCodeStr = cleanCodeCategory
        ? `${cleanCodeAttr} (${cleanCodeCategory})`
        : cleanCodeAttr;
    }

    const context = [
      locationStr,
      `**Rule:** ${ruleId}` + (ruleLink ? ` — [rule docs](${ruleLink})` : ''),
      `**Severity:** ${issue.severity}` + (impactsStr ? ` | **Impact:** ${impactsStr}` : ''),
      tags ? `**Tags:** ${tags}` : '',
      cleanCodeStr ? `**Clean Code:** ${cleanCodeStr}` : '',
      effort ? `**Estimated effort:** ${effort}` : '',
      scope === 'TEST' ? `**Scope:** Test code` : '',
      sonarMessage && sonarMessage !== desc ? `**Detail:** ${sonarMessage}` : '',
      flowsStr,
      quickFixAvailable ? `**Note:** SonarQube indicates a quick fix is available for this pattern.` : '',
    ].filter(Boolean).join('\n');

    let template = '';

    switch (category) {
      case 'bug':
        template = [
          `## Fix Bug`,
          ``,
          `**Issue:** ${desc}`,
          context,
          ``,
          `### Instructions:`,
          `1. Read the affected file and the related locations listed above to understand the full context`,
          `2. Analyze the reported bug and identify the root cause`,
          `3. Fix the logic error with a minimal, targeted change`,
          `4. Add null checks or boundary checks if the bug is caused by missing guards`,
          `5. Ensure the fix handles edge cases without altering unrelated behavior`,
          ``,
          `**Important:** Minimal change, follow existing code style. Fix only this issue.`,
        ].join('\n');
        break;

      case 'vulnerability':
        template = [
          `## Fix Security Vulnerability`,
          ``,
          `**Issue:** ${desc}`,
          context,
          ``,
          `### Instructions:`,
          `1. Read the affected file and any related locations listed above`,
          `2. Identify the vulnerability type (OWASP category) and attack vector`,
          `3. Apply the standard remediation for this vulnerability class`,
          `4. Use parameterized queries for injection, output encoding for XSS, etc.`,
          `5. Do not introduce new security controls — fix the existing vulnerability`,
          `6. Verify the fix does not break existing functionality`,
          ``,
          `**Important:** Minimal change, follow existing code style. Fix only this issue.`,
        ].join('\n');
        break;

      case 'security_hotspot':
        template = [
          `## Review Security Hotspot`,
          ``,
          `**Issue:** ${desc}`,
          context,
          ``,
          `### Instructions:`,
          `1. Read the affected file and any related locations listed above`,
          `2. Review the flagged code for security implications`,
          `3. If the current pattern is insecure: replace with the secure alternative`,
          `4. If the current pattern is intentional and safe: add a comment explaining why`,
          `5. Follow security best practices for the framework in use`,
          ``,
          `**Important:** Minimal change, follow existing code style. Fix only this issue.`,
        ].join('\n');
        break;

      case 'code_smell':
        template = [
          `## Fix Code Smell`,
          ``,
          `**Issue:** ${desc}`,
          context,
          ``,
          `### Instructions:`,
          `1. Read the affected file at the specified location`,
          `2. Understand the SonarQube rule requirement and why this code triggers it`,
          `3. Apply the minimal refactoring that resolves the issue`,
          `4. Maintain existing behavior — this is a quality fix, not a feature change`,
          `5. Follow the project's existing patterns and conventions`,
          ``,
          `**Important:** Minimal change, follow existing code style. Fix only this issue.`,
        ].join('\n');
        break;

      default:
        template = [
          `## Fix SonarQube Issue`,
          ``,
          `**Issue:** ${desc}`,
          context,
          ``,
          `### Instructions:`,
          `1. Read the affected file and any related locations listed above`,
          `2. Analyze the reported issue and understand the root cause`,
          `3. Apply the minimal fix that resolves it`,
          `4. Follow existing code style and patterns`,
          ``,
          `**Important:** Minimal change, follow existing code style. Fix only this issue.`,
        ].join('\n');
    }

    return template;
  },

  batchPromptTemplate: (issues) => {
    if (!issues || issues.length === 0) return '';

    const ruleId = issues[0].rule_id;
    const category = issues[0].category;

    // Build rule link for standard RSPEC rules (lang:S1234 format)
    const ruleMatch = ruleId ? ruleId.match(/^([^:]+):S(\d+)$/) : null;
    const ruleLink = ruleMatch ? `https://rules.sonarsource.com/${ruleMatch[1]}/RSPEC-${ruleMatch[2]}` : '';

    // Extract tags from first issue for context
    let tags = '';
    try {
      const data = typeof issues[0].scanner_data === 'string' ? JSON.parse(issues[0].scanner_data) : issues[0].scanner_data;
      tags = (data.tags || []).join(', ');
    } catch (_) {}

    // Build detailed per-issue locations with individual descriptions
    const locationDetails = issues.map((i) => {
      const loc = i.file_path || 'unknown';
      let entry = '';

      // Extract textRange and flows for richer context
      let rangeStr = '';
      let flowNotes = [];
      try {
        const data = typeof i.scanner_data === 'string' ? JSON.parse(i.scanner_data) : i.scanner_data;
        const tr = data.textRange;
        if (tr && tr.startLine) {
          rangeStr = tr.endLine && tr.endLine !== tr.startLine
            ? `lines ${tr.startLine}–${tr.endLine}`
            : `line ${tr.startLine}`;
        }
        for (const flow of (data.flows || [])) {
          for (const floc of (flow.locations || [])) {
            if (floc.msg) {
              const fFile = extractFilePath(floc.component) || loc;
              const fRange = floc.textRange;
              const fLine = fRange ? `line ${fRange.startLine}` : '';
              flowNotes.push(`${fFile}${fLine ? ':' + fLine : ''} — ${floc.msg}`);
            }
          }
        }
      } catch (_) {}

      const lineRef = rangeStr || (i.line_number ? `line ${i.line_number}` : '');
      entry = `- \`${loc}\`${lineRef ? ' ' + lineRef : ''}`;
      if (i.description !== issues[0].description) {
        entry += `: ${i.description}`;
      }
      if (flowNotes.length > 0) {
        entry += '\n' + flowNotes.map(n => `    - Related: ${n}`).join('\n');
      }
      return entry;
    }).join('\n');

    return [
      `## Batch Fix: ${issues.length} instances of ${ruleId}`,
      ``,
      `**Category:** ${category}`,
      `**Description:** ${issues[0].description}`,
      ruleLink ? `**Rule docs:** [${ruleId}](${ruleLink})` : '',
      tags ? `**Tags:** ${tags}` : '',
      ``,
      `### Affected locations:`,
      locationDetails,
      ``,
      `### Instructions:`,
      `1. Read each affected file at the specified locations`,
      `2. Understand the rule requirement: why this pattern is flagged`,
      `3. Fix all ${issues.length} instances applying the same fix pattern consistently`,
      `4. Verify each fix individually — locations may have slightly different contexts`,
      ``,
      `**Important:** Minimal change, follow existing code style. Fix only these issues.`,
    ].filter(Boolean).join('\n');
  },
};
