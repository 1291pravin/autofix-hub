'use strict';

/**
 * AQA Playwright Scanning Orchestrator
 *
 * Dual-engine support:
 *   - 'axe' (default) — Free axe-core injection, no account needed
 *   - 'aqa'           — Main AQA extension (snapshot + evaluateWebPage API)
 *
 * Flow (axe engine):
 *   1. Launch Chromium (no extension needed)
 *   2. Navigate to URL → dismiss cookie consent → inject axe-core CDN
 *   3. Run axe.run() → convert violations to AQA-compatible format
 *
 * Flow (aqa engine):
 *   1. Launch Chromium with the main AQA extension loaded
 *   2. Extension injects _AQAExt_.Analyzer into every page
 *   3. Capture DOM snapshot → POST to AQA evaluateWebPage API
 *   4. Parse evaluation results (issues)
 */

const { dismissCookieConsent: _dismissCookieConsent } = require('./cookie-consent');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AXE_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.8.2/axe.min.js';

// ---------------------------------------------------------------------------
// axe-core engine
// ---------------------------------------------------------------------------

async function _scanWithAxe(urls, browser, config) {
  const context = await browser.newContext({
    viewport: config.viewport || { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });

  const allIssues = [];

  for (const targetUrl of urls) {
    console.log(`  [axe] Scanning: ${targetUrl}`);
    let page;
    try {
      page = await context.newPage();

      // Navigate with networkidle fallback
      try {
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
      } catch (err) {
        if (err.name === 'TimeoutError') {
          console.warn('    networkidle timed out, falling back to domcontentloaded');
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        } else { throw err; }
      }

      await _dismissCookieConsent(page);
      await page.waitForTimeout(3000);

      // Inject axe-core and run
      await page.addScriptTag({ url: AXE_CDN_URL });
      await page.waitForFunction(() => typeof window.axe !== 'undefined', { timeout: 15000 });

      const axeResults = await page.evaluate(() => {
        return axe.run(document, {
          reporter: 'v2',
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
        });
      });

      console.log(`    ${axeResults.violations.length} violation rules`);

      for (const violation of axeResults.violations) {
        for (const node of violation.nodes) {
          allIssues.push({
            ruleId: violation.id,
            ruleTitle: violation.description,
            ruleShortTitle: violation.help,
            needFixTitle: violation.help,
            checkManuallyTitle: '',
            solutionId: violation.id,
            tagName: (node.html.match(/^<(\w+)/) || [])[1] || 'unknown',
            selectors: node.target || [],
            html: node.html,
            impact: node.impact || 'moderate',
            properties: [],
            responsibility: 'development',
            technology: 'web',
            _aqa_context: {
              type: 'playwright',
              pageUrl: targetUrl,
              scanMethod: 'axe-core',
              scanTimestamp: new Date().toISOString(),
            },
          });
        }
      }
    } catch (err) {
      console.error(`    Failed: ${err.message}`);
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  await context.close();
  return allIssues;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan URLs using Playwright with the specified engine.
 *
 * @param {object} config
 * @param {string} config.urls        — comma-separated URLs, file path, or array
 * @param {string} config.scanEngine  — 'axe' (default) or 'aqa'
 * @param {string} config.apiKey      — AQA API key (for aqa engine)
 * @param {string} config.teamSlug    — AQA team slug (for aqa engine)
 * @param {string} config.ruleset     — Ruleset ID (for aqa engine, default: 'wcag22')
 * @param {boolean} config.headless   — Run headless (only works for axe engine)
 * @returns {Promise<Array>} Raw issues in AQA-compatible format
 */
async function scanWithPlaywright(config = {}) {
  const { chromium } = require('playwright');
  const URLProcessor = require('../utils/url-processor');

  const engine = config.scanEngine || 'axe';

  // Process URLs
  const urlsInput = config.urls;
  if (!urlsInput) {
    throw new Error('Playwright scanning requires URLs. Pass --urls or provide urls config.');
  }
  const urls = URLProcessor.processUrls(urlsInput);
  if (urls.length === 0) throw new Error('No valid URLs found.');

  console.log(`\nPlaywright scan — engine: ${engine}, URLs: ${urls.length}`);

  let allIssues = [];

  if (engine === 'axe') {
    console.log('\n--- axe-core engine ---');
    const browser = await chromium.launch({ headless: config.headless || false });
    try {
      const axeIssues = await _scanWithAxe(urls, browser, config);
      allIssues.push(...axeIssues);
    } finally {
      await browser.close();
    }
  } else if (engine === 'aqa') {
    console.log('\n--- AQA extension engine ---');
    const { scanWithAQAMainExtension } = require('./aqa-main-extension');
    const aqaIssues = await scanWithAQAMainExtension(urls, config);
    allIssues.push(...aqaIssues);
  } else {
    throw new Error(`Unknown scan engine "${engine}". Must be: axe or aqa`);
  }

  console.log(`\nTotal issues: ${allIssues.length}`);
  return allIssues;
}

module.exports = { scanWithPlaywright };
