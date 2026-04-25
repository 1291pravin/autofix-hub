#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const { loadPlugins, listPlugins, KNOWN_PLUGINS } = require('../src/pluginLoader');

program
  .name('autofix-hub')
  .description('Unified scanner issue manager — fetch, fix, approve, and track issues from Apiiro, AQA, and SonarQube')
  .version('0.1.0');

// === Shared commands ===

program
  .command('setup')
  .description('Interactive setup wizard — configure scanners and initialize project')
  .action(async () => {
    const { setupCommand } = require('../src/commands/setup');
    await setupCommand();
  });

program
  .command('dashboard')
  .description('Start the dashboard web server')
  .action(async () => {
    const { dashboardCommand } = require('../src/commands/dashboard');
    await dashboardCommand();
  });

program
  .command('report')
  .description('Cross-source terminal summary report')
  .action(async () => {
    const { reportCommand } = require('../src/commands/report');
    await reportCommand();
  });

program
  .command('status <id> <newStatus>')
  .description('Transition issue status')
  .action(async (id, newStatus) => {
    const { statusCommand } = require('../src/commands/status');
    await statusCommand(id, newStatus);
  });

// === Club-scoped primitives for automated fire-and-forget runs ===

const worktreeCmd = program
  .command('worktree')
  .description('Manage per-club git worktrees');

worktreeCmd
  .command('create <clubId>')
  .description('Create an isolated worktree + branch for a club')
  .action(async (clubId) => {
    const { worktreeCreateCommand } = require('../src/commands/worktree');
    await worktreeCreateCommand(clubId);
  });

worktreeCmd
  .command('destroy <clubId>')
  .description('Remove a club worktree (deletes branch if no PR opened)')
  .action(async (clubId) => {
    const { worktreeDestroyCommand } = require('../src/commands/worktree');
    await worktreeDestroyCommand(clubId);
  });

program
  .command('gate <clubId>')
  .description('Run the configured gate (lint/typecheck/build) inside a club worktree')
  .option('--json', 'Output JSON (default)')
  .option('--cmd <command...>', 'Override gate commands (repeatable)')
  .action(async (clubId, opts) => {
    const { gateCommand } = require('../src/commands/gate');
    await gateCommand(clubId, { commands: opts.cmd });
  });

program
  .command('commit <clubId>')
  .description('Stage, commit, push, and open a PR for a club (enforces blocklist)')
  .option('--title <title>', 'Override PR title')
  .option('--body <body>', 'Override PR body')
  .option('--base <branch>', 'Base branch (overrides config)')
  .action(async (clubId, opts) => {
    const { commitCommand } = require('../src/commands/commit');
    await commitCommand(clubId, { title: opts.title, body: opts.body, baseBranch: opts.base });
  });

program
  .command('abandon <clubId>')
  .description('Abandon a club — restore issues, destroy worktree')
  .option('--reason <reason>', 'Why the club was abandoned', 'unspecified')
  .action(async (clubId, opts) => {
    const { abandonCommand } = require('../src/commands/abandon');
    await abandonCommand(clubId, { reason: opts.reason });
  });

program
  .command('summarize')
  .description('Summarize a session (writes markdown, optionally posts GitHub issue)')
  .option('--session <id>', 'Session ID (default: latest active)')
  .option('--post <target>', 'Post summary to: github-issue')
  .option('--end', 'Mark the session as ended')
  .action(async (opts) => {
    const { summarizeCommand } = require('../src/commands/summarize');
    await summarizeCommand(opts);
  });

// === Source-specific commands ===
// Register subcommands for each loaded plugin

let plugins;
try {
  plugins = loadPlugins();
} catch (_) {
  plugins = new Map();
}

