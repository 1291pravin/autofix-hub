'use strict';

const chalk = require('chalk');
const { getDb } = require('../db');
const { initSchema } = require('../setup');
const { getPlugin } = require('../pluginLoader');
const { createFixBranch, createClusterBranch } = require('../git');
const { acquireLock, isLocked } = require('../locks');

/**
 * Get the next highest-priority issue or cluster to fix for a source.
 * Outputs JSON for IDE/agent consumption.
 */
async function fixNextCommand(source) {
  const plugin = getPlugin(source);
  const db = getDb();
  initSchema();

  // Try cluster first (batch value), then individual issues
  const cluster = db.prepare(`
    SELECT c.id, c.cluster_key, c.issue_count, c.source
    FROM clusters c
    WHERE c.source = ? AND c.status = 'open'
    ORDER BY c.issue_count DESC
    LIMIT 1
  `).get(source);

  if (cluster) {
    const clusterIssues = db.prepare(`
      SELECT * FROM issues
      WHERE cluster_id = ? AND status = 'open' AND is_duplicate = 0
      ORDER BY impact_score DESC
    `).all(cluster.id);

    if (clusterIssues.length > 0) {
      // Check for locked files
      const hasLockedFiles = clusterIssues.some(i => i.file_path && isLocked(i.file_path));
      if (!hasLockedFiles) {
        return await processClusterFix(cluster, clusterIssues, plugin, db);
      }
    }
  }

  // Fall back to individual issues
  const issue = db.prepare(`
    SELECT * FROM issues
    WHERE source = ? AND status = 'open' AND is_duplicate = 0
    ORDER BY (impact_score / COALESCE(estimated_minutes, 15)) DESC
    LIMIT 1
  `).get(source);

  if (!issue) {
    console.log(chalk.yellow(`No open issues found for ${source}.`));
    process.exit(0);
  }

  // Check for locked files
  if (issue.file_path && isLocked(issue.file_path)) {
    console.error(chalk.red(`File ${issue.file_path} is locked by another fix in progress.`));
    process.exit(1);
  }

  await processIssueFix(issue, plugin, db);
}

/**
 * Fix a specific issue by ID.
 */
async function fixCommand(source, id) {
  const plugin = getPlugin(source);
  const db = getDb();
  initSchema();

  const issue = db.prepare('SELECT * FROM issues WHERE id = ? AND source = ?').get(id, source);
  if (!issue) {
    console.error(chalk.red(`Issue ${id} not found for source ${source}.`));
    process.exit(1);
  }

  if (issue.status !== 'open') {
    console.error(chalk.red(`Issue ${id} is not open (status: ${issue.status}).`));
    process.exit(1);
  }

  if (issue.file_path && isLocked(issue.file_path)) {
    console.error(chalk.red(`File ${issue.file_path} is locked by another fix in progress.`));
    process.exit(1);
  }

  await processIssueFix(issue, plugin, db);
}

/**
 * Fix all issues in a specific cluster.
 */
async function fixClusterCommand(source, clusterId) {
  const plugin = getPlugin(source);
  const db = getDb();
  initSchema();

  const cluster = db.prepare('SELECT * FROM clusters WHERE id = ? AND source = ?').get(clusterId, source);
  if (!cluster) {
    console.error(chalk.red(`Cluster ${clusterId} not found for source ${source}.`));
    process.exit(1);
  }

  const clusterIssues = db.prepare(`
    SELECT * FROM issues
    WHERE cluster_id = ? AND status = 'open' AND is_duplicate = 0
    ORDER BY impact_score DESC
  `).all(clusterId);

  if (clusterIssues.length === 0) {
    console.log(chalk.yellow(`No open issues in cluster ${clusterId}.`));
    process.exit(0);
  }

  const hasLockedFiles = clusterIssues.some(i => i.file_path && isLocked(i.file_path));
  if (hasLockedFiles) {
    console.error(chalk.red(`Some files in cluster ${clusterId} are locked by another fix in progress.`));
    process.exit(1);
  }

  await processClusterFix(cluster, clusterIssues, plugin, db);
}

/**
 * Process a single issue fix: transition status, create branch, acquire locks, output JSON.
 */
