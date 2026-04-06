'use strict';

const chalk = require('chalk');

async function dashboardCommand() {
  const { startServer } = require('../dashboard/server');

  const port = process.env.DASHBOARD_PORT || 8000;
  console.log(chalk.cyan('\nStarting autofix-hub dashboard...'));

  const server = await startServer({ port });

  // Try to open browser
  const url = `http://localhost:${port}`;
  try {
    const { exec } = require('child_process');
    const platform = process.platform;
    const cmd = platform === 'win32' ? `start ${url}`
      : platform === 'darwin' ? `open ${url}`
      : `xdg-open ${url}`;
    exec(cmd);
  } catch (_) {
    // Browser open is best-effort
  }

  console.log(chalk.green(`\nDashboard: ${url}`));
  console.log(chalk.gray('Press Ctrl+C to stop.\n'));

  // Keep process alive
  process.on('SIGINT', () => {
    console.log(chalk.yellow('\nShutting down...'));
    server.close();
    const { closeDb } = require('../db');
    closeDb();
    process.exit(0);
  });
}

module.exports = { dashboardCommand };
