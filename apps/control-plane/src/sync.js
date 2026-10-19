// M4 sync routine: pull today's per-key usage from the gateway SQLite store
// and make it authoritative in usage_cache for each mapped user.

import {
  getDb,
  getUserByGatewayKeyId,
  replaceUsageFromGateway,
  replaceModelUsageFromGateway,
  replaceUsageForDate,
  replaceModelUsageForDate,
} from './db.js';
import { readGatewayUsageToday, readGatewayUsageByDay, gatewayDbAvailable } from './gatewayUsage.js';

/**
 * Whether the scheduled usage sync has gone quiet (M8).
 *
 * A timer that stopped, a process that wedged, and a sync that has never once
 * succeeded all read the same way from the outside: `usage_cache` is frozen and
 * nobody is told. `lastSuccessAt` is null until the first success, so a sync
 * that has never completed counts as stale from `startedAt`.
 *
 * Pure and exported for its own test — the interesting part is the boundary, not
 * the timer around it.
 */
export function syncIsStale({ now, lastSuccessAt, startedAt, staleMs }) {
  const since = lastSuccessAt ?? startedAt;
  return now - since > staleMs;
}

export async function syncUsageFromGateway() {
  if (!gatewayDbAvailable()) {
    return { ok: false, reason: 'gateway data volume not mounted' };
  }

  // Rows arrive per (key, model); merge to per-key totals with summed cost and
  // keep the per-model rows for the breakdown (M6).
  const rows = await readGatewayUsageToday();
  const byKey = new Map();
  for (const row of rows) {
    const cur = byKey.get(row.apiKeyId) || { apiKeyId: row.apiKeyId, tokensIn: 0, tokensOut: 0, requests: 0, costUsd: 0, models: [] };
    cur.tokensIn += row.tokensIn;
    cur.tokensOut += row.tokensOut;
    cur.requests += row.requests;
    cur.costUsd += row.costUsd;
    cur.models.push(row);
    byKey.set(row.apiKeyId, cur);
  }

  // An account can own several keys (a rotated one, an app key, the legacy
  // shared one), and `replaceUsageFromGateway` REPLACES the day: writing each
  // key in turn leaves only the last one's tokens in the cache. Sum per account
  // first, then write once. Found live — the dashboard showed 31 requests where
  // the ledger had 77.
  const { byUser, unmapped, unknownKeys } = groupUnmappedByUser(byKey);

  let total = { tokensIn: 0, tokensOut: 0, requests: 0, costUsd: 0 };
  for (const agg of byUser.values()) {
    replaceUsageFromGateway(agg.userId, agg);
    replaceModelUsageFromGateway(agg.userId, agg.models);
    total.tokensIn += agg.tokensIn;
    total.tokensOut += agg.tokensOut;
    total.requests += agg.requests;
    total.costUsd += agg.costUsd;
  }

  return { ok: true, keys: byKey.size, matched: byUser.size, unknownKeys, unmapped, total };
}

/**
 * Fold per-key totals into per-account totals, keeping the per-model rows for
 * the breakdown, and collect the keys no account owns.
 *
 * Pure and exported so the "one account, several keys" case is a test rather
 * than a production surprise: getting it wrong silently under-reports a day.
 *
 * @param {Map<string, {apiKeyId: string, tokensIn: number, tokensOut: number,
 *                      requests: number, costUsd: number, models: object[]}>} byKey
 * @param {(apiKeyId: string) => ({ id: string } | null)} [lookup]
 */
export function groupUnmappedByUser(byKey, lookup = getUserByGatewayKeyId) {
  const byUser = new Map();
  const unmapped = [];
  let unknownKeys = 0;

  for (const agg of byKey.values()) {
    const user = lookup(agg.apiKeyId);
    if (!user) {
      // A gateway key we don't manage (dashboard-created, revoked, or the
      // host/operator key) — not a per-user account, nothing to record. Keep
      // the totals anyway: an unmapped key is traffic the dashboard cannot
      // show, and that is what `unmappedAlert` reports (M4/M8).
      unknownKeys += 1;
      unmapped.push({
        apiKeyId: agg.apiKeyId,
        tokensIn: agg.tokensIn,
        tokensOut: agg.tokensOut,
        requests: agg.requests,
      });
      continue;
    }
    const cur =
      byUser.get(user.id) || { userId: user.id, tokensIn: 0, tokensOut: 0, requests: 0, costUsd: 0, models: [] };
    cur.tokensIn += agg.tokensIn;
    cur.tokensOut += agg.tokensOut;
    cur.requests += agg.requests;
    cur.costUsd += agg.costUsd;
    cur.models.push(...agg.models);
    byUser.set(user.id, cur);
  }

  return { byUser, unmapped, unknownKeys };
}

