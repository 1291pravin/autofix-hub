'use strict';

const { execSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const TLS_ENV = { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' };

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
  // Use actual Apiiro API fields: riskCategory, ruleName, findingCategory, findingName
  const riskCategory = (raw.riskCategory || '').toLowerCase();
  const ruleName = (raw.ruleName || '').toLowerCase();
  const findingCategory = (raw.findingCategory || '').toLowerCase();
  const findingName = (raw.findingName || '').toLowerCase();
  const combined = `${riskCategory} ${ruleName} ${findingCategory} ${findingName}`;

  // Also support legacy fields for backwards compatibility
  const legacyType = (raw.type || raw.ruleId || '').toLowerCase();
  const all = `${combined} ${legacyType}`;

  if (all.includes('secret') || all.includes('credential') || all.includes('password') || all.includes('api_key')) {
    return 'secret';
  }
  if (all.includes('vulnerab') || all.includes('sca') || all.includes('dependency') || all.includes('cve') || riskCategory === 'vulnerability') {
    const severity = (raw.riskLevel || raw.severity || '').toLowerCase();
    return severity === 'low' || severity === 'info' ? 'sca_minor' : 'sca_major';
  }
  if (all.includes('license') || riskCategory === 'oss licenses') {
    return 'license';
  }
  if (all.includes('injection') || all.includes('sqli')) return 'sast_injection';
  if (all.includes('xss') || all.includes('cross-site')) return 'sast_xss';
  if (all.includes('pii') || all.includes('personal')) return 'pii';
  if (all.includes('supply chain') || all.includes('supply_chain') || (all.includes('supply') && all.includes('chain'))) return 'supply_chain';
  if (all.includes('sast')) return 'sast_generic';
  if (all.includes('misconfig') || all.includes('configuration')) return 'misconfiguration';
  return 'other';
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
 * Extract comprehensive dependency information from scanner data for SCA clustering and analysis.
 * Understands Apiiro's actual JSON structure: component field ("pkg: version"), findingTags for CVE/advisory data.
 */
function extractDepInfo(scannerData) {
  try {
    const data = typeof scannerData === 'string' ? JSON.parse(scannerData) : scannerData;

    // Apiiro stores package info in "component" as "name: version"
    let name = 'unknown';
    let currentVersion = '';
    const component = data.component || '';
    if (component && component.includes(':')) {
      const parts = component.split(':');
      name = parts[0].trim();
      currentVersion = parts.slice(1).join(':').trim();
    } else if (component) {
      name = component;
    }

    // Fallback to legacy fields
    if (name === 'unknown') {
      name = data.dependencyName || data.packageName || data.library || data.module || 'unknown';
    }
    if (!currentVersion) {
      currentVersion = data.currentVersion || data.installedVersion || data.version || '';
    }

    // Extract CVE, advisory URLs, vuln title, exploitability from findingTags
    const findingTags = data.findingTags || [];
    let cves = [];
    let advisoryUrls = [];
    let vulnTitle = '';
    let exploitabilityScore = '';
    let recommendedVersion = '';
    let dependencyScope = '';

    for (const tag of findingTags) {
      const tagName = (tag.name || '').toLowerCase();
      const tagValue = tag.value || '';

      if (tagName === 'references') {
        try {
          const refs = JSON.parse(tagValue);
          for (const ref of refs) {
            if (ref.Url) {
              advisoryUrls.push(ref.Url);
              // Extract CVE from URL if present
              const cveMatch = ref.Url.match(/CVE-\d{4}-\d+/i);
              if (cveMatch && !cves.includes(cveMatch[0])) cves.push(cveMatch[0]);
            }
          }
        } catch (_) {}
      } else if (tagName === 'title') {
        vulnTitle = tagValue;
      } else if (tagName === 'exploitabilityscore') {
        exploitabilityScore = tagValue;
      } else if (tagName === 'packageversion') {
        if (!currentVersion) currentVersion = tagValue;
      } else if (tagName === 'dependencyscope') {
        dependencyScope = tagValue;
      } else if (tagName === 'fixedversion' || tagName === 'recommendedversion') {
        recommendedVersion = tagValue;
      }
    }

    // Also check direct CVE fields
    if (cves.length === 0) {
      const directCve = data.cve || data.cveId || (data.cves && data.cves[0]) || '';
      if (directCve) cves.push(directCve);
    }

    // Fallback for recommended version
    if (!recommendedVersion) {
      recommendedVersion = data.recommendedVersion || data.fixedVersion || data.patchedVersion || data.safeVersion || '';
    }

    // Deduplicate advisory URLs
    advisoryUrls = [...new Set(advisoryUrls)];

    return {
      name,
      currentVersion,
      recommendedVersion,
      ecosystem: data.ecosystem || data.packageManager || data.language || '',
      cves,
      cve: cves[0] || '',
      severity: data.riskLevel || data.severity || '',
      vulnerabilityName: vulnTitle || data.vulnerabilityName || data.title || '',
      exploitabilityScore,
      advisoryUrls,
      dependencyScope,
    };
  } catch (_) {
    return {
      name: 'unknown',
      currentVersion: '',
      recommendedVersion: '',
      ecosystem: '',
      cves: [],
      cve: '',
      severity: '',
      vulnerabilityName: '',
      exploitabilityScore: '',
      advisoryUrls: [],
      dependencyScope: '',
    };
  }
}

/**
 * Extract rich context from Apiiro's scanner_data JSON.
 * Pulls insights, actionsTaken, policyTags, component, and business context.
 */
function extractApiiroContext(scannerData) {
  try {
    const data = typeof scannerData === 'string' ? JSON.parse(scannerData) : scannerData;

    // Insights (e.g., "Dev dependency", "Used in code", "Has vulnerabilities")
    const insights = (data.insights || []).map(i => {
      const sentiment = i.sentiment === 'Negative' ? '[!]' : i.sentiment === 'Positive' ? '[+]' : '[-]';
      return `${sentiment} ${i.name}: ${i.reason}`;
    });

    // Actions already taken by humans
    const actionsTaken = (data.actionsTaken || []).map(a => {
      const by = a.takenBy || 'unknown';
      const date = a.dateTaken ? a.dateTaken.split('T')[0] : '';
      return `${a.actionType || 'Action'} by ${by}${date ? ` (${date})` : ''}: ${a.comment || ''}`;
    }).filter(a => a.includes(':'));

    // Policy tags (e.g., "Compliance Review", "Security Code Review")
    const policyTags = data.policyTags || [];

    // Component (package:version)
    const component = data.component || '';

    // License info from findingName
    const findingName = data.findingName || '';
    const licenseName = findingName.match(/with (.+) license/i)?.[1] || '';

    // Business context
    const apps = (data.applications || []).map(a => a.name).filter(Boolean);
    const appGroups = (data.applicationGroups || []).map(a => a.name).filter(Boolean);
    const businessImpact = data.entity?.details?.businessImpact || '';

    // Source code URL
    const sourceUrl = data.sourceCode?.url || '';

    // Risk URL for human reference
    const apiiroRiskUrl = data.apiiroRiskUrl || '';

    return {
      insights,
      actionsTaken,
      policyTags,
      component,
      findingName,
      licenseName,
      apps,
      appGroups,
      businessImpact,
      sourceUrl,
      apiiroRiskUrl,
    };
  } catch (_) {
    return {
      insights: [],
      actionsTaken: [],
      policyTags: [],
      component: '',
      findingName: '',
      licenseName: '',
      apps: [],
      appGroups: [],
      businessImpact: '',
      sourceUrl: '',
      apiiroRiskUrl: '',
    };
  }
}

/**
 * Extract dependency name from scanner data for SCA clustering.
 */
function extractDepName(scannerData) {
  const depInfo = extractDepInfo(scannerData);
  return depInfo.name;
}

/**
 * Get repo name from environment variable or git remote.
 */
function getRepoName() {
  // First try environment variable
  const envRepoName = process.env.APIIRO_REPO_NAME;
  if (envRepoName && envRepoName.trim()) {
    return envRepoName.trim();
  }
  
  // Fallback to git remote
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    // Handle SSH: git@github.com:org/repo.git
    // Handle HTTPS: https://github.com/org/repo.git
    const match = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    return match ? match[1] : url;
  } catch (_) {
    throw new Error('Could not determine repo name. Set APIIRO_REPO_NAME environment variable or ensure you are in a git repository.');
  }
}

module.exports = {
  name: 'apiiro',
  displayName: 'Apiiro Security',

  checkInstalled: async () => {
    try {
      const version = execSync('apiiro --version', { encoding: 'utf8', timeout: 10000, env: TLS_ENV }).trim();
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
        env: TLS_ENV,
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
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    try {
      console.log(`Running: ${cliPath} risks --repo ${repoName} --output json`);
      
      // Try to save output to a file to bypass CLI output limitations
      const tempFile = path.join(os.tmpdir(), `apiiro-risks-${Date.now()}.json`);
      
      try {
        console.log('Saving output to temporary file to bypass CLI limits...');
        execSync(`${cliPath} risks --repo ${repoName} --output json --file ${tempFile}`, {
          encoding: 'utf8',
          timeout: 120000,
          maxBuffer: 100 * 1024 * 1024,
          env: TLS_ENV,
        });
        
        if (fs.existsSync(tempFile)) {
          const fileContent = fs.readFileSync(tempFile, 'utf8');
          console.log(`Read ${fileContent.length} characters from file`);
          
          // Clean up temp file
          fs.unlinkSync(tempFile);
          
          if (!fileContent || !fileContent.trim()) {
            console.warn('Temporary file is empty');
            return [];
          }
          
          const parsed = JSON.parse(fileContent);
          const result = Array.isArray(parsed) ? parsed : (parsed.risks || parsed.issues || parsed.results || []);
          console.log(`Parsed ${result.length} risks from file`);
          return result;
        } else {
          throw new Error('Temporary file was not created');
        }
      } catch (fileErr) {
        console.log('File approach failed, trying direct CLI output...');
        
        // Fallback to direct output with smaller page size
        const output = execSync(`${cliPath} risks --repo ${repoName} --output json --page-size 100`, {
          encoding: 'utf8',
          timeout: 120000,
          maxBuffer: 100 * 1024 * 1024,
          env: TLS_ENV,
        });
        
        console.log(`CLI output length: ${output.length} characters`);
        
        if (!output || !output.trim()) {
          console.warn('Apiiro CLI returned empty output');
          return [];
        }
        
        // Try to parse JSON with better error handling
        let parsed;
        try {
          parsed = JSON.parse(output);
        } catch (parseError) {
          // If JSON parsing fails at exactly 8192 chars, the CLI has limitations
          if (output.length === 8192) {
            throw new Error(`Apiiro CLI output truncated at 8192 characters. The CLI appears to have output limitations. Try using the --file option to save to a file first, or contact Apiiro support about this limitation.`);
          }
          
          // Show a sample of the problematic output for debugging
          const sample = output.length > 200 ? output.substring(0, 200) + '...' : output;
          throw new Error(`JSON parse failed: ${parseError.message}. Output sample: ${sample}`);
        }
        
        // Handle both array and object-with-array responses
        const result = Array.isArray(parsed) ? parsed : (parsed.risks || parsed.issues || parsed.results || []);
        console.log(`Parsed ${result.length} risks from API response`);
        return result;
      }
    } catch (err) {
      throw new Error(`Apiiro fetch failed: ${err.message}`);
    }
  },

  normalize: (raw) => {
    const category = categorize(raw);
    // Apiiro uses riskLevel (Critical/High/Medium/Low), fall back to severity for legacy
    const rawSeverity = raw.riskLevel || raw.severity || '';
    const severity = SEVERITY_MAP[rawSeverity] || SEVERITY_MAP[rawSeverity.toUpperCase()] || 'medium';

    // Apiiro nests file info under sourceCode
    const sourceCode = raw.sourceCode || {};
    const filePath = sourceCode.filePath || raw.filePath || raw.file_path || null;
    const lineNumber = sourceCode.lineNumber || raw.lineNumber || raw.line_number || raw.line || null;

    // Build a meaningful description from available fields
    const description = raw.findingName || raw.ruleName || raw.description || raw.title || raw.message || 'No description';

    // Use riskCategory/ruleName as rule_id instead of non-existent ruleId/type
    const ruleId = raw.ruleName || raw.riskCategory || raw.ruleId || raw.type || raw.category || 'unknown';

    return {
      id: `apiiro-${raw.id || crypto.createHash('md5').update(JSON.stringify(raw)).digest('hex').slice(0, 12)}`,
      source: 'apiiro',
      rule_id: ruleId,
      severity,
      category,
      status: 'open',
      file_path: filePath,
      line_number: lineNumber,
      description,
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

    if (category === 'sca_minor' || category === 'sca_major' || category === 'license') {
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
        license: { level: 'medium', minutes: 20 },
        sast_injection: { level: 'medium', minutes: 15 },
        sast_xss: { level: 'medium', minutes: 15 },
        sast_generic: { level: 'medium', minutes: 15 },
        misconfiguration: { level: 'medium', minutes: 15 },
        pii: { level: 'medium', minutes: 15 },
        supply_chain: { level: 'large', minutes: 30 },
        other: { level: 'medium', minutes: 15 },
      };
      return defaults[issue.category] || { level: 'medium', minutes: 15 };
    }
  },

  reviewLevel: (issue) => {
    const category = issue.category;
    // Secrets, injection, supply chain, PII → always security_review
    if (category === 'secret' || category === 'sast_injection' || category === 'pii' || category === 'supply_chain') {
      return 'security_review';
    }
    // SCA major, XSS → security_review (high-impact vulnerabilities)
    if (category === 'sca_major' || category === 'sast_xss') {
      return 'security_review';
    }
    // SCA minor bumps, license compliance → careful
    if (category === 'sca_minor' || category === 'license') {
      return 'careful';
    }
    // Misconfiguration, generic SAST, other → careful (need human judgment)
    return 'careful';
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
    const ruleId = issue.rule_id;

    // --- Extract rich context from Apiiro's scanner_data ---
    let scannerContext = {};
    try {
      scannerContext = typeof issue.scanner_data === 'string' ? JSON.parse(issue.scanner_data) : (issue.scanner_data || {});
    } catch (_) {}

    const apiiroCtx = extractApiiroContext(issue.scanner_data);
    const riskCategory = scannerContext.riskCategory || '';
    const riskLevel = scannerContext.riskLevel || scannerContext.severity || '';
    const remediation = scannerContext.remediation || scannerContext.recommendation || scannerContext.fixAdvice || '';
    const scannerDesc = scannerContext.description || scannerContext.summary || '';

    // Build a shared context block with Apiiro-specific details
    const contextLines = [
      `**File:** ${filePath}${line}`,
      `**Rule:** ${ruleId}`,
      riskCategory ? `**Risk Category:** ${riskCategory}` : '',
      riskLevel ? `**Risk Level:** ${riskLevel}` : '',
      apiiroCtx.component ? `**Component:** ${apiiroCtx.component}` : '',
      scannerDesc && scannerDesc !== desc ? `**Detail:** ${scannerDesc}` : '',
      remediation ? `**Remediation Advice:** ${remediation}` : '',
      apiiroCtx.sourceUrl ? `**Source:** ${apiiroCtx.sourceUrl}` : '',
      apiiroCtx.apiiroRiskUrl ? `**Apiiro Risk:** ${apiiroCtx.apiiroRiskUrl}` : '',
    ].filter(Boolean).join('\n');

    // Build Apiiro context appendix (insights, actions, business context)
    const apiiroAppendix = [];
    if (apiiroCtx.insights.length > 0) {
      apiiroAppendix.push(`\n### Apiiro Insights`);
      apiiroCtx.insights.forEach(i => apiiroAppendix.push(`- ${i}`));
    }
    if (apiiroCtx.actionsTaken.length > 0) {
      apiiroAppendix.push(`\n### Previous Actions`);
      apiiroCtx.actionsTaken.forEach(a => apiiroAppendix.push(`- ${a}`));
    }
    if (apiiroCtx.policyTags.length > 0) {
      apiiroAppendix.push(`**Policy Tags:** ${apiiroCtx.policyTags.join(', ')}`);
    }
    if (apiiroCtx.apps.length > 0 || apiiroCtx.appGroups.length > 0) {
      const bizParts = [];
      if (apiiroCtx.apps.length > 0) bizParts.push(`Applications: ${apiiroCtx.apps.join(', ')}`);
      if (apiiroCtx.appGroups.length > 0) bizParts.push(`Groups: ${apiiroCtx.appGroups.join(', ')}`);
      if (apiiroCtx.businessImpact) bizParts.push(`Business Impact: ${apiiroCtx.businessImpact}`);
      apiiroAppendix.push(`**Business Context:** ${bizParts.join(' | ')}`);
    }
    const appendixBlock = apiiroAppendix.length > 0 ? '\n' + apiiroAppendix.join('\n') : '';

    let template = '';

    switch (category) {
      case 'secret': {
        // Extract secret type/name from scanner data
        const secretType = scannerContext.secretType || scannerContext.findingName || scannerContext.ruleName || 'secret/credential';
        const secretLocation = scannerContext.matchedContent ? 'Matched content found in source' : '';

        template = [
          `## Fix Secret Exposure`,
          ``,
          `**Issue:** ${desc}`,
          contextLines,
          `**Secret Type:** ${secretType}`,
          secretLocation ? `**Note:** ${secretLocation}` : '',
          ``,
          `### Instructions:`,
          `1. Remove the hardcoded secret/credential from the source code`,
          `2. Replace it with an environment variable reference (e.g., \`process.env.SECRET_NAME\`)`,
          `3. Add the variable name to \`.env.example\` with a placeholder value`,
          `4. Ensure the secret is not committed anywhere in git history`,
          `5. Note: the actual secret needs to be rotated — this fix only removes it from code`,
          ``,
          `**Important:** Minimal change, follow existing code style. Fix only this issue.`,
        ].filter(Boolean).join('\n');
        break;
      }

      case 'license': {
        const depInfo = extractDepInfo(issue.scanner_data);
        const licenseName = apiiroCtx.licenseName || 'unknown';
        const packageName = depInfo.name !== 'unknown' ? depInfo.name : apiiroCtx.component || 'unknown';
        const packageVersion = depInfo.currentVersion || '';
        const isDevDep = apiiroCtx.insights.some(i => i.toLowerCase().includes('dev dependency'));
        const isUsedInCode = apiiroCtx.insights.some(i => i.toLowerCase().includes('used in code'));

        template = [
          `## Resolve License Compliance Issue`,
          ``,
          `**Issue:** ${desc}`,
          contextLines,
          `**License:** ${licenseName}`,
          `**Package:** ${packageName}${packageVersion ? ` @ ${packageVersion}` : ''}`,
          isDevDep ? `**Scope:** Dev dependency (not shipped to production)` : '',
          isUsedInCode ? `**Usage:** Imported and used in application code` : '',
          ``,
          `### Instructions:`,
          `This is a **license compliance** issue, NOT a vulnerability. Do NOT simply update the package version — the license will remain the same.`,
          ``,
          `1. **Evaluate the license:** Determine if \`${licenseName}\` is compatible with your project's licensing policy`,
          `2. **Check organizational policy:** Review whether this license type is approved, restricted, or banned`,
          isDevDep
            ? `3. **Consider scope:** This is a dev dependency — if it is not bundled into production artifacts, the license risk may be acceptable`
            : `3. **Consider scope:** This dependency is used in production code — license terms apply to distributed software`,
          `4. **Options to resolve:**`,
          `   - If the license is acceptable: document the approval (add to an allow-list or license policy file)`,
          `   - If the license is NOT acceptable: find an alternative package with a compatible license`,
          `   - If unclear: escalate to legal/compliance team for review`,
          `5. **Document the decision** in the project's license policy or compliance records`,
          ``,
          `**Important:** This requires a compliance decision, not just a code change. Fix only this issue.`,
        ].filter(Boolean).join('\n');
        break;
      }

      case 'sca_minor':
      case 'sca_major': {
        const depInfo = extractDepInfo(issue.scanner_data);
        const vulnLines = [
          depInfo.vulnerabilityName ? `**Vulnerability:** ${depInfo.vulnerabilityName}` : (depInfo.name !== 'unknown' ? `**Package:** ${depInfo.name}` : ''),
          depInfo.cves && depInfo.cves.length > 0 ? `**CVE(s):** ${depInfo.cves.join(', ')}` : '',
          depInfo.severity ? `**Severity:** ${depInfo.severity}` : '',
          depInfo.exploitabilityScore ? `**Exploitability Score:** ${depInfo.exploitabilityScore}` : '',
          depInfo.dependencyScope ? `**Dependency Scope:** ${depInfo.dependencyScope}` : '',
          depInfo.currentVersion && depInfo.recommendedVersion
            ? `**Version Update:** ${depInfo.name} ${depInfo.currentVersion} → ${depInfo.recommendedVersion}`
            : depInfo.currentVersion ? `**Current Version:** ${depInfo.name} @ ${depInfo.currentVersion}` : '',
          depInfo.recommendedVersion && !depInfo.currentVersion ? `**Recommended Version:** ${depInfo.recommendedVersion}` : '',
          depInfo.ecosystem ? `**Ecosystem:** ${depInfo.ecosystem}` : '',
        ].filter(Boolean).join('\n');

        // Advisory URLs from findingTags
        const advisoryLines = depInfo.advisoryUrls && depInfo.advisoryUrls.length > 0
          ? `**Advisory References:**\n${depInfo.advisoryUrls.map(u => `- ${u}`).join('\n')}`
          : '';

        template = [
          `## Fix Dependency Vulnerability`,
          ``,
          `**Issue:** ${desc}`,
          contextLines,
          vulnLines,
          advisoryLines,
          ``,
          `### Instructions:`,
          `1. Update the vulnerable dependency to the recommended/safe version`,
          `2. Check the dependency's changelog and release notes for breaking changes`,
          category === 'sca_major'
            ? `3. If this is a major version bump: review the migration guide carefully`
            : `3. Verify the update does not introduce breaking changes`,
          `4. Update your code to handle any API changes or deprecated features`,
          `5. Run your test suite to verify no regressions`,
          `6. Test critical functionality that depends on this dependency`,
          ``,
          `**Important:** Minimal change, follow existing code style. Fix only this vulnerability.`,
        ].filter(Boolean).join('\n');
        break;
      }

      case 'sast_injection': {
        const injectionType = scannerContext.findingName || scannerContext.ruleName || 'injection';
        template = [
          `## Fix Injection Vulnerability`,
          ``,
          `**Issue:** ${desc}`,
          contextLines,
          `**Injection Type:** ${injectionType}`,
          ``,
          `### Instructions:`,
          `1. Use parameterized queries instead of string concatenation for SQL/NoSQL`,
          `2. Apply proper input sanitization and validation`,
          `3. Use prepared statements or ORM methods`,
          `4. Do not bypass security controls — fix the root cause`,
          `5. Ensure the fix covers all code paths to the vulnerable sink`,
          ``,
          `**Important:** Minimal change, follow existing code style. Fix only this issue.`,
        ].filter(Boolean).join('\n');
        break;
      }

      case 'sast_xss': {
        template = [
          `## Fix Cross-Site Scripting (XSS)`,
          ``,
          `**Issue:** ${desc}`,
          contextLines,
          ``,
          `### Instructions:`,
          `1. Apply proper output encoding/escaping for the context (HTML, JS, URL, CSS)`,
          `2. Use framework-provided sanitization (e.g., React auto-escapes JSX)`,
          `3. Avoid \`dangerouslySetInnerHTML\`, \`innerHTML\`, or \`eval()\` with user input`,
          `4. Validate and sanitize input at the boundary`,
          ``,
          `**Important:** Minimal change, follow existing code style. Fix only this issue.`,
        ].filter(Boolean).join('\n');
        break;
      }

      case 'sast_generic': {
        template = [
          `## Fix SAST Finding`,
          ``,
          `**Issue:** ${desc}`,
          contextLines,
          ``,
          `### Instructions:`,
          `1. Identify the vulnerability type from the rule description above`,
          `2. Apply the standard remediation for this vulnerability class`,
          `3. Ensure user input is validated, sanitized, and never trusted`,
          `4. Do not introduce new security controls — fix the existing vulnerability`,
          ``,
          `**Important:** Minimal change, follow existing code style. Fix only this issue.`,
        ].filter(Boolean).join('\n');
        break;
      }

      case 'misconfiguration': {
        template = [
          `## Fix Security Misconfiguration`,
          ``,
          `**Issue:** ${desc}`,
          contextLines,
          ``,
          `### Instructions:`,
          `1. Fix the insecure default or misconfigured setting`,
          `2. Apply secure defaults (e.g., enable HTTPS, disable debug mode, set secure headers)`,
          `3. Follow security best practices for the framework/platform in use`,
          `4. Verify the configuration change does not break existing functionality`,
          ``,
          `**Important:** Minimal change, follow existing code style. Fix only this issue.`,
        ].filter(Boolean).join('\n');
        break;
      }

      case 'pii': {
        template = [
          `## Fix PII Exposure`,
          ``,
          `**Issue:** ${desc}`,
          contextLines,
          ``,
          `### Instructions:`,
          `1. Remove or mask personally identifiable information from logs, responses, or storage`,
          `2. Use encryption or hashing where PII must be stored`,
          `3. Ensure PII is not exposed in error messages or API responses`,
          `4. Verify no PII leaks to third-party services or analytics`,
          ``,
          `**Important:** Minimal change, follow existing code style. Fix only this issue.`,
        ].filter(Boolean).join('\n');
        break;
      }

      case 'supply_chain': {
        template = [
          `## Fix Supply Chain Risk`,
          ``,
          `**Issue:** ${desc}`,
          contextLines,
          ``,
          `### Instructions:`,
          `1. Verify the integrity of the affected dependency or build artifact`,
          `2. Pin dependency versions and use lock files to prevent tampering`,
          `3. If a compromised package is detected: remove it and find a trusted alternative`,
          `4. Review the dependency's maintainership, download stats, and recent changes`,
          `5. Add checksum verification or signature checks where possible`,
          ``,
          `**Important:** Minimal change, follow existing code style. Fix only this issue.`,
        ].filter(Boolean).join('\n');
        break;
      }

      default: {
        template = [
          `## Fix Security Issue`,
          ``,
          `**Issue:** ${desc}`,
          contextLines,
          ``,
          `### Instructions:`,
          `1. Analyze the reported security issue and its context`,
          `2. Apply the minimal fix that addresses the vulnerability`,
          `3. Follow security best practices for the language/framework`,
          `4. Verify the fix does not introduce new issues`,
          ``,
          `**Important:** Minimal change, follow existing code style. Fix only this issue.`,
        ].filter(Boolean).join('\n');
      }
    }

    // Append Apiiro context (insights, actions, business context) to all prompts
    return template + appendixBlock;
  },

  batchPromptTemplate: (issues) => {
    if (!issues || issues.length === 0) return '';

    const category = issues[0].category;
    const ruleId = issues[0].rule_id;
    const desc = issues[0].description;

    // Extract shared risk context from the first issue's scanner_data
    let riskCategory = '';
    let riskLevel = '';
    let remediation = '';
    try {
      const data = typeof issues[0].scanner_data === 'string' ? JSON.parse(issues[0].scanner_data) : (issues[0].scanner_data || {});
      riskCategory = data.riskCategory || '';
      riskLevel = data.riskLevel || data.severity || '';
      remediation = data.remediation || data.recommendation || data.fixAdvice || '';
    } catch (_) {}

    // Build inventory table with file, line, and severity per issue
    const inventoryLines = [
      `| # | File | Line | Severity | Description |`,
      `|---|------|------|----------|-------------|`,
    ];
    issues.forEach((issue, i) => {
      const file = issue.file_path || 'unknown';
      const ln = issue.line_number || '-';
      const sev = issue.severity || '-';
      const d = issue.description || '-';
      // Truncate long descriptions for table readability
      const shortDesc = d.length > 80 ? d.substring(0, 77) + '...' : d;
      inventoryLines.push(`| ${i + 1} | \`${file}\` | ${ln} | ${sev} | ${shortDesc} |`);
    });

    const parts = [
      `## Batch Fix: ${issues.length} instances of ${ruleId}`,
      ``,
      `**Category:** ${category}`,
      `**Description:** ${desc}`,
      riskCategory ? `**Risk Category:** ${riskCategory}` : '',
      riskLevel ? `**Risk Level:** ${riskLevel}` : '',
      remediation ? `\n**Remediation Advice:** ${remediation}` : '',
      ``,
      `### Affected Locations`,
      ...inventoryLines,
      ``,
      `### Instructions:`,
      `1. Fix all ${issues.length} instances of this issue across the listed files`,
      `2. Apply the same fix pattern consistently to each location`,
      `3. If fixes require context-specific values, tailor each one — do not use a generic placeholder`,
      `4. Verify no regressions are introduced across the ${issues.length} locations`,
      ``,
      `**Important:** Minimal change, follow existing code style. Fix only these issues.`,
    ];

    return parts.filter(Boolean).join('\n');
  },
};
