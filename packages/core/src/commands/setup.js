'use strict';

const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const inquirer = require('inquirer');
const {
  getProjectRoot,
  loadCredentials,
  saveCredentials,
  saveScannerConfig,
  GLOBAL_CONFIG_DIR,
} = require('../config');
const { getDb, closeDb } = require('../db');
const { initSchema } = require('../setup');
const { loadPlugins, listPlugins } = require('../pluginLoader');

async function setupCommand() {
  console.log(chalk.bold.cyan('\nWelcome to autofix-hub!\n'));

  const projectRoot = getProjectRoot();
  const credentials = loadCredentials();
  const isFirstRun = Object.keys(credentials).length === 0;

  if (isFirstRun) {
    console.log(chalk.gray('First-time setup detected. Configuring scanners...\n'));
  } else {
    console.log(chalk.gray('Existing credentials found. Running project setup...\n'));
  }

  // Check installed plugins
  const pluginList = listPlugins();
  const plugins = loadPlugins();
  let configuredCount = 0;

  console.log(chalk.bold('Checking installed scanners...\n'));

  for (let i = 0; i < pluginList.length; i++) {
    const info = pluginList[i];
    const plugin = plugins.get(info.name);
    const stepLabel = chalk.bold(`[${i + 1}/${pluginList.length}] ${info.displayName}`);

    if (!info.installed) {
      console.log(`${stepLabel}`);
      console.log(`  Checking... ${chalk.red('✗ Plugin not installed')}`);
      console.log(chalk.gray(`  Install: pnpm add @autofix-hub/plugin-${info.name}`));

      const { skip } = await inquirer.prompt([{
        type: 'confirm',
        name: 'skip',
        message: 'Skip for now?',
        default: true,
      }]);

      if (skip) {
        console.log(chalk.gray(`  → Skipped. Run 'autofix-hub setup' again after installing.\n`));
        continue;
      }
    }

    if (!plugin) continue;

    console.log(`${stepLabel}`);

    // Check if CLI/tool is installed
    if (typeof plugin.checkInstalled === 'function') {
      try {
        const installResult = await plugin.checkInstalled();
        if (installResult.installed) {
          console.log(`  Checking... ${chalk.green('✓')} ${installResult.message || 'Installed'}`);
        } else {
          console.log(`  Checking... ${chalk.red('✗')} ${installResult.message || 'Not found'}`);
          const { skip } = await inquirer.prompt([{
            type: 'confirm',
            name: 'skip',
            message: 'Skip for now?',
            default: true,
          }]);
          if (skip) {
            console.log(chalk.gray(`  → Skipped.\n`));
            continue;
          }
        }
      } catch (err) {
        console.log(`  Checking... ${chalk.red('✗')} Error: ${err.message}`);
      }
    }

    // Check authentication
    if (typeof plugin.checkAuth === 'function') {
      try {
        const authResult = await plugin.checkAuth(credentials[info.name] || {});
        if (authResult.authenticated) {
          console.log(`  Auth... ${chalk.green('✓')} ${authResult.message || 'Authenticated'}`);
          configuredCount++;
          console.log();
          continue;
        } else {
          console.log(`  Auth... ${chalk.red('✗')} ${authResult.message || 'Not authenticated'}`);
        }
      } catch (_) {
        console.log(`  Auth... ${chalk.yellow('?')} Could not verify authentication`);
      }
    }

    // Run setup prompts for credentials (auth only)
    if (typeof plugin.setupPrompts === 'function') {
      const questions = plugin.setupPrompts();
      if (questions && questions.length > 0) {
        const answers = await inquirer.prompt(questions);
        credentials[info.name] = { ...credentials[info.name], ...answers, configured: true };
      } else {
        credentials[info.name] = { ...credentials[info.name], configured: true };
      }
      configuredCount++;
    } else {
      credentials[info.name] = { ...credentials[info.name], configured: true };
      configuredCount++;
    }

    console.log();
  }

  // Save credentials (auth only)
  if (isFirstRun || configuredCount > 0) {
    console.log(chalk.gray('Saving credentials to ~/.autofix-hub/credentials.json'));
    saveCredentials(credentials);
  }

  // Create project .autofix-hub/ directory and DB
  const autofixDir = path.join(projectRoot, '.autofix-hub');
  if (!fs.existsSync(autofixDir)) {
    fs.mkdirSync(autofixDir, { recursive: true });
  }

  console.log(`\nCreating project database... `);
  initSchema();
  console.log(chalk.green('✓') + ' .autofix-hub/issues.db');

  // Collect per-project scanner config and save to DB
  for (let i = 0; i < pluginList.length; i++) {
    const info = pluginList[i];
    const plugin = plugins.get(info.name);
    if (!plugin || !info.installed) continue;

    if (typeof plugin.projectConfigPrompts === 'function') {
      const questions = plugin.projectConfigPrompts();
      if (questions && questions.length > 0) {
        console.log(chalk.bold(`\nProject config for ${info.displayName}:`));
        const answers = await inquirer.prompt(questions);
        saveScannerConfig(info.name, answers);
        console.log(chalk.green('✓') + ` Saved project config for ${info.displayName}`);
      }
    }
  }

  closeDb();

  // Scaffold config files
  console.log('Scaffolding config files... ');
  const configDir = path.join(projectRoot, 'config');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const scoringPath = path.join(configDir, 'scoring.json');
  if (!fs.existsSync(scoringPath)) {
    const defaultScoring = {
      severity_weights: { critical: 100, high: 70, medium: 40, low: 15, info: 5 },
      path_criticality: {
        'src/auth/*': 10, 'src/payment/*': 10, 'src/api/*': 7,
        'src/middleware/*': 6, 'src/components/*': 4, 'src/utils/*': 2,
        'src/tests/*': 1, '__default__': 3,
      },
      page_importance: {
        '/checkout*': 10, '/login*': 10, '/signup*': 8, '/dashboard*': 6, '/*': 3,
      },
      type_weights: { bug: 8, vulnerability: 10, security_hotspot: 7, code_smell: 3 },
    };
    fs.writeFileSync(scoringPath, JSON.stringify(defaultScoring, null, 2), 'utf8');
  }

  const effortPath = path.join(configDir, 'effort-map.json');
  if (!fs.existsSync(effortPath)) {
    const defaultEffort = {
      apiiro: {
        secret: { level: 'small', minutes: 5 }, sca_minor: { level: 'small', minutes: 5 },
        sca_major: { level: 'large', minutes: 30 }, sast_injection: { level: 'medium', minutes: 15 },
        sast_xss: { level: 'medium', minutes: 15 }, misconfiguration: { level: 'medium', minutes: 15 },
        pii: { level: 'medium', minutes: 15 }, __default__: { level: 'medium', minutes: 15 },
      },
      aqa: {
        'color-contrast': { level: 'medium', minutes: 15 }, 'image-alt': { level: 'small', minutes: 5 },
        label: { level: 'small', minutes: 5 }, 'heading-order': { level: 'medium', minutes: 15 },
        'html-has-lang': { level: 'trivial', minutes: 2 }, tabindex: { level: 'trivial', minutes: 2 },
        __default__: { level: 'small', minutes: 5 },
      },
      sonarqube: {
        bug_BLOCKER: { level: 'large', minutes: 30 }, bug_CRITICAL: { level: 'large', minutes: 30 },
        vulnerability_CRITICAL: { level: 'large', minutes: 30 }, code_smell_INFO: { level: 'trivial', minutes: 2 },
        code_smell_MINOR: { level: 'small', minutes: 5 }, __default__: { level: 'medium', minutes: 15 },
      },
    };
    fs.writeFileSync(effortPath, JSON.stringify(defaultEffort, null, 2), 'utf8');
  }

  console.log(chalk.green('✓') + ' config/scoring.json, config/effort-map.json');

  // Add .autofix-hub/ to .gitignore if not already there
  const gitignorePath = path.join(projectRoot, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gitignore = fs.readFileSync(gitignorePath, 'utf8');
    if (!gitignore.includes('.autofix-hub/')) {
      fs.appendFileSync(gitignorePath, '\n.autofix-hub/\n', 'utf8');
      console.log(chalk.green('✓') + ' Added .autofix-hub/ to .gitignore');
    }
  } else {
    fs.writeFileSync(gitignorePath, 'node_modules/\n.autofix-hub/\n.env\n*.db\n', 'utf8');
    console.log(chalk.green('✓') + ' Created .gitignore');
  }

  // Summary
  console.log(chalk.bold.green(`\nSetup complete! ${configuredCount} of ${pluginList.length} scanners configured.`));
  console.log(chalk.gray(`Run 'autofix-hub <source> fetch' to pull issues.\n`));
}

module.exports = { setupCommand };
