'use strict';

const path = require('path');
const fs = require('fs');
const { getProjectRoot } = require('./config');

const REQUIRED_METHODS = ['name', 'fetch', 'normalize', 'clusterKeys', 'effortEstimate', 'reviewLevel', 'promptTemplate'];
const OPTIONAL_METHODS = ['displayName', 'checkInstalled', 'checkAuth', 'setupPrompts', 'batchPromptTemplate', 'scoringFactors'];

const KNOWN_PLUGINS = ['apiiro', 'aqa', 'sonarqube'];

let pluginsCache = null;

/**
 * Discover and load all @autofix-hub/plugin-* packages.
 * Returns Map<string, Plugin> keyed by plugin.name
 */
function loadPlugins() {
  if (pluginsCache) return pluginsCache;

  const plugins = new Map();
  const projectRoot = getProjectRoot();
  const workspaceFile = path.join(projectRoot, 'pnpm-workspace.yaml');

  if (fs.existsSync(workspaceFile)) {
    // Monorepo mode: scan packages/ directory for plugin-* dirs
    const packagesDir = path.join(projectRoot, 'packages');
    if (fs.existsSync(packagesDir)) {
      const entries = fs.readdirSync(packagesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('plugin-')) continue;

        const pluginDir = path.join(packagesDir, entry.name);
        const pkgJsonPath = path.join(pluginDir, 'package.json');

        if (!fs.existsSync(pkgJsonPath)) continue;

        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        if (!pkgJson.name || !pkgJson.name.startsWith('@autofix-hub/plugin-')) continue;

        const mainFile = path.join(pluginDir, pkgJson.main || 'src/index.js');
        if (!fs.existsSync(mainFile)) continue;

        try {
          const plugin = require(mainFile);
          validatePlugin(plugin, pkgJson.name);
          plugins.set(plugin.name, plugin);
        } catch (err) {
          console.warn(`Warning: Failed to load plugin ${pkgJson.name}: ${err.message}`);
        }
      }
    }
  }

  // Also try loading from node_modules (installed mode)
  for (const name of KNOWN_PLUGINS) {
    if (plugins.has(name)) continue;
    try {
      const plugin = require(`@autofix-hub/plugin-${name}`);
      validatePlugin(plugin, `@autofix-hub/plugin-${name}`);
      plugins.set(plugin.name, plugin);
    } catch (_) {
      // Not installed, skip
    }
  }

  pluginsCache = plugins;
  return plugins;
}

/**
 * Validate that a plugin exports all required methods.
 */
function validatePlugin(plugin, packageName) {
  const missing = [];
  for (const method of REQUIRED_METHODS) {
    if (typeof method === 'string' && plugin[method] === undefined) {
      // 'name' is a string property, rest are functions
      if (method === 'name') {
        if (typeof plugin.name !== 'string' || !plugin.name) {
          missing.push('name (must be a non-empty string)');
        }
      } else if (typeof plugin[method] !== 'function') {
        missing.push(method);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(`Plugin ${packageName} is missing required exports: ${missing.join(', ')}`);
  }

  // Warn about missing optional methods
  for (const method of OPTIONAL_METHODS) {
    if (plugin[method] === undefined) {
      // Silent — optional methods are truly optional
    }
  }
}

/**
 * Get a specific plugin by name. Throws a helpful error if not found.
 */
function getPlugin(name) {
  const plugins = loadPlugins();
  const plugin = plugins.get(name);

  if (!plugin) {
    const isKnown = KNOWN_PLUGINS.includes(name);
    if (isKnown) {
      throw new Error(
        `Plugin '${name}' is not installed or has no src/index.js.\n` +
        `Install it with: pnpm add @autofix-hub/plugin-${name}\n` +
        `Or ensure packages/plugin-${name}/src/index.js exists and exports the plugin interface.`
      );
    }
    throw new Error(
      `Unknown plugin '${name}'. Available plugins: ${[...plugins.keys()].join(', ') || 'none loaded'}\n` +
      `Known plugins: ${KNOWN_PLUGINS.join(', ')}`
    );
  }

  return plugin;
}

/**
 * List all known plugins with their install status.
 */
function listPlugins() {
  const plugins = loadPlugins();
  return KNOWN_PLUGINS.map(name => ({
    name,
    displayName: plugins.has(name) ? (plugins.get(name).displayName || name) : name,
    installed: plugins.has(name),
  }));
}

/**
 * Clear the plugin cache (useful for testing or re-scanning).
 */
function clearCache() {
  pluginsCache = null;
}

module.exports = { loadPlugins, getPlugin, listPlugins, clearCache, KNOWN_PLUGINS };
