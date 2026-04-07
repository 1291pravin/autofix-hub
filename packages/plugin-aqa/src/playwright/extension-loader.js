'use strict';

/**
 * DEPRECATED — Extension loading is handled by playwright/index.js orchestrator.
 *
 * The orchestrator launches a Playwright persistent context with the AQA Page
 * Capture extension, waits for its service worker, and communicates via
 * chrome.runtime.sendMessage.
 *
 * This file is kept as a stub for backward compatibility.
 */

module.exports = {};
