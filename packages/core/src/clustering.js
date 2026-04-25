'use strict';

const crypto = require('crypto');

const TIER_RANK = { exact: 2, tight: 1 };

function clusterHash(source, key) {
  return crypto.createHash('md5').update(`${source}:${key}`).digest('hex').slice(0, 16);
}

/**
 * Accept entries as either bare strings (legacy, treated as 'exact')
 * or objects `{ key, tier }`. Invalid entries are dropped.
 */
function normalizeEntry(entry) {
  if (typeof entry === 'string') {
    return entry ? { key: entry, tier: 'exact' } : null;
  }
  if (entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key) {
    const tier = TIER_RANK[entry.tier] ? entry.tier : 'exact';
    return { key: entry.key, tier };
  }
  return null;
}

/**
 * Cluster issues using plugin-provided cluster keys.
 * Each issue may belong to multiple clusters via tagged tiers (exact > tight).
 * The denormalized issues.cluster_id picks the highest-tier cluster the issue
 * belongs to, breaking ties by cluster size.
 */
function clusterIssues(issues, plugin, db) {
  if (!issues || issues.length === 0) return;
  if (typeof plugin.clusterKeys !== 'function') return;

  // cluster_id → { key, source, tier, issueIds[] }
  const clusters = new Map();
  // issue_id → Set<cluster_id>
  const issueClusterMap = new Map();

  for (const issue of issues) {
    const rawKeys = plugin.clusterKeys(issue);
    if (!rawKeys || rawKeys.length === 0) continue;

    for (const raw of rawKeys) {
      const entry = normalizeEntry(raw);
      if (!entry) continue;

      const cid = clusterHash(issue.source, entry.key);
      if (!clusters.has(cid)) {
        clusters.set(cid, { key: entry.key, source: issue.source, tier: entry.tier, issueIds: [] });
      } else {
        // If the same cid is reached via multiple tiers, keep the strongest one
        const existing = clusters.get(cid);
        if ((TIER_RANK[entry.tier] || 0) > (TIER_RANK[existing.tier] || 0)) {
          existing.tier = entry.tier;
        }
      }
      clusters.get(cid).issueIds.push(issue.id);

      if (!issueClusterMap.has(issue.id)) issueClusterMap.set(issue.id, new Set());
      issueClusterMap.get(issue.id).add(cid);
    }
  }

  const upsertCluster = db.prepare(`
    INSERT INTO clusters (id, source, cluster_key, tier, issue_count, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'open', ?)
    ON CONFLICT(id) DO UPDATE SET
      cluster_key = excluded.cluster_key,
      tier = excluded.tier
  `);

  const updateIssueCluster = db.prepare(`UPDATE issues SET cluster_id = ? WHERE id = ?`);
  const insertJoin = db.prepare(`
    INSERT OR IGNORE INTO issue_clusters (issue_id, cluster_id) VALUES (?, ?)
  `);

  const now = new Date().toISOString();

  const applyAll = db.transaction(() => {
    const validClusterIds = new Set();

    for (const [cid, data] of clusters) {
      if (data.issueIds.length < 2) continue;
      validClusterIds.add(cid);
      upsertCluster.run(cid, data.source, data.key, data.tier, data.issueIds.length, now);
      for (const issueId of data.issueIds) {
        insertJoin.run(issueId, cid);
      }
    }

    if (validClusterIds.size > 0) {
      const ids = Array.from(validClusterIds);
      const ph = ids.map(() => '?').join(',');
      db.prepare(`
        UPDATE clusters SET issue_count = (
          SELECT COUNT(*) FROM issue_clusters WHERE issue_clusters.cluster_id = clusters.id
        ) WHERE id IN (${ph})
      `).run(...ids);
    }

    // Denormalize: each issue's cluster_id = highest-tier cluster it belongs to,
    // tiebreak by larger membership.
    for (const [issueId, cidSet] of issueClusterMap) {
      let bestCid = null, bestRank = -1, bestCount = 0;
      for (const cid of cidSet) {
        if (!validClusterIds.has(cid)) continue;
        const data = clusters.get(cid);
        const rank = TIER_RANK[data.tier] || 0;
        const count = data.issueIds.length;
        if (rank > bestRank || (rank === bestRank && count > bestCount)) {
          bestRank = rank;
          bestCount = count;
          bestCid = cid;
        }
      }
      if (bestCid) updateIssueCluster.run(bestCid, issueId);
    }
  });

  applyAll();
}

module.exports = { clusterIssues, clusterHash, TIER_RANK };
