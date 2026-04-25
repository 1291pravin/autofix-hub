'use strict';

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { getDb } = require('../db');
const { initSchema } = require('../setup');
const { getProjectRoot } = require('../config');
const { loadAutomationConfig } = require('../automationConfig');
const { getClub } = require('../clubbing');

function runGit(cmd, cwd) {
  return execSync(cmd, { cwd: cwd || getProjectRoot(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function runGitSafe(cmd, cwd) {
  try { return { ok: true, output: runGit(cmd, cwd) }; }
  catch (err) { return { ok: false, output: (err.stderr && err.stderr.toString()) || err.message }; }
}

function detectBaseBranch(configured) {
  if (configured) return configured;
  for (const b of ['main', 'master']) {
    const r = runGitSafe(`git rev-parse --verify ${b}`);
    if (r.ok) return b;
  }
  // Fallback: current default via remote HEAD
  const r = runGitSafe(`git symbolic-ref --short refs/remotes/origin/HEAD`);
  if (r.ok) return r.output.replace(/^origin\//, '');
  return 'main';
}

function worktreePath(config, clubId) {
  const root = config.worktree.root;
  const abs = path.isAbsolute(root) ? root : path.join(getProjectRoot(), root);
  return path.join(abs, clubId);
}

function branchName(config, source, clubId) {
  return `${config.worktree.branch_prefix}/${source}/${clubId}`;
}

async function worktreeCreateCommand(clubIdArg) {
  initSchema();
  const config = loadAutomationConfig();
  const db = getDb();

  const club = getClub(clubIdArg);
  if (!club) {
    console.log(JSON.stringify({ status: 'error', error: `Club ${clubIdArg} not found` }));
    process.exit(1);
  }

  const wtPath = worktreePath(config, club.id);
  const branch = branchName(config, club.source, club.id);
  const base = detectBaseBranch(config.wip.base_branch);

  // Ensure parent dir
  const parent = path.dirname(wtPath);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });

  // If worktree already exists, just return it.
  if (fs.existsSync(wtPath)) {
    db.prepare('UPDATE clubs SET worktree_path = ?, branch = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(wtPath, branch, 'in_progress', new Date().toISOString(), club.id);
    console.log(JSON.stringify({
      status: 'ok', club_id: club.id, worktree_path: wtPath, branch, base, reused: true,
    }, null, 2));
    return;
  }

  // Make sure the branch does not already exist locally (stale from a prior run).
  runGitSafe(`git branch -D ${branch}`);

  // Fetch base to be safe (if remote exists)
  runGitSafe(`git fetch origin ${base}`);

  // Create worktree on a new branch from the detected base.
  const baseRef = runGitSafe(`git rev-parse --verify origin/${base}`).ok ? `origin/${base}` : base;
  const add = runGitSafe(`git worktree add -b ${branch} "${wtPath}" ${baseRef}`);
  if (!add.ok) {
    console.log(JSON.stringify({ status: 'error', error: `worktree add failed: ${add.output}` }));
    process.exit(1);
  }

  db.prepare('UPDATE clubs SET worktree_path = ?, branch = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(wtPath, branch, 'in_progress', new Date().toISOString(), club.id);

  console.log(JSON.stringify({
    status: 'ok',
    club_id: club.id,
    worktree_path: wtPath,
    branch,
    base,
    reused: false,
  }, null, 2));
}

async function worktreeDestroyCommand(clubIdArg) {
  initSchema();
  const config = loadAutomationConfig();
  const db = getDb();

  const club = getClub(clubIdArg);
  if (!club) {
    console.log(JSON.stringify({ status: 'error', error: `Club ${clubIdArg} not found` }));
    process.exit(1);
  }

  const wtPath = club.worktree_path || worktreePath(config, club.id);
  const branch = club.branch || branchName(config, club.source, club.id);

  // Remove worktree (force because it may have uncommitted changes on abandon)
  if (fs.existsSync(wtPath)) {
    const r = runGitSafe(`git worktree remove --force "${wtPath}"`);
    if (!r.ok) {
      // Fallback: rm -rf then prune
      try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch (_) {}
      runGitSafe(`git worktree prune`);
    }
  }

  // Delete branch if no PR was created
  if (!club.pr_url) {
    runGitSafe(`git branch -D ${branch}`);
  }

  db.prepare('UPDATE clubs SET worktree_path = NULL, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), club.id);

  console.log(JSON.stringify({
    status: 'ok',
    club_id: club.id,
    removed_path: wtPath,
    branch_deleted: !club.pr_url,
  }, null, 2));
}

module.exports = {
  worktreeCreateCommand,
  worktreeDestroyCommand,
  worktreePath,
  branchName,
  detectBaseBranch,
};
