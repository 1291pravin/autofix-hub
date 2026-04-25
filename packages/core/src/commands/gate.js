'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db');
const { initSchema } = require('../setup');
const { loadAutomationConfig } = require('../automationConfig');
const { getClub } = require('../clubbing');

function runCommand(cmdStr, cwd, timeoutMs) {
  const start = Date.now();
  // Run through the user's shell so things like `pnpm` resolve naturally.
  const isWin = process.platform === 'win32';
  const shell = isWin ? 'cmd.exe' : '/bin/sh';
  const shellFlag = isWin ? '/c' : '-c';
  const r = spawnSync(shell, [shellFlag, cmdStr], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    command: cmdStr,
    exit_code: r.status == null ? -1 : r.status,
    duration_ms: Date.now() - start,
    stdout: (r.stdout || '').slice(-8000),
    stderr: (r.stderr || '').slice(-8000),
    timed_out: r.error && r.error.code === 'ETIMEDOUT',
    passed: r.status === 0,
  };
}

/**
 * Run configured gate commands inside the club's worktree.
 * Stops on first failure, returns structured result.
 */
async function gateCommand(clubIdArg, opts = {}) {
  initSchema();
  const config = loadAutomationConfig();
  const db = getDb();

  const club = getClub(clubIdArg);
  if (!club) {
    console.log(JSON.stringify({ status: 'error', error: `Club ${clubIdArg} not found` }));
    process.exit(1);
  }

  const cwd = club.worktree_path;
  if (!cwd || !fs.existsSync(cwd)) {
    console.log(JSON.stringify({
      status: 'error',
      error: `Worktree missing for club ${club.id}. Run 'autofix-hub worktree create ${club.id}' first.`,
    }));
    process.exit(1);
  }

  const commands = (opts.commands && opts.commands.length)
    ? opts.commands
    : config.gate.commands;

  const results = [];
  let allPassed = true;
  for (const cmd of commands) {
    const r = runCommand(cmd, cwd, config.gate.timeout_ms);
    results.push(r);
    if (!r.passed) { allPassed = false; break; }
  }

  // Persist gate result (summary only — the full stdout/stderr stays in the response for Cascade to read).
  const summary = {
    passed: allPassed,
    steps: results.map(r => ({ command: r.command, passed: r.passed, exit_code: r.exit_code, duration_ms: r.duration_ms })),
    failed_at: allPassed ? null : results[results.length - 1].command,
  };
  db.prepare('UPDATE clubs SET gate_result = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(summary), new Date().toISOString(), club.id);

  console.log(JSON.stringify({
    status: allPassed ? 'pass' : 'fail',
    club_id: club.id,
    worktree_path: cwd,
    summary,
    results,
  }, null, 2));

  process.exit(allPassed ? 0 : 2);
}

module.exports = { gateCommand };
