// Webhook alerts for operational events (quota denials, sync failures).
//
// Enabled by setting CONTROL_ALERT_WEBHOOK_URL to any endpoint that accepts a
// POST JSON webhook (ntfy, Slack-compatible, generic receivers, …). Payload:
//   { event, title, message, meta?, source: 'distro-control-plane', time }
// Per-event cooldowns (CONTROL_ALERT_COOLDOWN_MS, default 10 min) prevent
// alert storms (e.g. one 429 per capped user per window, not per request).

const WEBHOOK = (process.env.CONTROL_ALERT_WEBHOOK_URL || '').trim();
const COOLDOWN_MS = Number(process.env.CONTROL_ALERT_COOLDOWN_MS || 10 * 60 * 1000);

const lastSent = new Map();

export function alertsEnabled() {
  return WEBHOOK.length > 0;
}

/** Fire an alert if the webhook is configured and the cooldown for `key`
 *  (an event identifier) has elapsed. Never throws. */
export async function alert(key, { title, message, meta }) {
  if (!WEBHOOK.length) return { sent: false, reason: 'no webhook configured' };

  const now = Date.now();
  const last = lastSent.get(key) || 0;
  if (now - last < COOLDOWN_MS) return { sent: false, reason: 'cooldown' };
  lastSent.set(key, now);

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
      return { sent: false, reason: `http ${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.warn(`[alerts] webhook ${key} failed: ${err?.message || err}`);
    return { sent: false, reason: err?.message };
  }
}
