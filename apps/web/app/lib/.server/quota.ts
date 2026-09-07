import { createScopedLogger } from '~/utils/logger';

/**
 * M3 — server-side per-request quota gate for the Distro web app.
 *
 * The chat pipeline holds the user's gateway key (from the apiKeys cookie),
 * so it can identify the account to the control plane without ever seeing a
 * session token: GET /api/internal/quota-check decides, POST
 * /api/internal/usage-report records the finished turn. Hard spend caps still
 * live on the gateway key itself; these routes make daily request/token caps
 * and the usage widget real for chat traffic.
 *
 * Fail-open by design: if the control plane is unreachable, building must not
 * stop — the gateway key limits remain the backstop.
 */

const logger = createScopedLogger('quota');

export interface QuotaDecision {
  allowed: boolean;
  reasons: string[];
}

type EnvLike = Record<string, string | undefined> | undefined;

function envValue(env: EnvLike, key: string): string | undefined {
  const fromWorkerEnv = env && env[key];
  if (fromWorkerEnv !== undefined) return fromWorkerEnv;
  if (typeof process !== 'undefined' && process.env) {
    return (process.env as Record<string, string | undefined>)[key];
  }
  return undefined;
}

async function cpFetch(base: string, path: string, gatewayKey: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${gatewayKey}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `control plane ${path} -> ${res.status}`);
  }
  return data;
}

function enforcementOn(env: EnvLike): boolean {
  return envValue(env, 'DISTRO_ENFORCE_QUOTA') === 'true';
}

/** Pre-flight gate, called once per chat turn before anything is streamed. */
export async function quotaCheck(gatewayKey: string | undefined, env: EnvLike): Promise<QuotaDecision> {
  // Host-key / "skip for now" mode has no per-user account — operator traffic.
  if (!gatewayKey || !enforcementOn(env)) {
    return { allowed: true, reasons: [] };
  }

  const base = envValue(env, 'CONTROL_PLANE_INTERNAL_URL') || 'http://127.0.0.1:20140';

  try {
    const data = await cpFetch(base, '/api/internal/quota-check', gatewayKey);
    return { allowed: !!data.allowed, reasons: Array.isArray(data.reasons) ? data.reasons : [] };
  } catch (err: any) {
    logger.warn(`quota check skipped (fail-open): ${err?.message || err}`);
    return { allowed: true, reasons: [] };
  }
}

/** Fire-and-forget usage recording after a chat turn finishes. The model id
 *  is passed so the control plane can estimate spend (see pricing.js). */
export async function reportChatUsage(
  gatewayKey: string | undefined,
  usage: { tokensIn: number; tokensOut: number; requests: number; model?: string },
  env: EnvLike,
): Promise<void> {
  if (!gatewayKey || !enforcementOn(env)) return;

  const base = envValue(env, 'CONTROL_PLANE_INTERNAL_URL') || 'http://127.0.0.1:20140';

  try {
    await cpFetch(base, '/api/internal/usage-report', gatewayKey, {
      method: 'POST',
      body: JSON.stringify({
        tokensIn: Math.max(0, Math.round(usage.tokensIn) || 0),
        tokensOut: Math.max(0, Math.round(usage.tokensOut) || 0),
        requests: Math.max(1, Math.round(usage.requests) || 1),
        model: usage.model ? String(usage.model).slice(0, 200) : undefined,
      }),
    });
  } catch (err: any) {
    logger.warn(`usage report failed (ignored): ${err?.message || err}`);
  }
}
