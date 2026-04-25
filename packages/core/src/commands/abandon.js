'use strict';

const { getDb } = require('../db');
const { initSchema } = require('../setup');
const { getClub } = require('../clubbing');
const { worktreeDestroyCommand } = require('./worktree');

async function abandonCommand(clubIdArg, opts = {}) {
  initSchema();
  const db = getDb();

  const club = getClub(clubIdArg);
  if (!club) {
    console.log(JSON.stringify({ status: 'error', error: `Club ${clubIdArg} not found` }));
    process.exit(1);
  }

  const reason = opts.reason || 'unspecified';
  const now = new Date().toISOString();

  // Mark club abandoned first so worktree destroy knows not to delete the branch
  // (nothing to preserve — no PR — so branch deletion is fine).
  db.prepare(`
    UPDATE clubs SET status = 'abandoned', abandon_reason = ?, updated_at = ? WHERE id = ?
  `).run(reason.slice(0, 500), now, club.id);

  // Restore issue statuses (back to open so a future run can try again)
  const issueIds = db.prepare('SELECT issue_id FROM club_issues WHERE club_id = ?').all(club.id).map(r => r.issue_id);
  if (issueIds.length > 0) {
    const ph = issueIds.map(() => '?').join(',');
    db.prepare(`
      UPDATE issues SET status = 'open', updated_at = ? WHERE id IN (${ph}) AND status = 'in_progress'
    `).run(now, ...issueIds);
  }

  // Capture the console output of destroy for our JSON response
  const origLog = console.log;
  let destroyOut = '';
  console.log = (s) => { destroyOut = s; };
  try { await worktreeDestroyCommand(club.id); } catch (_) {}
  console.log = origLog;

  let destroyParsed = null;
  try { destroyParsed = JSON.parse(destroyOut); } catch (_) {}

  console.log(JSON.stringify({
    status: 'ok',
    club_id: club.id,
    reason,
    issues_restored: issueIds.length,
    worktree: destroyParsed,
  }, null, 2));
}

module.exports = { abandonCommand };
