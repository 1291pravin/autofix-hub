#!/usr/bin/env node
'use strict';

/**
 * Build installable tarballs for all autofix-hub packages.
 *
 * Usage (from repo root):
 *   node scripts/pack.js            # create tarballs in dist/
 *   node scripts/pack.js --install  # create tarballs + install globally
 *
 * Or via npm scripts:
 *   pnpm run pack
 *   pnpm run pack:install
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const doInstall = process.argv.includes('--install');

// ---------------------------------------------------------------------------

function log(msg)  { console.log(`\x1b[36m${msg}\x1b[0m`); }
function ok(msg)   { console.log(`\x1b[32m${msg}\x1b[0m`); }
function dim(msg)  { console.log(`\x1b[90m${msg}\x1b[0m`); }
function bold(msg) { console.log(`\x1b[1m${msg}\x1b[0m`); }

// ---------------------------------------------------------------------------

function packPackage(dir) {
  const result = execSync(`pnpm pack --pack-destination "${DIST}"`, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  return path.basename(result);
}

function generateInstallScript(coreTarball, pluginTarballs) {
  const lines = [
    '#!/usr/bin/env bash',
    '# Auto-generated install script for autofix-hub tarballs',
    '# Usage: bash install.sh [target-project-dir]',
    '',
    'set -e',
    '',
    'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
    'TARGET="${1:-.}"',
    '',
    'if [ ! -d "$TARGET" ]; then',
    '  echo "Error: target directory $TARGET does not exist"',
    '  exit 1',
    'fi',
    '',
    'echo "Installing autofix-hub tarballs into $TARGET..."',
    '',
    '# Install core first (plugins depend on it)',
    `npm install --prefix "$TARGET" "$SCRIPT_DIR/${coreTarball}"`,
    '',
    ...pluginTarballs.map(p => `npm install --prefix "$TARGET" "$SCRIPT_DIR/${p}"`),
    '',
    'echo ""',
    'echo "Done! autofix-hub installed from tarballs."',
    'echo "Run: npx autofix-hub --help"',
    '',
  ];

  const scriptPath = path.join(DIST, 'install.sh');
  fs.writeFileSync(scriptPath, lines.join('\n'));
  dim('   Generated install.sh');
}

// ---------------------------------------------------------------------------

// Clean / create dist directory
if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true });
}
fs.mkdirSync(DIST, { recursive: true });

// 1. Pack core
const coreDir = path.join(ROOT, 'packages', 'core');
log('\n  Packing @autofix-hub/core...');
const coreTarball = packPackage(coreDir);
ok(`   -> ${coreTarball}`);

// 2. Pack each plugin — temporarily rewrite workspace:* -> file: reference
const pluginDirs = fs.readdirSync(path.join(ROOT, 'packages'))
  .filter(d => d.startsWith('plugin-'))
  .map(d => path.join(ROOT, 'packages', d));

const pluginTarballs = [];
for (const pluginDir of pluginDirs) {
  const pkgPath = path.join(pluginDir, 'package.json');
  const original = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(original);

  log(`\n  Packing ${pkg.name}...`);

  // Replace workspace:* with file: reference to the core tarball
  let modified = false;
  if (pkg.dependencies && pkg.dependencies['@autofix-hub/core']) {
    pkg.dependencies['@autofix-hub/core'] = `file:${path.posix.join('..', coreTarball)}`;
    modified = true;
  }

  if (modified) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }

  try {
    const tarball = packPackage(pluginDir);
    pluginTarballs.push(tarball);
    ok(`   -> ${tarball}`);
  } finally {
    // Always restore original package.json
    if (modified) {
      fs.writeFileSync(pkgPath, original);
    }
  }
}

// 3. Generate install script
const allTarballs = [coreTarball, ...pluginTarballs];
generateInstallScript(coreTarball, pluginTarballs);

// 4. Print summary
ok('\n  All tarballs created in dist/\n');
console.log('Files:');
for (const t of allTarballs) {
  console.log(`  dist/${t}`);
}

if (doInstall) {
  log('\n  Installing tarballs globally...\n');
  for (const t of allTarballs) {
    const tarPath = path.join(DIST, t);
    dim(`  npm install -g ${t}`);
    execSync(`npm install -g "${tarPath}"`, { cwd: ROOT, stdio: 'inherit' });
  }
  ok('\n  Installed globally! Run: autofix-hub --help\n');
} else {
  bold('\n-- Install in a target project --\n');
  console.log('Option 1: Run the generated install script');
  console.log(`  cd dist && bash install.sh /path/to/target-project\n`);
  console.log('Option 2: Manual npm install (core first)');
  console.log('  cd /path/to/target-project');
  console.log(`  npm install /path/to/dist/${coreTarball}`);
  for (const t of pluginTarballs) {
    console.log(`  npm install /path/to/dist/${t}`);
  }
  console.log('\nOption 3: Install globally');
  console.log('  pnpm run pack:install');
  console.log('');
}
