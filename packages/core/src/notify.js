'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * Send a notification payload to a webhook URL.
 * Auto-detects Slack, Teams, or Discord from the URL and formats accordingly.
 * Skips silently if NOTIFICATION_WEBHOOK_URL is not configured.
 */
async function sendNotification(payload) {
  const webhookUrl = process.env.NOTIFICATION_WEBHOOK_URL;
  if (!webhookUrl) return;

  const body = formatPayload(webhookUrl, payload);
  return postJson(webhookUrl, body);
}

/**
 * Format the payload based on the webhook service (auto-detected from URL).
 */
function formatPayload(webhookUrl, payload) {
  const url = webhookUrl.toLowerCase();

  if (url.includes('hooks.slack.com') || url.includes('slack')) {
    return formatSlack(payload);
  }

  if (url.includes('office.com') || url.includes('teams') || url.includes('webhook.office')) {
    return formatTeams(payload);
  }

  if (url.includes('discord.com') || url.includes('discordapp.com')) {
    return formatDiscord(payload);
  }

  // Generic JSON payload
  return payload;
}

function formatSlack(payload) {
  const emoji = payload.critical_count > 0 ? ':rotating_light:' : ':mag:';
  return {
    text: `${emoji} *autofix-hub — ${payload.source}*\nNew issues: *${payload.new_issues}* | Open: *${payload.total_open}* | Critical: *${payload.critical_count}*`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *autofix-hub scan — ${payload.source}*`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*New Issues:*\n${payload.new_issues}` },
          { type: 'mrkdwn', text: `*Total Open:*\n${payload.total_open}` },
          { type: 'mrkdwn', text: `*Critical:*\n${payload.critical_count}` },
          { type: 'mrkdwn', text: `*Scanned at:*\n${payload.timestamp}` },
        ],
      },
    ],
  };
}

function formatTeams(payload) {
  const color = payload.critical_count > 0 ? 'FF0000' : '0078D4';
  return {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: color,
    summary: `autofix-hub: ${payload.new_issues} new issues from ${payload.source}`,
    sections: [
      {
        activityTitle: `autofix-hub scan — ${payload.source}`,
        facts: [
          { name: 'New Issues', value: String(payload.new_issues) },
          { name: 'Total Open', value: String(payload.total_open) },
          { name: 'Critical', value: String(payload.critical_count) },
          { name: 'Scanned at', value: payload.timestamp },
        ],
        markdown: true,
      },
    ],
  };
}

function formatDiscord(payload) {
  const color = payload.critical_count > 0 ? 0xFF0000 : 0x5865F2;
  return {
    embeds: [
      {
        title: `autofix-hub scan — ${payload.source}`,
        color,
        fields: [
          { name: 'New Issues', value: String(payload.new_issues), inline: true },
          { name: 'Total Open', value: String(payload.total_open), inline: true },
          { name: 'Critical', value: String(payload.critical_count), inline: true },
        ],
        timestamp: payload.timestamp,
      },
    ],
  };
}

/**
 * POST JSON to a URL. Returns a promise.
 */
function postJson(webhookUrl, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(webhookUrl);
    const transport = parsed.protocol === 'https:' ? https : http;

    const data = JSON.stringify(body);

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 10000,
    };

    const req = transport.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body: responseBody });
        } else {
          reject(new Error(`Webhook returned ${res.statusCode}: ${responseBody}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Webhook request timed out'));
    });

    req.write(data);
    req.end();
  });
}

module.exports = { sendNotification };
