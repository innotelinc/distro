/**
 * Magnate billing integration.
 *
 * Distro never holds Stripe keys.  Magnate owns subscriptions, plans and the
 * revenue ledger.  Distro queries Magnate's server-to-server entitlements API
 * to check whether a user has an active subscription and which plan they're on.
 *
 * Env vars:
 *   MAGNATE_URL               – base URL of the Magnate instance (e.g. https://magnate.example.com)
 *   MAGNATE_ENTITLEMENTS_TOKEN – shared secret for the /api/entitlements gate (optional on trusted nets)
 *   MAGNATE_BILLING_SLUG      – plan slug to check (default "distro")
 */

const MAGNATE_URL = (process.env.MAGNATE_URL || '').replace(/\/+$/, '');
const MAGNATE_ENTITLEMENTS_TOKEN = process.env.MAGNATE_ENTITLEMENTS_TOKEN || '';
const MAGNATE_BILLING_SLUG = process.env.MAGNATE_BILLING_SLUG || 'distro';

export function magnateConfigured() {
  return Boolean(MAGNATE_URL);
}

/**
 * Seed the 'distro' plan in Magnate on first run.
 * This ensures the plan exists for entitlements checks.
 * Idempotent: if the plan already exists, this is a no-op.
 */
export async function seedDistroPlan() {
  if (!MAGNATE_URL) return;

  const headers = {};
  if (MAGNATE_ENTITLEMENTS_TOKEN) {
    headers['Authorization'] = `Bearer ${MAGNATE_ENTITLEMENTS_TOKEN}`;
  }

  try {
    // Check if plan already exists
    const checkRes = await fetch(`${MAGNATE_URL}/api/entitlements?plan=${MAGNATE_BILLING_SLUG}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    const checkData = await checkRes.json();
    if (checkData.reason !== 'plan_not_found') {
      console.log(`[billing] distro plan already exists in Magnate`);
      return;
    }

    // Create the plan via Magnate's admin API
    const createRes = await fetch(`${MAGNATE_URL}/api/admin/plans`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Distro',
        slug: MAGNATE_BILLING_SLUG,
        description: 'AI app-building platform — unlimited builds, all models.',
        priceMonthlyCents: 1999,
        priceYearlyCents: 19990,
        features: [
          'Unlimited app builds',
          'Access to all AI models via OmniRoute',
          'Live preview & terminal in-browser',
          'Priority support'
        ],
        highlighted: true,
        active: true,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (createRes.ok) {
      console.log(`[billing] created distro plan in Magnate`);
    } else {
      console.warn(`[billing] failed to create distro plan: HTTP ${createRes.status}`);
    }
  } catch (err) {
    console.warn(`[billing] seed failed: ${err?.message || err}`);
  }
}

/**
 * Check a user's entitlement against Magnate.
 *
 * Returns the raw Magnate response shape:
 *   { entitled, source, plan, slug, status, expires_at, reason, user }
 *
 * When Magnate is unreachable or not configured, returns a fallback:
 *   { entitled: null, source: 'unconfigured'|'unreachable', magnate_url: '' }
 */
export async function checkEntitlement(usernameOrEmail) {
  if (!MAGNATE_URL) {
    return { entitled: null, source: 'unconfigured', magnate_url: '' };
  }

  const params = new URLSearchParams();
  if (MAGNATE_BILLING_SLUG) params.set('plan', MAGNATE_BILLING_SLUG);
  if (usernameOrEmail) params.set('user', usernameOrEmail);

  const headers = {};
  if (MAGNATE_ENTITLEMENTS_TOKEN) {
    headers['Authorization'] = `Bearer ${MAGNATE_ENTITLEMENTS_TOKEN}`;
  }

  try {
    const res = await fetch(`${MAGNATE_URL}/api/entitlements?${params}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { entitled: null, source: 'unreachable', magnate_url: MAGNATE_URL, reason: `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { ...data, magnate_url: MAGNATE_URL, source: 'magnate' };
  } catch (err) {
    return { entitled: null, source: 'unreachable', magnate_url: MAGNATE_URL, reason: err?.message || 'fetch failed' };
  }
}

/**
 * Fetch available plans from Magnate's storefront endpoint.
 * Falls back to an empty list when Magnate is unreachable.
 */
export async function listPlans() {
  if (!MAGNATE_URL) return [];

  try {
    const res = await fetch(`${MAGNATE_URL}/api/plans`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.plans) ? data.plans : [];
  } catch {
    return [];
  }
}

/**
 * Feature gating: returns adjusted quota limits based on entitlement status.
 *
 * Free users (no active subscription) get reduced limits.
 * Subscribed users get the full limits.
 * When billing is disabled, everyone gets full limits.
 */
export function gatedQuota(entitlement, baseQuota) {
  // If billing is not configured, no gating
  if (!magnateConfigured()) return baseQuota;

  // If entitlement check failed or user is not entitled, apply free tier limits
  if (!entitlement || entitlement.entitled !== true) {
    return {
      ...baseQuota,
      // Free tier: 10 requests/day, 50k tokens/day, $0.50 spend cap
      requests_per_day: Math.min(baseQuota.requests_per_day ?? 1000, 10),
      tokens_per_day: Math.min(baseQuota.tokens_per_day ?? 1000000, 50000),
      spend_cap_usd: Math.min(baseQuota.spend_cap_usd ?? 100, 0.5),
    };
  }

  // Subscribed user: full limits (or higher if plan specifies)
  return baseQuota;
}
