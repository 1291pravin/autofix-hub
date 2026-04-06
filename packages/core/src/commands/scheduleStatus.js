'use strict';

const chalk = require('chalk');
const Table = require('cli-table3');
const { getScheduleStatus } = require('../scheduler');

async function scheduleStatusCommand() {
  const statuses = getScheduleStatus();

  const table = new Table({
    head: [
      chalk.white.bold('Source'),
      chalk.white.bold('Cron Expression'),
      chalk.white.bold('Next Run'),
      chalk.white.bold('Status'),
    ],
    style: { head: [], border: [] },
  });

  for (const s of statuses) {
    table.push([
      s.source,
      s.cronExpr || chalk.gray('not configured'),
      s.nextRun ? new Date(s.nextRun).toLocaleString() : chalk.gray('—'),
      s.running ? chalk.green('running') : (s.cronExpr ? chalk.yellow('stopped') : chalk.gray('disabled')),
    ]);
  }

  console.log(chalk.bold('\nautofix-hub Schedule Status\n'));
  console.log(table.toString());
  console.log();
}

module.exports = { scheduleStatusCommand };
