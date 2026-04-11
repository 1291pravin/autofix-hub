'use strict';

/**
 * Extension Loading & Communication Utilities for the Main UsableNet AQA Extension.
 *
 * Extension ID: lcoodjnlebepmajggdbmapnofedgiloa
 * Extension Name: "UsableNet AQA"
 *
 * Architecture (discovered from extension source analysis):
 *   - The extension injects _AQAExt_.Analyzer into every page via content scripts
 *   - _AQAExt_.Analyzer.snapshot() captures a DOM snapshot of the page
 *   - The DevTools panel sends this snapshot to the AQA cloud API:
 *       POST https://api-aqa.usablenet.com/{teamSlug}/evaluateWebPage?lang=en
 *       Header: X-Team: {apiKey}
 *   - The API returns evaluation results (issues)
 *
 * This module handles:
 *   - Launching Chromium with the main AQA extension loaded (persistent context)
 *   - Waiting for _AQAExt_.Analyzer to be injected into the page
 *   - Capturing DOM snapshots via _AQAExt_.Analyzer.snapshot()
 *   - Sending snapshots to the AQA evaluateWebPage API
 *   - Parsing evaluation results
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

// Main AQA extension (NOT the Page Capture extension)
const AQA_MAIN_EXTENSION_ID = 'lcoodjnlebepmajggdbmapnofedgiloa';
const AQA_MAIN_EXTENSION_DIR = path.join(__dirname, '../../extensions/main-aqa-extension');

// AQA API defaults
const AQA_API_HOST = 'api-aqa.usablenet.com';
const AQA_API_BASE = '/v3.1';

// Timeout for _AQAExt_.Analyzer to be injected by the content script (ms)
const ANALYZER_INJECT_TIMEOUT = 15000;

/**
 * Check if the main AQA extension is available on disk.
 *
 * @returns {{ available: boolean, path: string, message: string }}
 */
function isExtensionAvailable() {
  const manifestPath = path.join(AQA_MAIN_EXTENSION_DIR, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    return {
      available: true,
      path: AQA_MAIN_EXTENSION_DIR,
      message: 'Main AQA extension found',
    };
  }
  return {
    available: false,
    path: AQA_MAIN_EXTENSION_DIR,
    message: [
      `Main AQA extension not found at ${AQA_MAIN_EXTENSION_DIR}`,
      '',
      'To use the aqa-main engine:',
      '1. Install the "UsableNet AQA" extension in Chrome (ID: lcoodjnlebepmajggdbmapnofedgiloa)',
      '2. Copy the unpacked extension files to:',
      `   ${AQA_MAIN_EXTENSION_DIR}/`,
      '',
      'See: packages/plugin-aqa/extensions/main-aqa-extension/README.md',
    ].join('\n'),
  };
}

/**
 * Launch a Chromium persistent context with the main AQA extension loaded.
 *
 * @param {object} options
 * @param {object} options.viewport - Browser viewport dimensions
 * @returns {Promise<{ context: BrowserContext, userDataDir: string }>}
 */
async function launchWithExtension(options = {}) {
  const { chromium } = require('playwright');

  const extensionCheck = isExtensionAvailable();
  if (!extensionCheck.available) {
    throw new Error(extensionCheck.message);
  }

  const extensionDir = extensionCheck.path;
  const userDataDir = path.join(os.tmpdir(), `aqa-main-${Date.now()}`);

  console.log(`  [aqa-main] Launching browser with main AQA extension...`);
  console.log(`  [aqa-main] Extension dir: ${extensionDir}`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // Extensions require headed mode
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
    viewport: options.viewport || { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    ignoreDefaultArgs: ['--disable-extensions'],
  });

  return { context, userDataDir };
}

/**
 * Wait for the extension's service worker to register and return its extensionId.
 *
 * @param {BrowserContext} context - Playwright browser context
 * @param {number} timeout - Max time to wait in ms
 * @returns {Promise<string>} The extension ID
 */
async function waitForExtensionServiceWorker(context, timeout = 30000) {
  console.log(`  [aqa-main] Waiting for extension service worker...`);
  const deadline = Date.now() + timeout;
  let extensionId = null;

  while (Date.now() < deadline) {
    for (const sw of context.serviceWorkers()) {
      const swUrl = sw.url();
      if (swUrl.includes('chrome-extension://')) {
        extensionId = swUrl.match(/chrome-extension:\/\/([a-z]+)/)?.[1];
        if (extensionId) break;
      }
    }
    if (extensionId) break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (!extensionId) {
    throw new Error(
      `AQA extension service worker not found within ${timeout / 1000}s. ` +
      'Ensure the extension is properly unpacked and manifest.json is valid.'
    );
  }

  console.log(`  [aqa-main] Extension loaded: ${extensionId}`);
  return extensionId;
}

/**
 * Get the service worker (background script) for the AQA extension.
 *
 * @param {BrowserContext} context - Playwright browser context
 * @param {string} extensionId - The extension ID
 * @returns {Worker|null} The service worker, or null
 */
function getServiceWorker(context, extensionId) {
  for (const sw of context.serviceWorkers()) {
    if (sw.url().includes(extensionId)) return sw;
  }
  return null;
}

/**
 * Read the extension's stored configuration from chrome.storage.sync.
 * The extension stores: api_key (userKey), teamslug, lang, userApiDomain, etc.
 *
 * @param {BrowserContext} context - Playwright browser context
 * @param {string} extensionId - The extension ID
 * @returns {Promise<object|null>} Extension config or null
 */
async function getExtensionStorageConfig(context, extensionId) {
  const bgWorker = getServiceWorker(context, extensionId);
  if (!bgWorker) return null;

  try {
    const config = await bgWorker.evaluate(async () => {
      return new Promise((resolve) => {
        chrome.storage.sync.get(null, (items) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(items);
        });
      });
    });
    return config;
  } catch (err) {
    console.warn(`    Could not read extension storage: ${err.message}`);
    return null;
  }
}

