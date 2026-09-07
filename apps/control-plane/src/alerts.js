// Webhook alerts for operational events (quota denials, sync failures).
//
// Enabled by setting CONTROL_ALERT_WEBHOOK_URL to any endpoint that accepts a
// POST JSON webhook (ntfy, Slack-compatible, generic receivers, …). Payload:
//   { event, title, message, meta?, source: 'distro-control-plane', time }
// Per-event cooldowns (CONTROL_ALERT_COOLDOWN_MS, default 10 min) prevent
// alert storms (e.g. one 429 per capped user per window, not per request).
// Every webhook attempt is recorded in alert_log (status sent | failed),
// surfaced in the admin console; cooldown-suppressed repeats are not logged.

import { logAlert } from './db.js';

const WEBHOOK = (process.env.CONTROL_ALERT_WEBHOOK_URL || '').trim();
const COOLDOWN_MS = Number(process.env.CONTROL_ALERT_COOLDOWN_MS || 10 * 60 * 1000);

const lastSent = new Map();

export function alertsEnabled() {
  return WEBHOOK.length > 0;
}

export function alertsConfig() {
  // Only the webhook host is exposed (never full URLs — they can carry
  // secret tokens in query/path).
  let webhookHost = null;
  try {
    webhookHost = WEBHOOK ? new URL(WEBHOOK).host : null;
  } catch {
    webhookHost = WEBHOOK || null;
  }
  return { enabled: WEBHOOK.length > 0, webhookHost, cooldownMs: COOLDOWN_MS };
}

/** Fire an alert if the webhook is configured and the cooldown for `key`
 *  (an event identifier) has elapsed. Never throws. Records the outcome. */
export async function alert(key, { title, message, meta }) {
  if (!WEBHOOK.length) return { sent: false, reason: 'no webhook configured' };

  const now = Date.now();
  const last = lastSent.get(key) || 0;
  if (now - last < COOLDOWN_MS) return { sent: false, reason: 'cooldown' };
  lastSent.set(key, now);

  const record = (status, reason = null) => {
    try {
      logAlert({ key, status, title, message, meta, reason });
    } catch (err) {
      console.warn(`[alerts] could not record ${key}: ${err?.message || err}`);
    }
  };

  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: key,
        title,
        message,
        meta: meta || null,
        source: 'distro-control-plane',
        time: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      console.warn(`[alerts] webhook ${key} -> HTTP ${res.status}`);
      record('failed', `http ${res.status}`);
      return { sent: false, reason: `http ${res.status}` };
    }
    record('sent');
    return { sent: true };
  } catch (err) {
    console.warn(`[alerts] webhook ${key} failed: ${err?.message || err}`);
    record('failed', err?.message || String(err));
    return { sent: false, reason: err?.message };
  }
}
