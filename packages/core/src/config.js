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

/**
 * Load per-project scanner config from DB (scanner_config table).
 * Returns an object of { key: value } for the given source.
 */
function loadScannerConfig(source) {
  const { getDb } = require('./db');
  const db = getDb();
  try {
    const rows = db.prepare('SELECT key, value FROM scanner_config WHERE source = ?').all(source);
    const config = {};
    for (const row of rows) {
      config[row.key] = row.value;
    }
    return config;
  } catch (_) {
    return {};
  }
}

/**
 * Save per-project scanner config to DB (scanner_config table).
 * @param {string} source - plugin name
 * @param {object} data - key-value pairs to save
 */
function saveScannerConfig(source, data) {
  const { getDb } = require('./db');
  const db = getDb();
  const upsert = db.prepare(
    'INSERT OR REPLACE INTO scanner_config (source, key, value) VALUES (?, ?, ?)'
  );
  const saveAll = db.transaction(() => {
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== '') {
        upsert.run(source, key, value);
      }
    }
  });
  saveAll();
}

module.exports = {
  getProjectRoot,
  loadCredentials,
  saveCredentials,
  loadScoringConfig,
  loadEffortMap,
  loadScannerConfig,
  saveScannerConfig,
  GLOBAL_CONFIG_DIR,
  CREDENTIALS_FILE,
};
