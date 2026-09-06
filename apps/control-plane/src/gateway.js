// Thin client over the OmniRoute dashboard API (see docs/gateway-api-inventory.md).
// Verified against v3.8.51: POST /api/auth/login, POST /api/keys.

const DEFAULT_DASHBOARD_URL = process.env.GATEWAY_DASHBOARD_URL || 'http://gateway:20128';

export class GatewayClient {
  constructor({ dashboardUrl = DEFAULT_DASHBOARD_URL, adminPassword } = {}) {
    this.dashboardUrl = dashboardUrl.replace(/\/$/, '');
    this.adminPassword = adminPassword;
    this.cookie = null;
  }

  async #json(method, path, body) {
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

  async createApiKey(name, { modelAccessMode = 'all', dailyUsageLimitUsd, weeklyUsageLimitUsd } = {}) {
    const body = { name, modelAccessMode };
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
}
