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
// (direct LAN mode).
export const CONTROL_PLANE_URL = ((import.meta.env.VITE_CONTROL_PLANE_URL as string | undefined) || '').replace(/\/+$/, '');

const TOKEN_KEY = 'distro_token';
const USER_KEY = 'distro_user';
const PROVIDER = 'OpenAILike'; // the OmniRoute gateway provider

export function controlPlaneBase(): string {
  if (typeof window === 'undefined') return '';
  if (CONTROL_PLANE_URL) return CONTROL_PLANE_URL;
  return `${window.location.protocol}//${window.location.hostname}:${CONTROL_PLANE_PORT}`;
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

export async function quotaStatus() {
  const token = getToken();
  if (!token) return { allowed: true, reasons: [] };
  return cpFetch('/api/me/quota-status', {
    headers: { Authorization: `Bearer ${token}` },
  });
}