/**
 * Capture a DOM snapshot using the extension's content script.
 *
 * The extension only auto-injects inspectFrame.js and shadow-root-init.js.
 * The heavy scripts (analyzer.js + main.js) that provide _AQAExt_.Analyzer
 * and the get-snapshot handler are injected ON-DEMAND by the DevTools panel
 * via chrome.scripting.executeScript().
 *
 * So we must:
 *   1. Find the tab ID for the page
 *   2. Inject analyzer.js + main.js via chrome.scripting.executeScript()
 *   3. Send {action: "get-snapshot"} via chrome.tabs.sendMessage()
 *   4. The content script calls _AQAExt_.Analyzer.snapshot() and returns HTML
 *
 * @param {BrowserContext} context - Playwright browser context
 * @param {Page} page - The page to snapshot
 * @param {string} extensionId - The extension ID
 * @param {number} timeout - Max time to wait (ms)
 * @returns {Promise<string|null>} HTML snapshot string, or null on failure
 */
async function captureSnapshot(context, page, extensionId, timeout = ANALYZER_INJECT_TIMEOUT) {
  console.log(`    Capturing DOM snapshot via extension content script...`);

  const bgWorker = getServiceWorker(context, extensionId);
  if (!bgWorker) {
    console.warn(`    Service worker not found for ${extensionId}`);
    return null;
  }

  // Step 1: Get the tab ID for this page
  const tabId = await bgWorker.evaluate(async (pageUrl) => {
    const tabs = await chrome.tabs.query({});
    // Match on URL prefix (ignore hash/query params)
    const baseUrl = pageUrl.split('#')[0].split('?')[0];
    const tab = tabs.find(t => t.url && t.url.startsWith(baseUrl));
    return tab ? tab.id : null;
  }, page.url()).catch(err => {
    console.warn(`    Failed to get tabId: ${err.message}`);
    return null;
  });

  if (!tabId) {
    console.warn(`    Could not find tab ID for ${page.url()}`);
    return null;
  }

  console.log(`    Tab ID: ${tabId}`);

  // Step 2: Inject analyzer.js and main.js into the page
  // These are normally injected by the DevTools panel on-demand
  console.log(`    Injecting analyzer.js + main.js into page...`);
  try {
    await bgWorker.evaluate(async (tid) => {
      await chrome.scripting.executeScript({
        target: { tabId: tid, allFrames: false },
        files: ['content_scripts/analyzer.js'],
      });
      await chrome.scripting.executeScript({
        target: { tabId: tid, allFrames: false },
        files: ['content_scripts/main.js'],
      });
    }, tabId);
    console.log(`    Scripts injected successfully`);
  } catch (err) {
    console.warn(`    Script injection failed: ${err.message}`);
    return null;
  }

  // Give injected scripts a moment to initialize
  await new Promise(r => setTimeout(r, 2000));

  // Step 3: Send get-snapshot to the content script
  console.log(`    Sending get-snapshot...`);
  const deadline = Date.now() + timeout;
  let snapshot = null;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      snapshot = await bgWorker.evaluate(async (tid) => {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ error: 'Snapshot timed out after 30s' }), 30000);
          chrome.tabs.sendMessage(tid, { action: 'get-snapshot' }, (response) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              resolve({ error: chrome.runtime.lastError.message });
              return;
            }
            resolve(response);
          });
        });
      }, tabId);

      if (snapshot && typeof snapshot === 'string' && snapshot.length > 100) {
        console.log(`    Snapshot captured: ${(snapshot.length / 1024).toFixed(1)} KB`);
        return snapshot;
      }
      if (snapshot && snapshot.error) {
        lastError = snapshot.error;
        // Content script may not be ready yet — retry
        if (snapshot.error.includes('Receiving end does not exist') ||
            snapshot.error.includes('Could not establish connection') ||
            snapshot.error.includes('message port closed')) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        console.warn(`    Snapshot error: ${snapshot.error}`);
      }
    } catch (err) {
      lastError = err.message;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  console.warn(`    Failed to capture snapshot. Last error: ${lastError || 'unknown'}`);
  return null;
}

