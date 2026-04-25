'use strict';

const { getDb } = require('../db');
const { initSchema } = require('../setup');
const { getPlugin } = require('../pluginLoader');
const { loadAutomationConfig, isBlocklisted } = require('../automationConfig');
const { buildClubs, persistClubs } = require('../clubbing');

function sessionId(source) {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '').replace(/-/g, '').slice(0, 14);
  return `${source}-${stamp}`;
}

function ensureSession(source) {
  const db = getDb();
  // Reuse the most recent active session for this source started within last 6h, else create.
  const recent = db.prepare(`
    SELECT id FROM sessions
    WHERE source = ? AND status = 'active' AND started_at > datetime('now', '-6 hours')
    ORDER BY started_at DESC LIMIT 1
  `).get(source);
  if (recent) return recent.id;

  const id = sessionId(source);
  db.prepare(`
    INSERT INTO sessions (id, source, started_at, status) VALUES (?, ?, ?, 'active')
  `).run(id, source, new Date().toISOString());
  return id;
}

function hydrateMetadata(issues, db) {
  if (issues.length === 0) return issues;
  const ids = issues.map(i => i.id);
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT issue_id, key, value FROM issue_metadata WHERE issue_id IN (${ph})`).all(...ids);
  const meta = new Map();
  for (const r of rows) {
    if (!meta.has(r.issue_id)) meta.set(r.issue_id, {});
    try { meta.get(r.issue_id)[r.key] = JSON.parse(r.value); }
    catch (_) { meta.get(r.issue_id)[r.key] = r.value; }
  }
  for (const issue of issues) {
    issue.metadata = meta.get(issue.id) || {};
  }
  return issues;
}

/**
 * `autofix-hub <plugin> issues --with-prompts --with-grouping-hint [--capacity N] --json`
 *
 * Returns open issues for a plugin with optional per-issue prompt, a clubbed
 * grouping honoring config caps, and a batch prompt per club. Clubs are
 * persisted to the DB with status='proposed' for downstream commands.
 */
async function issuesCommand(source, opts = {}) {
  const plugin = getPlugin(source);
  const db = getDb();
  initSchema();
  const config = loadAutomationConfig();

  const rows = db.prepare(`
    SELECT * FROM issues
    WHERE source = ? AND status = 'open' AND is_duplicate = 0
    ORDER BY impact_score DESC
  `).all(source);

  hydrateMetadata(rows, db);

  // Split: blocklisted vs actionable
  const blocklisted = [];
  const actionable = [];
  for (const issue of rows) {
    if (isBlocklisted(issue.file_path, config.blocklist)) blocklisted.push(issue);
    else actionable.push(issue);
  }

  const session_id = ensureSession(source);
  let clubs = buildClubs(actionable, config);

  // Apply capacity cap (take top N clubs by score).
  const capacity = opts.capacity != null ? Math.max(0, parseInt(opts.capacity, 10)) : clubs.length;
  clubs = clubs.slice(0, capacity);

  persistClubs(clubs, { session_id, source });

  // Build JSON output with prompts.
  const wantPrompts = opts.withPrompts !== false;
  const wantGrouping = opts.withGroupingHint !== false;

  const outClubs = clubs.map(c => {
    const combinedPrompt = typeof plugin.batchPromptTemplate === 'function'
      ? plugin.batchPromptTemplate(c.issues)
      : c.issues.map(i => plugin.promptTemplate(i)).join('\n\n---\n\n');
    return {
      id: c.id,
      title: c.title,
      category: c.category,
      rule_id: c.rule_id,
      common_dir: c.common_dir,
      issue_count: c.issue_count,
      files_count: c.files_count,
      files: c.files,
      issue_ids: c.issue_ids,
      score: c.score,
      combined_prompt: wantPrompts ? combinedPrompt : undefined,
      issues: wantPrompts
        ? c.issues.map(i => ({
            id: i.id,
            file: i.file_path,
            line: i.line_number,
            severity: i.severity,
            description: i.description,
            impact_score: i.impact_score,
            prompt: plugin.promptTemplate(i),
          }))
        : c.issues.map(i => ({
            id: i.id,
            file: i.file_path,
            line: i.line_number,
          })),
    };
  });

  const output = {
    session_id,
    source,
    total_open_issues: rows.length,
    actionable_issues: actionable.length,
    blocklisted_issues: blocklisted.length,
    blocklisted: blocklisted.map(i => ({ id: i.id, file: i.file_path })),
    capacity,
    clubs_count: outClubs.length,
    clubbed_issues: outClubs.reduce((s, c) => s + c.issue_count, 0),
  };
  if (wantGrouping) output.clubs = outClubs;

  console.log(JSON.stringify(output, null, 2));
}

module.exports = { issuesCommand };
