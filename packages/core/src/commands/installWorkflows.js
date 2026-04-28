'use strict';

const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const { getProjectRoot } = require('../config');

const SOURCE_DIR = path.resolve(__dirname, '..', '..', 'workflows');

function listBundledWorkflows() {
  if (!fs.existsSync(SOURCE_DIR)) return [];
  return fs.readdirSync(SOURCE_DIR).filter((f) => f.endsWith('.md'));
}

async function installWorkflowsCommand(opts = {}) {
  const { force = false, silent = false } = opts;
  const log = silent ? () => {} : (msg) => console.log(msg);

  const files = listBundledWorkflows();
  if (files.length === 0) {
    console.error(chalk.red(`No bundled workflows found at ${SOURCE_DIR}.`));
    process.exit(1);
  }

  const targetDir = path.join(getProjectRoot(), '.windsurf', 'workflows');
  fs.mkdirSync(targetDir, { recursive: true });

  const result = { copied: [], skipped: [], overwritten: [] };

  for (const file of files) {
    const src = path.join(SOURCE_DIR, file);
    const dest = path.join(targetDir, file);
    const exists = fs.existsSync(dest);

    if (exists && !force) {
      result.skipped.push(file);
      continue;
    }

    fs.copyFileSync(src, dest);
    if (exists) result.overwritten.push(file);
    else result.copied.push(file);
  }

  log(chalk.bold.cyan(`\nInstalling Windsurf workflows → ${targetDir}\n`));
  for (const f of result.copied) log(chalk.green(`  + ${f}`));
  for (const f of result.overwritten) log(chalk.yellow(`  ~ ${f} (overwritten)`));
  for (const f of result.skipped) log(chalk.gray(`  · ${f} (exists, use --force to overwrite)`));
  log('');

  return result;
}

module.exports = { installWorkflowsCommand };