/**
 * Send a DOM snapshot to the AQA evaluateWebPage API for evaluation.
 *
 * Replicates the exact DevTools panel protocol (from bundle analysis):
 *   1. Zip the HTML snapshot into code.html using JSZip (DEFLATE)
 *   2. Build FormData with: type, manual, a11ydoc, tool, toolid, codeurl, archive, descriptions
 *   3. POST https://{host}/audit/{teamSlug}/plugin/v2/evaluateWebPage?lang={lang}
 *   4. Header: X-User-Key: {apiKey}
 *
 * @param {string} snapshot - HTML snapshot from _AQAExt_.Analyzer.snapshot()
 * @param {object} config
 * @param {string} config.apiKey - AQA API key (X-User-Key header)
 * @param {string} config.teamSlug - AQA team slug
 * @param {string} config.pageUrl - The URL of the scanned page (codeurl field)
 * @param {string} config.apiHost - API hostname (default: api-aqa.usablenet.com)
 * @param {string} config.lang - Language for evaluation (default: 'en')
 * @param {string} config.ruleset - Ruleset type (default: 'wcag22')
 * @returns {Promise<object>} API response with evaluation results
 */
async function evaluateSnapshot(snapshot, config) {
  const JSZip = require('jszip');

  const apiKey = config.apiKey || config.user_api_key || config.api_key;
  const teamSlug = config.teamSlug || config.team_slug;
  const apiHost = config.apiHost || AQA_API_HOST;
  const lang = config.lang || 'en';
  const ruleset = config.ruleset || 'wcag22';
  const pageUrl = config.pageUrl || 'unknown';

  if (!apiKey) {
    throw new Error(
      'AQA API key is required for aqa engine.\n' +
      'Pass --api-key or configure it in Settings.'
    );
  }
  if (!teamSlug) {
    throw new Error(
      'AQA team slug is required for aqa engine.\n' +
      'Pass --team-slug or set AQA_TEAM_SLUG in your .env file.'
    );
  }

  // Step 1: Zip the snapshot HTML into code.html (matches extension's xe() function)
  console.log(`    Zipping snapshot (${(snapshot.length / 1024).toFixed(1)} KB)...`);
  const zip = new JSZip();
  zip.file('code.html', snapshot);
  const archiveBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 5 },
  });
  console.log(`    Zipped to ${(archiveBuffer.length / 1024).toFixed(1)} KB`);

  // Step 2: Build multipart form data (matches extension's ke() function)
  const boundary = '----AQAFormBoundary' + Date.now().toString(36);
  const formParts = [];

  const fields = {
    type: ruleset,
    manual: 'true',
    a11ydoc: 'true',
    tool: 'chrome',
    toolid: 'autofix-hub',
    codeurl: pageUrl,
    descriptions: 'new',
  };

  for (const [key, value] of Object.entries(fields)) {
    formParts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
      `${value}\r\n`
    );
  }

  // Add the zip archive as a binary part
  const archivePart = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="archive"; filename="code.zip"\r\n` +
      `Content-Type: application/zip\r\n\r\n`
    ),
    archiveBuffer,
    Buffer.from('\r\n'),
  ]);

  const bodyParts = Buffer.concat([
    Buffer.from(formParts.join('')),
    archivePart,
    Buffer.from(`--${boundary}--\r\n`),
  ]);

  // Step 3: POST to the API
  const apiPath = `/audit/${teamSlug}/plugin/v2/evaluateWebPage?lang=${lang}`;
  console.log(`    Sending to AQA API: https://${apiHost}${apiPath}`);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: apiHost,
      port: 443,
      path: apiPath,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyParts.length,
        'X-User-Key': apiKey,
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => { chunks.push(chunk); });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        console.log(`    API response: ${res.statusCode} (${body.length} bytes)`);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Failed to parse API response: ${err.message}\nBody: ${body.slice(0, 500)}`));
          }
        } else {
          reject(new Error(`AQA API returned ${res.statusCode}: ${body.slice(0, 1000)}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`AQA API request failed: ${err.message}`));
    });

    req.write(bodyParts);
    req.end();
  });
}

/**
 * Clean up: close context and remove temp user data directory.
 *
 * @param {BrowserContext} context
 * @param {string} userDataDir
 */
async function cleanup(context, userDataDir) {
  try {
    await context.close();
  } catch (_) { /* ignore */ }
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
}

module.exports = {
  AQA_MAIN_EXTENSION_ID,
  AQA_MAIN_EXTENSION_DIR,
  AQA_API_HOST,
  AQA_API_BASE,
  ANALYZER_INJECT_TIMEOUT,
  isExtensionAvailable,
  launchWithExtension,
  waitForExtensionServiceWorker,
  getServiceWorker,
  getExtensionStorageConfig,
  captureSnapshot,
  evaluateSnapshot,
  cleanup,
};
