// Thin client over the OmniRoute dashboard API (see docs/gateway-api-inventory.md).
// Verified against v3.8.51: POST /api/auth/login, POST /api/keys.
//
// The dashboard URL is resolved via gateway discovery (env override →
// Consul → local compose fallback) when not passed explicitly.

import { resolveGatewayUrls } from './discovery.js';

export class GatewayClient {
  constructor({ dashboardUrl, adminPassword } = {}) {
    this.dashboardUrl = null; // resolved lazily on first use
    this._explicitDashboardUrl = dashboardUrl?.replace(/\/$/, '');
    this.adminPassword = adminPassword;
    this.cookie = null;
  }

  async #ensureDashboardUrl() {
    if (this.dashboardUrl) return;
    if (this._explicitDashboardUrl) {
      this.dashboardUrl = this._explicitDashboardUrl;
      return;
    }
    const resolved = await resolveGatewayUrls();
    this.dashboardUrl = resolved.dashboardUrl;
  }

  async #json(method, path, body) {
    await this.#ensureDashboardUrl();
    const res = await fetch(`${this.dashboardUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const message =
        data?.error?.message || data?.error || data?.message || text.slice(0, 200) || res.statusText;
      throw new Error(`gateway ${method} ${path} -> ${res.status}: ${message}`);
    }
    return { status: res.status, data };
  }

  async login() {
    if (!this.adminPassword) {
      throw new Error('GATEWAY_ADMIN_PASSWORD is not configured');
    }
    await this.#ensureDashboardUrl();
    const res = await fetch(`${this.dashboardUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: this.adminPassword }),
      redirect: 'manual',
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      throw new Error(`gateway login failed (${res.status}): ${text}`);
    }
    const setCookie = res.headers.get('set-cookie') || '';
    const match = setCookie.match(/(^|,\s*)([^=;]+=[^;]+)/);
    if (!match) throw new Error('gateway login did not return a session cookie');
    this.cookie = match[2];
    return this.cookie;
  }

  /**
   * The connection ids this gateway has switched on, or `null` if it would not say.
   *
   * `GET /api/providers` is the gateway's own answer to "which providers do I have",
   * and `allowedConnections` on a key is how that answer gets enforced. Measured
   * against v3.8.51: with it set, a router skips every provider outside the set —
   * `auto/best-free` went from `400 Felo thread creation failed` to
   * `503 all targets were skipped by pre-dispatch filters` — while an explicit model
   * from a connected provider still answers `200`. So a key minted here can only
   * ever spend on a provider this deployment connected, which is the rule the
   * account was granted under.
   *
   * A connection is switched on when the gateway says so, and a connection in
   * backoff, sitting out a rate limit, or switched off is not offered. `null` is
   * "could not tell" and every caller must read it as *do not scope*: minting must
   * not fail because a read-only route hiccuped, and an unscoped key is exactly the
   * behaviour that predates this.
   */
  async enabledConnectionIds() {
    try {
      const { data } = await this.#json('GET', '/api/providers');
      const rows = Array.isArray(data) ? data : data?.connections;
      if (!Array.isArray(rows)) return null;
      return rows
        .filter(
          (row) =>
            row &&
            row.isActive !== false &&
            !(typeof row.backoffLevel === 'number' && row.backoffLevel > 0) &&
            row.rateLimitProtection !== true,
        )
        .map((row) => row.id)
        .filter((id) => typeof id === 'string' && id.length > 0);
    } catch {
      return null;
    }
  }

  /**
   * Mint a key. Scoped to the connected providers unless the caller says otherwise.
   *
   * The scope is applied by default rather than by each caller because every key
   * this plane mints is spending somebody's provider credentials, and a caller that
   * forgets is a caller whose requests route to providers nobody connected. An empty
   * scope is *not* sent: on this gateway `allowedConnections: []` is how an unscoped
   * key is written, so sending it when no connections are readable would look like
   * an explicit nothing rather than the fail-open it is meant to be.
   */
  async createApiKey(name, { modelAccessMode = 'all', allowedConnections, dailyUsageLimitUsd, weeklyUsageLimitUsd } = {}) {
    const body = { name, modelAccessMode };
    const scope = allowedConnections === undefined ? await this.enabledConnectionIds() : allowedConnections;
    if (Array.isArray(scope) && scope.length > 0) body.allowedConnections = scope;
    if (dailyUsageLimitUsd !== undefined) body.dailyUsageLimitUsd = dailyUsageLimitUsd;
    if (weeklyUsageLimitUsd !== undefined) body.weeklyUsageLimitUsd = weeklyUsageLimitUsd;
    const { data } = await this.#json('POST', '/api/keys', body);
    return { id: data.id, key: data.key, name: data.name };
  }

  async listApiKeys() {
    const { data } = await this.#json('GET', '/api/keys');
    const keys = Array.isArray(data) ? data : data?.keys || [];
    return keys;
  }

  async revokeApiKey(id) {
    // Prefer the DELETE route; fall back to the v1 revoke surface.
    try {
      await this.#json('DELETE', `/api/keys/${encodeURIComponent(id)}`);
    } catch {
      await this.#json('POST', `/api/v1/registered-keys/${encodeURIComponent(id)}/revoke`);
    }
  }

  /**
   * The running gateway's version, as it reports it.
   *
   * `GET /api/system/version` is OmniRoute's own version route and, because it
   * is explicitly whitelisted for GET on the gateway's sign-in proxy, it is the
   * one route that answers whether or not the dashboard sits behind SSO. The
   * older health routes (`/api/monitoring/health`, `/api/health`) are tried
   * only as fallbacks: once the dashboard is fronted by oauth2-proxy they
   * redirect to the identity provider, so this plane reads an HTML sign-in page
   * instead of a version and the console shows `unknown`. No payload shape is
   * part of a contract this plane controls, so the read stays defensive: try
   * each route, without a session first and with one on a 401/403, and look for
   * the version under the names it has appeared under. `version: null` means the
   * gateway answered but did not say.
   *
   * @returns {Promise<{ version: string|null, buildSha: string|null, endpoint: string|null }>}
   */
  async version() {
    await this.#ensureDashboardUrl();
    let lastError = null;
    let answeredWithoutVersion = null;
    for (const path of ['/api/system/version', '/api/monitoring/health', '/api/health']) {
      try {
        let res = await fetch(`${this.dashboardUrl}${path}`, { headers: this.cookie ? { Cookie: this.cookie } : {} });
        if ((res.status === 401 || res.status === 403) && this.adminPassword) {
          await this.login();
          res = await fetch(`${this.dashboardUrl}${path}`, { headers: { Cookie: this.cookie } });
        }
        if (!res.ok) {
          lastError = new Error(`gateway GET ${path} -> ${res.status}`);
          continue;
        }
        let data = null;
        try {
          data = JSON.parse(await res.text());
        } catch {
          data = null;
        }
        const found = extractVersion(data);
        if (found.version) return { ...found, endpoint: path };
        // Answered, but did not say: remember it and let the next route try.
        answeredWithoutVersion = answeredWithoutVersion || { ...found, endpoint: path };
      } catch (err) {
        lastError = err;
      }
    }
    if (answeredWithoutVersion) return answeredWithoutVersion;
    throw new Error(`gateway version probe failed: ${lastError?.message || 'no health route answered'}`);
  }
}

/** Pull `{ version, buildSha }` out of whatever a health payload looks like. */
export function extractVersion(data) {
  const out = { version: null, buildSha: null };
  if (!data || typeof data !== 'object') return out;
  const candidates = [
    // `/api/system/version` reports the running release as `current`.
    data.current,
    data.version,
    data.appVersion,
    data.app_version,
    data.build?.version,
    data.app?.version,
    data.system?.version,
    data.info?.version,
  ];
  for (const c of candidates) {
    const v = normalizeVersion(c);
    if (v) {
      out.version = v;
      break;
    }
  }
  const sha = data.buildSha ?? data.build_sha ?? data.build?.sha ?? data.build?.commit ?? data.commit ?? null;
  if (typeof sha === 'string' && /^[0-9a-f]{7,40}$/i.test(sha.trim())) out.buildSha = sha.trim();
  return out;
}

/** `v3.8.51`, `3.8.51-web`, ` 3.8.51 ` → `3.8.51`; anything else → null. */
export function normalizeVersion(value) {
  if (value == null) return null;
  const match = String(value).trim().match(/^v?(\d+(?:\.\d+){1,3})/i);
  return match ? match[1] : null;
}
