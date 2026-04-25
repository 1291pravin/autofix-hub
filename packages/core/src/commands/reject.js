'use strict';

const chalk = require('chalk');
const { getDb } = require('../db');
const { initSchema } = require('../setup');
const { getPlugin } = require('../pluginLoader');
const git = require('../git');
const { releaseLocksForIssue } = require('../locks');

const VALID_TAGS = [
  'wrong_scope',
  'broke_tests',
  'style_mismatch',
  'incomplete_fix',
  'wrong_approach',
  'other',
];

/**
 * Reject a fix with a categorized tag and reason.
 */
async function rejectCommand(source, id, tag, reason) {
  const plugin = getPlugin(source);
  const db = getDb();
  initSchema();

  // Validate tag
  if (!VALID_TAGS.includes(tag)) {
    console.error(chalk.red(`Invalid rejection tag: '${tag}'`));
    console.error(chalk.gray(`Valid tags: ${VALID_TAGS.join(', ')}`));
    process.exit(1);
  }

  const issue = db.prepare('SELECT * FROM issues WHERE id = ? AND source = ?').get(id, source);
  if (!issue) {
    console.error(chalk.red(`Issue ${id} not found for source ${source}.`));
    process.exit(1);
  }

  const now = new Date().toISOString();

  // Log fix attempt as failed with diff content
  let diffContent = null;
  try {
    if (issue.fix_branch) {
      diffContent = git.getDiffContent(issue.fix_branch);
    }
  } catch (_) {}

  const attemptNum = (db.prepare(
    'SELECT MAX(attempt_number) as max_num FROM fix_attempts WHERE issue_id = ?'
  ).get(id).max_num || 0) + 1;

  db.prepare(`
    INSERT INTO fix_attempts (issue_id, attempt_number, status, diff_content, error_log, attempted_at)
    VALUES (?, ?, 'failed', ?, ?, ?)
  `).run(id, attemptNum, diffContent, `[${tag}] ${reason}`, now);

  // Upsert rejection pattern
  const existingPattern = db.prepare(`
    SELECT id, occurrences FROM rejection_patterns
    WHERE source = ? AND rule_id = ? AND pattern_tag = ?
  `).get(source, issue.rule_id || '', tag);

  if (existingPattern) {
    db.prepare(`
      UPDATE rejection_patterns
      SET occurrences = occurrences + 1, last_seen_at = ?, description = ?
      WHERE id = ?
    `).run(now, reason, existingPattern.id);
  } else {
    db.prepare(`
      INSERT INTO rejection_patterns (source, rule_id, pattern_tag, description, occurrences, last_seen_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(source, issue.rule_id || '', tag, reason, now);
  }

  // Update issue status
  db.prepare(`
    UPDATE issues
    SET status = 'rejected', rejected_reason = ?, updated_at = ?
    WHERE id = ?
  `).run(`[${tag}] ${reason}`, now, id);

  // Resolve cluster membership once
  const clusterRow = issue.cluster_id
    ? { cluster_id: issue.cluster_id }
    : db.prepare('SELECT cluster_id FROM issue_clusters WHERE issue_id = ? LIMIT 1').get(id);
  const effectiveClusterId = clusterRow ? clusterRow.cluster_id : null;

  // Delete fix branch
  try {
    if (issue.fix_branch) {
      if (effectiveClusterId) {
        git.rollbackCluster(effectiveClusterId);
      } else {
        git.rollbackFix(id);
      }
    }
  } catch (err) {
    console.warn(chalk.yellow(`Warning: Could not clean up branch: ${err.message}`));
  }

  // Release file locks
  releaseLocksForIssue(id);
  if (effectiveClusterId) {
    releaseLocksForIssue(`cluster-${effectiveClusterId}`);
  }

  console.log(chalk.green(`${id} rejected [${tag}]: ${reason}`));
}

module.exports = { rejectCommand, VALID_TAGS };
