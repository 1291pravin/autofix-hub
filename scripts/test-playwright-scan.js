#!/usr/bin/env node
'use strict';

/**
 * Test script for AQA Playwright scanning.
 *
 * Usage:
 *   node scripts/test-playwright-scan.js <url> [engine]
 *
 * Examples:
 *   node scripts/test-playwright-scan.js https://fr.filorga.com           # default: axe
 *   node scripts/test-playwright-scan.js https://fr.filorga.com axe       # axe-core only
 *   node scripts/test-playwright-scan.js https://fr.filorga.com aqa       # AQA Page Capture extension
 *   node scripts/test-playwright-scan.js https://fr.filorga.com aqa-main  # Main AQA extension (direct eval)
 *   node scripts/test-playwright-scan.js https://fr.filorga.com both      # axe + AQA Page Capture
 *
 * AQA engine requires: AQA_EXTENSION_API_KEY, AQA_TEAM_SLUG, AQA_SUITE_ID in .env
 * AQA-main engine requires: Main AQA extension unpacked in extensions/main-aqa-extension/
 */

const path = require('path');

// Load .env from project root (dotenv is optional)
try { require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); } catch (_) { /* no dotenv */ }

async function main() {
  const targetUrl = process.argv[2];
  const engine = process.argv[3] || 'axe';

  if (!targetUrl) {
    console.error('Usage: node scripts/test-playwright-scan.js <url> [axe|aqa|aqa-main|both]');
    process.exit(1);
  }

  if (!['axe', 'aqa', 'aqa-main', 'both'].includes(engine)) {
    console.error(`Invalid engine "${engine}". Must be: axe, aqa, aqa-main, or both`);
    process.exit(1);
  }

  // Force playwright method for this test
  process.env.AQA_METHOD = 'playwright';
  process.env.AQA_URLS = targetUrl;
  process.env.AQA_SCAN_ENGINE = engine;

  const plugin = require('../packages/plugin-aqa/src/index.js');
  const startTime = Date.now();

  console.log(`\n========================================`);
  console.log(`  AQA Playwright Scan — Test Runner`);
  console.log(`  URL:    ${targetUrl}`);
  console.log(`  Engine: ${engine}`);
  console.log(`========================================\n`);

  try {
    const rawIssues = await plugin.fetch({
      method: 'playwright',
      urls: targetUrl,
      scanEngine: engine,
      api_key: process.env.AQA_API_KEY || 'unused-for-axe',
      team_slug: process.env.AQA_TEAM_SLUG || 'unused-for-axe',
      aqaApiKey: process.env.AQA_EXTENSION_API_KEY || process.env.AQA_API_KEY,
      aqaTeamSlug: process.env.AQA_TEAM_SLUG,
      aqaSuiteId: process.env.AQA_SUITE_ID,
      fallbackToAPI: false,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n========================================`);
    console.log(`  Scan completed in ${elapsed}s`);
    console.log(`  Raw issues returned: ${rawIssues.length}`);
    console.log(`========================================\n`);

    if (rawIssues.length === 0) {
      console.log('No issues found — site may be fully compliant or the page did not load properly.');
      return;
    }

    // Normalize through the plugin
    const normalized = rawIssues.map(raw => plugin.normalize(raw));

    // Summary by severity
    const bySeverity = {};
    const byCategory = {};
    const byEngine = {};
    for (const iss of normalized) {
      bySeverity[iss.severity] = (bySeverity[iss.severity] || 0) + 1;
      byCategory[iss.category] = (byCategory[iss.category] || 0) + 1;
      const eng = iss.metadata?.scan_method || 'unknown';
      byEngine[eng] = (byEngine[eng] || 0) + 1;
    }

    console.log('--- By Severity ---');
    for (const [sev, count] of Object.entries(bySeverity).sort()) {
      console.log(`  ${sev}: ${count}`);
    }

    if (Object.keys(byEngine).length > 1) {
      console.log('\n--- By Engine ---');
      for (const [eng, count] of Object.entries(byEngine).sort()) {
        console.log(`  ${eng}: ${count}`);
      }
    }

    console.log('\n--- By Category ---');
    for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cat}: ${count}`);
    }

    // Print first 5 issues as samples
    console.log('\n--- Sample Issues (first 5) ---');
    normalized.slice(0, 5).forEach((iss, i) => {
      console.log(`\n  ${i + 1}. [${iss.severity.toUpperCase()}] ${iss.rule_id}`);
      console.log(`     ${iss.description}`);
      console.log(`     Category: ${iss.category}`);
      const sel = iss.metadata?.selector;
      if (sel) console.log(`     Selector: ${sel}`);
    });

    console.log('\nTest passed.');
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\nTest failed after ${elapsed}s: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
