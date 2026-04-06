'use strict';

const crypto = require('crypto');

/**
 * Generate a deterministic cluster ID from source + key.
 */
function clusterHash(source, key) {
  return crypto.createHash('md5').update(`${source}:${key}`).digest('hex').slice(0, 16);
}

/**
 * Cluster issues using plugin-provided cluster keys.
 * Groups issues by shared cluster keys, upserts cluster rows,
 * and updates each issue's cluster_id in the DB.
 *
 * @param {object[]} issues - Array of normalized issues (already in DB)
 * @param {object} plugin - Plugin instance (must export clusterKeys)
 * @param {object} db - better-sqlite3 database instance
 */
function clusterIssues(issues, plugin, db) {
  if (!issues || issues.length === 0) return;
  if (typeof plugin.clusterKeys !== 'function') return;

  // Map: cluster_id → { key, issueIds[] }
  const clusters = new Map();

  for (const issue of issues) {
    const keys = plugin.clusterKeys(issue);
    if (!keys || keys.length === 0) continue;

    for (const key of keys) {
      const cid = clusterHash(issue.source, key);
      if (!clusters.has(cid)) {
        clusters.set(cid, { key, source: issue.source, issueIds: [] });
      }
      clusters.get(cid).issueIds.push(issue.id);
    }
  }

  const upsertCluster = db.prepare(`
    INSERT INTO clusters (id, source, cluster_key, issue_count, status, created_at)
    VALUES (?, ?, ?, ?, 'open', ?)
    ON CONFLICT(id) DO UPDATE SET
      issue_count = excluded.issue_count,
      cluster_key = excluded.cluster_key
  `);

  const updateIssueCluster = db.prepare(`
    UPDATE issues SET cluster_id = ? WHERE id = ?
  `);

  const now = new Date().toISOString();

  const applyAll = db.transaction(() => {
    for (const [cid, data] of clusters) {
      // Only create clusters for 2+ issues
      if (data.issueIds.length < 2) continue;

      upsertCluster.run(cid, data.source, data.key, data.issueIds.length, now);

      for (const issueId of data.issueIds) {
        updateIssueCluster.run(cid, issueId);
      }
    }
  });

  applyAll();
}

module.exports = { clusterIssues, clusterHash };
