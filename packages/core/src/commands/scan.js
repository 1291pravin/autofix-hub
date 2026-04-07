'use strict';

const chalk = require('chalk');
const { getPlugin } = require('../pluginLoader');

/**
 * Quick scan command — runs a scan and prints results to terminal.
 * No DB insertion, no scoring, no clustering.
 *
 * @param {string} source - Plugin name (e.g., 'aqa')
 * @param {string} url - URL to scan (positional arg, optional if --urls provided)
 * @param {object} opts - CLI options
 */
async function scanCommand(source, url, opts = {}) {
  const plugin = getPlugin(source);

  if (!plugin.scanWithPlaywright) {
    console.error(chalk.red(`Plugin '${source}' does not support scanning. Use 'fetch' instead.`));
    process.exit(1);
  }

  const urls = url || opts.urls;
  if (!urls) {
    console.error(chalk.red('URL required. Usage: autofix-hub aqa scan <url>'));
    process.exit(1);
  }

  const config = {
    urls,
    scanEngine: opts.engine || 'axe',
    headless: opts.headless || false,
  };

  // Pass credentials for aqa engine
  if (opts.apiKey) config.apiKey = opts.apiKey;
  if (opts.teamSlug) config.teamSlug = opts.teamSlug;
  if (opts.suiteId) config.aqaSuiteId = opts.suiteId;
  if (opts.ruleset) config.ruleset = opts.ruleset;

  // Fallback to .env for aqa engine credentials
  if (!config.apiKey && process.env.AQA_API_KEY) config.apiKey = process.env.AQA_API_KEY;
  if (!config.teamSlug && process.env.AQA_TEAM_SLUG) config.teamSlug = process.env.AQA_TEAM_SLUG;

  console.log(chalk.cyan(`\nScanning with ${plugin.displayName || source}...`));
  console.log(chalk.gray(`  Engine: ${config.scanEngine}`));
  console.log(chalk.gray(`  URLs:   ${urls}`));

  let rawIssues;
  try {
    rawIssues = await plugin.scanWithPlaywright(config);
  } catch (err) {
    console.error(chalk.red(`\nScan failed: ${err.message}`));
    process.exit(1);
  }

  if (!rawIssues || rawIssues.length === 0) {
    console.log(chalk.green('\nNo issues found — site may be fully compliant.'));
    return;
  }

  // Normalize
  const normalized = rawIssues.map(raw => plugin.normalize(raw)).filter(Boolean);

  // Output based on format
  const format = opts.format || 'table';

  if (format === 'json') {
    console.log(JSON.stringify(normalized, null, 2));
    return;
  }

  if (format === 'summary') {
    printSummary(normalized);
    return;
  }

  // Default: table format
  printTable(normalized);
}

function printSummary(issues) {
  const bySeverity = {};
  const byCategory = {};

  for (const iss of issues) {
    bySeverity[iss.severity] = (bySeverity[iss.severity] || 0) + 1;
    byCategory[iss.category] = (byCategory[iss.category] || 0) + 1;
  }

  console.log(chalk.bold(`\nScan Results: ${issues.length} issues\n`));

  console.log(chalk.bold('By Severity:'));
  for (const [sev, count] of Object.entries(bySeverity).sort()) {
    const color = sev === 'critical' ? 'red' : sev === 'high' ? 'yellow' : 'gray';
    console.log(`  ${chalk[color](sev)}: ${count}`);
  }

  console.log(chalk.bold('\nBy Category:'));
  for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }
}

function printTable(issues) {
  let Table;
  try {
    Table = require('cli-table3');
  } catch (_) {
    // Fallback if cli-table3 not available
    printSummary(issues);
    console.log(chalk.bold('\nSample Issues (first 10):'));
    issues.slice(0, 10).forEach((iss, i) => {
      console.log(`  ${i + 1}. [${iss.severity.toUpperCase()}] ${iss.rule_id}`);
      console.log(`     ${iss.description}`);
    });
    return;
  }

  // Summary first
  printSummary(issues);

  // Then detailed table
  const table = new Table({
    head: [
      chalk.white.bold('#'),
      chalk.white.bold('Severity'),
      chalk.white.bold('Rule'),
      chalk.white.bold('Description'),
    ],
    style: { head: [], border: [] },
    colWidths: [5, 10, 25, 60],
    wordWrap: true,
  });

  const display = issues.slice(0, 25);
  display.forEach((iss, i) => {
    const sevColor = iss.severity === 'critical' ? 'red' : iss.severity === 'high' ? 'yellow' : 'white';
    table.push([
      i + 1,
      chalk[sevColor](iss.severity),
      iss.rule_id,
      iss.description.slice(0, 120),
    ]);
  });

  console.log(chalk.bold('\nIssues:'));
  console.log(table.toString());

  if (issues.length > 25) {
    console.log(chalk.gray(`\n  ... and ${issues.length - 25} more. Use --format json for full output.`));
  }
}

module.exports = { scanCommand };
