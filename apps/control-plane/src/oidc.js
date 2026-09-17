// Authentik (OIDC) single sign-on for control-plane logins.
//
// Configure via env (see .env.example "Authentik SSO"):
//   OIDC_ISSUER_URL      Authentik application issuer, e.g.
//                        https://auth.example.com/application/o/distro/
//   OIDC_CLIENT_ID       Authentik OAuth2/OIDC provider client id
//   OIDC_CLIENT_SECRET   ... and secret
//   OIDC_REDIRECT_URI    Callback URL this control plane is reachable at, e.g.
//                        https://admin.distro.innotel.us/api/auth/oidc/callback
//                        Comma-separated when the console answers on more than
//                        one origin: the callback then follows the origin the
//                        sign-in started on, and every listed URL must be
//                        registered on the Authentik provider too.
//
// Flow: the Distro login page opens the popup URL /api/auth/oidc/start
// (authorize redirect). Authentik redirects to /api/auth/oidc/callback where
// the code is exchanged server-side; the callback then posts the session back
// to the opener (window.opener.postMessage) and closes itself. No upstream
// secrets ever touch the browser.

const ISSUER = (process.env.OIDC_ISSUER_URL || '').trim().replace(/\/+$/, '');
const CLIENT_ID = (process.env.OIDC_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.OIDC_CLIENT_SECRET || '').trim();
// Every callback URL the provider has registered for this client. The first one
// is the canonical answer; the rest exist so a sign-in started on another origin
// can come back to it (see callbackUrlFor).
const REDIRECT_URIS = (process.env.OIDC_REDIRECT_URI || '')
  .split(',')
  .map((uri) => uri.trim())
  .filter(Boolean);
const REDIRECT_URI = REDIRECT_URIS[0] || '';
const TIMEOUT_MS = 15000;

let discoveryCache = null;
let discoveryAt = 0;
const DISCOVERY_TTL_MS = 5 * 60 * 1000;

export function oidcEnabled() {
  return Boolean(ISSUER && CLIENT_ID && CLIENT_SECRET && REDIRECT_URIS.length);
}

/** Compare two callback URLs by scheme, host and path (trailing slash and case aside). */
function callbackKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return raw.replace(/\/+$/, '').toLowerCase();
  }
}

function firstHeaderValue(value) {
  return String(value || '').split(',')[0].trim();
}

/**
 * The callback URL for one request.
 *
 * The flow returns the browser to the redirect_uri it was started with, and the
 * `distro_oidc_state` cookie is host-only — so a fixed callback URL only works
 * on the origin it names. Measured: the console is served on
 * `admin.distro.innotel.us` while the one registered callback was
 * `http://192.168.1.46:20140/...`, so the callback landed on a different origin,
 * the browser sent no state cookie with it, and every attempt failed with
 * "invalid or expired state".
 *
 * So the request's own origin is used when the operator listed it among the
 * registered callbacks, and the canonical (first) entry otherwise. The list is
 * what makes this safe: a forged `Host` / `X-Forwarded-Host` can only name an
 * origin that was registered with Authentik, and an unlisted one falls back to
 * the canonical URL instead of being honoured.
 */
export function callbackUrlFor(headers = {}) {
  if (!REDIRECT_URI) return '';
  const host = firstHeaderValue(headers['x-forwarded-host']) || firstHeaderValue(headers.host);
  if (!host) return REDIRECT_URI;

  let path = '/api/auth/oidc/callback';
  try {
    path = new URL(REDIRECT_URI).pathname;
  } catch {
    // A malformed canonical value is the operator's to fix; the default path
    // keeps the flow's own route rather than failing open on something else.
  }
  // The edge says which scheme the browser used; a direct LAN hit says nothing,
  // so the plain-HTTP spelling is tried after the TLS one. Whichever is
  // registered wins, which keeps the answer a matter of the operator's list and
  // not of a guess here.
  const forwarded = firstHeaderValue(headers['x-forwarded-proto']).toLowerCase();
  const schemes = [...new Set([forwarded, 'https', 'http'].filter(Boolean))];
  for (const scheme of schemes) {
    const candidate = `${scheme}://${host}${path}`;
    const match = REDIRECT_URIS.find((uri) => callbackKey(uri) === callbackKey(candidate));
    if (match) return match;
  }
  return REDIRECT_URI;
}

// Password sign-in is the BREAK-GLASS path, not the default. Identity lives in
// Cerulean Authentik (the stack's IdentityOps platform); this control plane is
// SSO-only unless an operator explicitly re-enables the local fallback by
// setting BREAKGLASS_LOGIN=1 and restarting.
//
// The flag gates BOTH halves: the login/signup handlers refuse locally-issued
// sessions, and the admin console hides the password form. Recovery is: set
// BREAKGLASS_LOGIN=1, restart the control plane, sign in, then unset it.
export function localLoginEnabled() {
  const v = String(process.env.BREAKGLASS_LOGIN || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function oidcPublicConfig() {
  let host = null;
  try {
    host = ISSUER ? new URL(ISSUER).host : null;
  } catch {
    host = ISSUER || null;
  }
  return {
    enabled: oidcEnabled(),
    provider: 'Authentik',
    issuerHost: host,
    // Whether the password form is offered. False = Authentik only.
    localLogin: localLoginEnabled(),
    // True when the instance is SSO-only *and* OIDC is unusable — the console
    // must say so loudly instead of rendering a dead sign-in page.
    misconfigured: !localLoginEnabled() && !oidcEnabled(),
  };
}

async function discovery() {
  const now = Date.now();
  if (discoveryCache && now - discoveryAt < DISCOVERY_TTL_MS) return discoveryCache;
  const base = ISSUER.endsWith('/.well-known/openid-configuration')
    ? ISSUER
    : `${ISSUER}/.well-known/openid-configuration`;
  const res = await fetch(base, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`OIDC discovery failed (HTTP ${res.status})`);
  discoveryCache = await res.json();
  discoveryAt = now;
  return discoveryCache;
}

export async function oidcAuthorizeUrl(state, redirectUri = REDIRECT_URI) {
  const meta = await discovery();
  if (!meta.authorization_endpoint) throw new Error('OIDC discovery missing authorization_endpoint');
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function oidcExchangeCode(code, redirectUri = REDIRECT_URI) {
  const meta = await discovery();
  if (!meta.token_endpoint) throw new Error('OIDC discovery missing token_endpoint');
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    },
    body: params.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`token exchange failed (HTTP ${res.status}): ${body.slice(0, 160)}`);
  }
  const tokens = await res.json();
  if (!tokens.access_token) throw new Error('token exchange returned no access_token');
  return { accessToken: tokens.access_token, idToken: tokens.id_token || null };
}

export async function oidcUserinfo(accessToken) {
  const meta = await discovery();
  if (!meta.userinfo_endpoint) throw new Error('OIDC discovery missing userinfo_endpoint');
  const res = await fetch(meta.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`userinfo failed (HTTP ${res.status})`);
  return res.json();
}
