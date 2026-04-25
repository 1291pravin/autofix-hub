#!/usr/bin/env node
'use strict';

/**
 * Playwright test: verify clustering fixes in the dashboard UI.
 * Tests:
 * 1. Clusters page loads and shows clusters with accurate counts
 * 2. Cluster detail pages show the correct number of issues (matching the count)
 * 3. Cluster prompts are rich and contain detailed per-issue context
 * 4. No cluster shows "No issues found" when it has a non-zero count
 */

const { chromium } = require('playwright');

const BASE = 'http://localhost:8000';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let passed = 0;
  let failed = 0;

  function assert(condition, msg) {
    if (condition) {
      console.log(`  ✅ ${msg}`);
      passed++;
    } else {
      console.error(`  ❌ ${msg}`);
      failed++;
    }
  }

  try {
    // ========== TEST 1: Clusters page loads ==========
    console.log('\n--- TEST 1: Clusters page loads with accurate counts ---');
    await page.goto(`${BASE}/#/clusters`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.cluster-card', { timeout: 10000 });

    const clusterCards = await page.$$('.cluster-card');
    assert(clusterCards.length > 0, `Clusters page shows ${clusterCards.length} clusters`);

    // Get the first cluster's count and id from the card
    const firstCard = clusterCards[0];
    const countText = await firstCard.$eval('.cluster-card-count', el => el.textContent.trim());
    const count = parseInt(countText, 10);
    assert(count > 0, `First cluster shows count: ${count}`);

    // ========== TEST 2: Verify API consistency ==========
    console.log('\n--- TEST 2: API clusters endpoint returns accurate data ---');
    const apiResponse = await page.evaluate(async () => {
      const res = await fetch('/api/clusters');
      return res.json();
    });

    assert(apiResponse.clusters && apiResponse.clusters.length > 0, `API returns ${apiResponse.clusters.length} clusters`);

    // Check that no cluster has a mismatch between issue_count and join table
    const apiCheckResponse = await page.evaluate(async (clusters) => {
      const results = [];
      for (const c of clusters.slice(0, 5)) {
        const issuesRes = await fetch(`/api/issues?cluster=${c.id}&limit=200`);
        const issuesData = await issuesRes.json();
        results.push({
          id: c.id,
          clusterKey: c.cluster_key,
          displayedCount: c.issue_count,
          actualIssues: issuesData.pagination.total,
        });
      }
      return results;
    }, apiResponse.clusters);

    for (const check of apiCheckResponse) {
      assert(
        check.displayedCount === check.actualIssues,
        `Cluster ${check.id.slice(0,8)} (${check.clusterKey}): displayed=${check.displayedCount}, actual=${check.actualIssues}`
      );
    }

    // ========== TEST 3: Cluster detail page shows correct issues ==========
    console.log('\n--- TEST 3: Cluster detail pages show correct issues ---');

    // Pick the cluster with the most issues
    const topCluster = apiResponse.clusters[0];
    console.log(`  Testing cluster: ${topCluster.cluster_key} (${topCluster.issue_count} issues)`);

    await page.goto(`${BASE}/#/clusters/${topCluster.id}`, { waitUntil: 'networkidle' });

    // Wait for issues table to load
    await page.waitForFunction(() => {
      const spinner = document.querySelector('.loading');
      return !spinner;
    }, { timeout: 10000 });

    // Check that the empty state element is NOT visible (the text may exist in JSX source)
    const emptyElement = await page.$('.empty');
    assert(!emptyElement || topCluster.issue_count === 0, `Detail page does NOT show empty state for cluster with ${topCluster.issue_count} issues`);

    // Check issue rows in the table
    const issueRows = await page.$$('tr[class*="issue"], tbody tr');
    console.log(`  Found ${issueRows.length} issue rows in detail table`);
    assert(issueRows.length > 0, `Detail page shows issue rows (found ${issueRows.length})`);

    // ========== TEST 4: Cluster prompt is rich and detailed ==========
    console.log('\n--- TEST 4: Cluster prompt quality ---');

    const promptResponse = await page.evaluate(async (clusterId) => {
      const res = await fetch(`/api/clusters/${clusterId}/prompt`);
      return res.json();
    }, topCluster.id);

    assert(promptResponse.prompt && promptResponse.prompt.length > 0, `Prompt is non-empty (length: ${promptResponse.prompt?.length || 0})`);

    if (promptResponse.prompt) {
      // Check for rich content markers that should exist in enhanced prompts
      const prompt = promptResponse.prompt;
      assert(prompt.includes('## Batch Fix'), 'Prompt contains "## Batch Fix" header');
      assert(prompt.includes('**Category:**'), 'Prompt contains Category field');
      assert(prompt.includes('**Description:**'), 'Prompt contains Description field');
      assert(prompt.includes('### Instructions'), 'Prompt contains Instructions section');

      // Check for detailed per-issue context (the new enhancement)
      assert(prompt.includes('### Detailed Issue Context') || prompt.includes('#### Issue 1'), 'Prompt contains detailed per-issue context blocks');
      assert(prompt.includes('**Selector**'), 'Prompt contains Selector details');

      // Check for WCAG or solution content
      const hasWcag = prompt.includes('WCAG') || prompt.includes('wcag');
      const hasSolutions = prompt.includes('AQA Recommended Fix') || prompt.includes('Solution');
      assert(hasWcag || hasSolutions, 'Prompt contains WCAG or solution guidance');
    }

    // ========== TEST 5: Test the previously broken clusters ==========
    console.log('\n--- TEST 5: Previously broken clusters ---');

    // Check cluster 185651adce7c295b
    const cluster185 = apiResponse.clusters.find(c => c.id === '185651adce7c295b');
    if (cluster185) {
      const issues185 = await page.evaluate(async () => {
        const res = await fetch('/api/issues?cluster=185651adce7c295b&limit=200');
        return res.json();
      });
      assert(
        cluster185.issue_count === issues185.pagination.total,
        `Cluster 185651ad: count=${cluster185.issue_count}, actual issues=${issues185.pagination.total} (was showing 116 with 0 issues before)`
      );
      assert(
        issues185.pagination.total > 0,
        `Cluster 185651ad now has ${issues185.pagination.total} actual issues (was 0 before fix)`
      );

      // Navigate to detail page
      await page.goto(`${BASE}/#/clusters/185651adce7c295b`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !document.querySelector('.loading'), { timeout: 10000 });

      const emptyEl185 = await page.$('.empty');
      assert(!emptyEl185, 'Cluster 185651ad detail page does NOT show empty state anymore');
    } else {
      console.log('  ⚠️  Cluster 185651adce7c295b not found (may have been cleaned up if it had 0 issues)');
    }

    // Check cluster 950d48916db94531
    const cluster950 = apiResponse.clusters.find(c => c.id === '950d48916db94531');
    if (cluster950) {
      const issues950 = await page.evaluate(async () => {
        const res = await fetch('/api/issues?cluster=950d48916db94531&limit=200');
        return res.json();
      });
      assert(
        cluster950.issue_count === issues950.pagination.total,
        `Cluster 950d4891: count=${cluster950.issue_count}, actual issues=${issues950.pagination.total} (was showing 116 with only few before)`
      );
    } else {
      console.log('  ⚠️  Cluster 950d48916db94531 not found (may have been cleaned up)');
    }

    // ========== TEST 6: Verify individual prompts still look good ==========
    console.log('\n--- TEST 6: Individual issue prompt quality (for comparison) ---');

    const issueListRes = await page.evaluate(async () => {
      const res = await fetch('/api/issues?limit=1');
      return res.json();
    });

    if (issueListRes.issues?.length > 0) {
      const singleIssue = issueListRes.issues[0];
      const detailRes = await page.evaluate(async (id) => {
        const res = await fetch(`/api/issues/${id}`);
        return res.json();
      }, singleIssue.id);

      const indivPrompt = detailRes.issue?.fix_prompt || '';
      assert(indivPrompt.length > 0, `Individual prompt exists (length: ${indivPrompt.length})`);
      assert(indivPrompt.includes('### Issue Details') || indivPrompt.includes('**Issue:**'), 'Individual prompt has detailed structure');
    }

    // ========== SUMMARY ==========
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`${'='.repeat(50)}\n`);

  } catch (err) {
    console.error('Test error:', err.message);
    failed++;
  } finally {
    await browser.close();
  }

  process.exit(failed > 0 ? 1 : 0);
}

run();
