'use strict';

const chalk = require('chalk');
const { getDb } = require('../db');
const { initSchema } = require('../setup');

// Valid status transitions
const VALID_TRANSITIONS = {
  open: ['in_progress'],
  in_progress: ['ai_fixed', 'open', 'rejected'],
  ai_fixed: ['verified', 'rejected', 'open'],
  verified: ['merged', 'rejected', 'open'],
  merged: ['closed', 'open'],  // open = reopen
  closed: ['open'],
  rejected: ['open'],
};

const TERMINAL_STATUSES = ['merged', 'closed'];

/**
 * Transition an issue to a new status with validation.
 */
async function statusCommand(id, newStatus) {
  const db = getDb();
  initSchema();

  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!issue) {
    console.error(chalk.red(`Issue ${id} not found.`));
    process.exit(1);
  }

  const currentStatus = issue.status;
  const allowed = VALID_TRANSITIONS[currentStatus];

  if (!allowed || !allowed.includes(newStatus)) {
    console.error(
      chalk.red(`Invalid transition: ${currentStatus} → ${newStatus}`) +
      chalk.gray(`\nAllowed from '${currentStatus}': ${(allowed || []).join(', ')}`)
    );
    process.exit(1);
  }

  const now = new Date().toISOString();
  const updates = { status: newStatus, updated_at: now };

  if (TERMINAL_STATUSES.includes(newStatus)) {
    updates.resolved_at = now;
  }

  // Clear resolved_at when reopening
  if (newStatus === 'open' && issue.resolved_at) {
    updates.resolved_at = null;
  }

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);

  db.prepare(`UPDATE issues SET ${setClauses} WHERE id = ?`).run(...values, id);

  console.log(chalk.green(`${id}: ${currentStatus} → ${newStatus}`));

  // If transitioned to ai_fixed, trigger auto-approve check
  if (newStatus === 'ai_fixed') {
    try {
      const { checkAutoApprove } = require('../autoApprove');
      const updatedIssue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
      await checkAutoApprove(updatedIssue, db);
    } catch (err) {
      // Auto-approve is best-effort
      console.log(chalk.gray(`  Auto-approve check skipped: ${err.message}`));
    }
  }
}

module.exports = { statusCommand, VALID_TRANSITIONS };
