import { hashPassword, verifyPassword } from './passwords.js';
import {
  createUser,
  userCount,
  getUserByEmail,
  getUserById,
  listUsers,
  updateUser,
  setGatewayKey,
  getGatewayKey,
  revokeGatewayKey,
  getQuota,
  upsertQuota,
  getUsageToday,
  userIsDisabled,
} from './db.js';
import { openSession, currentUser, closeSession, requireAdmin } from './auth.js';

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __invalid: true };
  }
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    disabled_at: u.disabled_at,
    created_at: u.created_at,
  };
}

export async function handler(req, res, { gateway }) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;
  const send = (status, body) => json(res, status, body);

  // CORS: the Distro web UI (option A) calls the control plane from the
  // browser to log in and fetch the user's gateway key. LAN installs set
  // CONTROL_CORS_ORIGIN to the Distro origin; default is permissive.
  res.setHeader('Access-Control-Allow-Origin', process.env.CONTROL_CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (method === 'OPTIONS') {
    return send(204, {});
  }

  // ---- health ----
  if (path === '/health' && method === 'GET') {
    return send(200, { ok: true, service: 'distro-control-plane' });
  }

  // ---- auth ----
  if (path === '/api/auth/signup' && method === 'POST') {
    const body = await readBody(req);
    if (body.__invalid) return send(400, { error: 'invalid JSON' });
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return send(400, { error: 'valid email required' });
    }
    if (password.length < 8) return send(400, { error: 'password must be at least 8 characters' });
    if (getUserByEmail(email)) return send(409, { error: 'email already registered' });

    // Bootstrap: the very first account is an admin. Otherwise role comes from
    // the ADMIN_EMAILS env list (comma-separated).
    const admins = (process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const role = userCount() === 0 || admins.includes(email) ? 'admin' : 'user';

    const user = createUser({ email, passwordHash: hashPassword(password), role });
    const quota = upsertQuota(user.id, { plan: body.plan || 'free' });

    // M2: mint one gateway API key for the user.
    let gatewayKey = null;
    try {
      await gateway.login();
      const key = await gateway.createApiKey(`distro-user-${user.id.slice(0, 8)}`, {
        // Hard spend cap on the gateway key (M3); daily/token caps need M4 sync.
        dailyUsageLimitUsd: quota.spend_cap_usd ?? undefined,
        weeklyUsageLimitUsd: quota.spend_cap_usd != null ? quota.spend_cap_usd * 7 : undefined,
      });
      gatewayKey = setGatewayKey(user.id, { gatewayKeyId: key.id, gatewayKey: key.key });
    } catch (err) {
      updateUser(user.id, { disabled_at: new Date().toISOString() });
      return send(502, { error: `gateway unreachable: ${err.message}` });
    }

    return send(201, { user: publicUser(user), quota });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const user = getUserByEmail(email);
    if (!user || userIsDisabled(user.id) || !verifyPassword(String(body.password || ''), user.password_hash)) {
      return send(401, { error: 'invalid credentials' });
    }
    return send(200, { token: openSession(user.id), user: publicUser(user) });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    closeSession(req);
    return send(204, {});
  }

  // ---- authenticated user routes ----
  const me = currentUser(req);
  if (!me) return send(401, { error: 'unauthorized' });

  if (path === '/api/me' && method === 'GET') {
    const key = getGatewayKey(me.id);
    return send(200, {
      user: publicUser(me),
      quota: getQuota(me.id),
      gatewayKeyPresent: !!key,
      usageToday: getUsageToday(me.id),
    });
  }

  if (path === '/api/me/gateway-key' && method === 'GET') {
    const key = getGatewayKey(me.id);
    if (!key) return send(404, { error: 'no gateway key; contact an admin' });
    // Option A: browser-held key. Distro stores only gateway-issued keys.
    return send(200, { gatewayKeyId: key.gateway_key_id, gatewayKey: key.gateway_key });
  }

  if (path === '/api/me/gateway-key/rotate' && method === 'POST') {
    const existing = getGatewayKey(me.id);
    try {
      await gateway.login();
      if (existing) await gateway.revokeApiKey(existing.gateway_key_id);
      const fresh = await gateway.createApiKey(`distro-user-${me.id.slice(0, 8)}`, {
        dailyUsageLimitUsd: getQuota(me.id).spend_cap_usd ?? undefined,
        weeklyUsageLimitUsd:
          getQuota(me.id).spend_cap_usd != null ? getQuota(me.id).spend_cap_usd * 7 : undefined,
      });
      const key = setGatewayKey(me.id, { gatewayKeyId: fresh.id, gatewayKey: fresh.key });
      return send(200, { gatewayKeyId: key.gateway_key_id, gatewayKey: key.gateway_key });
    } catch (err) {
      return send(502, { error: `gateway unreachable: ${err.message}` });
    }
  }

  if (path === '/api/me/usage' && method === 'GET') {
    // M4 stub: today's snapshot from usage_cache. Gateway usage sync lands in
    // the M4 milestone (see apps/control-plane/docs/roadmap.md).
    return send(200, { date: new Date().toISOString().slice(0, 10), ...getUsageToday(me.id) });
  }

  if (path === '/api/me/quota-status' && method === 'GET') {
    // Coarse pre-chat check (M3). Hard enforcement happens on the gateway via
    // the usage limits attached to the user's key.
    const quota = getQuota(me.id);
    const today = getUsageToday(me.id);
    const reasons = [];
    if (quota.requests_per_day != null && today.requests >= quota.requests_per_day) {
      reasons.push('daily request limit reached');
    }
    if (quota.tokens_per_day != null && today.tokens_in + today.tokens_out >= quota.tokens_per_day) {
      reasons.push('daily token limit reached');
    }
    if (quota.spend_cap_usd != null && today.cost_usd >= quota.spend_cap_usd) {
      reasons.push('spend cap reached');
    }
    return send(200, { allowed: reasons.length === 0, reasons, quota, usageToday: today });
  }

  // ---- admin routes ----
  const admin = requireAdmin(req);
  if (!admin) return send(403, { error: 'admin required' });

  if (path === '/api/admin/users' && method === 'GET') {
    const users = listUsers().map((u) => ({
      ...publicUser(u),
      quota: getQuota(u.id),
      hasGatewayKey: !!getGatewayKey(u.id),
    }));
    return send(200, { users });
  }

  const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
  const revokeMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/revoke-key$/);
  if (!userMatch && !revokeMatch) return send(404, { error: 'not found' });

  if (userMatch && method === 'PATCH') {
    const target = getUserById(decodeURIComponent(userMatch[1]));
    if (!target) return send(404, { error: 'user not found' });
    const body = await readBody(req);
    const fields = {};
    if (body.disabled !== undefined) {
      fields.disabled_at = body.disabled ? new Date().toISOString() : null;
    }
    if (fields.disabled_at || body.quota) {
      upsertQuota(target.id, {
        plan: body.quota?.plan,
        requests_per_day: body.quota?.requests_per_day,
        tokens_per_day: body.quota?.tokens_per_day,
        spend_cap_usd: body.quota?.spend_cap_usd,
      });
    }
    updateUser(target.id, fields);
    if (body.disabled && getGatewayKey(target.id)) {
      try {
        await gateway.login();
        await gateway.revokeApiKey(getGatewayKey(target.id).gateway_key_id);
        revokeGatewayKey(target.id);
      } catch (err) {
        return send(502, { error: `gateway unreachable: ${err.message}` });
      }
    }
    const updated = getUserById(target.id);
    return send(200, { user: publicUser(updated), quota: getQuota(updated.id) });
  }

  if (revokeMatch && method === 'POST') {
    const target = getUserById(decodeURIComponent(revokeMatch[1]));
    if (!target) return send(404, { error: 'user not found' });
    const key = getGatewayKey(target.id);
    if (!key) return send(404, { error: 'no gateway key for user' });
    try {
      await gateway.login();
      await gateway.revokeApiKey(key.gateway_key_id);
      revokeGatewayKey(target.id);
      return send(200, { revoked: true });
    } catch (err) {
      return send(502, { error: `gateway unreachable: ${err.message}` });
    }
  }

  return send(405, { error: 'method not allowed' });
}
