'use strict';

const { getDb } = require('./db');
const { initSchema } = require('./setup');

/**
 * Mean Time To Fix: average duration from created_at to resolved_at.
 * Filters: source, severity, rule_id.
 * Returns result in hours.
 */
function getMTTF(filters = {}) {
  const db = getDb();
  initSchema();

  const where = ['resolved_at IS NOT NULL'];
  const params = [];

  if (filters.source) {
    where.push('source = ?');
    params.push(filters.source);
  }
  if (filters.severity) {
    where.push('severity = ?');
    params.push(filters.severity);
  }
  if (filters.rule_id) {
    where.push('rule_id = ?');
    params.push(filters.rule_id);
  }

  const row = db.prepare(`
    SELECT
      COUNT(*) as count,
      AVG(
        (julianday(resolved_at) - julianday(created_at)) * 24
      ) as avg_hours
    FROM issues
    WHERE ${where.join(' AND ')}
  `).get(...params);

  return {
    count: row.count || 0,
    avgHours: row.avg_hours ? Math.round(row.avg_hours * 10) / 10 : null,
  };
}

/**
 * Acceptance rate: COUNT(verified or merged or closed) / COUNT(ai_fixed + verified + merged + closed + rejected)
 * Grouped by rule_id or source.
 */
function getAcceptanceRate(filters = {}) {
  const db = getDb();
  initSchema();

  const where = ["status IN ('verified', 'merged', 'closed', 'rejected')"];
  const params = [];

  if (filters.source) {
    where.push('source = ?');
    params.push(filters.source);
  }

  const groupBy = filters.groupBy === 'source' ? 'source' : 'rule_id';

  const rows = db.prepare(`
    SELECT
      ${groupBy} as group_key,
      COUNT(*) as total,
      SUM(CASE WHEN status IN ('verified', 'merged', 'closed') THEN 1 ELSE 0 END) as accepted,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
    FROM issues
    WHERE ${where.join(' AND ')}
    GROUP BY ${groupBy}
    ORDER BY total DESC
  `).all(...params);

  return rows.map(r => ({
    key: r.group_key,
    total: r.total,
    accepted: r.accepted,
    rejected: r.rejected,
    rate: r.total > 0 ? Math.round((r.accepted / r.total) * 100) : 0,
  }));
}

/**
 * Velocity: issues fixed per day or week, with trend direction.
 */
function getVelocity(period = 'week') {
  const db = getDb();
  initSchema();

  const groupExpr = period === 'day'
    ? "strftime('%Y-%m-%d', resolved_at)"
    : "strftime('%Y-W%W', resolved_at)";

  const rows = db.prepare(`
    SELECT
      ${groupExpr} as period,
      COUNT(*) as fixed
    FROM issues
    WHERE resolved_at IS NOT NULL
    GROUP BY ${groupExpr}
    ORDER BY period DESC
    LIMIT 12
  `).all();

  // Calculate trend: compare last 2 periods
  let trend = 'stable';
  if (rows.length >= 2) {
    const current = rows[0].fixed;
    const previous = rows[1].fixed;
    if (current > previous * 1.1) trend = 'up';
    else if (current < previous * 0.9) trend = 'down';
  }

  return { period, data: rows.reverse(), trend };
}

/**
 * Queue health: open count, estimated time to clear, aging issues.
 */
function getQueueHealth() {
  const db = getDb();
  initSchema();

  const open = db.prepare(
    "SELECT COUNT(*) as count FROM issues WHERE status = 'open'"
  ).get().count;

  const inProgress = db.prepare(
    "SELECT COUNT(*) as count FROM issues WHERE status = 'in_progress'"
  ).get().count;

  const aiFixed = db.prepare(
    "SELECT COUNT(*) as count FROM issues WHERE status = 'ai_fixed'"
  ).get().count;

  // Estimated time to clear based on average estimated_minutes
  const avgMinutes = db.prepare(
    "SELECT AVG(estimated_minutes) as avg FROM issues WHERE status = 'open' AND estimated_minutes > 0"
  ).get().avg || 15;

  const estimatedHours = Math.round((open * avgMinutes) / 60 * 10) / 10;

  // Aging: issues open more than 7 days
  const aging = db.prepare(`
    SELECT COUNT(*) as count FROM issues
    WHERE status = 'open'
    AND created_at < datetime('now', '-7 days')
  `).get().count;

  return { open, inProgress, aiFixed, estimatedHours, aging };
}

/**
 * Rejection patterns: which categories have highest rejection rates.
 */
function getRejectionsByCategory() {
  const db = getDb();
  initSchema();

  return db.prepare(`
    SELECT
      source,
      rule_id,
      pattern_tag,
      occurrences,
      last_seen_at,
      description
    FROM rejection_patterns
    ORDER BY occurrences DESC
    LIMIT 20
  `).all();
}

/**
 * Summary stats for dashboard cards. Optionally filtered by source.
 */
function getStats(source = null) {
  const db = getDb();
  initSchema();

  const where = source ? 'WHERE source = ?' : '';
  const params = source ? [source] : [];

  const statusCounts = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM issues ${where}
    GROUP BY status
  `).all(...params);

  const counts = {};
  for (const row of statusCounts) {
    counts[row.status] = row.count;
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  // Auto-approved count
  const autoApproved = db.prepare(`
    SELECT COUNT(*) as count FROM auto_approve_log
    WHERE decision = 'approved'
    ${source ? 'AND issue_id IN (SELECT id FROM issues WHERE source = ?)' : ''}
  `).get(...(source ? [source] : [])).count;

  // Overall acceptance rate
  const reviewed = (counts.verified || 0) + (counts.merged || 0) + (counts.closed || 0) + (counts.rejected || 0);
  const accepted = (counts.verified || 0) + (counts.merged || 0) + (counts.closed || 0);
  const acceptanceRate = reviewed > 0 ? Math.round((accepted / reviewed) * 100) : 0;

  // Per-source breakdown
  let bySource = [];
  if (!source) {
    bySource = db.prepare(`
      SELECT source, status, COUNT(*) as count
      FROM issues
      GROUP BY source, status
    `).all();
  }

  // Severity breakdown
  const severityCounts = db.prepare(`
    SELECT severity, COUNT(*) as count
    FROM issues ${where}
    GROUP BY severity
  `).all(...params);

  const bySeverity = {};
  for (const row of severityCounts) {
    bySeverity[row.severity] = row.count;
  }

  return {
    total,
    open: counts.open || 0,
    in_progress: counts.in_progress || 0,
    ai_fixed: counts.ai_fixed || 0,
    verified: counts.verified || 0,
    merged: counts.merged || 0,
    closed: counts.closed || 0,
    rejected: counts.rejected || 0,
    autoApproved,
    acceptanceRate,
    bySource,
    by_severity: bySeverity,
  };
}

module.exports = {
  getMTTF,
  getAcceptanceRate,
  getVelocity,
  getQueueHealth,
  getRejectionsByCategory,
  getStats,
};
