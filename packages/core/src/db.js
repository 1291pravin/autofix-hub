'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let dbInstance = null;

/**
 * Find project root by walking up from cwd looking for .git/ or package.json
 */
function findProjectRoot(startDir) {
  let dir = startDir || process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return process.cwd();
    }
    dir = parent;
  }
}

/**
 * Get singleton DB connection for current project.
 * DB stored at <project-root>/.autofix-hub/issues.db
 */
function getDb() {
  if (dbInstance) return dbInstance;

  const projectRoot = findProjectRoot();
  const dbDir = path.join(projectRoot, '.autofix-hub');

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = path.join(dbDir, 'issues.db');
  dbInstance = new Database(dbPath);

  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');

  return dbInstance;
}

/**
 * Close DB connection for clean shutdown.
 */
function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

module.exports = { getDb, closeDb, findProjectRoot };
