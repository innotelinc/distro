// M4 sync routine: pull today's per-key usage from the gateway SQLite store
// and make it authoritative in usage_cache for each mapped user.

import { getUserByGatewayKeyId, replaceUsageFromGateway } from './db.js';
import { readGatewayUsageToday, gatewayDbAvailable } from './gatewayUsage.js';

export async function syncUsageFromGateway() {
  if (!gatewayDbAvailable()) {
    return { ok: false, reason: 'gateway data volume not mounted' };
  }

  const rows = await readGatewayUsageToday();
  let matched = 0;
  let unknownKeys = 0;
  let total = { tokensIn: 0, tokensOut: 0, requests: 0 };

  for (const row of rows) {
    const user = getUserByGatewayKeyId(row.apiKeyId);
    if (!user) {
      // A gateway key we don't manage (dashboard-created, revoked, or the
      // host/operator key) — not a per-user account, nothing to record.
      unknownKeys += 1;
      continue;
    }
    replaceUsageFromGateway(user.id, row);
    matched += 1;
    total.tokensIn += row.tokensIn;
    total.tokensOut += row.tokensOut;
    total.requests += row.requests;
  }

  return { ok: true, keys: rows.length, matched, unknownKeys, total };
}
