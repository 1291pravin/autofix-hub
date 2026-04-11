'use strict';

const path = require('path');
const fs = require('fs');

const GLOBAL_CONFIG_DIR = path.join(require('os').homedir(), '.autofix-hub');
const CREDENTIALS_FILE = path.join(GLOBAL_CONFIG_DIR, 'credentials.json');

/**
 * Walk up from cwd looking for .git/ or package.json to find project root.
 */
function getProjectRoot() {
  let dir = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/**
 * Load global credentials from ~/.autofix-hub/credentials.json
 */
function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
}

/**
 * Save credentials to ~/.autofix-hub/credentials.json
 */
function saveCredentials(data) {
  if (!fs.existsSync(GLOBAL_CONFIG_DIR)) {
    fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Load scoring config from config/scoring.json in project root.
 */
function loadScoringConfig() {
  const configPath = path.join(getProjectRoot(), 'config', 'scoring.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Scoring config not found at ${configPath}. Run 'autofix-hub setup' first.`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

/**
 * Load effort map from config/effort-map.json in project root.
 */
function loadEffortMap() {
  const configPath = path.join(getProjectRoot(), 'config', 'effort-map.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Effort map not found at ${configPath}. Run 'autofix-hub setup' first.`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

module.exports = {
  getProjectRoot,
  loadCredentials,
  saveCredentials,
  loadScoringConfig,
  loadEffortMap,
  GLOBAL_CONFIG_DIR,
  CREDENTIALS_FILE,
};