/**
 * The alert raised when the gateway reports tokens on keys no account owns.
 *
 * This is the failure mode that looks like success: the sync completes, the
 * dashboard renders, and the traffic simply is not there — which reads as "the
 * platform is idle", not "attribution broke". Pure and exported so the wording
 * and the ordering are pinned by a test rather than by a live gateway.
 *
 * @param {Array<{apiKeyId: string, tokensIn: number, tokensOut: number, requests: number}>} unmapped
 * @returns {{title: string, message: string, meta: object}}
 */
export function unmappedAlert(unmapped) {
  const rows = [...unmapped].sort(
    (a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut),
  );
  const tokens = rows.reduce((n, r) => n + r.tokensIn + r.tokensOut, 0);
  const requests = rows.reduce((n, r) => n + r.requests, 0);
  // Five is the useful prefix: enough to recognise the keys, short enough to
  // read in a webhook notification.
  const shown = rows
    .slice(0, 5)
    .map((r) => `${r.apiKeyId} (${r.tokensIn + r.tokensOut} tok/${r.requests} req)`)
    .join(', ');
  const more = rows.length > 5 ? ` and ${rows.length - 5} more` : '';
  return {
    title: `${rows.length} gateway key(s) have no Distro account`,
    message:
      `Today's ledger holds ${tokens} token(s) across ${requests} request(s) on keys the sync cannot attribute: ` +
      `${shown}${more}. Those tokens are invisible in the dashboard until each key is mapped to an account ` +
      `(gateway_keys.gateway_key_id).`,
    meta: { unmapped: rows },
  };
}

/**
 * Fold per-(day, key, model) ledger rows into the shape the cache stores, split
 * by owning account.
 *
 * Pure on purpose: the backfill writes history, so the grouping is the part
 * worth pinning with a test rather than discovering in production. Rows whose
 * key has no account (revoked, or never mapped) are summed per key instead of
 * dropped — the summary has to say how much traffic it could not place.
 *
 * @param {Array<{date: string, apiKeyId: string, model: string, tokensIn: number,
 *                tokensOut: number, requests: number, costUsd: number}>} rows
 * @param {(apiKeyId: string) => ({ id: string } | null)} [lookup]
 */
export function planBackfill(rows, lookup = getUserByGatewayKeyId) {
  const perUserDay = new Map();
  const unmapped = new Map();

  const bump = (acc, row) => {
    acc.tokensIn += row.tokensIn;
    acc.tokensOut += row.tokensOut;
    acc.requests += row.requests;
    acc.costUsd += row.costUsd;
    return acc;
  };

  for (const row of rows) {
    const user = lookup(row.apiKeyId);
    if (!user) {
      const cur =
        unmapped.get(row.apiKeyId) || { apiKeyId: row.apiKeyId, tokensIn: 0, tokensOut: 0, requests: 0, costUsd: 0 };
      bump(cur, row);
      unmapped.set(row.apiKeyId, cur);
      continue;
    }
    const key = `${user.id}\u0000${row.date}`;
    const day =
      perUserDay.get(key) ||
      { userId: user.id, date: row.date, tokensIn: 0, tokensOut: 0, requests: 0, costUsd: 0, models: [] };
    bump(day, row);
    day.models.push(row);
    perUserDay.set(key, day);
  }

  return { perUserDay: [...perUserDay.values()], unmapped: [...unmapped.values()] };
}

/**
 * Make the gateway ledger authoritative for a window of past days, not just
 * today (M4). One pass, one transaction: history the cache never received
 * (days before the sync was switched on) otherwise reads as platform idleness.
 *
 * Only days present in the ledger are touched, and each (user, day) is
 * replaced, so re-running is idempotent and chat-report rows for days the
 * ledger does not cover are left alone.
 */
export async function backfillUsageFromGateway({ days = 30 } = {}) {
  if (!gatewayDbAvailable()) {
    throw new Error('gateway data volume not mounted');
  }
  const rows = await readGatewayUsageByDay({ days });
  const plan = planBackfill(rows);
  const database = getDb();
  database.transaction(() => {
    for (const day of plan.perUserDay) {
      replaceUsageForDate(day.userId, day.date, day);
      replaceModelUsageForDate(day.userId, day.date, day.models);
    }
  })();
  return {
    ok: true,
    days: Math.min(Math.max(Math.trunc(days) || 30, 1), 365),
    ledgerRows: rows.length,
    users: new Set(plan.perUserDay.map((d) => d.userId)).size,
    userDaysWritten: plan.perUserDay.length,
    unmapped: plan.unmapped,
  };
}
