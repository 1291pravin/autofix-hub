'use strict';

/**
 * Main AQA Extension Scanner
 *
 * Scans URLs using the main UsableNet AQA Chrome extension
 * (ID: lcoodjnlebepmajggdbmapnofedgiloa) for accessibility evaluation.
 *
 * Architecture (from extension source analysis):
 *   1. Launch Chromium with the AQA extension loaded
 *   2. Extension's content scripts inject _AQAExt_.Analyzer into every page
 *   3. Navigate to each URL and wait for _AQAExt_.Analyzer injection
 *   4. Call _AQAExt_.Analyzer.snapshot() to capture a DOM snapshot
 *   5. POST the snapshot to api-aqa.usablenet.com/{teamSlug}/evaluateWebPage
 *   6. Parse the evaluation results (issues)
 *
 * Required env vars:
 *   AQA_EXTENSION_API_KEY or AQA_API_KEY — X-Team header for the API
 *   AQA_TEAM_SLUG — team slug in the API URL
 *
 * Usage:
 *   node scripts/test-playwright-scan.js https://example.com aqa-main
 */

const {
  isExtensionAvailable,
  launchWithExtension,
  waitForExtensionServiceWorker,
  getServiceWorker,
  getExtensionStorageConfig,
  captureSnapshot,
  evaluateSnapshot,
  cleanup,
} = require('./aqa-extension');
const { dismissCookieConsent: _dismissCookieConsent } = require('./cookie-consent');

/**
 * Scan a single URL using the extension's snapshot + AQA API evaluation.
 *
 * @param {BrowserContext} context - Playwright browser context
 * @param {Page} page - Playwright page
 * @param {string} targetUrl - URL to scan
 * @param {string} extensionId - The extension ID
 * @param {object} config - Scan configuration
 * @returns {Promise<object[]>} Raw issues array from the AQA API
 */
