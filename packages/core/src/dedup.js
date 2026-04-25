'use strict';

const crypto = require('crypto');
const path = require('path');

/**
 * Generate a content-based dedup hash from rule_id, description, and file directory.
 */
function contentHash(issue) {
  const ruleId = issue.rule_id || '';
  const desc = (issue.description || '').trim().toLowerCase();
  const dir = issue.file_path ? path.dirname(issue.file_path) : '';
  return crypto.createHash('md5').update(`${ruleId}|${desc}|${dir}`).digest('hex').slice(0, 16);
}

/**
 * Deduplicate issues against the existing DB.
 * Returns only non-duplicate new issues that should be inserted.
 *
 * @param {object[]} issues - Array of normalized issues (not yet in DB)
 * @param {object} plugin - Plugin instance (unused currently, reserved for plugin-specific dedup)
 * @param {object} db - better-sqlite3 database instance
 * @returns {object[]} issues that are new and not duplicates
 */
function dedupIssues(issues, plugin, db) {
  if (!issues || issues.length === 0) return [];

  const existsById = db.prepare('SELECT id, severity FROM issues WHERE id = ?');
  const existsByDedup = db.prepare('SELECT id, severity FROM issues WHERE dedup_group = ? AND is_duplicate = 0 LIMIT 1');
  const updateDedupGroup = db.prepare('UPDATE issues SET dedup_group = ? WHERE id = ?');
  const markDuplicate = db.prepare('UPDATE issues SET is_duplicate = 1, dedup_group = ? WHERE id = ?');

  const severityRank = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

  const newIssues = [];
  const seenIds = new Set(); // Track IDs we've already processed in this batch
  const seenDedupGroups = new Map(); // Track dedup groups and their best severity

  for (const issue of issues) {
    // 1. Skip if ID already exists in database
    const existing = existsById.get(issue.id);
    if (existing) continue;

    // 2. Skip if we've already seen this ID in the current batch (collision)
    if (seenIds.has(issue.id)) {
      continue; // Skip duplicate ID in current batch
    }
    seenIds.add(issue.id);

    // 3. Content-based dedup
    const hash = contentHash(issue);
    const primary = existsByDedup.get(hash);

    if (primary) {
      // A primary issue with this content hash already exists in DB
      const primaryRank = severityRank[primary.severity] || 0;
      const newRank = severityRank[issue.severity] || 0;

      if (newRank > primaryRank) {
        // New issue is higher severity — it becomes the primary
        // Mark old primary as duplicate
        markDuplicate.run(hash, primary.id);
        issue.dedup_group = hash;
        issue.is_duplicate = 0;
      } else {
        // New issue is same or lower severity — mark it as duplicate
        issue.dedup_group = hash;
        issue.is_duplicate = 1;
      }
    } else {
      // No content duplicate found in DB — check current batch
      const batchBest = seenDedupGroups.get(hash);
      
      if (batchBest) {
        // We've seen this dedup group in current batch
        const bestRank = severityRank[batchBest.severity] || 0;
        const newRank = severityRank[issue.severity] || 0;

        if (newRank > bestRank) {
          // New issue is higher severity — it becomes the primary
          // Mark previous best as duplicate
          batchBest.is_duplicate = 1;
          issue.dedup_group = hash;
          issue.is_duplicate = 0;
          seenDedupGroups.set(hash, issue); // Update best in batch
        } else {
          // New issue is same or lower severity — mark it as duplicate
          issue.dedup_group = hash;
          issue.is_duplicate = 1;
        }
      } else {
        // First time seeing this dedup group
        issue.dedup_group = hash;
        issue.is_duplicate = 0;
        seenDedupGroups.set(hash, issue);
      }
    }

    newIssues.push(issue);
  }

  return newIssues;
}

module.exports = { dedupIssues, contentHash };
