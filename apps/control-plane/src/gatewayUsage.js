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

const DATA_DIR = process.env.GATEWAY_DATA_DIR || '/gateway-data';
const DB_FILE = `${DATA_DIR}/storage.sqlite`;

export function gatewayDbAvailable() {
  return existsSync(DB_FILE);
}

/**
 * @returns {Promise<Array<{ apiKeyId: string, tokensIn: number, tokensOut: number, requests: number }>>}
 *          Today's aggregates per gateway key. Throws on schema drift /
 *          unreadable DB so callers can log + skip.
 */
export async function readGatewayUsageToday() {
  if (!gatewayDbAvailable()) {
    throw new Error(`gateway DB not found at ${DB_FILE} (is gateway-data mounted?)`);
  }

  let db;
  try {
    db = new Database(DB_FILE, { readonly: true, fileMustExist: true, timeout: 5000 });
    const rows = db
      .prepare(
        `SELECT api_key_id AS apiKeyId,
                COALESCE(SUM(COALESCE(tokens_input, 0)), 0)  AS tokensIn,
                COALESCE(SUM(COALESCE(tokens_output, 0)), 0) AS tokensOut,
                COUNT(*)                                     AS requests
         FROM usage_history
         WHERE api_key_id IS NOT NULL
           AND timestamp >= date('now')
         GROUP BY api_key_id`,
      )
      .all();

    return rows.map((r) => ({
      apiKeyId: String(r.apiKeyId),
      tokensIn: Number(r.tokensIn) || 0,
      tokensOut: Number(r.tokensOut) || 0,
      requests: Number(r.requests) || 0,
    }));
  } catch (err) {
    throw new Error(`gateway usage read failed (schema drift?): ${err.message}`);
  } finally {
    if (db) db.close();
  }
}
