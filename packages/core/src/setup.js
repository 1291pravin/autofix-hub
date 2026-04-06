'use strict';

const { getDb } = require('./db');

/**
 * Idempotent schema creation. Safe to call multiple times.
 */
function initSchema() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      rule_id TEXT,
      severity TEXT,
      category TEXT,
      status TEXT DEFAULT 'open',
      review_level TEXT,
      file_path TEXT,
      line_number INTEGER,
      description TEXT,
      fix_prompt TEXT,
      fix_branch TEXT,
      fix_pr_url TEXT,
      reviewed_by TEXT,
      rejected_reason TEXT,
      created_at TEXT,
      updated_at TEXT,
      resolved_at TEXT,
      impact_score REAL,
      estimated_effort TEXT,
      estimated_minutes INTEGER,
      cluster_id TEXT,
      dedup_group TEXT,
      is_duplicate INTEGER DEFAULT 0,
      prompt_version TEXT,
      scanner_data TEXT
    );

    CREATE TABLE IF NOT EXISTS issue_metadata (
      issue_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (issue_id, key)
    );

    CREATE TABLE IF NOT EXISTS fix_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id TEXT NOT NULL,
      attempt_number INTEGER,
      status TEXT,
      diff_content TEXT,
      error_log TEXT,
      attempted_by TEXT,
      attempted_at TEXT,
      prompt_version TEXT
    );

    CREATE TABLE IF NOT EXISTS scan_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT,
      ran_at TEXT,
      issues_found INTEGER,
      new_issues INTEGER,
      reopened INTEGER
    );

    CREATE TABLE IF NOT EXISTS clusters (
      id TEXT PRIMARY KEY,
      source TEXT,
      cluster_key TEXT,
      root_cause TEXT,
      issue_count INTEGER,
      status TEXT,
      fix_branch TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS rejection_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT,
      rule_id TEXT,
      pattern_tag TEXT,
      description TEXT,
      occurrences INTEGER DEFAULT 0,
      last_seen_at TEXT,
      negative_prompt_clause TEXT
    );

    CREATE TABLE IF NOT EXISTS auto_approve_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id TEXT,
      decision TEXT,
      reason TEXT,
      diff_stats TEXT,
      decided_at TEXT
    );

    CREATE TABLE IF NOT EXISTS locks (
      file_path TEXT PRIMARY KEY,
      locked_by TEXT,
      locked_at TEXT,
      expires_at TEXT
    );
  `);

  // Create indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_issues_source_status ON issues (source, status);
    CREATE INDEX IF NOT EXISTS idx_issues_impact_score ON issues (impact_score);
    CREATE INDEX IF NOT EXISTS idx_issues_cluster_id ON issues (cluster_id);
    CREATE INDEX IF NOT EXISTS idx_issues_dedup_group ON issues (dedup_group);
    CREATE INDEX IF NOT EXISTS idx_fix_attempts_issue_id ON fix_attempts (issue_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rejection_patterns_unique
      ON rejection_patterns (source, rule_id, pattern_tag);
    CREATE INDEX IF NOT EXISTS idx_locks_expires_at ON locks (expires_at);
  `);
}

module.exports = { initSchema };
