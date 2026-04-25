'use strict';

/**
 * Result Extraction for the Main UsableNet AQA Extension.
 *
 * Extracts accessibility issues from the main AQA extension using
 * multiple strategies (in order of reliability):
 *
 *   1. Network interception — capture API responses from AQA endpoints
 *   2. Extension storage — read results from chrome.storage.local
 *   3. DOM scraping — parse results from the extension's injected UI panel
 *   4. Console log parsing — capture structured output from the extension
 *
 * All extracted results are normalized to the AQA-compatible issue format
 * used by the rest of autofix-hub.
 */

/**
 * Extract evaluation results using all available strategies.
 *
 * @param {Page} page - The evaluated page
 * @param {string} extensionId - The AQA extension ID
 * @param {object[]} interceptedData - Network responses captured during evaluation
 * @returns {Promise<object[]>} Normalized issues array
 */
async function extractResults(page, extensionId, interceptedData = []) {
  let issues = [];

  // Strategy 1: Network interception (most reliable if extension makes API calls)
  console.log(`    [extract] Trying network interception...`);
  issues = extractFromNetworkData(interceptedData);
  if (issues.length > 0) {
    console.log(`    [extract] Found ${issues.length} issues via network interception`);
    return issues;
  }

  // Strategy 2: Extension storage
  console.log(`    [extract] Trying extension storage...`);
  issues = await extractFromExtensionStorage(page, extensionId);
  if (issues.length > 0) {
    console.log(`    [extract] Found ${issues.length} issues via extension storage`);
    return issues;
  }

  // Strategy 3: DOM scraping — the extension injects UI into the page
  console.log(`    [extract] Trying DOM scraping...`);
  issues = await extractFromDOM(page);
  if (issues.length > 0) {
    console.log(`    [extract] Found ${issues.length} issues via DOM scraping`);
    return issues;
  }

  // Strategy 4: Console log parsing
  console.log(`    [extract] Trying console log parsing...`);
  issues = await extractFromConsoleLogs(page);
  if (issues.length > 0) {
    console.log(`    [extract] Found ${issues.length} issues via console logs`);
    return issues;
  }

  console.warn(`    [extract] No issues found via any extraction strategy`);
  return [];
}

/**
 * Strategy 1: Extract issues from intercepted network responses.
 *
 * The main AQA extension may call AQA API endpoints during evaluation.
 * These responses often contain structured issue data.
 *
 * @param {object[]} interceptedData - Array of { url, status, data, timestamp }
 * @returns {object[]} Normalized issues
 */
function extractFromNetworkData(interceptedData) {
  const allIssues = [];

  for (const entry of interceptedData) {
    const data = entry.data;
    if (!data) continue;

    // Look for issues in various response formats
    const issueArrays = [
      data.issues,
      data.issuesData?.issues,
      data.results?.issues,
      data.violations,
      data.data?.issues,
      data.data?.violations,
    ].filter(Boolean);

    for (const issuesArr of issueArrays) {
      if (Array.isArray(issuesArr)) {
        for (const issue of issuesArr) {
          allIssues.push(normalizeRawIssue(issue, 'network-interception'));
        }
      }
    }
  }

  return allIssues;
}

/**
 * Strategy 2: Extract issues from extension's chrome.storage.local.
 *
 * Many extensions store evaluation results in chrome.storage for
 * persistence across popup opens/closes.
 *
 * @param {Page} page
 * @param {string} extensionId
 * @returns {Promise<object[]>}
 */
async function extractFromExtensionStorage(page, extensionId) {
  try {
    const storageData = await page.evaluate(async (extId) => {
      // Try accessing extension storage via sendMessage
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 10000);

        try {
          // Ask the extension for its stored results
          chrome.runtime.sendMessage(extId, {
            action: 'getResults',
            type: 'getResults',
          }, (response) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              resolve(null);
              return;
            }
            resolve(response);
          });
        } catch (_) {
          clearTimeout(timer);
          resolve(null);
        }
      });
    }, extensionId).catch(() => null);

    if (!storageData) return [];

    // Parse various storage formats
    const issues = storageData.issues
      || storageData.results?.issues
      || storageData.data?.issues
      || [];

    if (Array.isArray(issues)) {
      return issues.map(issue => normalizeRawIssue(issue, 'extension-storage'));
    }
  } catch (_) { /* ignore */ }

  return [];
}

