// Is every account's gateway key still one the gateway accepts?
//
// A key is minted once, on the gateway, and kept here. Nothing re-checks it
// afterwards — so when the gateway's own store is replaced (a restore, a
// migration, a rebuilt volume), our copy keeps looking configured while the
// gateway has never heard of it. Every turn that spends it is then refused with
// `401 Invalid API key` *before* a model is chosen, and the builder surface
// reports that as "every model in the chain failed to answer", which reads like a
// provider or a quota problem and is neither: it is one account's credential,
// and only that account can tell.
//
// The check asks the surface a turn actually spends on — the OpenAI-compatible
// `/v1/models`, with the account's key as the bearer — because a key is only as
// good as the door it opens. Only 401/403 count as broken: 402, 429 and 5xx are
// the gateway's own upstream weather, and an account that is merely throttled
// today is not an account somebody has to go and fix.
//
// Re-minting is human work, and `--fix` is the human saying so: it rotates the
// broken key rather than quietly retrying a credential the gateway has already
// refused.
//
// A refusal is not the only way a key is wrong, and it is not even the quieter
// one. The same key stored against several accounts is accepted by the gateway for
// all of them — so the check that only asks "does the gateway still know this key"
// reports `ok` while every turn those accounts make is spent, and attributed, as
// one identity. A row with no key at all is the third shape: an account whose key
// was never minted, and asking the gateway with an empty bearer is not a question
// worth putting to it. Both are found here and both are what `--fix` rotates.

import { getQuota, listGatewayKeys, logAudit, setGatewayKey } from './db.js';
import { resolveGatewayUrls } from './discovery.js';

/** The statuses that mean the credential itself was rejected. */
const REJECTED_STATUSES = new Set([401, 403]);
const TIMEOUT_MS = 15_000;

/**
 * The gateway's OpenAI-compatible base.
 *
 * `GATEWAY_API_URL` is sometimes pinned with the `/v1` already on it, and
 * appending another one would 404 every request — which would look like a
 * gateway problem in a check whose whole job is to tell the two apart.
 */
export async function gatewayApiBase() {
  const { apiUrl } = await resolveGatewayUrls();
  return apiUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * Validate every live account key against the gateway.
 *
 * @param {{ fetchImpl?: typeof fetch, base?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ base: string, checked: number, ok: object[], rejected: object[], unchecked: object[], missing: object[], shared: object[] }>}
 *          `unchecked` is the honest third answer: the gateway could not be
 *          asked, or answered something that is neither acceptance nor refusal.
 *          Folding those into either verdict is how a check starts lying.
 *          `missing` and `shared` are the two verdicts the gateway itself cannot
 *          give: it accepts a shared key, and it answers an empty bearer without
 *          saying which account the row belongs to.
 */
export async function checkAccountKeys({ fetchImpl = fetch, base, timeoutMs = TIMEOUT_MS } = {}) {
  const resolvedBase = base || (await gatewayApiBase());
  const rows = listGatewayKeys();
  const ok = [];
  const rejected = [];
  const unchecked = [];
  const missing = [];
  const shared = [];

  // Who else holds each key. Built before anything is asked, because a key that
  // two accounts hold is answered `200` by the gateway and would otherwise land
  // in `ok` — the one verdict that says nobody has to do anything.
  const holders = new Map();
  for (const row of rows) {
    const key = String(row.gateway_key || '');
    if (key === '') continue;
    if (!holders.has(key)) holders.set(key, []);
    holders.get(key).push(row.user_id);
  }
  // The earliest row keeps a key several accounts somehow ended up with: that is
  // the one it was minted for. `listGatewayKeys` orders by email, so the tie is
  // broken on the row's own creation time.
  const keeperByKey = new Map();
  for (const row of rows) {
    const key = String(row.gateway_key || '');
    if (key === '' || (holders.get(key) || []).length < 2) continue;
    const current = keeperByKey.get(key);
    if (!current || String(row.created_at) < String(current.created_at)) keeperByKey.set(key, row);
  }

  for (const row of rows) {
    const key = String(row.gateway_key || '');
    const entry = {
      userId: row.user_id,
      email: row.email,
      label: row.label,
      keyPrefix: key.slice(0, 12),
      gatewayKeyId: row.gateway_key_id,
      lastUsedAt: row.last_used_at ?? null,
    };
    if (key === '') {
      entry.reason = 'this account has no gateway key stored';
      missing.push(entry);
      continue;
    }
    if ((holders.get(key) || []).length > 1 && keeperByKey.get(key)?.user_id !== row.user_id) {
      entry.reason = `the same key is stored for ${(holders.get(key) || []).length} accounts, so what it spends cannot be attributed to one of them`;
      shared.push(entry);
      continue;
    }
    try {
      const response = await fetchImpl(`${resolvedBase}/v1/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      entry.status = response.status;
      if (response.status === 200) ok.push(entry);
      else if (REJECTED_STATUSES.has(response.status)) rejected.push(entry);
      else unchecked.push(entry);
    } catch (error) {
      entry.error = error && error.message ? error.message : String(error);
      unchecked.push(entry);
    }
  }

  return { base: resolvedBase, checked: rows.length, ok, rejected, unchecked, missing, shared };
}

/**
 * Everything `--fix` has to rotate, in the order it is reported.
 *
 * A function rather than a spread at each call site: the three verdicts are one
 * answer to the operator ("these accounts cannot spend what they should"), and a
 * caller that forgets one of them is a caller that reports a clean check over a
 * deployment that is not.
 */
export function brokenAccountKeys(result) {
  return [...result.rejected, ...result.missing, ...result.shared];
}

/**
 * Give an account a key the gateway will accept, replacing the one it cannot.
 *
 * The superseded key is left on the gateway — its store is not this plane's to
 * prune — but nothing here references it again, and the mint is recorded as the
 * rotation it is. Returns the new key's id, never the key itself.
 */
export async function remintAccountKey(entry, { gateway }) {
  const quota = getQuota(entry.userId);
  await gateway.login();
  const key = await gateway.createApiKey(`genie-user-${entry.userId.slice(0, 8)}`, {
    dailyUsageLimitUsd: quota.spend_cap_usd ?? undefined,
    weeklyUsageLimitUsd: quota.spend_cap_usd != null ? quota.spend_cap_usd * 7 : undefined,
  });
  // The label matters: a row per label is a key per surface, and writing the mint
  // over `default` when the broken row was `openmaic` would leave that surface
  // holding the key it cannot use.
  setGatewayKey(entry.userId, {
    gatewayKeyId: key.id,
    gatewayKey: key.key,
    label: entry.label || 'default',
  });
  logAudit({
    action: 'key.rotate',
    targetId: entry.userId,
    targetEmail: entry.email,
    meta: {
      reason: entry.reason || 'the gateway refused the stored key',
      label: entry.label || 'default',
      previousKeyPrefix: entry.keyPrefix,
      previousStatus: entry.status ?? null,
      via: 'control.mjs keys-check --fix',
    },
  });
  return { gatewayKeyId: key.id };
}
