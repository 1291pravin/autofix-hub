'use strict';

/**
 * AQA Playwright Scanning Orchestrator
 *
 * Dual-engine support:
 *   - 'axe'  — Free axe-core injection (default)
 *   - 'aqa'  — Licensed UsableNet AQA Page Capture extension
 *   - 'both' — Run both engines, merge results
 *
 * The AQA engine uses the "AQA Page Capture" Chrome extension
 * (ID: llaaiankjgnonjipogopofnpahaoccfo) which communicates via
 * chrome.runtime.sendMessage with externally_connectable.
 *
 * Flow (AQA engine):
 *   1. Launch Chromium with the Page Capture extension loaded
 *   2. Health-check the extension background script
 *   3. createFlow → navigate pages → doSnapshot each → uploadZip
 *   4. API: getFlowID → createTest → run → waitForRun → getAllIssues
 *   5. Return issues in AQA-compatible raw format
 *
 * Flow (axe engine):
 *   1. Launch Chromium (no extension needed)
 *   2. Navigate to URL → dismiss cookie consent → inject axe-core CDN
 *   3. Run axe.run() → convert violations to AQA-compatible format
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AXE_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.8.2/axe.min.js';

// AQA Page Capture extension (NOT the main AQA testing extension)
const AQA_CAPTURE_EXTENSION_ID = 'llaaiankjgnonjipogopofnpahaoccfo';
const AQA_CAPTURE_EXTENSION_DIR = path.join(__dirname, '../../extensions/aqa-page-capture');

// AQA API defaults
const AQA_API_BASE = 'https://api-aqa.usablenet.com/v3.1';
const AQA_DEFAULT_RULESET_PACK = 'v2';
const AQA_DEFAULT_RULESET_ID = 'wcag22';

// Cookie consent selectors (OneTrust, Didomi, TrustArc, Usercentrics, French)
const COOKIE_CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '.didomi-continue-without-agreeing',
  '#didomi-notice-agree-button',
  '[id*="truste-consent-button"]',
  'button[data-testid="uc-accept-all-button"]',
  'button.accept-all, button.accept_all',
  'button[id*="accept"], button[class*="accept"]',
  'button[id*="cookie"], button[class*="cookie"]',
  '.cookie-consent button, .consent-banner button',
  'button:has-text("Accept all")',
  'button:has-text("Accept All")',
  'button:has-text("Tout accepter")',
  'button:has-text("Accepter")',
  "button:has-text(\"J'accepte\")",
  'button:has-text("Continuer sans accepter")',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _apiRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: { Accept: 'application/json', ...options.headers },
    };
    if (options.body) {
      reqOptions.headers['Content-Type'] = 'application/json';
      reqOptions.headers['Content-Length'] = Buffer.byteLength(options.body);
    }
    const req = mod.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`AQA API ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Invalid JSON: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('AQA API timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function _dismissCookieConsent(page) {
  for (const sel of COOKIE_CONSENT_SELECTORS) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        await page.waitForTimeout(800);
        return;
      }
    } catch (_) { /* ignore */ }
  }
}

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
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: config.timeout || 60000 });
      } catch (err) {
        if (err.name === 'TimeoutError') {
          console.warn('    networkidle timed out, falling back to domcontentloaded');
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        } else { throw err; }
      }

      await _dismissCookieConsent(page);
      await page.waitForTimeout(config.waitAfterLoad || 3000);

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
// AQA Page Capture engine
// ---------------------------------------------------------------------------

