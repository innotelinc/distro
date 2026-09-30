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
 * @returns {Promise<{ base: string, checked: number, ok: object[], rejected: object[], unchecked: object[] }>}
 *          `unchecked` is the honest third answer: the gateway could not be
 *          asked, or answered something that is neither acceptance nor refusal.
 *          Folding those into either verdict is how a check starts lying.
 */
export async function checkAccountKeys({ fetchImpl = fetch, base, timeoutMs = TIMEOUT_MS } = {}) {
  const resolvedBase = base || (await gatewayApiBase());
  const rows = listGatewayKeys();
  const ok = [];
  const rejected = [];
  const unchecked = [];

  for (const row of rows) {
    const entry = {
      userId: row.user_id,
      email: row.email,
      keyPrefix: String(row.gateway_key || '').slice(0, 12),
      gatewayKeyId: row.gateway_key_id,
      lastUsedAt: row.last_used_at ?? null,
    };
    try {
      const response = await fetchImpl(`${resolvedBase}/v1/models`, {
        headers: { Authorization: `Bearer ${row.gateway_key}` },
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

  return { base: resolvedBase, checked: rows.length, ok, rejected, unchecked };
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
  const key = await gateway.createApiKey(`studio-user-${entry.userId.slice(0, 8)}`, {
    dailyUsageLimitUsd: quota.spend_cap_usd ?? undefined,
    weeklyUsageLimitUsd: quota.spend_cap_usd != null ? quota.spend_cap_usd * 7 : undefined,
  });
  setGatewayKey(entry.userId, { gatewayKeyId: key.id, gatewayKey: key.key });
  logAudit({
    action: 'key.rotate',
    targetId: entry.userId,
    targetEmail: entry.email,
    meta: {
      reason: 'the gateway refused the stored key',
      previousKeyPrefix: entry.keyPrefix,
      previousStatus: entry.status ?? null,
      via: 'control.mjs keys-check --fix',
    },
  });
  return { gatewayKeyId: key.id };
}
