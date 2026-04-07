'use strict';

/**
 * DEPRECATED — Extension management is handled by playwright/index.js orchestrator.
 *
 * The AQA Page Capture extension (ID: llaaiankjgnonjipogopofnpahaoccfo) must be
 * placed manually at:
 *   packages/plugin-aqa/extensions/aqa-page-capture/
 *
 * It is a licensed extension and cannot be auto-downloaded from the Chrome Web Store.
 * Obtain it from your UsableNet account or the reference repo.
 */

const path = require('path');
const fs = require('fs');

const EXTENSION_DIR = path.join(__dirname, '../../extensions/aqa-page-capture');

function isExtensionAvailable() {
  return fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'));
}

function getExtensionPath() {
  return EXTENSION_DIR;
}

module.exports = { isExtensionAvailable, getExtensionPath, EXTENSION_DIR };
