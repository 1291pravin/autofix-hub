'use strict';

const cron = require('node-cron');
const chalk = require('chalk');

const jobs = new Map();

/**
 * Start scheduled fetch jobs for all configured plugins.
 * Reads cron expressions from env: FETCH_CRON_APIIRO, FETCH_CRON_AQA, FETCH_CRON_SONARQUBE
 */
function startScheduler(plugins) {
  for (const [name, plugin] of plugins) {
    const envKey = `FETCH_CRON_${name.toUpperCase()}`;
    const cronExpr = process.env[envKey];

    if (!cronExpr) {
      console.log(chalk.gray(`  No cron configured for ${plugin.displayName || name} (${envKey})`));
      continue;
    }

    if (!cron.validate(cronExpr)) {
      console.warn(chalk.yellow(`  Invalid cron expression for ${name}: "${cronExpr}"`));
      continue;
    }

    const job = cron.schedule(cronExpr, async () => {
      console.log(chalk.cyan(`\n[scheduler] Running scheduled fetch for ${name}...`));
      try {
        const { fetchCommand } = require('./commands/fetch');
        await fetchCommand(name);
      } catch (err) {
        console.error(chalk.red(`[scheduler] Fetch failed for ${name}: ${err.message}`));
      }
    }, {
      scheduled: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    jobs.set(name, { job, cronExpr });
    console.log(chalk.green(`  Scheduled ${plugin.displayName || name}: ${cronExpr}`));
  }

  if (jobs.size > 0) {
    console.log(chalk.green(`\nScheduler started with ${jobs.size} job(s).`));
  } else {
    console.log(chalk.yellow('\nNo scheduled jobs configured. Set FETCH_CRON_* in .env to enable.'));
  }
}

/**
 * Stop all scheduled jobs.
 */
function stopScheduler() {
  for (const [name, { job }] of jobs) {
    job.stop();
  }
  jobs.clear();
}

/**
 * Get status of all scheduled jobs.
 * Returns array of {source, cronExpr, nextRun, running}.
 */
function getScheduleStatus() {
  const status = [];

  // Check all known sources, not just running jobs
  const knownSources = ['apiiro', 'aqa', 'sonarqube'];

  for (const source of knownSources) {
    const envKey = `FETCH_CRON_${source.toUpperCase()}`;
    const cronExpr = process.env[envKey];

    if (!cronExpr) {
      status.push({
        source,
        cronExpr: null,
        nextRun: null,
        running: false,
      });
      continue;
    }

    const jobEntry = jobs.get(source);
    const nextRun = computeNextRun(cronExpr);

    status.push({
      source,
      cronExpr,
      nextRun,
      running: !!jobEntry,
    });
  }

  return status;
}

/**
 * Compute approximate next run time from a cron expression.
 * Simple heuristic — not a full cron parser for next occurrence.
 */
function computeNextRun(cronExpr) {
  try {
    // node-cron doesn't expose next run, so we compute a rough estimate
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length < 5) return null;

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const now = new Date();

    // Simple case: fixed hour and minute
    if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
      const next = new Date(now);
      next.setHours(parseInt(hour, 10), parseInt(minute, 10), 0, 0);

      // If that time already passed today, advance to next valid day
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }

      // Check day-of-week constraint
      if (dayOfWeek !== '*') {
        const allowedDays = parseCronField(dayOfWeek, 0, 6);
        while (!allowedDays.includes(next.getDay())) {
          next.setDate(next.getDate() + 1);
        }
      }

      return next.toISOString();
    }

    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Parse a cron field like "1-5" or "1,3,5" into an array of integers.
 */
function parseCronField(field, min, max) {
  if (field === '*') {
    const result = [];
    for (let i = min; i <= max; i++) result.push(i);
    return result;
  }

  const values = new Set();

  for (const part of field.split(',')) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      for (let i = start; i <= end; i++) values.add(i);
    } else {
      values.add(parseInt(part, 10));
    }
  }

  return [...values].sort((a, b) => a - b);
}

module.exports = { startScheduler, stopScheduler, getScheduleStatus };