/**
 * Strategy 3: Extract issues from DOM elements injected by the extension.
 *
 * The main AQA extension typically injects a panel/overlay into the page
 * showing evaluation results. We scrape structured data from it.
 *
 * @param {Page} page
 * @returns {Promise<object[]>}
 */
async function extractFromDOM(page) {
  try {
    const domIssues = await page.evaluate(() => {
      const issues = [];

      // Common AQA extension panel selectors
      const panelSelectors = [
        '[id*="aqa"]',
        '[class*="aqa"]',
        '[id*="usablenet"]',
        '[class*="usablenet"]',
        '[data-aqa-panel]',
        'shadow-root-host[id*="aqa"]',
      ];

      // Find the AQA panel
      let panel = null;
      for (const sel of panelSelectors) {
        panel = document.querySelector(sel);
        if (panel) break;
      }

      if (!panel) return [];

      // Try to find issue rows/items within the panel
      const issueSelectors = [
        '[class*="issue"]',
        '[class*="violation"]',
        '[data-issue-id]',
        '[data-rule-id]',
        'li[class*="result"]',
        'tr[class*="issue"]',
        '.issue-row',
        '.violation-item',
      ];

      let issueElements = [];
      for (const sel of issueSelectors) {
        issueElements = panel.querySelectorAll(sel);
        if (issueElements.length > 0) break;
      }

      // Also check shadow DOM
      if (issueElements.length === 0 && panel.shadowRoot) {
        for (const sel of issueSelectors) {
          issueElements = panel.shadowRoot.querySelectorAll(sel);
          if (issueElements.length > 0) break;
        }
      }

      for (const el of issueElements) {
        const issue = {};

        // Extract data attributes
        issue.ruleId = el.getAttribute('data-rule-id')
          || el.getAttribute('data-rule')
          || '';

        issue.ruleTitle = el.getAttribute('data-rule-title')
          || el.querySelector('[class*="title"], [class*="name"], h3, h4')?.textContent?.trim()
          || '';

        issue.impact = el.getAttribute('data-impact')
          || el.getAttribute('data-severity')
          || el.querySelector('[class*="severity"], [class*="impact"]')?.textContent?.trim()?.toLowerCase()
          || 'moderate';

        issue.selector = el.getAttribute('data-selector')
          || el.querySelector('[class*="selector"], code')?.textContent?.trim()
          || '';

        issue.description = el.getAttribute('data-description')
          || el.querySelector('[class*="description"], [class*="detail"], p')?.textContent?.trim()
          || '';

        issue.tagName = el.getAttribute('data-tag')
          || el.querySelector('[class*="element"], [class*="tag"]')?.textContent?.trim()
          || '';

        // Only include if we got meaningful data
        if (issue.ruleId || issue.ruleTitle || issue.description) {
          issues.push(issue);
        }
      }

      // Fallback: Try to extract from summary text (e.g., "42 issues found")
      if (issues.length === 0) {
        const summaryText = panel.textContent || '';
        const countMatch = summaryText.match(/(\d+)\s*(?:issues?|violations?|errors?|problems?)/i);
        if (countMatch) {
          // We know there are issues but can't parse them individually
          // Return a placeholder that indicates scraping found a count
          issues.push({
            _summaryOnly: true,
            _issueCount: parseInt(countMatch[1], 10),
            _panelText: summaryText.slice(0, 500),
          });
        }
      }

      return issues;
    });

    if (!Array.isArray(domIssues) || domIssues.length === 0) return [];

    // Handle summary-only case
    if (domIssues[0]?._summaryOnly) {
      console.log(`    [extract] Found AQA panel with ${domIssues[0]._issueCount} issues (summary only, details not parseable)`);
      return [];
    }

    return domIssues.map(issue => normalizeRawIssue(issue, 'dom-scraping'));

  } catch (err) {
    console.warn(`    [extract] DOM extraction error: ${err.message}`);
    return [];
  }
}

