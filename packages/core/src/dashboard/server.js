'use strict';

const path = require('path');
const express = require('express');
const { getDb } = require('../db');
const { initSchema } = require('../setup');
const { loadPlugins, listPlugins } = require('../pluginLoader');
const {
  getMTTF,
  getAcceptanceRate,
  getVelocity,
  getQueueHealth,
  getRejectionsByCategory,
  getStats,
} = require('../metrics');

/**
 * Create and configure the Express app.
 */
function createApp() {
  const app = express();

  app.use(express.json());

  // Serve static frontend
  app.use(express.static(path.join(__dirname)));

  // === API Routes ===

  // List issues with filtering and pagination
  app.get('/api/issues', (req, res) => {
    const db = getDb();
    initSchema();

    const { source, status, severity, cluster, page = 1, limit = 50, sort, order } = req.query;
    const where = [];
    const params = [];

    if (source) { where.push('source = ?'); params.push(source); }
    if (status) { where.push('status = ?'); params.push(status); }
    if (severity) { where.push('severity = ?'); params.push(severity); }
    if (cluster) { where.push('cluster_id = ?'); params.push(cluster); }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    // Sorting
    const allowedSorts = ['impact_score', 'severity', 'created_at', 'updated_at', 'estimated_minutes', 'status', 'source'];
    const sortCol = allowedSorts.includes(sort) ? sort : 'impact_score';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    const total = db.prepare(`SELECT COUNT(*) as count FROM issues ${whereClause}`).get(...params).count;

    const issues = db.prepare(`
      SELECT * FROM issues ${whereClause}
      ORDER BY ${sortCol} ${sortOrder}
      LIMIT ? OFFSET ?
    `).all(...params, limitNum, offset);

    res.json({
      issues,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  });

  // Get single issue by ID
  app.get('/api/issues/next', (req, res) => {
    const db = getDb();
    initSchema();

    const { source } = req.query;
    const where = ["status = 'open'", 'is_duplicate = 0'];
    const params = [];

    if (source) { where.push('source = ?'); params.push(source); }

    const issue = db.prepare(`
      SELECT * FROM issues
      WHERE ${where.join(' AND ')}
      ORDER BY (CAST(impact_score AS REAL) / CASE WHEN estimated_minutes > 0 THEN estimated_minutes ELSE 15 END) DESC
      LIMIT 1
    `).get(...params);

    if (!issue) {
      return res.json({ issue: null, message: 'No open issues found' });
    }

    res.json({ issue });
  });

  app.get('/api/issues/:id', (req, res) => {
    const db = getDb();
    initSchema();

    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
    if (!issue) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    // Attach metadata
    const metadata = db.prepare('SELECT key, value FROM issue_metadata WHERE issue_id = ?').all(req.params.id);
    issue.metadata = {};
    for (const m of metadata) {
      try { issue.metadata[m.key] = JSON.parse(m.value); } catch (_) { issue.metadata[m.key] = m.value; }
    }

    // Attach fix attempts
    issue.fix_attempts = db.prepare('SELECT * FROM fix_attempts WHERE issue_id = ? ORDER BY attempted_at DESC').all(req.params.id);

    res.json({ issue });
  });

  // Update issue status
  app.post('/api/issues/:id/status', (req, res) => {
    const db = getDb();
    initSchema();

    const { status: newStatus, reviewed_by, rejected_reason, rejection_tag } = req.body;
    const id = req.params.id;

    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
    if (!issue) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    const { VALID_TRANSITIONS } = require('../commands/status');
    const allowed = VALID_TRANSITIONS[issue.status];
    if (!allowed || !allowed.includes(newStatus)) {
      return res.status(400).json({
        error: `Invalid transition: ${issue.status} → ${newStatus}`,
        allowed: allowed || [],
      });
    }

    const now = new Date().toISOString();
    const updates = { status: newStatus, updated_at: now };

    if (['merged', 'closed'].includes(newStatus)) {
      updates.resolved_at = now;
    }
    if (newStatus === 'open' && issue.resolved_at) {
      updates.resolved_at = null;
    }
    if (reviewed_by) updates.reviewed_by = reviewed_by;
    if (rejected_reason) updates.rejected_reason = rejected_reason;

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    db.prepare(`UPDATE issues SET ${setClauses} WHERE id = ?`).run(...values, id);

    // Handle rejection pattern tracking
    if (newStatus === 'rejected' && rejection_tag) {
      const existing = db.prepare(
        'SELECT * FROM rejection_patterns WHERE source = ? AND rule_id = ? AND pattern_tag = ?'
      ).get(issue.source, issue.rule_id || '', rejection_tag);

      if (existing) {
        db.prepare(
          'UPDATE rejection_patterns SET occurrences = occurrences + 1, last_seen_at = ?, description = ? WHERE id = ?'
        ).run(now, rejected_reason || existing.description, existing.id);
      } else {
        db.prepare(
          'INSERT INTO rejection_patterns (source, rule_id, pattern_tag, occurrences, first_seen_at, last_seen_at, description) VALUES (?, ?, ?, 1, ?, ?, ?)'
        ).run(issue.source, issue.rule_id || '', rejection_tag, now, now, rejected_reason || '');
      }
    }

    const updated = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
    res.json({ issue: updated });
  });

  // Stats
  app.get('/api/stats', (req, res) => {
    const { source } = req.query;
    res.json(getStats(source || null));
  });

  // Clusters
  app.get('/api/clusters', (req, res) => {
    const db = getDb();
    initSchema();

    const { source } = req.query;
    const where = [];
    const params = [];

    if (source) { where.push('source = ?'); params.push(source); }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const clusters = db.prepare(`
      SELECT * FROM clusters ${whereClause}
      ORDER BY issue_count DESC
    `).all(...params);

    res.json({ clusters });
  });

  // Metrics
  app.get('/api/metrics/mttf', (req, res) => {
    const { source, severity } = req.query;
    res.json(getMTTF({ source, severity }));
  });

  app.get('/api/metrics/acceptance', (req, res) => {
    const { source } = req.query;
    res.json(getAcceptanceRate({ source, groupBy: req.query.groupBy || 'rule_id' }));
  });

  app.get('/api/metrics/velocity', (req, res) => {
    const { period } = req.query;
    res.json(getVelocity(period || 'week'));
  });

  app.get('/api/metrics/queue-health', (req, res) => {
    res.json(getQueueHealth());
  });

  app.get('/api/metrics/rejections', (req, res) => {
    res.json(getRejectionsByCategory());
  });

  // Scanners
  app.get('/api/scanners', (req, res) => {
    const scanners = listPlugins();
    res.json({ scanners });
  });

  app.post('/api/scanners/:source/test', async (req, res) => {
    try {
      const plugins = loadPlugins();
      const plugin = plugins.get(req.params.source);

      if (!plugin) {
        return res.status(404).json({ error: `Plugin ${req.params.source} not found` });
      }

      const results = {};

      if (typeof plugin.checkInstalled === 'function') {
        results.installed = await plugin.checkInstalled();
      }

      if (typeof plugin.checkAuth === 'function') {
        results.auth = await plugin.checkAuth();
      }

      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/scanners/:source/config', (req, res) => {
    try {
      const { loadCredentials, saveCredentials } = require('../config');
      const creds = loadCredentials();
      creds[req.params.source] = { ...creds[req.params.source], ...req.body };
      saveCredentials(creds);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Scan history
  app.get('/api/scan-history', (req, res) => {
    const db = getDb();
    initSchema();

    const { source, limit = 20 } = req.query;
    const where = [];
    const params = [];

    if (source) { where.push('source = ?'); params.push(source); }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const history = db.prepare(`
      SELECT * FROM scan_history ${whereClause}
      ORDER BY ran_at DESC
      LIMIT ?
    `).all(...params, limitNum);

    res.json({ history });
  });

  // Fallback: serve index.html for SPA routing
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  return app;
}

/**
 * Start the dashboard server.
 */
function startServer(options = {}) {
  const port = options.port || process.env.DASHBOARD_PORT || 8000;
  const app = createApp();

  // Initialize DB schema
  initSchema();

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`\nDashboard running at http://localhost:${port}`);
      resolve(server);
    });
  });
}

module.exports = { createApp, startServer };
