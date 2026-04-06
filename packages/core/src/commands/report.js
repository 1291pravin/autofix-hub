'use strict';

const chalk = require('chalk');
const Table = require('cli-table3');
const { getDb } = require('../db');
const { initSchema } = require('../setup');
const { getStats, getMTTF, getQueueHealth } = require('../metrics');

/**
 * Display a terminal report.
 * If source specified: source-specific report.
 * If no source: cross-source summary.
 */
function reportCommand(source = null) {
  const db = getDb();
  initSchema();

  if (source) {
    printSourceReport(source, db);
  } else {
    printSummaryReport(db);
  }
}

function printSummaryReport(db) {
  const stats = getStats();

  console.log('');
  console.log(chalk.bold.cyan('  autofix-hub Report'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');

  // Cross-source status table
  const sources = [...new Set(stats.bySource.map(r => r.source))].sort();

  if (sources.length > 0) {
    const statusTable = new Table({
      head: ['Source', 'Open', 'In Progress', 'AI Fixed', 'Verified', 'Merged', 'Rejected'].map(h => chalk.white(h)),
      style: { head: [], border: ['gray'] },
    });

    for (const src of sources) {
      const srcRows = stats.bySource.filter(r => r.source === src);
      const c = {};
      for (const row of srcRows) c[row.status] = row.count;

      statusTable.push([
        chalk.bold(src),
        colorCount(c.open || 0, 'open'),
        colorCount(c.in_progress || 0, 'in_progress'),
        colorCount(c.ai_fixed || 0, 'ai_fixed'),
        colorCount(c.verified || 0, 'verified'),
        colorCount(c.merged || 0, 'merged'),
        colorCount(c.rejected || 0, 'rejected'),
      ]);
    }

    // Totals row
    statusTable.push([
      chalk.bold('TOTAL'),
      chalk.bold(String(stats.open)),
      chalk.bold(String(stats.in_progress)),
      chalk.bold(String(stats.ai_fixed)),
      chalk.bold(String(stats.verified)),
      chalk.bold(String(stats.merged)),
      chalk.bold(String(stats.rejected)),
    ]);

    console.log(statusTable.toString());
  } else {
    console.log(chalk.gray('  No issues found. Run a fetch first.'));
  }

  // Summary cards
  console.log('');
  console.log(chalk.bold('  Summary'));
  console.log(`    Total Issues:     ${chalk.bold(String(stats.total))}`);
  console.log(`    Acceptance Rate:  ${colorRate(stats.acceptanceRate)}%`);
  console.log(`    Auto-Approved:    ${stats.autoApproved}`);
  console.log('');

  // Queue health
  const health = getQueueHealth();
  console.log(chalk.bold('  Queue Health'));
  console.log(`    Open:             ${health.open}`);
  console.log(`    In Progress:      ${health.inProgress}`);
  console.log(`    Awaiting Review:  ${health.aiFixed}`);
  console.log(`    Est. Time Clear:  ${health.estimatedHours}h`);
  console.log(`    Aging (>7 days):  ${health.aging > 0 ? chalk.red(String(health.aging)) : chalk.green('0')}`);
  console.log('');

  // Top 5 issues by priority
  printTopIssues(db, null);
}

function printSourceReport(source, db) {
  const stats = getStats(source);

  console.log('');
  console.log(chalk.bold.cyan(`  autofix-hub Report: ${source}`));
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');

  console.log(chalk.bold('  Status'));
  console.log(`    Open:           ${colorCount(stats.open, 'open')}`);
  console.log(`    In Progress:    ${colorCount(stats.in_progress, 'in_progress')}`);
  console.log(`    AI Fixed:       ${colorCount(stats.ai_fixed, 'ai_fixed')}`);
  console.log(`    Verified:       ${colorCount(stats.verified, 'verified')}`);
  console.log(`    Merged:         ${colorCount(stats.merged, 'merged')}`);
  console.log(`    Rejected:       ${colorCount(stats.rejected, 'rejected')}`);
  console.log(`    Total:          ${chalk.bold(String(stats.total))}`);
  console.log('');

  console.log(chalk.bold('  Metrics'));
  console.log(`    Acceptance Rate:  ${colorRate(stats.acceptanceRate)}%`);
  console.log(`    Auto-Approved:    ${stats.autoApproved}`);

  const mttf = getMTTF({ source });
  if (mttf.avgHours !== null) {
    console.log(`    Avg Time to Fix:  ${mttf.avgHours}h (${mttf.count} resolved)`);
  } else {
    console.log(`    Avg Time to Fix:  ${chalk.gray('N/A')}`);
  }
  console.log('');

  // Top issues by severity
  printTopIssues(db, source);

  // Recent scan history
  const scans = db.prepare(`
    SELECT * FROM scan_history
    WHERE source = ?
    ORDER BY ran_at DESC
    LIMIT 5
  `).all(source);

  if (scans.length > 0) {
    console.log(chalk.bold('  Recent Scans'));
    const scanTable = new Table({
      head: ['Date', 'Found', 'New', 'Reopened'].map(h => chalk.white(h)),
      style: { head: [], border: ['gray'] },
    });

    for (const s of scans) {
      scanTable.push([
        formatDate(s.ran_at),
        String(s.issues_found),
        String(s.new_issues),
        String(s.reopened || 0),
      ]);
    }

    console.log(scanTable.toString());
    console.log('');
  }
}

function printTopIssues(db, source) {
  const where = source ? "WHERE source = ? AND status = 'open'" : "WHERE status = 'open'";
  const params = source ? [source] : [];

  const topIssues = db.prepare(`
    SELECT id, source, severity, impact_score, estimated_minutes, description, file_path
    FROM issues
    ${where}
    ORDER BY
      CASE WHEN estimated_minutes > 0 THEN impact_score / estimated_minutes ELSE impact_score END DESC
    LIMIT 5
  `).all(...params);

  if (topIssues.length === 0) return;

  console.log(chalk.bold('  Top Issues by Priority'));
  const issueTable = new Table({
    head: ['#', 'ID', 'Severity', 'Score', 'Effort', 'Description'].map(h => chalk.white(h)),
    style: { head: [], border: ['gray'] },
    colWidths: [4, 20, 10, 8, 8, 40],
    wordWrap: true,
  });

  topIssues.forEach((issue, i) => {
    issueTable.push([
      String(i + 1),
      issue.id,
      colorSeverity(issue.severity),
      issue.impact_score ? issue.impact_score.toFixed(1) : '-',
      issue.estimated_minutes ? `${issue.estimated_minutes}m` : '-',
      truncate(issue.description || issue.file_path || '', 38),
    ]);
  });

  console.log(issueTable.toString());
  console.log('');
}

// --- Formatting helpers ---

function colorCount(count, status) {
  const n = String(count);
  if (count === 0) return chalk.gray(n);
  switch (status) {
    case 'open': return chalk.yellow(n);
    case 'in_progress': return chalk.cyan(n);
    case 'ai_fixed': return chalk.blue(n);
    case 'verified': return chalk.green(n);
    case 'merged': return chalk.greenBright(n);
    case 'rejected': return chalk.red(n);
    default: return n;
  }
}

function colorSeverity(severity) {
  switch (severity) {
    case 'critical': return chalk.red.bold('CRITICAL');
    case 'high': return chalk.red('HIGH');
    case 'medium': return chalk.yellow('MEDIUM');
    case 'low': return chalk.blue('LOW');
    case 'info': return chalk.gray('INFO');
    default: return severity || '-';
  }
}

function colorRate(rate) {
  if (rate >= 80) return chalk.green(String(rate));
  if (rate >= 50) return chalk.yellow(String(rate));
  return chalk.red(String(rate));
}

function formatDate(isoStr) {
  if (!isoStr) return '-';
  return isoStr.replace('T', ' ').slice(0, 16);
}

function truncate(str, len) {
  if (str.length <= len) return str;
  return str.slice(0, len - 1) + '…';
}

module.exports = { reportCommand };
