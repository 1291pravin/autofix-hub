'use strict';

const { spawnSync } = require('child_process');
const { getDb } = require('../db');
const { initSchema } = require('../setup');
const { loadAutomationConfig, isBlocklisted } = require('../automationConfig');
const { buildClubs, persistClubs, getClub } = require('../clubbing');
const { getPlugin } = require('../pluginLoader');
const { worktreeCreateCommand } = require('./worktree');
const { checkPrsCommand } = require('./checkPrs');

function ghJson(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || '').trim() };
  try { return { ok: true, data: JSON.parse(r.stdout || '[]') }; }
  catch (err) { return { ok: false, error: `parse failed: ${err.message}` }; }
}

function listOpenAutofixPrs(label, doneLabel) {
  const r = ghJson(['pr', 'list', '--state', 'open', '--label', label,
    '--json', 'number,url,title,labels,createdAt', '--limit', '100']);
  if (!r.ok) return r;
  const filtered = r.data.filter(pr => !pr.labels.some(l => l.name === doneLabel));
  return { ok: true, prs: filtered };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sessionId(source) {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '').replace(/-/g, '').slice(0, 14);
  return `${source}-${stamp}`;
}

function ensureSession(source) {
  const db = getDb();
  const recent = db.prepare(`
    SELECT id FROM sessions
    WHERE source = ? AND status = 'active' AND started_at > datetime('now', '-6 hours')
    ORDER BY started_at DESC LIMIT 1
  `).get(source);
  if (recent) return recent.id;

  const id = sessionId(source);
  db.prepare(`INSERT INTO sessions (id, source, started_at, status) VALUES (?, ?, ?, 'active')`)
    .run(id, source, new Date().toISOString());
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
  for (const issue of issues) issue.metadata = meta.get(issue.id) || {};
  return issues;
}

