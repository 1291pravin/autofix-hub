'use strict';

const chalk = require('chalk');
const { getDb } = require('../db');
const { initSchema } = require('../setup');
const { getPlugin } = require('../pluginLoader');
const git = require('../git');
const { releaseLocksForIssue } = require('../locks');

/**
 * Rollback a fix: restore files from main, delete branch, set status back to open.
 */
async function rollbackCommand(source, id) {
  const plugin = getPlugin(source);
  const db = getDb();
  initSchema();

  const issue = db.prepare('SELECT * FROM issues WHERE id = ? AND source = ?').get(id, source);
  if (!issue) {
    console.error(chalk.red(`Issue ${id} not found for source ${source}.`));
    process.exit(1);
  }

  if (issue.status === 'open') {
    console.log(chalk.yellow(`Issue ${id} is already open. Nothing to rollback.`));
    return;
  }

  const now = new Date().toISOString();

  // Get affected files from the branch diff
  let affectedFiles = [];
  try {
    if (issue.fix_branch) {
      affectedFiles = git.getChangedFiles(issue.fix_branch);
    }
  } catch (_) {}

  // Rollback git changes
  try {
    if (issue.cluster_id) {
      git.rollbackCluster(issue.cluster_id);
      // Reset cluster status
      db.prepare('UPDATE clusters SET status = ?, fix_branch = NULL WHERE id = ?')
        .run('open', issue.cluster_id);
      // Reset all issues in cluster
      db.prepare(`
        UPDATE issues
        SET status = 'open', fix_branch = NULL, updated_at = ?
        WHERE cluster_id = ? AND status IN ('in_progress', 'ai_fixed')
      `).run(now, issue.cluster_id);
    } else {
      git.rollbackFix(id, affectedFiles);
    }
  } catch (err) {
    console.warn(chalk.yellow(`Warning: Git rollback had issues: ${err.message}`));
  }

  // Update issue status
  db.prepare(`
    UPDATE issues
    SET status = 'open', fix_branch = NULL, updated_at = ?
    WHERE id = ?
  `).run(now, id);

  // Release file locks
  releaseLocksForIssue(id);
  if (issue.cluster_id) {
    releaseLocksForIssue(`cluster-${issue.cluster_id}`);
  }

  console.log(chalk.green(`${id} rolled back to open.`));
  if (affectedFiles.length > 0) {
    console.log(chalk.gray(`  Restored ${affectedFiles.length} file(s) to main.`));
  }
}

module.exports = { rollbackCommand };
