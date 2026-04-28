'use strict';

const { spawnSync } = require('child_process');
const { getDb } = require('../db');
const { initSchema } = require('../setup');

function ghJson(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || '').trim() };
  }
  try { return { ok: true, data: JSON.parse(r.stdout || 'null') }; }
  catch (err) { return { ok: false, error: `parse failed: ${err.message}` }; }
}

function classify(prJson) {
  if (!prJson) return 'unknown';
  const state = (prJson.state || '').toUpperCase();
  if (state === 'MERGED' || prJson.mergedAt) return 'merged';
  if (state === 'CLOSED') return 'rejected';
  if (state === 'OPEN') return 'open';
  return 'unknown';
}

function reconcileClub(db, club) {
  const r = ghJson(['pr', 'view', club.pr_url, '--json', 'state,mergedAt,number,url']);
  if (!r.ok) return { club_id: club.id, pr_url: club.pr_url, status: 'error', error: r.error };

  const verdict = classify(r.data);
  const now = new Date().toISOString();

  if (verdict === 'merged') {
    db.prepare(`UPDATE clubs SET status = 'merged', updated_at = ? WHERE id = ?`).run(now, club.id);
    db.prepare(`
      UPDATE issues SET status = 'merged', resolved_at = ?, updated_at = ?
      WHERE id IN (SELECT issue_id FROM club_issues WHERE club_id = ?)
        AND status IN ('ai_fixed','pr_opened','open','in_progress')
    `).run(now, now, club.id);
    return { club_id: club.id, pr_url: club.pr_url, transition: 'pr_opened -> merged' };
  }

  if (verdict === 'rejected') {
    db.prepare(`UPDATE clubs SET status = 'rejected', updated_at = ? WHERE id = ?`).run(now, club.id);
    db.prepare(`
      UPDATE issues SET status = 'rejected', updated_at = ?
      WHERE id IN (SELECT issue_id FROM club_issues WHERE club_id = ?)
        AND status IN ('ai_fixed','pr_opened','open','in_progress')
    `).run(now, club.id);
    return { club_id: club.id, pr_url: club.pr_url, transition: 'pr_opened -> rejected' };
  }

  if (verdict === 'open') return { club_id: club.id, pr_url: club.pr_url, transition: 'still open' };
  return { club_id: club.id, pr_url: club.pr_url, transition: 'unknown', state: r.data && r.data.state };
}

/**
 * `autofix-hub <plugin> check-prs`
 * Reconciles club + issue status for every club with a PR URL whose status is
 * still `pr_opened`. Walks `gh pr view` for each and transitions to merged or
 * rejected as appropriate. Open PRs are left alone.
 */
async function checkPrsCommand(source) {
  initSchema();
  const db = getDb();

  const clubs = db.prepare(`
    SELECT id, pr_url FROM clubs
    WHERE source = ? AND status = 'pr_opened' AND pr_url IS NOT NULL
  `).all(source);

  if (clubs.length === 0) {
    console.log(JSON.stringify({
      status: 'ok', source, checked: 0, merged: 0, rejected: 0, still_open: 0, results: [],
    }, null, 2));
    return;
  }

  const results = clubs.map(c => reconcileClub(db, c));
  const counts = {
    checked: results.length,
    merged: results.filter(r => r.transition === 'pr_opened -> merged').length,
    rejected: results.filter(r => r.transition === 'pr_opened -> rejected').length,
    still_open: results.filter(r => r.transition === 'still open').length,
    errors: results.filter(r => r.status === 'error').length,
  };

  console.log(JSON.stringify({ status: 'ok', source, ...counts, results }, null, 2));
}

module.exports = { checkPrsCommand };