for (const [name, plugin] of plugins) {
  const sourceCmd = program
    .command(name)
    .description(`${plugin.displayName || name} scanner commands`);

  sourceCmd
    .command('fetch')
    .description(`Fetch issues from ${plugin.displayName || name}, normalize, score, cluster, and store in DB`)
    .option('--method <method>', 'Scanning method: api or playwright', 'api')
    .option('--engine <engine>', 'Playwright scan engine: axe or aqa', 'axe')
    .option('--urls <urls>', 'Comma-separated URLs to scan (playwright method)')
    .option('--api-key <key>', 'API key (overrides .env)')
    .option('--team-slug <slug>', 'Team slug (overrides .env)')
    .option('--test-id <id>', 'Test ID for API method (overrides .env)')
    .option('--suite-id <id>', 'Suite ID (for aqa engine)')
    .option('--ruleset <id>', 'Ruleset ID (default: wcag22)')
    .option('--headless', 'Run browser in headless mode')
    .option('--dry-run', 'Show what would be fetched without writing to DB')
    .option('--json', 'Output results as JSON')
    .action(async (opts) => {
      const { fetchCommand } = require('../src/commands/fetch');
      await fetchCommand(name, opts);
    });

  sourceCmd
    .command('scan [url]')
    .description(`Quick scan — run accessibility check on a URL, print results (no DB)`)
    .option('--engine <engine>', 'Scan engine: axe or aqa', 'axe')
    .option('--urls <urls>', 'Comma-separated URLs (alternative to positional arg)')
    .option('--api-key <key>', 'API key (for aqa engine)')
    .option('--team-slug <slug>', 'Team slug (for aqa engine)')
    .option('--suite-id <id>', 'Suite ID (for aqa engine)')
    .option('--ruleset <id>', 'Ruleset ID (default: wcag22)')
    .option('--headless', 'Run browser in headless mode')
    .option('--format <format>', 'Output format: table, json, or summary', 'table')
    .action(async (url, opts) => {
      const { scanCommand } = require('../src/commands/scan');
      await scanCommand(name, url, opts);
    });

  sourceCmd
    .command('fix-next')
    .description('Get next highest-priority issue/cluster to fix (JSON)')
    .action(async () => {
      const { fixNextCommand } = require('../src/commands/fix');
      await fixNextCommand(name);
    });

  sourceCmd
    .command('fix <id>')
    .description('Get a specific issue to fix (JSON)')
    .action(async (id) => {
      const { fixCommand } = require('../src/commands/fix');
      await fixCommand(name, id);
    });

  sourceCmd
    .command('fix-cluster <clusterId>')
    .description('Get a cluster of issues to fix (JSON)')
    .action(async (clusterId) => {
      const { fixClusterCommand } = require('../src/commands/fix');
      await fixClusterCommand(name, clusterId);
    });

  sourceCmd
    .command('approve <id>')
    .description('Push fix branch, create PR, and check CI')
    .action(async (id) => {
      const { approveCommand } = require('../src/commands/approve');
      await approveCommand(name, id);
    });

  sourceCmd
    .command('reject <id> <tag> <reason>')
    .description('Reject a fix with a tag and reason')
    .action(async (id, tag, reason) => {
      const { rejectCommand } = require('../src/commands/reject');
      await rejectCommand(name, id, tag, reason);
    });

  sourceCmd
    .command('rollback <id>')
    .description('Undo a fix — restore files, delete branch')
    .action(async (id) => {
      const { rollbackCommand } = require('../src/commands/rollback');
      await rollbackCommand(name, id);
    });

  sourceCmd
    .command('report')
    .description(`${plugin.displayName || name} terminal summary report`)
    .action(async () => {
      const { reportCommand } = require('../src/commands/report');
      await reportCommand(name);
    });

  sourceCmd
    .command('issues')
    .description('List open issues with prompts + club grouping hint (JSON)')
    .option('--with-prompts', 'Include fix prompts per issue (default)', true)
    .option('--no-prompts', 'Omit prompts from output')
    .option('--with-grouping-hint', 'Include clubbed grouping (default)', true)
    .option('--no-grouping-hint', 'Omit grouping')
    .option('--capacity <n>', 'Limit number of clubs returned (top-N by score)')
    .action(async (opts) => {
      const { issuesCommand } = require('../src/commands/issues');
      await issuesCommand(name, {
        withPrompts: opts.prompts !== false,
        withGroupingHint: opts.groupingHint !== false,
        capacity: opts.capacity,
      });
    });

  sourceCmd
    .command('run')
    .description('Check WIP cap for this plugin — returns capacity JSON')
    .option('--check-wip', 'Check WIP cap (default)', true)
    .option('--no-check-wip', 'Skip WIP check (returns max capacity)')
    .action(async (opts) => {
      const { runCommand } = require('../src/commands/run');
      await runCommand(name, { checkWip: opts.checkWip !== false });
    });
}

// Handle unknown source names with helpful error
program.on('command:*', (operands) => {
  const unknownCmd = operands[0];
  if (KNOWN_PLUGINS.includes(unknownCmd) && !plugins.has(unknownCmd)) {
    console.error(
      `\nError: Plugin '${unknownCmd}' is not installed or has no src/index.js.\n` +
      `Install it: pnpm add @autofix-hub/plugin-${unknownCmd}\n` +
      `Or ensure packages/plugin-${unknownCmd}/src/index.js exists.\n` +
      `Run 'autofix-hub setup' to configure scanners.\n`
    );
    process.exit(1);
  }
});

program.parse();
