'use strict';

const { execSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');

// Severity mapping: Apiiro → normalized
const SEVERITY_MAP = {
  'CRITICAL': 'critical',
  'HIGH': 'high',
  'MEDIUM': 'medium',
  'LOW': 'low',
  'INFO': 'info',
  'critical': 'critical',
  'high': 'high',
  'medium': 'medium',
  'low': 'low',
  'info': 'info',
};

/**
 * Categorize an Apiiro risk by its type/ruleId.
 */
function categorize(raw) {
  const type = (raw.type || raw.ruleId || '').toLowerCase();
  if (type.includes('secret') || type.includes('credential') || type.includes('password') || type.includes('api_key')) {
    return 'secret';
  }
  if (type.includes('sca') || type.includes('dependency') || type.includes('cve')) {
    const severity = (raw.severity || '').toLowerCase();
    return severity === 'low' || severity === 'info' ? 'sca_minor' : 'sca_major';
  }
  if (type.includes('injection') || type.includes('sqli')) return 'sast_injection';
  if (type.includes('xss') || type.includes('cross-site')) return 'sast_xss';
  if (type.includes('misconfig') || type.includes('configuration')) return 'misconfiguration';
  if (type.includes('pii') || type.includes('personal')) return 'pii';
  if (type.includes('supply') || type.includes('chain')) return 'supply_chain';
  // Default SAST
  if (type.includes('sast')) return 'sast_injection';
  return 'misconfiguration';
}

/**
 * Hash first/last 4 chars of a detected secret for clustering.
 */
function hashSecretEnds(scannerData) {
  try {
    const data = typeof scannerData === 'string' ? JSON.parse(scannerData) : scannerData;
    const secret = data.secretValue || data.matchedContent || data.snippet || '';
    const trimmed = secret.trim();
    if (trimmed.length < 8) return crypto.createHash('md5').update(trimmed).digest('hex').slice(0, 8);
    const ends = trimmed.slice(0, 4) + trimmed.slice(-4);
    return crypto.createHash('md5').update(ends).digest('hex').slice(0, 8);
  } catch (_) {
    return 'unknown';
  }
}

/**
 * Extract dependency name from scanner data for SCA clustering.
 */
function extractDepName(scannerData) {
  try {
    const data = typeof scannerData === 'string' ? JSON.parse(scannerData) : scannerData;
    return data.dependencyName || data.packageName || data.library || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

/**
 * Get repo name from git remote.
 */
function getRepoName() {
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    // Handle SSH: git@github.com:org/repo.git
    // Handle HTTPS: https://github.com/org/repo.git
    const match = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    return match ? match[1] : url;
  } catch (_) {
    throw new Error('Could not determine repo name from git remote. Are you in a git repository?');
  }
}

module.exports = {
  name: 'apiiro',
  displayName: 'Apiiro Security',

  checkInstalled: async () => {
    try {
      const version = execSync('apiiro --version', { encoding: 'utf8', timeout: 10000 }).trim();
      return { installed: true, message: version };
    } catch (_) {
      return { installed: false, message: 'Apiiro CLI not found. Install from: https://docs.apiiro.com/cli/install' };
    }
  },

  checkAuth: async (creds) => {
    try {
      const cliPath = (creds && creds.cli_path) || 'apiiro';
      execSync(`${cliPath} risks --repo test --output json --limit 0`, {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { authenticated: true, message: 'Authenticated' };
    } catch (err) {
      const msg = (err.stderr || err.message || '').toLowerCase();
      if (msg.includes('auth') || msg.includes('login') || msg.includes('token') || msg.includes('unauthorized')) {
        return { authenticated: false, message: 'Not authenticated. Run: apiiro login' };
      }
      // Could be a repo-not-found error which still means auth is fine
      return { authenticated: true, message: 'Authenticated (test repo not found, but CLI responds)' };
    }
  },

  setupPrompts: () => [
    {
      type: 'input',
      name: 'cli_path',
      message: 'Apiiro CLI path (leave blank for default):',
      default: 'apiiro',
    },
  ],

  fetch: async (config) => {
    const repoName = getRepoName();
    const cliPath = (config && config.cli_path) || 'apiiro';

    try {
      const output = execSync(`${cliPath} risks --repo ${repoName} --output json`, {
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 50 * 1024 * 1024,
      });
      const parsed = JSON.parse(output);
      // Handle both array and object-with-array responses
      return Array.isArray(parsed) ? parsed : (parsed.risks || parsed.issues || parsed.results || []);
    } catch (err) {
      throw new Error(`Apiiro fetch failed: ${err.message}`);
    }
  },

  normalize: (raw) => {
    const category = categorize(raw);
    const severity = SEVERITY_MAP[raw.severity] || SEVERITY_MAP[(raw.severity || '').toUpperCase()] || 'medium';

    return {
      id: `apiiro-${raw.id || crypto.createHash('md5').update(JSON.stringify(raw)).digest('hex').slice(0, 12)}`,
      source: 'apiiro',
      rule_id: raw.ruleId || raw.type || raw.category || 'unknown',
      severity,
      category,
      status: 'open',
      file_path: raw.filePath || raw.file_path || null,
      line_number: raw.lineNumber || raw.line_number || raw.line || null,
      description: raw.description || raw.title || raw.message || 'No description',
      scanner_data: JSON.stringify(raw),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  },

  clusterKeys: (issue) => {
    const category = issue.category;

    if (category === 'secret') {
      const hash = hashSecretEnds(issue.scanner_data);
      return [`${issue.rule_id}:secret:${hash}`];
    }

    if (category === 'sca_minor' || category === 'sca_major') {
      const dep = extractDepName(issue.scanner_data);
      return [`${issue.rule_id}:dep:${dep}`];
    }

    // SAST and others: group by rule + directory
    const dir = issue.file_path ? path.dirname(issue.file_path) : 'unknown';
    return [`${issue.rule_id}:${dir}`];
  },

  effortEstimate: (issue) => {
    // Load effort map and look up by category
    try {
      const { loadEffortMap } = require('@autofix-hub/core/src/config');
      const effortMap = loadEffortMap();
      const sourceMap = effortMap.apiiro || {};
      return sourceMap[issue.category] || sourceMap.__default__ || { level: 'medium', minutes: 15 };
    } catch (_) {
      // Fallback defaults
      const defaults = {
        secret: { level: 'small', minutes: 5 },
        sca_minor: { level: 'small', minutes: 5 },
        sca_major: { level: 'large', minutes: 30 },
        sast_injection: { level: 'medium', minutes: 15 },
        sast_xss: { level: 'medium', minutes: 15 },
        misconfiguration: { level: 'medium', minutes: 15 },
        pii: { level: 'medium', minutes: 15 },
      };
      return defaults[issue.category] || { level: 'medium', minutes: 15 };
    }
  },

  reviewLevel: (issue) => {
    const category = issue.category;
    // Secrets, injection, IAM-related → always security_review
    if (category === 'secret' || category === 'sast_injection' || category === 'pii' || category === 'supply_chain') {
      return 'security_review';
    }
    // SCA minor bumps → careful
    if (category === 'sca_minor') {
      return 'careful';
    }
    // Everything else (sca_major, sast_xss, misconfiguration) → security_review
    return 'security_review';
  },

  scoringFactors: (issue) => {
    let blastRadius = 1;
    let pathCriticality = 3; // default
    let isSecret = issue.category === 'secret';

    // Attempt to compute blast radius by counting files importing this file
    if (issue.file_path) {
      try {
        const result = execSync(
          `git grep -l "${path.basename(issue.file_path, path.extname(issue.file_path))}" -- "*.js" "*.ts" "*.jsx" "*.tsx" 2>/dev/null | wc -l`,
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
      } catch (_) {
        // Use default
      }
    }

    const blastRadiusLog = Math.log2(blastRadius + 1);
    return blastRadiusLog * pathCriticality * (isSecret ? 10 : 1);
  },

  promptTemplate: (issue) => {
    const category = issue.category;
    const filePath = issue.file_path || 'unknown file';
    const line = issue.line_number ? ` (line ${issue.line_number})` : '';
    const desc = issue.description;

    let template = '';

    switch (category) {
      case 'secret':
        template = [
          `## Fix Secret Exposure`,
          ``,
          `**File:** ${filePath}${line}`,
          `**Issue:** ${desc}`,
          ``,
          `### Instructions:`,
          `1. Remove the hardcoded secret/credential from the source code`,
          `2. Replace it with an environment variable reference (e.g., \`process.env.SECRET_NAME\`)`,
          `3. Add the variable name to \`.env.example\` with a placeholder value`,
          `4. Ensure the secret is not committed anywhere in git history`,
          `5. Note: the actual secret needs to be rotated — this fix only removes it from code`,
          ``,
          `**Important:** Fix only this issue. Do not touch unrelated code. Follow existing patterns.`,
        ].join('\n');
        break;

      case 'sca_minor':
      case 'sca_major':
        template = [
          `## Fix Dependency Vulnerability`,
          ``,
          `**File:** ${filePath}${line}`,
          `**Issue:** ${desc}`,
          ``,
          `### Instructions:`,
          `1. Bump the vulnerable dependency to the patched version`,
          `2. Check the dependency's changelog for breaking changes`,
          `3. If a major version bump: review migration guide and update usage accordingly`,
          `4. Run tests to verify no regressions`,
          ``,
          `**Important:** Fix only this issue. Do not touch unrelated code. Follow existing patterns.`,
        ].join('\n');
        break;

      case 'sast_injection':
        template = [
          `## Fix Injection Vulnerability`,
          ``,
          `**File:** ${filePath}${line}`,
          `**Issue:** ${desc}`,
          ``,
          `### Instructions:`,
          `1. Use parameterized queries instead of string concatenation for SQL/NoSQL`,
          `2. Apply proper input sanitization and validation`,
          `3. Use prepared statements or ORM methods`,
          `4. Do not bypass security controls — fix the root cause`,
          ``,
          `**Important:** Fix only this issue. Do not touch unrelated code. Follow existing patterns.`,
        ].join('\n');
        break;

      case 'sast_xss':
        template = [
          `## Fix Cross-Site Scripting (XSS)`,
          ``,
          `**File:** ${filePath}${line}`,
          `**Issue:** ${desc}`,
          ``,
          `### Instructions:`,
          `1. Apply proper output encoding/escaping for the context (HTML, JS, URL, CSS)`,
          `2. Use framework-provided sanitization (e.g., React auto-escapes JSX)`,
          `3. Avoid \`dangerouslySetInnerHTML\`, \`innerHTML\`, or \`eval()\` with user input`,
          `4. Validate and sanitize input at the boundary`,
          ``,
          `**Important:** Fix only this issue. Do not touch unrelated code. Follow existing patterns.`,
        ].join('\n');
        break;

      case 'misconfiguration':
        template = [
          `## Fix Security Misconfiguration`,
          ``,
          `**File:** ${filePath}${line}`,
          `**Issue:** ${desc}`,
          ``,
          `### Instructions:`,
          `1. Fix the insecure default or misconfigured setting`,
          `2. Apply secure defaults (e.g., enable HTTPS, disable debug mode, set secure headers)`,
          `3. Follow security best practices for the framework/platform in use`,
          ``,
          `**Important:** Fix only this issue. Do not touch unrelated code. Follow existing patterns.`,
        ].join('\n');
        break;

      case 'pii':
        template = [
          `## Fix PII Exposure`,
          ``,
          `**File:** ${filePath}${line}`,
          `**Issue:** ${desc}`,
          ``,
          `### Instructions:`,
          `1. Remove or mask personally identifiable information from logs, responses, or storage`,
          `2. Use encryption or hashing where PII must be stored`,
          `3. Ensure PII is not exposed in error messages or API responses`,
          ``,
          `**Important:** Fix only this issue. Do not touch unrelated code. Follow existing patterns.`,
        ].join('\n');
        break;

      default:
        template = [
          `## Fix Security Issue`,
          ``,
          `**File:** ${filePath}${line}`,
          `**Issue:** ${desc}`,
          ``,
          `### Instructions:`,
          `1. Analyze the reported security issue`,
          `2. Apply the minimal fix that addresses the vulnerability`,
          `3. Follow security best practices for the language/framework`,
          ``,
          `**Important:** Fix only this issue. Do not touch unrelated code. Follow existing patterns.`,
        ].join('\n');
    }

    return template;
  },

  batchPromptTemplate: (issues) => {
    if (!issues || issues.length === 0) return '';

    const category = issues[0].category;
    const ruleId = issues[0].rule_id;
    const locations = issues.map(i => {
      const loc = i.file_path || 'unknown';
      return i.line_number ? `- ${loc}:${i.line_number}` : `- ${loc}`;
    }).join('\n');

    return [
      `## Batch Fix: ${issues.length} instances of ${ruleId}`,
      ``,
      `**Category:** ${category}`,
      `**Description:** ${issues[0].description}`,
      ``,
      `### Affected locations:`,
      locations,
      ``,
      `### Instructions:`,
      `Fix all ${issues.length} instances of this issue across the listed files.`,
      `Apply the same fix pattern consistently to each location.`,
      ``,
      `**Important:** Fix only these issues. Do not touch unrelated code. Follow existing patterns.`,
    ].join('\n');
  },
};
