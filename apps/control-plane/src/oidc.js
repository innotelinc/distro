// Authentik (OIDC) single sign-on for control-plane logins.
//
// Configure via env (see .env.example "Authentik SSO"):
//   OIDC_ISSUER_URL      Authentik application issuer, e.g.
//                        https://auth.example.com/application/o/distro/
//   OIDC_CLIENT_ID       Authentik OAuth2/OIDC provider client id
//   OIDC_CLIENT_SECRET   ... and secret
//   OIDC_REDIRECT_URI    Absolute callback URL this control plane is reachable
//                        at, e.g. https://app.example.com/cp/api/auth/oidc/callback
//                        (same origin as the app under the /cp proxy layout).
//
// Flow: the Distro login page opens the popup URL /api/auth/oidc/start
// (authorize redirect). Authentik redirects to /api/auth/oidc/callback where
// the code is exchanged server-side; the callback then posts the session back
// to the opener (window.opener.postMessage) and closes itself. No upstream
// secrets ever touch the browser.

const ISSUER = (process.env.OIDC_ISSUER_URL || '').trim().replace(/\/+$/, '');
const CLIENT_ID = (process.env.OIDC_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.OIDC_CLIENT_SECRET || '').trim();
const REDIRECT_URI = (process.env.OIDC_REDIRECT_URI || '').trim();
const TIMEOUT_MS = 15000;

let discoveryCache = null;
let discoveryAt = 0;
const DISCOVERY_TTL_MS = 5 * 60 * 1000;

export function oidcEnabled() {
  return Boolean(ISSUER && CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

export function oidcPublicConfig() {
  let host = null;
  try {
    host = ISSUER ? new URL(ISSUER).host : null;
  } catch {
    host = ISSUER || null;
  }
  return { enabled: oidcEnabled(), provider: 'Authentik', issuerHost: host };
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

export async function oidcAuthorizeUrl(state) {
  const meta = await discovery();
  if (!meta.authorization_endpoint) throw new Error('OIDC discovery missing authorization_endpoint');
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function oidcExchangeCode(code) {
  const meta = await discovery();
  if (!meta.token_endpoint) throw new Error('OIDC discovery missing token_endpoint');
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
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
