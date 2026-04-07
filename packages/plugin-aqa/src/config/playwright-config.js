'use strict';

/**
 * DEPRECATED — The playwright/index.js orchestrator reads env vars directly.
 *
 * This stub is kept for backward compatibility only.  The orchestrator honours:
 *   AQA_PLAYWRIGHT_HEADLESS, AQA_PLAYWRIGHT_TIMEOUT, AQA_PLAYWRIGHT_WAIT_AFTER_LOAD,
 *   AQA_SCAN_ENGINE (axe | aqa | both), AQA_URLS
 */

class PlaywrightConfig {
  getConfig(userConfig = {}) {
    return {
      browser: {
        headless: process.env.AQA_PLAYWRIGHT_HEADLESS === 'true',
        viewport: { width: 1280, height: 720 },
      },
      scan: {
        timeout: parseInt(process.env.AQA_PLAYWRIGHT_TIMEOUT, 10) || 60000,
        waitTime: parseInt(process.env.AQA_PLAYWRIGHT_WAIT_AFTER_LOAD, 10) || 3000,
        scanLevel: 'standard',
        concurrency: 3,
        includeScreenshots: true,
      },
      page: {
        timeout: parseInt(process.env.AQA_PLAYWRIGHT_TIMEOUT, 10) || 60000,
      },
      auth: { type: null },
      output: { format: 'aqa' },
      ...userConfig,
    };
  }

  printConfigSummary(config) {
    const b = config.browser || {};
    const s = config.scan || {};
    console.log(`\n=== AQA Playwright Configuration ===`);
    console.log(`Browser: ${b.headless ? 'Headless' : 'Headed'} (${b.viewport?.width || 1280}x${b.viewport?.height || 720})`);
    console.log(`Scan Level: ${s.scanLevel || 'standard'}`);
    console.log(`Timeout: ${s.timeout || 60000}ms, Wait Time: ${s.waitTime || 3000}ms`);
    console.log(`Concurrency: ${s.concurrency || 3}`);
    console.log(`Screenshots: ${s.includeScreenshots !== false ? 'Enabled' : 'Disabled'}`);
    console.log(`Auth: ${config.auth?.type || 'None'}`);
    console.log(`Output Format: ${config.output?.format || 'aqa'}`);
    console.log(`=====================================\n`);
  }
}

module.exports = PlaywrightConfig;
