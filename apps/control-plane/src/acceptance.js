// The acceptance loop: does *this* deployment still do the thing tenancy is for?
//
// The M7 item it belongs to says a scheduled check should prove the deployment
// works end to end. This is the plane's half of that: a subject resolves to an
// account (provisioned on first sight), the account's own gateway key is what
// every later call carries, the quota gate answers, a turn's usage is reported
// and reads back through the same route a turn's accounting uses. The sign-in
// half lives with the surface that signs in
// (`ontrak-genie/scripts/verify-tenancy.mjs`), so neither half needs an
// Authentik, provider or Cerulean credential.
//
// Written as a function over an injected `fetch` so a test can drive it against
// the real server on a temporary database rather than a description of one; the
// CLI (`control.mjs acceptance`) and the scheduled wrapper are thin around it.

/**
 * @typedef {{ name: string, ok: boolean, detail: string }} AcceptanceStep
 * @typedef {{
 *   base: string,
 *   token: string,
 *   sub?: string,
 *   email?: string,
 *   model?: string,
 *   fetchImpl?: typeof fetch,
 * }} AcceptanceOptions
 * @typedef {{ steps: AcceptanceStep[], ok: boolean }} AcceptanceResult
 */

const DEFAULTS = {
  sub: 'distro-acceptance-loop',
  email: 'acceptance@distro.invalid',
  model: 'acceptance/loop',
};

/**
 * Run the loop once and return what each step found.
 * @param {AcceptanceOptions} options
 * @returns {Promise<AcceptanceResult>}
 */
export async function runAcceptance(options) {
  const doFetch = options.fetchImpl || fetch;
  const base = options.base.replace(/\/+$/, '');
  const token = options.token;
  const sub = options.sub || DEFAULTS.sub;
  const email = (options.email || DEFAULTS.email).toLowerCase();
  const model = options.model || DEFAULTS.model;

  /** @type {AcceptanceStep[]} */
  const steps = [];
  const step = (name, ok, detail = '') => {
    steps.push({ name, ok, detail });
  };

  const call = async (path, init = {}) => {
    const res = await doFetch(base + path, {
      ...init,
      headers: { 'x-control-internal-token': token, ...(init.headers || {}) },
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };

  const identity = () =>
    call('/api/internal/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub, email, name: 'Acceptance loop' }),
    });

  const health = await call('/health');
  step('the plane answers', health.status === 200, `HTTP ${health.status}`);

  // One subject, one account, one key — and the same ones every run. A subject
  // that resolved to a fresh account each time would pass every other step while
  // silently destroying attribution.
  const first = await identity();
  const user = first.body && first.body.user;
  const key = first.body && first.body.gatewayKey;
  step(
    'a subject resolves to an account and its own key',
    first.status === 200 && !!user && !!key,
    user ? `${String(user.id).slice(0, 8)} key ${key ? 'minted' : 'MISSING'}` : `HTTP ${first.status}`,
  );

  const again = await identity();
  step(
    'the identity is stable, so a restart does not re-key an account',
    again.status === 200 && again.body.user?.id === user?.id && again.body.gatewayKey === key,
    'same account id and same gateway key on the second call',
  );

  const quota = await call('/api/internal/quota-check', {
    headers: { authorization: `Bearer ${key}` },
  });
  const before = Number(quota.body?.usageToday?.requests) || 0;
  step(
    "the account's key answers the quota gate",
    quota.status === 200 && typeof quota.body?.allowed === 'boolean',
    `allowed=${quota.body?.allowed}, ${before} request(s) today`,
  );

  const report = await call('/api/internal/usage-report', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ tokensIn: 7, tokensOut: 11, model }),
  });
  step("a turn's usage is reported", report.status === 200, `HTTP ${report.status}`);

  // Read it back through the same route a turn's accounting uses: reported is
  // not the same claim as recorded.
  const after = await call('/api/internal/quota-check', {
    headers: { authorization: `Bearer ${key}` },
  });
  const now = Number(after.body?.usageToday?.requests) || 0;
  step('and it reads back', now > before, `requests today ${before} -> ${now}`);

  return { steps, ok: steps.every((entry) => entry.ok) };
}

/**
 * The accounts a cross-repository check may sign in as.
 *
 * The M7 item is two halves — the plane's loop and the console's sign-in — and the
 * sign-in half has to name *real* subjects. A check that carried its own made-up
 * subject would prove the console mints a cookie, not that the accounts people use
 * resolve through this plane; so the plane is asked which accounts exist, and only
 * the ones bound to an identity (`oidc_sub`) can be signed in as. Disabled accounts
 * are left out for the same reason: they are precisely the ones a sign-in must
 * refuse, so including them would make a healthy deployment look broken.
 *
 * The return shape is the flag `ontrak-genie/scripts/verify-tenancy.mjs` takes
 * (`sub=email`), so the two halves join without a translation table in between.
 *
 * @param {Array<{ oidc_sub?: string|null, email?: string, disabled_at?: string|null }>} users
 * @param {number} [limit]
 * @returns {string[]}
 */
export function linkedAccountPairs(users, limit = 2) {
  return users
    .filter((user) => user && user.oidc_sub && !user.disabled_at && user.email)
    .slice(0, limit)
    .map((user) => `${user.oidc_sub}=${user.email}`);
}

/**
 * Render a run the way the CLI and the scheduled wrapper print it.
 * @param {AcceptanceResult} result
 * @returns {string}
 */
export function formatAcceptance(result) {
  const lines = result.steps.map(
    (entry) => `  ${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`,
  );
  const passed = result.steps.filter((entry) => entry.ok).length;
  lines.push(
    result.ok
      ? `\nacceptance: ${passed}/${result.steps.length} passed`
      : `\nacceptance: ${result.steps.length - passed} of ${result.steps.length} step(s) failed`,
  );
  return lines.join('\n');
}
