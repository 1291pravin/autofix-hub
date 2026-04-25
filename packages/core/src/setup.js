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
      created_at TEXT,
      tier TEXT DEFAULT 'exact'
    );

    CREATE TABLE IF NOT EXISTS issue_clusters (
      issue_id TEXT NOT NULL,
      cluster_id TEXT NOT NULL,
      PRIMARY KEY (issue_id, cluster_id)
    );

    CREATE TABLE IF NOT EXISTS rejection_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT,
      rule_id TEXT,
      pattern_tag TEXT,
      description TEXT,
      occurrences INTEGER DEFAULT 0,
      first_seen_at TEXT,
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

    CREATE TABLE IF NOT EXISTS scanner_config (
      source TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (source, key)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      source TEXT,
      started_at TEXT,
      ended_at TEXT,
      status TEXT DEFAULT 'active',
      meta TEXT
    );

    CREATE TABLE IF NOT EXISTS clubs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      source TEXT NOT NULL,
      category TEXT,
      rule_id TEXT,
      common_dir TEXT,
      issue_count INTEGER,
      files_count INTEGER,
      lines_est INTEGER,
      status TEXT DEFAULT 'proposed',
      branch TEXT,
      worktree_path TEXT,
      pr_url TEXT,
      abandon_reason TEXT,
      gate_result TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS club_issues (
      club_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      PRIMARY KEY (club_id, issue_id)
    );
  `);

  // ALTER migrations for pre-existing DBs created before a column existed.
  const clusterCols = db.prepare("PRAGMA table_info(clusters)").all().map(c => c.name);
  if (!clusterCols.includes('tier')) {
    db.exec(`ALTER TABLE clusters ADD COLUMN tier TEXT DEFAULT 'exact'`);
    // Invalidate old cluster data so tier-aware rebuild can run cleanly.
    // migrateIssueClusters will repopulate from current plugin clusterKeys.
    db.exec('DELETE FROM issue_clusters');
    db.exec('DELETE FROM clusters');
    db.exec('UPDATE issues SET cluster_id = NULL');
  }

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
    CREATE INDEX IF NOT EXISTS idx_issue_clusters_cluster_id ON issue_clusters (cluster_id);
    CREATE INDEX IF NOT EXISTS idx_issue_clusters_issue_id ON issue_clusters (issue_id);
    CREATE INDEX IF NOT EXISTS idx_clusters_source_tier ON clusters (source, tier);
    CREATE INDEX IF NOT EXISTS idx_clubs_session ON clubs (session_id);
    CREATE INDEX IF NOT EXISTS idx_clubs_status ON clubs (status);
    CREATE INDEX IF NOT EXISTS idx_club_issues_issue ON club_issues (issue_id);
  `);
}

/**
 * Backfill the issue_clusters join table from existing cluster_id assignments
 * and re-cluster all issues to establish proper many-to-many relationships.
 * Safe to call multiple times (idempotent).
 */
function migrateIssueClusters() {
  const db = getDb();

  // Skip if the join table is already populated — clustering has been done.
  // We run when join is empty AND there are issues to (re-)cluster.
  const joinCount = db.prepare('SELECT COUNT(*) as cnt FROM issue_clusters').get().cnt;
  if (joinCount > 0) return;

  const issueCount = db.prepare('SELECT COUNT(*) as cnt FROM issues WHERE is_duplicate = 0').get().cnt;
  if (issueCount === 0) return;

  try {
    const { loadPlugins } = require('./pluginLoader');
    const { clusterIssues } = require('./clustering');
    const plugins = loadPlugins();

    const allIssues = db.prepare('SELECT * FROM issues WHERE is_duplicate = 0').all();

    // Hydrate metadata so plugin clusterKeys() can read from issue.metadata
    const allMeta = db.prepare('SELECT issue_id, key, value FROM issue_metadata').all();
    const metaMap = new Map();
    for (const row of allMeta) {
      if (!metaMap.has(row.issue_id)) metaMap.set(row.issue_id, {});
      const obj = metaMap.get(row.issue_id);
      try { obj[row.key] = JSON.parse(row.value); } catch (_) { obj[row.key] = row.value; }
    }

    const bySource = new Map();
    for (const issue of allIssues) {
      issue.metadata = metaMap.get(issue.id) || {};
      if (!bySource.has(issue.source)) bySource.set(issue.source, []);
      bySource.get(issue.source).push(issue);
    }

    for (const [source, issues] of bySource) {
      const plugin = plugins.get(source);
      if (!plugin || typeof plugin.clusterKeys !== 'function') continue;
      clusterIssues(issues, plugin, db);
    }

    // Drop clusters that still have zero members after rebuild
    db.exec('DELETE FROM clusters WHERE issue_count = 0');
  } catch (err) {
    console.warn(`Warning: cluster rebuild skipped: ${err.message}`);
  }
}

module.exports = { initSchema, migrateIssueClusters };
