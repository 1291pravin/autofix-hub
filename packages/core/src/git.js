'use strict';

const { execSync } = require('child_process');

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', ...opts }).trim();
}

function runSafe(cmd, opts = {}) {
  try {
    return { ok: true, output: run(cmd, opts) };
  } catch (err) {
    return { ok: false, output: err.stderr || err.message };
  }
}

/**
 * Parse git remote URL → org/repo
 */
function getRepoName() {
  const url = run('git remote get-url origin');
  // Handle SSH (git@github.com:org/repo.git) and HTTPS (https://github.com/org/repo.git)
  const match = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match) throw new Error(`Cannot parse repo name from remote URL: ${url}`);
  return match[1];
}

function getCurrentBranch() {
  return run('git branch --show-current');
}

function createFixBranch(issueId) {
  const branch = `autofix/${issueId}`;
  run(`git checkout -b ${branch}`);
  return branch;
}

function createClusterBranch(clusterId) {
  const branch = `autofix/cluster-${clusterId}`;
  return branch;
}

/**
 * Stage all changes and commit with conventional commit message.
 */
function commitFix(issueId, message) {
  run('git add -A');
  // Escape double quotes in message
  const escaped = message.replace(/"/g, '\\"');
  run(`git commit -m "${escaped}"`);
}

/**
 * Push branch and create a PR via gh CLI.
 * Returns the PR URL.
 */
function pushAndCreatePR(issueId, title, body) {
  const branch = getCurrentBranch();
  run(`git push -u origin ${branch}`);

  const escapedTitle = title.replace(/"/g, '\\"');
  // Write body to a temp approach using stdin to avoid shell escaping issues
  const prUrl = run(`gh pr create --title "${escapedTitle}" --body-file -`, {
    input: body,
  });
  return prUrl;
}

/**
 * Poll gh pr checks until all complete or timeout.
 * Returns { passed: bool, details: string }
 */
function checkCIStatus(prUrl, timeoutMs = 600000, intervalMs = 15000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const result = runSafe(`gh pr checks "${prUrl}"`);
    const output = result.output;

    if (!output) {
      sleep(intervalMs);
      continue;
    }

    // Check if any are still pending
    const hasPending = output.includes('pending') || output.includes('queued') || output.includes('in_progress');
    if (hasPending) {
      sleep(intervalMs);
      continue;
    }

    const hasFail = output.includes('fail') || output.includes('error');
    return { passed: !hasFail, details: output };
  }

  return { passed: false, details: 'CI check timed out' };
}

function sleep(ms) {
  execSync(`sleep ${Math.ceil(ms / 1000)}`, { stdio: 'ignore' });
}

/**
 * Rollback a fix: restore files from main, switch back, delete branch.
 */
function rollbackFix(issueId, affectedFiles = []) {
  const branch = `autofix/${issueId}`;
  const currentBranch = getCurrentBranch();

  if (affectedFiles.length > 0) {
    const files = affectedFiles.map(f => `"${f}"`).join(' ');
    runSafe(`git checkout main -- ${files}`);
  }

  if (currentBranch === branch) {
    run('git checkout main');
  }

  runSafe(`git branch -D ${branch}`);
}

/**
 * Rollback a cluster fix branch.
 */
function rollbackCluster(clusterId) {
  const branch = `autofix/cluster-${clusterId}`;
  const currentBranch = getCurrentBranch();

  if (currentBranch === branch) {
    run('git checkout main');
  }

  runSafe(`git branch -D ${branch}`);
}

/**
 * Get diff stats between main and branch.
 */
function getDiffStat(branch) {
  branch = branch || getCurrentBranch();
  return run(`git diff --stat main...${branch}`);
}

/**
 * Get full diff content between main and branch.
 */
function getDiffContent(branch) {
  branch = branch || getCurrentBranch();
  return run(`git diff main...${branch}`);
}

/**
 * Get list of files changed between main and branch.
 */
function getChangedFiles(branch) {
  branch = branch || getCurrentBranch();
  const output = run(`git diff --name-only main...${branch}`);
  return output ? output.split('\n').filter(Boolean) : [];
}

module.exports = {
  getRepoName,
  getCurrentBranch,
  createFixBranch,
  createClusterBranch,
  commitFix,
  pushAndCreatePR,
  checkCIStatus,
  rollbackFix,
  rollbackCluster,
  getDiffStat,
  getDiffContent,
  getChangedFiles,
};