async function _scanSingleUrl(context, page, targetUrl, extensionId, config) {
  console.log(`  [aqa-main] Scanning: ${targetUrl}`);

  // Navigate with networkidle fallback
  try {
    await page.goto(targetUrl, {
      waitUntil: 'networkidle',
      timeout: config.timeout || 60000,
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      console.warn('    networkidle timed out, falling back to domcontentloaded');
      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
    } else {
      throw err;
    }
  }

  // Dismiss cookie consent banners
  await _dismissCookieConsent(page);
  await page.waitForTimeout(config.waitAfterLoad || 3000);

  // Capture DOM snapshot via the extension's service worker → content script
  const snapshot = await captureSnapshot(context, page, extensionId);
  if (!snapshot) {
    console.error(`    Failed to capture snapshot for ${targetUrl}`);
    return [];
  }

  // Read extension's stored configuration (contains api_key, teamslug, etc.)
  const extConfig = await getExtensionStorageConfig(context, extensionId);
  if (extConfig) {
    console.log(`    Extension config found: api_key=${extConfig.api_key ? '***' : 'missing'}, teamslug=${extConfig.teamslug || 'missing'}`);
  }

  // Send snapshot to AQA API for evaluation
  let apiResponse;
  try {
    const apiConfig = {
      ...config,
      pageUrl: targetUrl,
      // Override with extension's stored values if available
      apiKey: extConfig?.api_key || config.apiKey,
      teamSlug: extConfig?.teamslug || config.teamSlug,
      apiHost: extConfig?.userApiDomain || config.apiHost,
      lang: extConfig?.lang || config.lang,
      ruleset: extConfig?.ruleset || config.ruleset,
    };
    apiResponse = await evaluateSnapshot(snapshot, apiConfig);
  } catch (err) {
    console.error(`    AQA API evaluation failed: ${err.message}`);
    return [];
  }

  // Parse issues from the API response
  const issues = parseEvaluationResponse(apiResponse, targetUrl);
  console.log(`    ${issues.length} issues found for ${targetUrl}`);
  return issues;
}

/**
 * Parse the evaluateWebPage API response into raw issue objects.
 *
 * The API returns issues in the same format as the AQA cloud platform.
 *
 * @param {object} apiResponse - Raw API response
 * @param {string} pageUrl - The scanned URL (for metadata)
 * @returns {object[]} Normalized issue array
 */
function parseEvaluationResponse(apiResponse, pageUrl) {
  if (!apiResponse) return [];

  console.log(`    API response keys: ${Object.keys(apiResponse).join(', ')}`);

  // The evaluateWebPage API returns:
  //   notes[]           — array of issues, each with: id, ruleId, ruleTitle, ruleShortTitle,
  //                        title, tagName, selectors[], properties[], responsibility, technology,
  //                        solutionId, auto, question, preview, unId, unIds
  //   descriptions      — solution descriptions keyed by ruleId → solutionId
  //   propertyTitles[]  — labels for the properties array (e.g. ["Issue status", "Severity", "Complexity"])
  //   responsibilities  — responsibility definitions
  //   accessibilityDocument — DOM tree, rotor, navigation data (not issues)

  const notes = apiResponse.notes;
  if (!Array.isArray(notes) || notes.length === 0) {
    console.warn(`    No notes (issues) found in API response`);
    return [];
  }

  // Enrich each note with description data and pageUrl
  const descriptions = apiResponse.descriptions || {};
  const propertyTitles = apiResponse.propertyTitles || [];

  const issues = notes.map(note => {
    // Look up solution description if available
    const ruleDescs = descriptions[note.ruleId] || {};
    const solutionDesc = ruleDescs[note.solutionId] || {};

    return {
      ...note,
      pageUrl,
      _descriptions: solutionDesc,
      _propertyTitles: propertyTitles,
    };
  });

  console.log(`    Extracted ${issues.length} issues from API response (notes)`);
  return issues;
}

/**
 * Scan multiple URLs with the main AQA extension.
 *
 * This is the primary entry point for the aqa-main engine.
 *
 * @param {string[]} urls - Array of URLs to scan
 * @param {object} config - Scan configuration
 * @param {string} config.apiKey - AQA API key (X-Team header)
 * @param {string} config.teamSlug - AQA team slug
 * @param {number} config.timeout - Page load timeout (ms)
 * @param {number} config.waitAfterLoad - Wait after page load (ms)
 * @param {object} config.viewport - Browser viewport dimensions
 * @returns {Promise<object[]>} All raw issues across all URLs
 */
async function scanWithAQAMainExtension(urls, config = {}) {
  // Verify extension is available
  const extensionCheck = isExtensionAvailable();
  if (!extensionCheck.available) {
    throw new Error(extensionCheck.message);
  }

  let context = null;
  let userDataDir = null;

  try {
    // Launch browser with the main AQA extension
    const launched = await launchWithExtension({
      viewport: config.viewport || { width: 1280, height: 720 },
    });
    context = launched.context;
    userDataDir = launched.userDataDir;

    // Wait for extension to load
    const extensionId = await waitForExtensionServiceWorker(context);

    // Scan each URL
    const allIssues = [];
    for (const targetUrl of urls) {
      let page = null;
      try {
        page = await context.newPage();
        const issues = await _scanSingleUrl(context, page, targetUrl, extensionId, config);

        // Annotate issues with context metadata
        for (const issue of issues) {
          issue._aqa_context = {
            type: 'playwright',
            pageUrl: targetUrl,
            scanMethod: 'aqa-main-extension',
            scanTimestamp: new Date().toISOString(),
            extensionId,
          };
        }

        allIssues.push(...issues);
      } catch (err) {
        console.error(`    [aqa-main] Failed to scan ${targetUrl}: ${err.message}`);
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    console.log(`  [aqa-main] Total issues: ${allIssues.length}`);
    return allIssues;

  } finally {
    if (context && userDataDir) {
      await cleanup(context, userDataDir);
    }
  }
}

module.exports = { scanWithAQAMainExtension };