function loadOpenIssues(source) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM issues
    WHERE source = ? AND status = 'open' AND is_duplicate = 0
    ORDER BY impact_score DESC
  `).all(source);
  hydrateMetadata(rows, db);
  return rows;
}

function pickTopClub(source, config) {
  const issues = loadOpenIssues(source);
  if (issues.length === 0) return { reason: 'queue_empty' };
  const actionable = issues.filter(i => !isBlocklisted(i.file_path, config.blocklist));
  if (actionable.length === 0) return { reason: 'all_blocklisted' };
  const clubs = buildClubs(actionable, config);
  if (clubs.length === 0) return { reason: 'no_clubs' };
  return { club: clubs[0], total_open: issues.length };
}

async function captureWorktreeCreate(clubId) {
  const orig = console.log;
  let out = '';
  console.log = (s) => { out = s; };
  let err = null;
  try { await worktreeCreateCommand(clubId); }
  catch (e) { err = e; }
  finally { console.log = orig; }
  if (err) return { ok: false, error: err.message };
  try { return { ok: true, data: JSON.parse(out) }; }
  catch (e) { return { ok: false, error: `worktree output parse failed: ${e.message}` }; }
}

async function captureCheckPrs(source) {
  const orig = console.log;
  let out = '';
  console.log = (s) => { out = s; };
  try { await checkPrsCommand(source); } catch (_) {}
  console.log = orig;
  try { return JSON.parse(out); } catch (_) { return null; }
}

function buildClubPayload(club, plugin) {
  const combined = typeof plugin.batchPromptTemplate === 'function'
    ? plugin.batchPromptTemplate(club.issues)
    : club.issues.map(i => plugin.promptTemplate(i)).join('\n\n---\n\n');
  return {
    id: club.id,
    title: club.title,
    category: club.category,
    rule_id: club.rule_id,
    common_dir: club.common_dir,
    issue_count: club.issue_count,
    files_count: club.files_count,
    files: club.files,
    issue_ids: club.issue_ids,
    score: club.score,
    combined_prompt: combined,
    issues: club.issues.map(i => ({
      id: i.id,
      file: i.file_path,
      line: i.line_number,
      severity: i.severity,
      description: i.description,
      impact_score: i.impact_score,
      prompt: plugin.promptTemplate(i),
    })),
  };
}

function transitionIssuesInProgress(db, issueIds) {
  if (issueIds.length === 0) return;
  const now = new Date().toISOString();
  const ph = issueIds.map(() => '?').join(',');
  db.prepare(`
    UPDATE issues SET status = 'in_progress', updated_at = ?
    WHERE id IN (${ph}) AND status = 'open'
  `).run(now, ...issueIds);
}

/**
 * `autofix-hub <plugin> next-club [--wait] [--poll-seconds N] [--max-wait-minutes M] [--no-sync]`
 *
 * One iteration of the autopilot loop:
 *   1. (default) Reconcile PR statuses via `check-prs` so freshly merged PRs
 *      free up DB state (live `gh pr list` already drops them from the WIP gate).
 *   2. Compute capacity from the WIP gate.
 *   3. If capacity == 0 and --wait, poll every poll-seconds until a slot opens
 *      or max-wait-minutes elapses.
 *   4. When a slot is available, pick the highest-scored open cluster, persist
 *      it, transition its issues to in_progress, create a worktree, and emit
 *      everything Cascade needs to apply the fix.
 *
 * Exit codes:
 *   0 — `ready` (a club was prepared) OR `queue_empty` (clean stop)
 *   4 — `wip_full_timeout` (waited but no slot opened)
 *   1 — error
 */
async function nextClubCommand(source, opts = {}) {
  initSchema();
  const config = loadAutomationConfig();
  const db = getDb();
  const plugin = getPlugin(source);

  const label = config.wip.label;
  const doneLabel = config.wip.done_label;
  const max = config.wip.max_open_prs;
  const pollMs = Math.max(5, parseInt(opts.pollSeconds || 60, 10)) * 1000;
  const maxWaitMs = Math.max(0, parseInt(opts.maxWaitMinutes || 30, 10)) * 60 * 1000;
  const wait = opts.wait === true;

  if (opts.sync !== false) {
    await captureCheckPrs(source);
  }

  const deadline = Date.now() + maxWaitMs;
  let prs;
  while (true) {
    const r = listOpenAutofixPrs(label, doneLabel);
    if (!r.ok) {
      console.log(JSON.stringify({
        status: 'error', source,
        error: `gh pr list failed: ${r.error}`,
        hint: 'Ensure gh is authenticated (gh auth status).',
      }, null, 2));
      process.exit(1);
    }
    prs = r.prs;
    const capacity = Math.max(0, max - prs.length);
    if (capacity > 0) break;
    if (!wait || Date.now() >= deadline) {
      console.log(JSON.stringify({
        status: 'wip_full_timeout',
        source,
        max_open_prs: max,
        open_count: prs.length,
        capacity: 0,
        waited: wait,
        open_prs: prs.map(p => ({ url: p.url, title: p.title, createdAt: p.createdAt })),
        hint: wait
          ? `No slot opened within ${opts.maxWaitMinutes} minute(s). Merge or close an autofix PR.`
          : `WIP cap reached. Re-run with --wait to block until a slot opens.`,
      }, null, 2));
      process.exit(4);
    }
    // Re-sync before sleeping so freshly merged PRs are detected promptly.
    if (opts.sync !== false) await captureCheckPrs(source);
    await sleep(pollMs);
  }

  // Capacity available. Pick the top club.
  const pick = pickTopClub(source, config);
  if (pick.reason) {
    console.log(JSON.stringify({
      status: 'queue_empty',
      source,
      reason: pick.reason,
      open_prs: prs.map(p => ({ url: p.url, title: p.title })),
    }, null, 2));
    return;
  }

  const session_id = ensureSession(source);
  persistClubs([pick.club], { session_id, source });
  transitionIssuesInProgress(db, pick.club.issue_ids);

  // Create the worktree for this club (sets clubs.status='in_progress', branch, worktree_path).
  const wt = await captureWorktreeCreate(pick.club.id);
  if (!wt.ok || (wt.data && wt.data.status !== 'ok')) {
    // Roll back: restore issues to open so the next pass can retry
    const ph = pick.club.issue_ids.map(() => '?').join(',');
    db.prepare(`UPDATE issues SET status = 'open' WHERE id IN (${ph}) AND status = 'in_progress'`)
      .run(...pick.club.issue_ids);
    console.log(JSON.stringify({
      status: 'error',
      source,
      club_id: pick.club.id,
      error: wt.error || (wt.data && wt.data.error) || 'worktree create failed',
    }, null, 2));
    process.exit(1);
  }

  const refreshed = getClub(pick.club.id);
  const payload = buildClubPayload(pick.club, plugin);

  console.log(JSON.stringify({
    status: 'ready',
    source,
    session_id,
    wip: { open_count: prs.length, capacity: max - prs.length, max },
    open_prs: prs.map(p => ({ url: p.url, title: p.title })),
    next_club: {
      ...payload,
      worktree_path: refreshed.worktree_path,
      branch: refreshed.branch,
    },
  }, null, 2));
}

module.exports = { nextClubCommand };
