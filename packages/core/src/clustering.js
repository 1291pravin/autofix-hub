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
  // Track all clusters each issue belongs to, so we pick the largest
  const issueClusterMap = new Map(); // issue_id → Set<cluster_id>

  for (const issue of issues) {
    const keys = plugin.clusterKeys(issue);
    if (!keys || keys.length === 0) continue;

    for (const key of keys) {
      const cid = clusterHash(issue.source, key);
      if (!clusters.has(cid)) {
        clusters.set(cid, { key, source: issue.source, issueIds: [] });
      }
      clusters.get(cid).issueIds.push(issue.id);

      if (!issueClusterMap.has(issue.id)) issueClusterMap.set(issue.id, new Set());
      issueClusterMap.get(issue.id).add(cid);
    }
  }

  const upsertCluster = db.prepare(`
    INSERT INTO clusters (id, source, cluster_key, issue_count, status, created_at)
    VALUES (?, ?, ?, ?, 'open', ?)
    ON CONFLICT(id) DO UPDATE SET
      cluster_key = excluded.cluster_key
  `);

  const updateIssueCluster = db.prepare(`
    UPDATE issues SET cluster_id = ? WHERE id = ?
  `);

  const insertJoin = db.prepare(`
    INSERT OR IGNORE INTO issue_clusters (issue_id, cluster_id) VALUES (?, ?)
  `);

  const now = new Date().toISOString();

  const applyAll = db.transaction(() => {
    // Collect valid cluster IDs (2+ issues in this batch)
    const validClusterIds = new Set();

    for (const [cid, data] of clusters) {
      // Only create clusters for 2+ issues
      if (data.issueIds.length < 2) continue;

      validClusterIds.add(cid);
      upsertCluster.run(cid, data.source, data.key, data.issueIds.length, now);

      for (const issueId of data.issueIds) {
        insertJoin.run(issueId, cid);
      }
    }

    // Recalculate issue_count from the join table for accuracy (includes old + new issues)
    if (validClusterIds.size > 0) {
      const clusterIds = Array.from(validClusterIds);
      const ph = clusterIds.map(() => '?').join(',');
      db.prepare(`
        UPDATE clusters SET issue_count = (
          SELECT COUNT(*) FROM issue_clusters WHERE issue_clusters.cluster_id = clusters.id
        ) WHERE id IN (${ph})
      `).run(...clusterIds);
    }

    // Set each issue's denormalized cluster_id to its largest cluster
    for (const [issueId, cidSet] of issueClusterMap) {
      let bestCid = null;
      let bestCount = 0;
      for (const cid of cidSet) {
        if (!validClusterIds.has(cid)) continue;
        const data = clusters.get(cid);
        if (data && data.issueIds.length > bestCount) {
          bestCount = data.issueIds.length;
          bestCid = cid;
        }
      }
      if (bestCid) {
        updateIssueCluster.run(bestCid, issueId);
      }
    }
  });

  applyAll();
}

module.exports = { clusterIssues, clusterHash };
