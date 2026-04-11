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
    CREATE INDEX IF NOT EXISTS idx_issue_clusters_cluster_id ON issue_clusters (cluster_id);
    CREATE INDEX IF NOT EXISTS idx_issue_clusters_issue_id ON issue_clusters (issue_id);
  `);
}

/**
 * Backfill the issue_clusters join table from existing cluster_id assignments
 * and re-cluster all issues to establish proper many-to-many relationships.
 * Safe to call multiple times (idempotent).
 */
function migrateIssueClusters() {
  const db = getDb();

  // Check if migration is needed: if issue_clusters is empty but clusters exist
  const clusterCount = db.prepare('SELECT COUNT(*) as cnt FROM clusters').get().cnt;
  const joinCount = db.prepare('SELECT COUNT(*) as cnt FROM issue_clusters').get().cnt;

  if (clusterCount === 0 || joinCount > 0) return; // Nothing to migrate or already done

  // Re-cluster all issues using plugin clusterKeys to get proper many-to-many
  try {
    const { loadPlugins } = require('./pluginLoader');
    const { clusterHash } = require('./clustering');
    const plugins = loadPlugins();

    const insertJoin = db.prepare(
      'INSERT OR IGNORE INTO issue_clusters (issue_id, cluster_id) VALUES (?, ?)'
    );

    const allIssues = db.prepare('SELECT * FROM issues WHERE is_duplicate = 0').all();

    // Hydrate metadata for all issues
    const allMeta = db.prepare('SELECT issue_id, key, value FROM issue_metadata').all();
    const metaMap = new Map();
    for (const row of allMeta) {
      if (!metaMap.has(row.issue_id)) metaMap.set(row.issue_id, {});
      const obj = metaMap.get(row.issue_id);
      try { obj[row.key] = JSON.parse(row.value); } catch (_) { obj[row.key] = row.value; }
    }
    for (const issue of allIssues) {
      issue.metadata = metaMap.get(issue.id) || {};
    }

    const recluster = db.transaction(() => {
      for (const issue of allIssues) {
        const plugin = plugins.get(issue.source);
        if (!plugin || typeof plugin.clusterKeys !== 'function') continue;

        const keys = plugin.clusterKeys(issue);
        if (!keys || keys.length === 0) continue;

        for (const key of keys) {
          const cid = clusterHash(issue.source, key);
          // Only insert into join table for clusters that exist
          const exists = db.prepare('SELECT 1 FROM clusters WHERE id = ?').get(cid);
          if (exists) {
            insertJoin.run(issue.id, cid);
          }
        }
      }

      // Update issue_count from join table for ALL clusters
      db.exec(`
        UPDATE clusters SET issue_count = (
          SELECT COUNT(*) FROM issue_clusters WHERE issue_clusters.cluster_id = clusters.id
        )
      `);

      // Delete stale clusters that have 0 actual issues in the join table
      db.exec('DELETE FROM clusters WHERE issue_count = 0');
    });

    recluster();
  } catch (err) {
    // If re-clustering fails (e.g., plugins not available), fall back to basic backfill
    console.warn(`Warning: Re-clustering migration partial: ${err.message}`);
    // Basic fallback: backfill from cluster_id column
    db.exec(`
      INSERT OR IGNORE INTO issue_clusters (issue_id, cluster_id)
      SELECT id, cluster_id FROM issues WHERE cluster_id IS NOT NULL
    `);
    db.exec(`
      UPDATE clusters SET issue_count = (
        SELECT COUNT(*) FROM issue_clusters WHERE issue_clusters.cluster_id = clusters.id
      )
    `);
    db.exec('DELETE FROM clusters WHERE issue_count = 0');
  }
}

module.exports = { initSchema, migrateIssueClusters };
