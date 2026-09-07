// Client-side helpers for the Distro control plane (option A: per-user
// gateway keys). Enabled at build time with VITE_DISTRO_CONTROL_PLANE=true.
// The control-plane base URL is derived from the page origin so it works from
// any host/LAN address that can reach the published control-plane port.
import Cookies from 'js-cookie';

export const CONTROL_PLANE_ENABLED = import.meta.env.VITE_DISTRO_CONTROL_PLANE === 'true';
export const CONTROL_PLANE_PORT = Number(import.meta.env.VITE_CONTROL_PLANE_PORT || 20140);

// Distro: when the app is fronted by a reverse proxy (e.g. nginx proxy
// manager) the control plane usually sits behind its own host/HTTPS rather
// than raw hostname:20140 — set VITE_CONTROL_PLANE_URL to that absolute base
// URL (scheme + host, optional path). Empty = derive from the page origin
// (see controlPlaneBase below).
export const CONTROL_PLANE_URL = ((import.meta.env.VITE_CONTROL_PLANE_URL as string | undefined) || '').replace(/\/+$/, '');

// Public HTTPS origin used by the origin-mode indicator's one-click link
// (e.g. https://app.example.com). Empty = hide the link unless it can be
// derived (same hostname over HTTPS).
export const PUBLIC_ORIGIN = ((import.meta.env.VITE_PUBLIC_ORIGIN as string | undefined) || '').replace(/\/+$/, '');

const TOKEN_KEY = 'distro_token';
const USER_KEY = 'distro_user';
const PROVIDER = 'OpenAILike'; // the OmniRoute gateway provider

export function isLocalHostname(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/** Which access mode the page is running in. The full shell (WebContainer
 *  preview/terminal) needs a trustworthy origin: HTTPS or localhost. Plain
 *  HTTP from a LAN IP/hostname is chat-only. */
export function pageOriginMode(): 'unknown' | 'local' | 'https' | 'insecure' {
  if (typeof window === 'undefined') return 'unknown';
  const { protocol, hostname } = window.location;
  if (isLocalHostname(hostname)) return 'local';
  return protocol === 'https:' ? 'https' : 'insecure';
}

/** Best-guess public HTTPS origin for the one-click link. An explicit
 *  VITE_PUBLIC_ORIGIN wins; otherwise the same hostname over HTTPS (only for
 *  hostnames — a bare IP usually has no certificate). */
export function httpsOriginHint(): string {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN;
  if (typeof window === 'undefined') return '';
  const h = window.location.hostname;
  if (!h || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return '';
  return `https://${h}`;
}

export function controlPlaneBase(): string {
  if (typeof window === 'undefined') return '';
  if (CONTROL_PLANE_URL) return CONTROL_PLANE_URL;
  const { protocol, hostname, origin } = window.location;
  // Proxied HTTPS host (reverse proxy, e.g. nginx proxy manager): the browser
  // cannot reach a raw :20140 port behind the proxy, so the control plane is
  // expected at the SAME origin under /cp (an NPM "advanced" location that
  // forwards /cp/ -> <host>:20140/, stripping the prefix). Same-origin means
  // no CORS is involved. Override with VITE_CONTROL_PLANE_URL for a separate
  // host layout.
  if (protocol === 'https:' && !isLocalHostname(hostname)) {
    return `${origin}/cp`;
  }
  // Direct LAN / localhost mode: the control-plane port is reachable directly.
  return `${protocol}//${hostname}:${CONTROL_PLANE_PORT}`;
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): Record<string, unknown> | null {
  if (typeof window === 'undefined') return null;
  try {
    return JSON.parse(window.localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

async function cpFetch(path: string, init: RequestInit = {}) {
  const base = controlPlaneBase();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
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
    throw new Error(data?.error || `request failed (${res.status})`);
  }
  return data;
}

export async function signUp(email: string, password: string) {
  const data = await cpFetch('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  window.localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  return data;
}

export async function logIn(email: string, password: string) {
  const data = await cpFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  window.localStorage.setItem(TOKEN_KEY, data.token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  return data;
}

/** Authentik popup callback: the control plane posts { token, user } back to
 *  the opener. Persist the session exactly like logIn, then adopt the user's
 *  gateway key so the workspace is ready. */
export async function finishOidcLogin(token: string, user: { role?: string; email?: string }) {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
  await adoptGatewayKey();
}

export function logOut() {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
  Cookies.remove('apiKeys');
}

/** Option A: fetch the user's gateway key and store it the way bolt.diy
 *  expects (the `apiKeys` cookie for the OpenAILike provider). */
export async function adoptGatewayKey(): Promise<string> {
  const token = getToken();
  if (!token) throw new Error('not logged in');
  const data = await cpFetch('/api/me/gateway-key', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!data.gatewayKey) throw new Error('no gateway key assigned');
  const existing: Record<string, string> = {};
  const raw = Cookies.get('apiKeys');
  if (raw) {
    try {
      Object.assign(existing, JSON.parse(raw));
    } catch {
      // ignore malformed cookie
    }
  }
  existing[PROVIDER] = data.gatewayKey;
  Cookies.set('apiKeys', JSON.stringify(existing), { expires: 7 });
  return data.gatewayKey;
}

export async function oidcConfig() {
  const res = await fetch(`${controlPlaneBase()}/api/auth/oidc/config`);
  if (!res.ok) return { enabled: false };
  try {
    const data: any = await res.json();
    return { enabled: !!data.enabled, provider: data.provider || 'Authentik' };
  } catch {
    return { enabled: false };
  }
}

export async function quotaStatus() {
  const token = getToken();
  if (!token) return { allowed: true, reasons: [] };
  return cpFetch('/api/me/quota-status', {
    headers: { Authorization: `Bearer ${token}` },
  });
}
