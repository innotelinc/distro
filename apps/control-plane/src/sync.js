// M4 sync routine: pull today's per-key usage from the gateway SQLite store
// and make it authoritative in usage_cache for each mapped user.

import { getUserByGatewayKeyId, replaceUsageFromGateway } from './db.js';
import { readGatewayUsageToday, gatewayDbAvailable } from './gatewayUsage.js';

export async function syncUsageFromGateway() {
  if (!gatewayDbAvailable()) {
    return { ok: false, reason: 'gateway data volume not mounted' };
  }

  // Rows arrive per (key, model); merge to per-key totals with summed cost.
  const rows = await readGatewayUsageToday();
  const byKey = new Map();
  for (const row of rows) {
    const cur = byKey.get(row.apiKeyId) || { apiKeyId: row.apiKeyId, tokensIn: 0, tokensOut: 0, requests: 0, costUsd: 0 };
    cur.tokensIn += row.tokensIn;
    cur.tokensOut += row.tokensOut;
    cur.requests += row.requests;
    cur.costUsd += row.costUsd;
    byKey.set(row.apiKeyId, cur);
  }

  let matched = 0;
  let unknownKeys = 0;
  let total = { tokensIn: 0, tokensOut: 0, requests: 0, costUsd: 0 };

  for (const agg of byKey.values()) {
    const user = getUserByGatewayKeyId(agg.apiKeyId);
    if (!user) {
      // A gateway key we don't manage (dashboard-created, revoked, or the
      // host/operator key) — not a per-user account, nothing to record.
      unknownKeys += 1;
      continue;
    }
    replaceUsageFromGateway(user.id, agg);
    matched += 1;
    total.tokensIn += agg.tokensIn;
    total.tokensOut += agg.tokensOut;
    total.requests += agg.requests;
    total.costUsd += agg.costUsd;
  }

  return { ok: true, keys: byKey.size, matched, unknownKeys, total };
}
