'use strict';

const { spawnSync } = require('child_process');
const { initSchema } = require('../setup');
const { loadAutomationConfig } = require('../automationConfig');

function ghSafe(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

/**
 * List open PRs in the current repo that carry the autofix label AND do NOT
 * carry the done_label. These are the PRs occupying WIP slots.
 */
function listPendingAutofixPRs(label, doneLabel) {
  const r = ghSafe([
    'pr', 'list',
    '--state', 'open',
    '--label', label,
    '--json', 'number,url,title,labels,author,createdAt',
    '--limit', '100',
  ]);
  if (!r.ok) {
    return { ok: false, error: r.stderr || r.stdout };
  }
  let prs;
  try { prs = JSON.parse(r.stdout); }
  catch (err) { return { ok: false, error: `parse failed: ${err.message}` }; }
  const filtered = prs.filter(pr => !pr.labels.some(l => l.name === doneLabel));
  return { ok: true, prs: filtered };
}

/**
 * `autofix-hub <plugin> run --check-wip`
 * Pre-flight: returns JSON with WIP status + remaining capacity. Does not perform any work.
 */
async function runCommand(source, opts = {}) {
  initSchema();
  const config = loadAutomationConfig();
  const label = config.wip.label;
  const doneLabel = config.wip.done_label;
  const max = config.wip.max_open_prs;

  if (opts.checkWip !== false) {
    const r = listPendingAutofixPRs(label, doneLabel);
    if (!r.ok) {
      console.log(JSON.stringify({
        status: 'error',
        error: `Could not query open PRs via gh: ${r.error}`,
        hint: 'Ensure gh is authenticated (gh auth status).',
      }, null, 2));
      process.exit(1);
    }
    const openCount = r.prs.length;
    const capacity = Math.max(0, max - openCount);
    if (capacity === 0) {
      console.log(JSON.stringify({
        status: 'wip_full',
        source,
        max_open_prs: max,
        open_count: openCount,
        capacity: 0,
        open_prs: r.prs.map(p => ({ url: p.url, title: p.title, createdAt: p.createdAt })),
        hint: `Merge or label '${doneLabel}' on an open autofix PR to free a slot.`,
      }, null, 2));
      process.exit(0);
    }
    console.log(JSON.stringify({
      status: 'ok',
      source,
      max_open_prs: max,
      open_count: openCount,
      capacity,
      open_prs: r.prs.map(p => ({ url: p.url, title: p.title, createdAt: p.createdAt })),
    }, null, 2));
    return;
  }

  console.log(JSON.stringify({ status: 'ok', source, skipped_wip_check: true, capacity: max }, null, 2));
}

module.exports = { runCommand };