async function _scanWithAQA(urls, browser, config) {
  const apiKey = config.aqaApiKey || process.env.AQA_EXTENSION_API_KEY || process.env.AQA_API_KEY;
  const teamSlug = config.aqaTeamSlug || process.env.AQA_TEAM_SLUG;
  const suiteId = config.aqaSuiteId || process.env.AQA_SUITE_ID;
  const flowName = config.aqaFlowName || process.env.AQA_FLOW_NAME || `autofix-${Date.now()}`;
  const testName = config.aqaTestName || process.env.AQA_TEST_NAME || `autofix-scan-${Date.now()}`;
  const rulesetPackId = config.aqaRulesetPackId || process.env.AQA_RULESET_PACK_ID || AQA_DEFAULT_RULESET_PACK;
  const rulesetId = config.aqaRulesetId || process.env.AQA_RULESET_ID || AQA_DEFAULT_RULESET_ID;
  const cleanupFlow = (config.aqaCleanupFlow || process.env.AQA_CLEANUP_FLOW) === 'true';

  if (!apiKey || !teamSlug) {
    throw new Error('AQA engine requires AQA_EXTENSION_API_KEY and AQA_TEAM_SLUG. Set in .env or config.');
  }
  if (!suiteId) {
    throw new Error('AQA engine requires AQA_SUITE_ID. Set in .env or config.');
  }

  // Verify extension exists
  if (!fs.existsSync(path.join(AQA_CAPTURE_EXTENSION_DIR, 'manifest.json'))) {
    const errorMsg = [
      `AQA Page Capture extension not found at ${AQA_CAPTURE_EXTENSION_DIR}`,
      '',
      'To use the AQA engine:',
      '1. Copy the "AQA Page Capture" Chrome extension (ID: llaaiankjgnonjipogopofnpahaoccfo)',
      '   from the reference repo (colpal/ecommerce-test-playwrightframework)',
      '   into: packages/plugin-aqa/extensions/aqa-page-capture/',
      '',
      'Alternatively, use the free axe-core engine:',
      `  node scripts/test-playwright-scan.js https://fr.filorga.com axe`,
      '  or set: AQA_SCAN_ENGINE=axe',
      '',
      'See: packages/plugin-aqa/extensions/aqa-page-capture/README.md'
    ].join('\n');
    throw new Error(errorMsg);
  }

  const apiBase = `${AQA_API_BASE}/${teamSlug}`;
  const apiHeaders = { 'X-Team': apiKey };

  console.log(`  [aqa] Launching browser with Page Capture extension...`);

  // Launch persistent context with extension
  const userDataDir = path.join(require('os').tmpdir(), `aqa-pw-${Date.now()}`);
  const context = await browser._type
    ? (await require('playwright').chromium.launchPersistentContext(userDataDir, {
        headless: false, // Extension requires headed mode
        args: [
          `--disable-extensions-except=${AQA_CAPTURE_EXTENSION_DIR}`,
          `--load-extension=${AQA_CAPTURE_EXTENSION_DIR}`,
          '--no-sandbox',
          '--disable-dev-shm-usage',
        ],
        viewport: config.viewport || { width: 1280, height: 720 },
        ignoreHTTPSErrors: true,
        ignoreDefaultArgs: ['--disable-extensions'],
      }))
    : null;

  if (!context) throw new Error('Failed to launch persistent context for AQA extension');

  let extensionId = null;

  try {
    // Wait for extension service worker to confirm it loaded
    console.log(`  [aqa] Waiting for extension to load...`);
    const swDeadline = Date.now() + 20000;
    while (Date.now() < swDeadline) {
      for (const sw of context.serviceWorkers()) {
        if (sw.url().includes('chrome-extension://')) {
          extensionId = sw.url().match(/chrome-extension:\/\/([a-z]+)/)?.[1];
          break;
        }
      }
      if (extensionId) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (!extensionId) throw new Error('Extension service worker not found within 20s');
    console.log(`  [aqa] Extension loaded: ${extensionId}`);

    // Helper: send message to extension from a page context
    // (externally_connectable requires messages from web pages, not service workers)
    async function _sendExtMsg(page, messageData) {
      return page.evaluate(([msg, extId]) => {
        return new Promise((resolve) => {
          if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
            resolve({ success: false, error: 'chrome.runtime is not defined.' });
            return;
          }
          chrome.runtime.sendMessage(extId, msg, (response) => {
            if (chrome.runtime.lastError) {
              resolve({ success: false, error: chrome.runtime.lastError.message || String(chrome.runtime.lastError) });
              return;
            }
            if (response) {
              resolve(response);
            } else {
              resolve({ success: false, error: 'extension provided an undefined response' });
            }
          });
        });
      }, [messageData, extensionId]);
    }

    // Open a blank page for extension communication (health check, create flow, upload)
    const commPage = await context.newPage();
    await commPage.goto('about:blank');
    await new Promise(r => setTimeout(r, 1000));

    // Health check
    const healthResp = await _sendExtMsg(commPage, { action: 'bg-ext-health-check' });
    console.log(`  [aqa] Health check:`, healthResp?.success ? 'OK' : 'failed', healthResp?.error || '');

    if (!healthResp?.success) {
      await commPage.close().catch(() => {});
      throw new Error(
        `AQA Page Capture extension health check failed${healthResp?.error ? ': ' + healthResp.error : ''}.\n` +
        'Ensure the extension is properly loaded and functional.\n' +
        'Alternatively, use the free axe-core engine: node scripts/test-playwright-scan.js https://fr.filorga.com axe'
      );
    }

    // Create flow
    const flowResp = await _sendExtMsg(commPage, {
      action: 'bg-ext-create-flow',
      payload: { name: flowName, device: 'custom' },
    });
    console.log(`  [aqa] Flow created:`, flowResp?.success ? 'OK' : 'failed', flowResp?.error || '');
    await commPage.close().catch(() => {});

    // Navigate to each URL, take snapshot
    for (const targetUrl of urls) {
      console.log(`  [aqa] Scanning: ${targetUrl}`);
      const page = await context.newPage();
      try {
        try {
          await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: config.timeout || 60000 });
        } catch (err) {
          if (err.name === 'TimeoutError') {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          } else { throw err; }
        }

        await _dismissCookieConsent(page);
        await page.waitForTimeout(config.waitAfterLoad || 3000);

        // Take snapshot via extension (from page context)
        const pageTitle = await page.title();
        const snapResp = await _sendExtMsg(page, {
          action: 'bg-ext-do-snapshot',
          payload: { url: targetUrl, pageName: pageTitle },
        });
        console.log(`    Snapshot:`, snapResp?.success ? 'OK' : 'failed', snapResp?.error || '');
      } finally {
        await page.close().catch(() => {});
      }
    }

    // Upload captured data (open new page for this)
    console.log(`  [aqa] Uploading snapshots...`);
    const uploadPage = await context.newPage();
    await uploadPage.goto('about:blank');
    const uploadResp = await _sendExtMsg(uploadPage, {
      action: 'bg-ext-upload',
      payload: {
        name: flowName,
        suite: suiteId,
        team: teamSlug,
        xTeam: apiKey,
      },
    });
    console.log(`  [aqa] Upload:`, uploadResp?.success ? 'OK' : 'failed', uploadResp?.error || '');
    await uploadPage.close().catch(() => {});

    // The extension handles upload → test creation internally.
    // Now query the AQA cloud API to find the test/run.
    // Note: The cloud API may need a different API key than the extension API key.
    // Try using AQA_API_KEY first, fall back to extension key.
    const cloudApiKey = process.env.AQA_API_KEY || apiKey;
    const cloudHeaders = { 'X-Team': cloudApiKey };

    // The extension upload creates a test automatically on the AQA backend.
    // If the upload response contains a testId, use it directly.
    // Otherwise, look up the latest test on the suite.
    let testId = uploadResp?.testId || uploadResp?.data?.testId || null;

    // Wait a moment for the backend to process the upload
    console.log(`  [aqa] Waiting for backend to process upload...`);
    await new Promise(r => setTimeout(r, 5000));

    // If no testId from upload, find the latest test on the suite
    if (!testId) {
      console.log(`  [aqa] Looking up latest test on suite ${suiteId}...`);
      try {
        const suiteData = await _apiRequest(`${apiBase}/a11y/suites/${suiteId}`, { headers: cloudHeaders });
        const suite = suiteData.suite || suiteData;
        const tests = suite.tests || suiteData.tests || [];
        if (tests.length > 0) {
          // Tests may be objects with id, or just string IDs
          const firstTest = tests[tests.length - 1]; // latest is usually at end
          testId = typeof firstTest === 'string' ? firstTest : (firstTest.id || firstTest._id);
          console.log(`  [aqa] Found test: ${testId}`);
        }
      } catch (err) {
        console.log(`  [aqa] Suite lookup failed: ${err.message}`);
      }
    }

    // If still no testId, try the known test ID from .env
    if (!testId && process.env.AQA_TEST_ID) {
      testId = process.env.AQA_TEST_ID;
      console.log(`  [aqa] Using AQA_TEST_ID from env: ${testId}`);
    }

    // If still no testId, try listing tests on the suite
    if (!testId) {
      console.log(`  [aqa] Listing tests for suite ${suiteId}...`);
      try {
        const testsData = await _apiRequest(`${apiBase}/a11y/tests?suiteId=${suiteId}&limit=5`, { headers: cloudHeaders });
        const tests = testsData.tests || [];
        if (tests.length > 0) {
          testId = typeof tests[0] === 'string' ? tests[0] : (tests[0].id || tests[0]._id);
          console.log(`  [aqa] Found test: ${testId}`);
        }
      } catch (err) {
        console.log(`  [aqa] Tests listing failed: ${err.message}`);
      }
    }

    if (!testId) throw new Error('Could not find test created by extension upload');
    console.log(`  [aqa] Test ID: ${testId}`);

    // Wait for run to complete
    console.log(`  [aqa] Waiting for run to complete...`);
    let runId = null;
    const runDeadline = Date.now() + 300000; // 5 minute max
    while (Date.now() < runDeadline) {
      const testData = await _apiRequest(`${apiBase}/a11y/tests/${testId}`, { headers: cloudHeaders });
      const testDef = testData.definition || testData;
      const runs = testData.runs || testDef.runs || [];
      const latestRun = runs[0];
      if (latestRun && latestRun.status === 'ready') {
        runId = latestRun.id;
        break;
      }
      if (latestRun && latestRun.status === 'error') {
        throw new Error(`Test run failed: ${latestRun.error || 'unknown error'}`);
      }
      console.log(`    Status: ${latestRun?.status || 'unknown'}...`);
      await new Promise(r => setTimeout(r, 5000));
    }
    if (!runId) throw new Error('Test run did not complete within 5 minutes');
    console.log(`  [aqa] Run completed: ${runId}`);

    // Get all issues
    console.log(`  [aqa] Fetching issues...`);
    const allIssues = [];

    // Try flow-based issues (iterate steps like main plugin)
    const flowListData = await _apiRequest(`${apiBase}/a11y/tests/runs/${runId}/flows`, { headers: cloudHeaders });
    const runFlows = flowListData.flows || [];
    for (const rf of runFlows) {
      const rfId = rf.id;
      if (!rfId) continue;
      try {
        // Get flow details for step count
        const flowDetails = await _apiRequest(`${apiBase}/a11y/tests/runs/${runId}/flows/${rfId}`, { headers: cloudHeaders });
        const flowDetail = flowDetails.flow || flowDetails;
        const numSteps = flowDetail.numSteps || 1;
        console.log(`    Flow ${rfId}: ${numSteps} step(s)`);

        for (let stepIndex = 0; stepIndex < numSteps; stepIndex++) {
          try {
            const issuesData = await _apiRequest(
              `${apiBase}/a11y/tests/runs/${runId}/flows/${rfId}/issues?stepIndex=${stepIndex}&changeIndex=-1&manual=true&comments=true`,
              { headers: cloudHeaders }
            );
            const payload = issuesData.issuesData || issuesData;
            const issues = payload.issues || [];
            for (const issue of issues) {
              issue._aqa_context = {
                type: 'playwright',
                pageUrl: issue.pageUrl || urls[0],
                scanMethod: 'aqa-extension',
                scanTimestamp: new Date().toISOString(),
                testId,
                runId,
                flowId: rfId,
                stepIndex,
              };
            }
            allIssues.push(...issues);
          } catch (err) {
            console.error(`    Failed to fetch flow ${rfId} step ${stepIndex} issues: ${err.message}`);
          }
        }
      } catch (err) {
        console.error(`    Failed to fetch flow ${rfId} details: ${err.message}`);
      }
    }

    // Try page-based issues if no flow issues found
    if (allIssues.length === 0) {
      try {
        const pageListData = await _apiRequest(`${apiBase}/a11y/tests/runs/${runId}/pages`, { headers: cloudHeaders });
        const pages = pageListData.pages || [];
        for (const pg of pages) {
          if (!pg.id) continue;
          const issuesData = await _apiRequest(
            `${apiBase}/a11y/tests/runs/${runId}/pages/${pg.id}/issues?manual=true&comments=true`,
            { headers: cloudHeaders }
          );
          const payload = issuesData.issuesData || issuesData;
          const issues = payload.issues || [];
          for (const issue of issues) {
            issue._aqa_context = {
              type: 'playwright',
              pageUrl: pg.url || urls[0],
              scanMethod: 'aqa-extension',
              scanTimestamp: new Date().toISOString(),
              testId,
              runId,
              pageId: pg.id,
            };
          }
          allIssues.push(...issues);
        }
      } catch (err) {
        console.error(`    Failed to fetch page issues: ${err.message}`);
      }
    }

    console.log(`  [aqa] ${allIssues.length} issues found`);

    // Cleanup flow if configured
    if (cleanupFlow) {
      try {
        const flowLookup = await _apiRequest(`${apiBase}/a11y/flows?name=${encodeURIComponent(flowName)}`, { headers: cloudHeaders });
        const matchedFlow = (flowLookup.flows || []).find(f => f.name === flowName);
        if (matchedFlow) {
          await _apiRequest(`${apiBase}/a11y/flows/${matchedFlow.id}`, { method: 'DELETE', headers: cloudHeaders });
          console.log(`  [aqa] Flow ${matchedFlow.id} cleaned up`);
        }
      } catch (err) {
        console.warn(`  [aqa] Flow cleanup failed: ${err.message}`);
      }
    }

    return allIssues;

  } finally {
    await context.close().catch(() => {});
    // Clean up temp user data dir
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan URLs using Playwright with the specified engine.
 *
 * @param {object} config
 * @param {string} config.urls        — comma-separated URLs, file path, or array
 * @param {string} config.scanEngine  — 'axe' (default), 'aqa', 'aqa-main', or 'both'
 * @param {string} config.aqaApiKey   — AQA extension API key (different from cloud API key)
 * @param {string} config.aqaTeamSlug — AQA team slug
 * @param {string} config.aqaSuiteId  — AQA suite ID for test creation
 * @returns {Promise<Array>} Raw issues in AQA-compatible format
 */
async function scanWithPlaywright(config = {}) {
  const { chromium } = require('playwright');
  const URLProcessor = require('../utils/url-processor');

  const engine = config.scanEngine || process.env.AQA_SCAN_ENGINE || 'axe';

  // Process URLs
  const urlsInput = config.urls || process.env.AQA_URLS;
  if (!urlsInput) {
    throw new Error('Playwright scanning requires URLs. Set AQA_URLS or pass urls config.');
  }
  const urls = URLProcessor.processUrls(urlsInput);
  if (urls.length === 0) throw new Error('No valid URLs found.');

  console.log(`\nPlaywright scan — engine: ${engine}, URLs: ${urls.length}`);

  const scanConfig = {
    viewport: { width: 1280, height: 720 },
    timeout: parseInt(process.env.AQA_PLAYWRIGHT_TIMEOUT, 10) || 60000,
    waitAfterLoad: parseInt(process.env.AQA_PLAYWRIGHT_WAIT_AFTER_LOAD, 10) || 3000,
    headless: process.env.AQA_PLAYWRIGHT_HEADLESS === 'true',
    ...config,
  };

  let allIssues = [];

  if (engine === 'axe' || engine === 'both') {
    console.log('\n--- axe-core engine ---');
    const browser = await chromium.launch({ headless: scanConfig.headless });
    try {
      const axeIssues = await _scanWithAxe(urls, browser, scanConfig);
      allIssues.push(...axeIssues);
    } finally {
      await browser.close();
    }
  }

  if (engine === 'aqa' || engine === 'both') {
    console.log('\n--- AQA extension engine ---');
    // AQA engine needs a separate browser launch (persistent context)
    // We pass a dummy browser object; _scanWithAQA handles its own launch
    try {
      const aqaIssues = await _scanWithAQA(urls, { _type: 'chromium' }, scanConfig);
      allIssues.push(...aqaIssues);
    } catch (err) {
      console.error(`AQA engine failed: ${err.message}`);
      if (engine === 'aqa') throw err; // Only throw if aqa-only
    }
  }

  if (engine === 'aqa-main') {
    console.log('\n--- AQA main extension engine ---');
    try {
      const { scanWithAQAMainExtension } = require('./aqa-main-extension');
      const aqaMainIssues = await scanWithAQAMainExtension(urls, scanConfig);
      allIssues.push(...aqaMainIssues);
    } catch (err) {
      console.error(`AQA main extension engine failed: ${err.message}`);
      throw err;
    }
  }

  console.log(`\nTotal issues: ${allIssues.length}`);
  return allIssues;
}

module.exports = { scanWithPlaywright };
