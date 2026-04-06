'use strict';

const chalk = require('chalk');
const { getDb } = require('../db');
const { initSchema } = require('../setup');
const { loadCredentials, loadScoringConfig, loadProjectEnv } = require('../config');
const { getPlugin } = require('../pluginLoader');
const { dedupIssues } = require('../dedup');
const { scoreIssue } = require('../scoring');
const { clusterIssues } = require('../clustering');

/**
 * Fetch issues from a scanner source, normalize, dedup, score, cluster, and insert into DB.
 */
async function fetchCommand(source) {
  const plugin = getPlugin(source);
  const db = getDb();
  initSchema();

  const credentials = loadCredentials();
  const scoringConfig = loadScoringConfig();
  const config = {
    ...credentials[source],
    env: process.env,
  };

  // 1. Fetch raw issues
  console.log(chalk.cyan(`Fetching issues from ${plugin.displayName || source}...`));
  let rawIssues;
  try {
    rawIssues = await plugin.fetch(config);
  } catch (err) {
    console.error(chalk.red(`Fetch failed: ${err.message}`));
    process.exit(1);
  }

  if (!rawIssues || rawIssues.length === 0) {
    console.log(chalk.yellow('No issues found.'));
    insertScanHistory(db, source, 0, 0, 0);
    return;
  }

  console.log(chalk.gray(`  Raw issues: ${rawIssues.length}`));

  // 2. Normalize
  const normalized = rawIssues.map(raw => plugin.normalize(raw)).filter(Boolean);

  // 3. Dedup
  const newIssues = dedupIssues(normalized, plugin, db);
  console.log(chalk.gray(`  After dedup: ${newIssues.length} new`));

  // 4. Score, estimate effort, set review level and fix prompt
  for (const issue of newIssues) {
    issue.impact_score = scoreIssue(issue, plugin, scoringConfig);

    if (typeof plugin.effortEstimate === 'function') {
      const effort = plugin.effortEstimate(issue);
      issue.estimated_effort = effort.level;
      issue.estimated_minutes = effort.minutes;
    }

    if (typeof plugin.reviewLevel === 'function') {
      issue.review_level = plugin.reviewLevel(issue);
    }

    if (typeof plugin.promptTemplate === 'function') {
      issue.fix_prompt = plugin.promptTemplate(issue);
    }

    issue.created_at = issue.created_at || new Date().toISOString();
    issue.updated_at = new Date().toISOString();
    issue.status = issue.status || 'open';
  }

  // 5. Insert into DB
  const insertIssue = db.prepare(`
    INSERT INTO issues (
      id, source, rule_id, severity, category, status, review_level,
      file_path, line_number, description, fix_prompt, impact_score,
      estimated_effort, estimated_minutes, dedup_group, is_duplicate,
      scanner_data, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?
    )
  `);

  const insertMetadata = db.prepare(`
    INSERT OR REPLACE INTO issue_metadata (issue_id, key, value) VALUES (?, ?, ?)
  `);

  const insertAll = db.transaction(() => {
    for (const issue of newIssues) {
      insertIssue.run(
        issue.id, issue.source, issue.rule_id, issue.severity, issue.category,
        issue.status, issue.review_level,
        issue.file_path, issue.line_number || null, issue.description, issue.fix_prompt,
        issue.impact_score,
        issue.estimated_effort, issue.estimated_minutes,
        issue.dedup_group || null, issue.is_duplicate || 0,
        issue.scanner_data || null, issue.created_at, issue.updated_at
      );

      // Store metadata if present
      if (issue.metadata && typeof issue.metadata === 'object') {
        for (const [key, value] of Object.entries(issue.metadata)) {
          insertMetadata.run(issue.id, key, typeof value === 'string' ? value : JSON.stringify(value));
        }
      }
    }
  });

  insertAll();

  // 6. Cluster
  clusterIssues(newIssues, plugin, db);

  // 7. Reopen check: issues that were merged but reappear
  let reopened = 0;
  const findMerged = db.prepare(
    `SELECT id FROM issues WHERE source = ? AND status IN ('merged', 'closed') AND id = ?`
  );
  const reopenIssue = db.prepare(
    `UPDATE issues SET status = 'open', resolved_at = NULL, updated_at = ? WHERE id = ?`
  );

  for (const raw of rawIssues) {
    const norm = plugin.normalize(raw);
    if (!norm) continue;
    const merged = findMerged.get(source, norm.id);
    if (merged) {
      reopenIssue.run(new Date().toISOString(), norm.id);
      reopened++;
    }
  }

  // 8. Scan history
  insertScanHistory(db, source, rawIssues.length, newIssues.length, reopened);

  // 9. Notification (best-effort)
  try {
    const webhookUrl = process.env.NOTIFICATION_WEBHOOK_URL;
    if (webhookUrl && newIssues.length > 0) {
      const { sendNotification } = require('../notify');
      const criticalCount = newIssues.filter(i => i.severity === 'critical').length;
      const totalOpen = db.prepare(
        `SELECT COUNT(*) as cnt FROM issues WHERE source = ? AND status = 'open'`
      ).get(source).cnt;

      await sendNotification({
        source,
        new_issues: newIssues.length,
        total_open: totalOpen,
        critical_count: criticalCount,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (_) {
    // Notification failure is non-fatal
  }

  // 10. Summary
  console.log(chalk.green(`\nFetch complete for ${plugin.displayName || source}:`));
  console.log(`  Found: ${chalk.bold(rawIssues.length)} issues`);
  console.log(`  New:   ${chalk.bold(newIssues.length)}`);
  if (reopened > 0) {
    console.log(`  Reopened: ${chalk.yellow.bold(reopened)}`);
  }
}

function insertScanHistory(db, source, found, newCount, reopened) {
  db.prepare(`
    INSERT INTO scan_history (source, ran_at, issues_found, new_issues, reopened)
    VALUES (?, ?, ?, ?, ?)
  `).run(source, new Date().toISOString(), found, newCount, reopened);
}

module.exports = { fetchCommand };