async function processIssueFix(issue, plugin, db) {
  // Atomic status transition
  const result = db.prepare(
    `UPDATE issues SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'open'`
  ).run(new Date().toISOString(), issue.id);

  if (result.changes === 0) {
    console.error(chalk.red(`Issue ${issue.id} was already picked up by another process.`));
    process.exit(1);
  }

  // Create git branch
  let branch;
  try {
    branch = createFixBranch(issue.id);
  } catch (err) {
    // Rollback status
    db.prepare(`UPDATE issues SET status = 'open', updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), issue.id);
    console.error(chalk.red(`Failed to create branch: ${err.message}`));
    process.exit(1);
  }

  // Store branch in DB
  db.prepare('UPDATE issues SET fix_branch = ? WHERE id = ?').run(branch, issue.id);

  // Acquire file locks
  if (issue.file_path) {
    acquireLock(issue.file_path, issue.id);
  }

  // Output JSON
  const output = {
    issueId: issue.id,
    branch,
    files: issue.file_path ? [issue.file_path] : [],
    fixPrompt: issue.fix_prompt || '',
    clusterInfo: null,
    reviewLevel: issue.review_level || 'careful',
    estimatedEffort: issue.estimated_effort || 'medium',
    severity: issue.severity,
    category: issue.category,
    ruleId: issue.rule_id,
    description: issue.description,
  };

  console.log(JSON.stringify(output, null, 2));
}

/**
 * Process a cluster fix: transition all issues, create branch, acquire locks, output JSON.
 */
async function processClusterFix(cluster, clusterIssues, plugin, db) {
  const now = new Date().toISOString();

  // Atomic status transitions for all issues in cluster
  const transitionStmt = db.prepare(
    `UPDATE issues SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'open'`
  );

  const transitioned = [];
  const transition = db.transaction(() => {
    for (const issue of clusterIssues) {
      const r = transitionStmt.run(now, issue.id);
      if (r.changes > 0) transitioned.push(issue);
    }
  });
  transition();

  if (transitioned.length === 0) {
    console.error(chalk.red(`All issues in cluster ${cluster.id} were already picked up.`));
    process.exit(1);
  }

  // Create git branch
  let branch;
  try {
    branch = createClusterBranch(cluster.id);
  } catch (err) {
    // Rollback status
    const rollback = db.prepare(`UPDATE issues SET status = 'open', updated_at = ? WHERE id = ?`);
    for (const issue of transitioned) rollback.run(now, issue.id);
    console.error(chalk.red(`Failed to create branch: ${err.message}`));
    process.exit(1);
  }

  // Update cluster and issues with branch
  db.prepare('UPDATE clusters SET status = ?, fix_branch = ? WHERE id = ?')
    .run('in_progress', branch, cluster.id);
  const updateBranch = db.prepare('UPDATE issues SET fix_branch = ? WHERE id = ?');
  for (const issue of transitioned) updateBranch.run(branch, issue.id);

  // Acquire file locks
  const files = [...new Set(transitioned.map(i => i.file_path).filter(Boolean))];
  for (const fp of files) {
    acquireLock(fp, `cluster-${cluster.id}`);
  }

  // Generate batch prompt if plugin supports it
  let fixPrompt = '';
  if (typeof plugin.batchPromptTemplate === 'function') {
    fixPrompt = plugin.batchPromptTemplate(transitioned);
  } else {
    // Fallback: concatenate individual prompts
    fixPrompt = transitioned
      .map(i => i.fix_prompt || '')
      .filter(Boolean)
      .join('\n\n---\n\n');
  }

  // Output JSON
  const output = {
    issueId: transitioned[0].id,
    branch,
    files,
    fixPrompt,
    clusterInfo: {
      clusterId: cluster.id,
      clusterKey: cluster.cluster_key,
      issueCount: transitioned.length,
      issueIds: transitioned.map(i => i.id),
    },
    reviewLevel: transitioned[0].review_level || 'careful',
    estimatedEffort: transitioned[0].estimated_effort || 'medium',
    severity: transitioned[0].severity,
    category: transitioned[0].category,
    ruleId: transitioned[0].rule_id,
    description: `Cluster: ${cluster.cluster_key} (${transitioned.length} issues)`,
  };

  console.log(JSON.stringify(output, null, 2));
}

module.exports = { fixNextCommand, fixCommand, fixClusterCommand };
