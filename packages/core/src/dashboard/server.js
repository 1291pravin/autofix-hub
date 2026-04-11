'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const express = require('express');
const { getDb } = require('../db');
const { initSchema, migrateIssueClusters } = require('../setup');
const { loadPlugins, listPlugins } = require('../pluginLoader');
const {
  getMTTF,
  getAcceptanceRate,
  getVelocity,
  getQueueHealth,
  getRejectionsByCategory,
  getStats,
} = require('../metrics');
const { getProjectRoot, loadCredentials, saveCredentials } = require('../config');

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
    if (cluster) { where.push('id IN (SELECT issue_id FROM issue_clusters WHERE cluster_id = ?)'); params.push(cluster); }

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

    if (source) { where.push('c.source = ?'); params.push(source); }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const clusters = db.prepare(`
      SELECT c.*, COALESCE(jc.cnt, c.issue_count) as issue_count
      FROM clusters c
      LEFT JOIN (SELECT cluster_id, COUNT(*) as cnt FROM issue_clusters GROUP BY cluster_id) jc ON jc.cluster_id = c.id
      ${whereClause}
      ORDER BY issue_count DESC
    `).all(...params);

    res.json({ clusters });
  });

  // Get batch prompt for a cluster
  app.get('/api/clusters/:id/prompt', async (req, res) => {
    try {
      const db = getDb();
      initSchema();

      const clusterId = req.params.id;
      const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
      
      if (!cluster) {
        return res.status(404).json({ error: 'Cluster not found' });
      }

      const clusterIssues = db.prepare(`
        SELECT i.* FROM issues i
        INNER JOIN issue_clusters ic ON ic.issue_id = i.id
        WHERE ic.cluster_id = ? AND i.status = 'open' AND i.is_duplicate = 0
        ORDER BY i.impact_score DESC
      `).all(clusterId);

      if (clusterIssues.length === 0) {
        return res.json({ prompt: '', message: 'No open issues in cluster' });
      }

      // Hydrate metadata for all cluster issues in one query
      const issueIds = clusterIssues.map(i => i.id);
      const placeholders = issueIds.map(() => '?').join(',');
      const allMeta = db.prepare(
        `SELECT issue_id, key, value FROM issue_metadata WHERE issue_id IN (${placeholders})`
      ).all(...issueIds);

      const metaMap = new Map();
      for (const row of allMeta) {
        if (!metaMap.has(row.issue_id)) metaMap.set(row.issue_id, {});
        const obj = metaMap.get(row.issue_id);
        try { obj[row.key] = JSON.parse(row.value); } catch (_) { obj[row.key] = row.value; }
      }
      for (const issue of clusterIssues) {
        issue.metadata = metaMap.get(issue.id) || {};
      }

      // Load plugin and try to get batch prompt
      const plugins = loadPlugins();
      const plugin = plugins.get(cluster.source);

      let fixPrompt = '';
      if (plugin && typeof plugin.batchPromptTemplate === 'function') {
        fixPrompt = plugin.batchPromptTemplate(clusterIssues);
      } else {
        // Fallback: concatenate individual prompts with dashboard format
        const promptIssues = clusterIssues.filter(i => i.fix_prompt);
        if (promptIssues.length > 0) {
          fixPrompt = `# Cluster Fix: ${cluster.cluster_key || cluster.id}\n\n${cluster.root_cause ? `> **Root Cause:** ${cluster.root_cause}\n\n` : ''}${promptIssues.map((issue) => `---\n\n${issue.fix_prompt}`).join('\n\n')}`;
        }
      }

      res.json({ 
        prompt: fixPrompt,
        cluster: {
          id: cluster.id,
          clusterKey: cluster.cluster_key,
          source: cluster.source,
          issueCount: clusterIssues.length,
          rootCause: cluster.root_cause
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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

      const creds = loadCredentials()[req.params.source] || {};

      if (typeof plugin.checkInstalled === 'function') {
        results.installed = await plugin.checkInstalled(creds);
      }

      if (typeof plugin.checkAuth === 'function') {
        results.auth = await plugin.checkAuth(creds);
      }

      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/scanners/:source/config', (req, res) => {
    try {
      const creds = loadCredentials();
      creds[req.params.source] = { ...creds[req.params.source], ...req.body };
      saveCredentials(creds);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Scanner Setup Fields ─────────────────────────────

  // Get setup prompt fields for a scanner plugin
  app.get('/api/scanners/:source/setup-fields', (req, res) => {
    try {
      const plugins = loadPlugins();
      const plugin = plugins.get(req.params.source);
      if (!plugin) {
        return res.status(404).json({ error: `Plugin ${req.params.source} not found` });
      }

      const fields = typeof plugin.setupPrompts === 'function' ? plugin.setupPrompts() : [];
      const creds = loadCredentials();
      const saved = creds[req.params.source] || {};

      res.json({ fields, saved });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Apiiro CLI Install ───────────────────────────────

  // Track background processes for install/login
  const _bgProcesses = {};

  app.post('/api/scanners/apiiro/install', (req, res) => {
    try {
      const platform = os.platform();
      const arch = os.arch();
      let binaryName;
      let installCmd;

      if (platform === 'win32') {
        binaryName = 'apiiro-win.exe';
        const dest = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'apiiro', 'apiiro.exe');
        const destDir = path.dirname(dest);
        // Use powershell to create directory and download binary
        installCmd = `powershell -Command "New-Item -ItemType Directory -Force -Path '${destDir}' | Out-Null; Invoke-WebRequest -Uri 'https://github.com/apiiro/cli-releases/releases/latest/download/${binaryName}' -OutFile '${dest}'"`;
      } else if (platform === 'darwin') {
        // macOS — use Homebrew if available, otherwise direct download
        installCmd = 'brew tap apiiro/tap && brew install apiiro';
      } else {
        // Linux
        binaryName = arch === 'arm64' ? 'apiiro-linux-arm64' : 'apiiro-linux-x64';
        installCmd = `curl -fSL -o /usr/local/bin/apiiro "https://github.com/apiiro/cli-releases/releases/latest/download/${binaryName}" && chmod +x /usr/local/bin/apiiro`;
      }

      const child = spawn(installCmd, {
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      _bgProcesses['apiiro-install'] = { status: 'running', stdout: '', stderr: '' };

      child.on('close', (code) => {
        _bgProcesses['apiiro-install'] = {
          status: code === 0 ? 'success' : 'failed',
          stdout,
          stderr,
          exitCode: code,
        };
      });

      res.json({ status: 'started', message: 'Installing Apiiro CLI from GitHub releases...' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Poll install/login status
  app.get('/api/scanners/apiiro/process/:action', (req, res) => {
    const key = `apiiro-${req.params.action}`;
    const process = _bgProcesses[key];
    if (!process) {
      return res.json({ status: 'idle' });
    }
    res.json(process);
  });

  // ─── Apiiro Login ─────────────────────────────────────

  app.post('/api/scanners/apiiro/login', (req, res) => {
    try {
      const plugins = loadPlugins();
      const plugin = plugins.get('apiiro');
      const creds = loadCredentials();
      const cliPath = (creds.apiiro && creds.apiiro.cli_path) || 'apiiro';

      const child = spawn(cliPath, ['login'], {
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      _bgProcesses['apiiro-login'] = { status: 'running', stdout: '', stderr: '' };

      child.on('close', (code) => {
        _bgProcesses['apiiro-login'] = {
          status: code === 0 ? 'success' : 'failed',
          stdout,
          stderr,
          exitCode: code,
        };
      });

      res.json({ status: 'started', message: 'Opening Apiiro login... Complete authentication in the browser window.' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Scan Trigger ─────────────────────────────────────

  app.post('/api/scanners/:source/fetch', async (req, res) => {
    try {
      const { fetchCommand } = require('../commands/fetch');
      const source = req.params.source;
      const opts = { json: true, ...(req.body || {}) };

      // Capture console output
      const logs = [];
      const origLog = console.log;
      const origError = console.error;
      console.log = (...args) => logs.push({ level: 'info', message: args.join(' ') });
      console.error = (...args) => logs.push({ level: 'error', message: args.join(' ') });

      try {
        await fetchCommand(source, opts);
        console.log = origLog;
        console.error = origError;
        res.json({ success: true, logs });
      } catch (err) {
        console.log = origLog;
        console.error = origError;
        res.status(500).json({ error: err.message, logs });
      }
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
  const port = options.port || 8000;
  const app = createApp();

  // Initialize DB schema and run migrations
  initSchema();
  migrateIssueClusters();

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`\nDashboard running at http://localhost:${port}`);
      resolve(server);
    });
  });
}

module.exports = { createApp, startServer };
