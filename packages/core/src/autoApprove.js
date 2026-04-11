'use strict';

const chalk = require('chalk');
const git = require('./git');

/**
 * Check if an issue qualifies for auto-approval.
 * Called automatically when status transitions to 'ai_fixed'.
 */
function checkAutoApprove(issue, db) {
  const enabled = true; // auto-approve enabled by default
  if (!enabled) {
    logDecision(db, issue.id, 'skipped', 'Auto-approve disabled', null);
    return;
  }

  // Only auto-approve quick review level issues
  if (issue.review_level !== 'quick') {
    logDecision(db, issue.id, 'blocked', `Review level '${issue.review_level}' requires manual review`, null);
    return;
  }

  // NEVER auto-approve security issues from Apiiro
  if (issue.source === 'apiiro') {
    logDecision(db, issue.id, 'blocked', 'Apiiro issues are never auto-approved', null);
    return;
  }

  // Get diff stats
  let diffStats;
  try {
    diffStats = git.getDiffStat(issue.fix_branch);
  } catch (err) {
    logDecision(db, issue.id, 'blocked', `Cannot read diff: ${err.message}`, null);
    return;
  }

  // Parse diff stats: count total lines changed
  const { filesChanged, linesChanged } = parseDiffStat(diffStats);
  const maxLines = 10;

  if (linesChanged > maxLines) {
    logDecision(db, issue.id, 'blocked', `Diff too large: ${linesChanged} lines (max ${maxLines})`, diffStats);
    console.log(chalk.yellow(`  Auto-approve blocked: ${linesChanged} lines changed (max ${maxLines})`));
    return;
  }

  // Check for unexpected files
  let changedFiles;
  try {
    changedFiles = git.getChangedFiles(issue.fix_branch);
  } catch (_) {
    changedFiles = [];
  }

  if (issue.file_path && changedFiles.length > 0) {
    const expectedDir = issue.file_path.replace(/[/\\][^/\\]+$/, '');
    const unexpected = changedFiles.filter(f => !f.startsWith(expectedDir) && f !== issue.file_path);
    if (unexpected.length > 0) {
      logDecision(db, issue.id, 'blocked', `Unexpected files touched: ${unexpected.join(', ')}`, diffStats);
      console.log(chalk.yellow(`  Auto-approve blocked: unexpected files changed`));
      return;
    }
  }

  // All checks passed — auto-approve
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE issues SET status = 'verified', reviewed_by = 'auto-approve', updated_at = ? WHERE id = ?`
  ).run(now, issue.id);

  logDecision(db, issue.id, 'approved', `${filesChanged} file(s), ${linesChanged} line(s)`, diffStats);
  console.log(chalk.green(`  Auto-approved: ${issue.id} (${linesChanged} lines, ${filesChanged} files)`));
}

/**
 * Parse git diff --stat output to extract file and line counts.
 */
function parseDiffStat(statOutput) {
  if (!statOutput) return { filesChanged: 0, linesChanged: 0 };

  const lines = statOutput.trim().split('\n');
  // Last line is summary: " N files changed, M insertions(+), K deletions(-)"
  const summary = lines[lines.length - 1] || '';
  const filesMatch = summary.match(/(\d+)\s+files?\s+changed/);
  const insertMatch = summary.match(/(\d+)\s+insertions?/);
  const deleteMatch = summary.match(/(\d+)\s+deletions?/);

  const filesChanged = filesMatch ? parseInt(filesMatch[1], 10) : 0;
  const insertions = insertMatch ? parseInt(insertMatch[1], 10) : 0;
  const deletions = deleteMatch ? parseInt(deleteMatch[1], 10) : 0;

  return { filesChanged, linesChanged: insertions + deletions };
}

/**
 * Log auto-approve decision to auto_approve_log table.
 */
function logDecision(db, issueId, decision, reason, diffStats) {
  db.prepare(`
    INSERT INTO auto_approve_log (issue_id, decision, reason, diff_stats, decided_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(issueId, decision, reason, diffStats || null, new Date().toISOString());
}

module.exports = { checkAutoApprove };
