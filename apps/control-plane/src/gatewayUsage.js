// M4 — per-key usage sync from the OmniRoute gateway's own SQLite store.
//
// The gateway records every proxied call in its `usage_history` table WITH
// `api_key_id` attribution (its dashboard request-logs endpoint drops that
// column, which is why the API-based read was a dead end). The gateway data
// volume is mounted read-only into this container at /gateway-data, so we can
// aggregate today's tokens/requests per gateway key directly.
//
// Deliberately defensive: the gateway image is upstream-controlled, so schema
// drift must degrade to a warning, never a crash. Chat-traffic accounting via
// POST /api/internal/usage-report keeps working as the real-time fallback.

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { estimateCostUsd } from './pricing.js';
import { usageDay, usageDayOf } from './usageDay.js';

const DATA_DIR = process.env.GATEWAY_DATA_DIR || '/gateway-data';
const DB_FILE = `${DATA_DIR}/storage.sqlite`;

export function gatewayDbAvailable() {
  return existsSync(DB_FILE);
}

/**
 * @returns {Promise<Array<{ apiKeyId: string, model: string, tokensIn: number, tokensOut: number, requests: number, costUsd: number }>>}
 *          Today's aggregates per gateway key AND model, with estimated USD
 *          cost (usage_history stores tokens; pricing lives in pricing.js).
 *          Throws on schema drift / unreadable DB so callers can log + skip.
 */
/**
 * The same ledger, grouped by day instead of narrowed to today — the read the
 * backfill needs. Days are the accounting day (12:00 AM America/New_York, see
 * usageDay.js), which is what every other date in this service uses, so a
 * backfilled day lines up with the rows the scheduled sync writes.
 *
 * @param {{ days?: number }} [opts] accounting days ending today, inclusive
 * @returns {Promise<Array<{ date: string, apiKeyId: string, model: string,
 *                           tokensIn: number, tokensOut: number, requests: number,
 *                           costUsd: number }>>}
 */
export async function readGatewayUsageByDay({ days = 30 } = {}) {
  if (!gatewayDbAvailable()) {
    throw new Error(`gateway DB not found at ${DB_FILE} (is gateway-data mounted?)`);
  }
  const window = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);

  let db;
  try {
    db = new Database(DB_FILE, { readonly: true, fileMustExist: true, timeout: 5000 });
    // One extra UTC day on each side of the window, because the accounting day
    // is offset from UTC by up to five hours: without the margin the first and
    // last accounting days would be read short.
    const rows = db
      .prepare(
        `SELECT api_key_id  AS apiKeyId,
                COALESCE(model, '')       AS model,
                COALESCE(tokens_input, 0)  AS tokensIn,
                COALESCE(tokens_output, 0) AS tokensOut,
                timestamp                 AS timestamp
         FROM usage_history
         WHERE api_key_id IS NOT NULL
           AND timestamp >= datetime('now', ?)
         ORDER BY timestamp`,
      )
      .all(`-${window + 1} days`);

    const byDay = new Map();
    for (const r of rows) {
      let day;
      try {
        day = usageDayOf(r.timestamp);
      } catch {
        continue;
      }
      const key = `${day}\u0000${r.apiKeyId}\u0000${r.model}`;
      const cur = byDay.get(key) || {
        date: day,
        apiKeyId: String(r.apiKeyId),
        model: String(r.model || ''),
        tokensIn: 0,
        tokensOut: 0,
        requests: 0,
      };
      cur.tokensIn += Number(r.tokensIn) || 0;
      cur.tokensOut += Number(r.tokensOut) || 0;
      cur.requests += 1;
      byDay.set(key, cur);
    }

    return [...byDay.values()].map((r) => ({
      ...r,
      costUsd: estimateCostUsd(r.model, r.tokensIn, r.tokensOut),
    }));
  } catch (err) {
    throw new Error(`gateway usage read failed (schema drift?): ${err.message}`);
  } finally {
    if (db) db.close();
  }
}

export async function readGatewayUsageToday() {
  if (!gatewayDbAvailable()) {
    throw new Error(`gateway DB not found at ${DB_FILE} (is gateway-data mounted?)`);
  }

  let db;
  try {
    db = new Database(DB_FILE, { readonly: true, fileMustExist: true, timeout: 5000 });
    // Rows are bucketed in JS, not by SQL `date(timestamp)`: SQLite alone cannot
    // resolve America/New_York (DST included), and a UTC day boundary is the bug
    // this replaced. Three days of rows keeps the read small while still covering
    // the longest possible accounting day (25 h) plus its skew.
    const rows = db
      .prepare(
        `SELECT api_key_id  AS apiKeyId,
                COALESCE(model, '')       AS model,
                COALESCE(tokens_input, 0)  AS tokensIn,
                COALESCE(tokens_output, 0) AS tokensOut,
                timestamp                 AS timestamp
         FROM usage_history
         WHERE api_key_id IS NOT NULL
           AND timestamp >= datetime('now', '-3 days')`,
      )
      .all();

    const today = usageDay();
    const byKey = new Map();
    for (const r of rows) {
      let day;
      try {
        day = usageDayOf(r.timestamp);
      } catch {
        continue; // an unparseable row is skipped, never guessed at
      }
      if (day !== today) continue;
      const key = `${r.apiKeyId}\u0000${r.model}`;
      const cur = byKey.get(key) || {
        apiKeyId: String(r.apiKeyId),
        model: String(r.model || ''),
        tokensIn: 0,
        tokensOut: 0,
        requests: 0,
      };
      cur.tokensIn += Number(r.tokensIn) || 0;
      cur.tokensOut += Number(r.tokensOut) || 0;
      cur.requests += 1;
      byKey.set(key, cur);
    }

    return [...byKey.values()].map((r) => ({
      ...r,
      costUsd: estimateCostUsd(r.model, r.tokensIn, r.tokensOut),
    }));
  } catch (err) {
    throw new Error(`gateway usage read failed (schema drift?): ${err.message}`);
  } finally {
    if (db) db.close();
  }
}