/**
 * Strategy 4: Extract issues from console logs.
 *
 * Some extensions log structured data to the console during evaluation.
 *
 * @param {Page} page
 * @returns {Promise<object[]>}
 */
async function extractFromConsoleLogs(page) {
  // This relies on console messages collected during page evaluation.
  // The page object has a 'console' event we can listen to, but since we
  // set this up after navigation, we may have missed some messages.
  // This is a last-resort fallback.
  try {
    const consoleData = await page.evaluate(() => {
      // Check if the extension stored data in window for debugging
      const dataLocations = [
        window.__aqa_results,
        window.__usablenet_results,
        window.aqaResults,
        window.usablenetResults,
        document.querySelector('script[type="application/json"][data-aqa]')?.textContent,
      ];

      for (const loc of dataLocations) {
        if (loc) {
          const data = typeof loc === 'string' ? JSON.parse(loc) : loc;
          if (data && (data.issues || data.violations || Array.isArray(data))) {
            return data;
          }
        }
      }
      return null;
    }).catch(() => null);

    if (!consoleData) return [];

    const issues = consoleData.issues || consoleData.violations || (Array.isArray(consoleData) ? consoleData : []);
    return issues.map(issue => normalizeRawIssue(issue, 'console-logs'));

  } catch (_) {
    return [];
  }
}

/**
 * Normalize a raw issue from any extraction strategy into the
 * AQA-compatible format used by autofix-hub.
 *
 * Handles variations in field names across different extraction methods.
 *
 * @param {object} raw - Raw issue data
 * @param {string} source - Extraction strategy that found this issue
 * @returns {object} Normalized issue
 */
function normalizeRawIssue(raw, source) {
  // Handle axe-core style violations (if extension uses axe internally)
  if (raw.nodes && Array.isArray(raw.nodes)) {
    // This is an axe-core violation object — expand to individual node issues
    return {
      ruleId: raw.id || raw.ruleId || 'unknown',
      ruleTitle: raw.description || raw.ruleTitle || '',
      ruleShortTitle: raw.help || raw.ruleShortTitle || '',
      needFixTitle: raw.help || raw.needFixTitle || '',
      checkManuallyTitle: '',
      solutionId: raw.id || raw.solutionId || '',
      tagName: '',
      selectors: [],
      html: '',
      impact: raw.impact || 'moderate',
      properties: [],
      responsibility: 'development',
      technology: 'web',
      _extractionSource: source,
    };
  }

  return {
    ruleId: raw.ruleId || raw.rule || raw.id || raw.ruleID || 'unknown',
    ruleTitle: raw.ruleTitle || raw.description || raw.title || raw.message || '',
    ruleShortTitle: raw.ruleShortTitle || raw.help || raw.shortTitle || '',
    needFixTitle: raw.needFixTitle || raw.help || raw.ruleTitle || raw.description || '',
    checkManuallyTitle: raw.checkManuallyTitle || '',
    solutionId: raw.solutionId || raw.solution || raw.ruleId || raw.id || '',
    tagName: raw.tagName || raw.tag || raw.element ||
      (raw.html ? (raw.html.match(/^<(\w+)/) || [])[1] || '' : '') || '',
    selectors: raw.selectors || (raw.selector ? [raw.selector] : (raw.target || [])),
    html: raw.html || raw.snippet || '',
    impact: raw.impact || raw.severity || 'moderate',
    properties: raw.properties || [],
    responsibility: raw.responsibility || 'development',
    technology: raw.technology || 'web',
    _extractionSource: source,
  };
}

module.exports = { extractResults, normalizeRawIssue };
