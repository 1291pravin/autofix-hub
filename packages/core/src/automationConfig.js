'use strict';

const path = require('path');
const fs = require('fs');
const { getProjectRoot } = require('./config');

const DEFAULT_CONFIG = {
  wip: {
    max_open_prs: 3,
    label: 'autofix',
    done_label: 'autofix-reviewed',
    base_branch: null,
  },
  clubbing: {
    max_files: 50,
    max_lines_est: 800,
    max_issues: 30,
    prefer_same_directory: true,
  },
  gate: {
    commands: ['pnpm lint', 'pnpm typecheck', 'pnpm build'],
    cwd: null,
    timeout_ms: 600000,
    run_tests_locally: false,
  },
  blocklist: [
    'auth/**',
    'crypto/**',
    '**/migrations/**',
    '**/secrets/**',
    '**/.env*',
  ],
  worktree: {
    root: '.autofix-hub/worktrees',
    branch_prefix: 'autofix',
  },
  pr: {
    title_prefix: 'autofix',
    draft: false,
  },
};

function configPath() {
  return path.join(getProjectRoot(), '.autofix-hub', 'config.json');
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function loadAutomationConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return { ...DEFAULT_CONFIG };
  try {
    const user = JSON.parse(fs.readFileSync(p, 'utf8'));
    return deepMerge(DEFAULT_CONFIG, user);
  } catch (err) {
    throw new Error(`Failed to parse ${p}: ${err.message}`);
  }
}

function writeDefaultConfigIfMissing() {
  const p = configPath();
  if (fs.existsSync(p)) return false;
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
  return true;
}

function isBlocklisted(filePath, blocklist) {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');
  for (const pattern of blocklist) {
    if (globMatch(normalized, pattern)) return true;
  }
  return false;
}

function globMatch(filePath, pattern) {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLESTAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLESTAR::/g, '.*')
    .replace(/\?/g, '[^/]');
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(filePath);
}

module.exports = {
  DEFAULT_CONFIG,
  loadAutomationConfig,
  writeDefaultConfigIfMissing,
  configPath,
  isBlocklisted,
};
