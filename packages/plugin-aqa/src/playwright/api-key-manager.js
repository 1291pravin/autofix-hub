'use strict';

/**
 * DEPRECATED — Credential injection is handled by playwright/index.js orchestrator.
 *
 * The AQA Page Capture extension authenticates via the X-Team HTTP header,
 * not via chrome.storage.local injection. The orchestrator passes the
 * AQA_EXTENSION_API_KEY through the AQA cloud API directly.
 *
 * This file is kept as a stub for backward compatibility.
 */

module.exports = {};
