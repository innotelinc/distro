const FREE_TIER_CLAMP = /^(1|true|yes)$/i.test(String(process.env.CONTROL_FREE_TIER_LIMITS || ''));

/**
 * Magnate billing integration.
 *
 * Distro never holds Stripe keys.  Magnate owns subscriptions, plans and the
 * revenue ledger (RevenueOps in the Innotel Platform Stack).  Distro queries
 * Magnate's server-to-server entitlements API (/api/entitlements) to check
 * whether a user has an active subscription and which plan they're on.
 *
 * Magnate itself is Cerulean/Authentik-first: subscriber accounts + passwords
 * live in Cerulean's Authentik, and Jellyfin authenticates against it via the
 * LDAP outpost.  Distro is therefore one of many consumers that gate a feature
 * on Magnate billing without ever holding Stripe keys.
 *
 * Env vars:
 *   MAGNATE_URL               – base URL of the Magnate instance (e.g. https://magnate.innotel.us)
 *   MAGNATE_ENTITLEMENTS_TOKEN – shared secret for the /api/entitlements gate;
 *                               must equal Magnate's ENTITLEMENTS_API_TOKEN.
 *                               Optional on trusted networks (empty = open).
 *   MAGNATE_BILLING_SLUG      – plan slug to check (default "distro")
 *
 * MAGNATE_URL is optional: when unset it is resolved via Consul service
 * discovery (see discovery.js) and billing stays disabled if that fails too.
 */
import { magnateUrlSync } from './discovery.js';

const MAGNATE_ENTITLEMENTS_TOKEN = process.env.MAGNATE_ENTITLEMENTS_TOKEN || '';
const MAGNATE_BILLING_SLUG = process.env.MAGNATE_BILLING_SLUG || 'distro';

const magnateUrl = () => magnateUrlSync() || '';

export function magnateConfigured() {
  return Boolean(magnateUrl());
}

/**
 * Seed the 'distro' plan in Magnate on first run.
 * This ensures the plan exists for entitlements checks.
 * Idempotent: if the plan already exists, this is a no-op.
 */
export async function seedDistroPlan() {
  const MAGNATE_URL = magnateUrl();
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
        // What Distro sells is the tenancy layer, not a builder: the build plane
        // was retired with the front door it served, and a plan that promises
        // "unlimited builds" describes a product that no longer exists.
        description: 'Multi-tenant control plane for the shared AI gateway — accounts, one key each, quota and usage per turn.',
        priceMonthlyCents: 1999,
        priceYearlyCents: 19990,
        features: [
          'Unlimited model turns through OmniRoute',
          'One gateway key per account, minted and revocable',
          'Quota checked before each turn, usage recorded after',
          'Admin console: accounts, limits and an audit log'
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
export async function checkEntitlement(usernameOrEmail, plan = null) {
  const MAGNATE_URL = magnateUrl();
  if (!MAGNATE_URL) {
    return { entitled: null, source: 'unconfigured', magnate_url: '' };
  }

  const params = new URLSearchParams();
  const slug = String(plan || '').trim() || MAGNATE_BILLING_SLUG;
  if (slug) params.set('plan', slug);
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
 * Fetch available plans from Magnate's admin plans endpoint.
 * Falls back to an empty list when Magnate is unreachable or the control plane
 * can't authenticate (ENTITLEMENTS_API_TOKEN required on the Magnate side).
 *
 * Magnate contract (see magnate/app/api/admin/plans/route.ts):
 *   GET /api/admin/plans  →  200 { plans: […] }   (admin auth via
 *   ENTITLEMENTS_API_TOKEN bearer when that token is set; else 401)
 */
export async function listPlans() {
  const MAGNATE_URL = magnateUrl();
  if (!MAGNATE_URL) return [];

  const headers = {};
  if (MAGNATE_ENTITLEMENTS_TOKEN) {
    headers['Authorization'] = `Bearer ${MAGNATE_ENTITLEMENTS_TOKEN}`;
  }

  try {
    const res = await fetch(`${MAGNATE_URL}/api/admin/plans`, {
      headers,
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
/** The plan name that means "this account is a service, not a subscriber". */
export const SERVICE_PLAN = 'service';

export function isServicePlan(quota) {
  return String(quota?.plan || '').trim().toLowerCase() === SERVICE_PLAN;
}

/**
 * The limits a turn is judged by.
 *
 * A subscription is what carries limits, and a service account is what has none:
 * `ontrak-genie@`, `atheniq@` and the classroom key are machines — the platform's
 * own apps — and clamping them to a free tier is how a class gets a 429 at
 * dinner time. So they short-circuit before Magnate is even consulted.
 *
 * For everyone else the verdict is reported, not enforced as starvation: an
 * account without a subscription keeps the limits Distro holds for it (usually
 * none) and the *product* decides what an unsubscribed account may do — that is
 * what `checkEntitlement` is for. The old free-tier clamp (10 requests/day) is
 * kept behind CONTROL_FREE_TIER_LIMITS for a deployment that wants it, because
 * removing an enforcement silently is worse than making it opt-in.
 */
export function gatedQuota(entitlement, baseQuota) {
  if (isServicePlan(baseQuota) || entitlement?.service === true) return baseQuota;
  if (!magnateConfigured()) return baseQuota;
  if (FREE_TIER_CLAMP) {
    if (!entitlement || entitlement.entitled !== true) {
      return {
        ...baseQuota,
        requests_per_day: Math.min(baseQuota.requests_per_day ?? 1000, 10),
        tokens_per_day: Math.min(baseQuota.tokens_per_day ?? 1000000, 50000),
        spend_cap_usd: Math.min(baseQuota.spend_cap_usd ?? 100, 0.5),
      };
    }
  }
  return baseQuota;
}

/**
 * One answer for "what is this account allowed, and what does it own".
 *
 * The endpoint Genie asks instead of asking Magnate itself: it resolves the
 * account, short-circuits service accounts (no subscription, no limits), and
 * otherwise reports Magnate's verdict plus the limits that verdict implies.
 *
 * `plan` is the account's own label in Distro and says nothing about a *product's*
 * question, so the plan that was asked about is reported separately as
 * `plan_asked`. Without it a product asking about `genie` for an account whose
 * local label is `unlimited` gets `plan: "unlimited"` back and cannot tell whether
 * its own question was even understood.
 *
 * @param {{id: string, email: string}|null} user
 * @param {{plan?: string}|null} quota
 * @param {string|null} plan  the plan this question is about, if any
 */
export async function entitlementFor(user, quota, plan = null) {
  const limits = {
    requests_per_day: quota?.requests_per_day ?? null,
    tokens_per_day: quota?.tokens_per_day ?? null,
    spend_cap_usd: quota?.spend_cap_usd ?? null,
  };

  if (isServicePlan(quota)) {
    return {
      entitled: true,
      service: true,
      reason: 'service account: no subscription, no limits',
      plan: SERVICE_PLAN,
      slug: SERVICE_PLAN,
      plan_asked: plan,
      status: 'service',
      source: 'distro',
      email: user?.email || null,
      limits: null,
    };
  }

  const answer = await checkEntitlement(user?.email, plan);
  return {
    ...answer,
    service: false,
    plan: quota?.plan ?? null,
    plan_asked: plan,
    email: user?.email || null,
    limits,
  };
}
