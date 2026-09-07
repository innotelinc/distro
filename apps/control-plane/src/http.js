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
  usageFor,
  usageAll,
  userIsDisabled,
  getUserByGatewayKey,
  touchGatewayKey,
  recordUsage,
  setUserRole,
  deleteUser,
  logAudit,
  listAudit,
  listAlerts,
} from './db.js';
import { openSession, currentUser, closeSession, requireAdmin } from './auth.js';
import { alert, alertsConfig } from './alerts.js';
import { estimateCostUsd } from './pricing.js';
import { randomBytes } from 'node:crypto';
import {
  oidcEnabled,
  oidcPublicConfig,
  oidcAuthorizeUrl,
  oidcExchangeCode,
  oidcUserinfo,
} from './oidc.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { magnateConfigured, checkEntitlement, listPlans } from './billing.js';

const here = dirname(fileURLToPath(import.meta.url));

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

  function quotaDecision(userId) {
    const quota = getQuota(userId);
    const today = getUsageToday(userId);
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
    return { allowed: reasons.length === 0, reasons, quota, usageToday: today };
  }

  async function userFromGatewayKey(req) {
    const header = req.headers.authorization || '';
    const key = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!key) return null;
    const user = getUserByGatewayKey(key);
    if (!user) return null;
    touchGatewayKey(user.id);
    return user;
  }

  // ---- admin console (public shell; data requires the admin API) ----
  if ((path === '/admin' || path === '/admin/') && method === 'GET') {
    const html = readFileSync(join(here, 'admin.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // CORS: the Distro web UI (option A) calls the control plane from the
  // browser to log in and fetch the user's gateway key. Set
  // CONTROL_CORS_ORIGIN to the Distro origin to lock cross-origin calls to
  // that origin (default is permissive '*'). When locked, the allow-origin
  // header is only emitted for a matching request Origin, so browsers from
  // any other origin get no CORS grant (non-browser clients are unaffected).
  const corsOrigin = process.env.CONTROL_CORS_ORIGIN || '*';
  const reqOrigin = req.headers.origin;
  if (corsOrigin === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (reqOrigin && reqOrigin === corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (method === 'OPTIONS') {
    // Preflight from a non-allowed origin must not get a CORS grant; respond
    // 403 so the browser fails the request visibly.
    if (corsOrigin !== '*' && (!reqOrigin || reqOrigin !== corsOrigin)) {
      return send(403, { error: 'origin not allowed' });
    }
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

    logAudit({ action: 'user.signup', targetId: user.id, targetEmail: user.email, meta: { role, plan: quota.plan, gatewayKeyId: gatewayKey?.gateway_key_id || null } });

    return send(201, { user: publicUser(user), quota });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const user = getUserByEmail(email);
    if (user && String(user.password_hash || '').startsWith('sso:')) {
      return send(401, { error: 'This account signs in with Authentik — use "Continue with Authentik" below.' });
    }
    if (!user || userIsDisabled(user.id) || !verifyPassword(String(body.password || ''), user.password_hash)) {
      return send(401, { error: 'invalid credentials' });
    }
    return send(200, { token: openSession(user.id), user: publicUser(user) });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    closeSession(req);
    return send(204, {});
  }

  // ---- Authentik (OIDC) SSO ----
  if (path === '/api/auth/oidc/config' && method === 'GET') {
    return send(200, oidcPublicConfig());
  }

  if (path === '/api/auth/oidc/start' && method === 'GET') {
    if (!oidcEnabled()) return send(404, { error: 'OIDC sign-in is not configured' });
    const state = randomBytes(16).toString('hex');
    let authorizeUrl;
    try {
      authorizeUrl = await oidcAuthorizeUrl(state);
    } catch (err) {
      console.warn('[oidc] authorize URL failed:', err?.message || err);
      return send(502, { error: `Authentik unreachable: ${err?.message || err}` });
    }
    res.writeHead(302, {
      Location: authorizeUrl,
      'Set-Cookie': `distro_oidc_state=${state}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax`,
    });
    return res.end();
  }

  if (path === '/api/auth/oidc/callback' && method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    const cookieState = (req.headers.cookie || '').match(/(?:^|;\s*)distro_oidc_state=([^;]+)/)?.[1] || '';
    res.setHeader('Set-Cookie', 'distro_oidc_state=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    const html = (message) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sign-in</title></head><body style="font-family:system-ui;background:#0b0f1a;color:#e6edf7;display:grid;place-items:center;height:100vh;margin:0"><p>${message}</p></body></html>`;
    const htmlResp = (status, message) => {
      const buf = Buffer.from(html(message));
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
      return res.end(buf);
    };
    if (!code || !state || state !== cookieState) {
      return htmlResp(400, 'Sign-in failed: invalid or expired state. Close this window and try again.');
    }
    if (!oidcEnabled()) return htmlResp(404, 'Sign-in with Authentik is not configured on this instance.');

    let profile;
    try {
      const { accessToken } = await oidcExchangeCode(code);
      profile = await oidcUserinfo(accessToken);
    } catch (err) {
      console.warn('[oidc] exchange/userinfo failed:', err?.message || err);
      return htmlResp(502, 'Sign-in failed: Authentik did not complete the exchange. Close this window and try again.');
    }
    const email = String(profile.email || '').trim().toLowerCase();
    if (!email) return htmlResp(400, 'Sign-in failed: Authentik returned no email address.');

    let user = getUserByEmail(email);
    let isNew = false;
    if (!user) {
      isNew = true;
      const admins = (process.env.ADMIN_EMAILS || '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      const role = userCount() === 0 || admins.includes(email) ? 'admin' : 'user';
      user = createUser({ email, passwordHash: `sso:${randomBytes(18).toString('hex')}`, role });
      const quota = upsertQuota(user.id, { plan: 'free' });
      try {
        await gateway.login();
        const key = await gateway.createApiKey(`distro-user-${user.id.slice(0, 8)}`, {
          dailyUsageLimitUsd: quota.spend_cap_usd ?? undefined,
          weeklyUsageLimitUsd: quota.spend_cap_usd != null ? quota.spend_cap_usd * 7 : undefined,
        });
        setGatewayKey(user.id, { gatewayKeyId: key.id, gatewayKey: key.key });
      } catch (err) {
        updateUser(user.id, { disabled_at: new Date().toISOString() });
        console.warn('[oidc] gateway provisioning failed for', email, ':', err?.message || err);
        return htmlResp(502, 'Sign-in failed: could not provision a gateway key for the new account. Contact the administrator.');
      }
      logAudit({ action: 'user.oidc-signup', targetId: user.id, targetEmail: email, meta: { provider: 'Authentik', role } });
    }
    if (userIsDisabled(user.id)) return htmlResp(403, 'Sign-in failed: this account is disabled.');
    if (!isNew) logAudit({ action: 'user.oidc-login', targetId: user.id, targetEmail: email, meta: { provider: 'Authentik' } });
    const token = openSession(user.id);
    const payload = JSON.stringify({ token, user: publicUser(user) })
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e');
    const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Signed in</title></head><body><script>const d=${payload};window.opener&&window.opener.postMessage({source:'distro-oidc',token:d.token,user:d.user},'*');window.close();</script><noscript><p style="font-family:system-ui">Signed in — close this window and return to Distro.</p></noscript></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page);
  }

  // ---- internal routes (auth by gateway key, called server-side by the web
  //      app's quota middleware — never exposed to browser JS) ----
  if (path === '/api/internal/quota-check' && method === 'GET') {
    const user = await userFromGatewayKey(req);
    if (!user) return send(401, { error: 'unknown or revoked gateway key' });
    const decision = quotaDecision(user.id);
    if (!decision.allowed) {
      void alert(`quota.denied:${user.id.slice(0, 8)}`, {
        title: 'User hit a daily quota limit',
        message: `${user.email} was blocked (${decision.reasons.join(', ')}).`,
        meta: { userId: user.id, reasons: decision.reasons, quota: decision.quota, usageToday: decision.usageToday },
      });
    }
    return send(200, { user: publicUser(user), ...decision });
  }

  if (path === '/api/internal/usage-report' && method === 'POST') {
    const user = await userFromGatewayKey(req);
    if (!user) return send(401, { error: 'unknown or revoked gateway key' });
    const body = await readBody(req);
    if (body.__invalid) return send(400, { error: 'invalid JSON' });
    const tokensIn = Number(body.tokensIn) || 0;
    const tokensOut = Number(body.tokensOut) || 0;
    const usage = recordUsage(user.id, {
      tokensIn,
      tokensOut,
      requests: Math.max(1, Number(body.requests) || 1),
      costUsd: body.model ? estimateCostUsd(String(body.model), tokensIn, tokensOut) : Number(body.costUsd) || 0,
    });
    return send(200, { ok: true, usageToday: usage });
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
      logAudit({ action: 'key.rotate', actorId: me.id, actorEmail: me.email, targetId: me.id, targetEmail: me.email, meta: { gatewayKeyId: key.gateway_key_id } });
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
    // Coarse pre-chat check (M3): same decision the web app enforces
    // server-side via /api/internal/quota-check.
    return send(200, quotaDecision(me.id));
  }

  // ---- billing (Magnate integration) ----
  if (path === '/api/billing/entitlements' && method === 'GET') {
    const result = await checkEntitlement(me.email);
    return send(200, result);
  }

  if (path === '/api/billing/plans' && method === 'GET') {
    const plans = await listPlans();
    return send(200, { plans, magnate_configured: magnateConfigured() });
  }

  if (path === '/api/billing/checkout' && method === 'POST') {
    if (!magnateConfigured()) return send(400, { error: 'billing not configured (MAGNATE_URL)' });
    const body = await readBody(req);
    if (body.__invalid) return send(400, { error: 'invalid JSON' });
    const planSlug = String(body.planSlug || '').trim();
    const interval = body.interval === 'year' ? 'year' : 'month';
    if (!planSlug) return send(400, { error: 'planSlug required' });

    // Forward to Magnate checkout, passing the Distro user's email.
    const params = { planSlug, interval, email: me.email, username: me.email.split('@')[0] };
    try {
      const res = await fetch(`${process.env.MAGNATE_URL.replace(/\/+$/, '')}/api/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.MAGNATE_ENTITLEMENTS_TOKEN ? { Authorization: `Bearer ${process.env.MAGNATE_ENTITLEMENTS_TOKEN}` } : {}),
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      if (!res.ok) return send(res.status, data);
      return send(200, data);
    } catch (err) {
      return send(502, { error: `magnate unreachable: ${err?.message || err}` });
    }
  }

  // ---- admin routes ----
  const admin = requireAdmin(req);
  if (!admin) return send(403, { error: 'admin required' });

  if (path === '/api/admin/users' && method === 'GET') {
    const users = listUsers().map((u) => {
      const key = getGatewayKey(u.id);
      return {
        ...publicUser(u),
        quota: getQuota(u.id),
        usageToday: getUsageToday(u.id),
        usage7d: usageFor(u.id, 7),
        hasGatewayKey: !!key,
        gatewayKeyId: key?.gateway_key_id || null,
      };
    });
    return send(200, { users });
  }

  if (path === '/api/admin/stats' && method === 'GET') {
    const users = listUsers();
    const totals = users.reduce(
      (acc, u) => {
        const t = getUsageToday(u.id);
        acc.requests += t.requests;
        acc.tokensIn += t.tokens_in;
        acc.tokensOut += t.tokens_out;
        acc.costUsd += t.cost_usd;
        return acc;
      },
      { users: users.length, active: users.filter((u) => !u.disabled_at).length, requests: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
    );
    const week = usageAll(7);
    return send(200, {
      date: new Date().toISOString().slice(0, 10),
      ...totals,
      week: { requests: week.requests, tokensIn: week.tokens_in, tokensOut: week.tokens_out, costUsd: week.cost_usd },
      alerting: alertsConfig(),
      billing: { magnate_configured: magnateConfigured() },
    });
  }

  if (path === '/api/admin/audit' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit')) || 200;
    return send(200, { entries: listAudit(limit) });
  }

  if (path === '/api/admin/alerts' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit')) || 100;
    return send(200, { entries: listAlerts(limit) });
  }

  const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
  const revokeMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/revoke-key$/);
  const rotateMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/rotate-key$/);
  if (!userMatch && !revokeMatch && !rotateMatch) return send(404, { error: 'not found' });

  if (userMatch && method === 'PATCH') {
    const target = getUserById(decodeURIComponent(userMatch[1]));
    if (!target) return send(404, { error: 'user not found' });
    const body = await readBody(req);
    const fields = {};
    if (body.disabled !== undefined) {
      fields.disabled_at = body.disabled ? new Date().toISOString() : null;
    }
    if (body.role === 'admin' || body.role === 'user') {
      const admins = listUsers().filter((u) => u.role === 'admin' && !u.disabled_at);
      const demotingLastAdmin =
        target.role === 'admin' && body.role === 'user' && admins.length === 1 && admins[0].id === target.id;
      if (demotingLastAdmin) return send(400, { error: 'cannot demote the last active admin' });
      setUserRole(target.id, body.role);
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
    logAudit({
      action: 'user.update',
      actorId: admin.id,
      actorEmail: admin.email,
      targetId: target.id,
      targetEmail: target.email,
      meta: {
        disabled: body.disabled !== undefined ? body.disabled : undefined,
        role: body.role || undefined,
        quota: body.quota || undefined,
      },
    });
    return send(200, { user: publicUser(updated), quota: getQuota(updated.id) });
  }

  if (userMatch && method === 'DELETE') {
    const target = getUserById(decodeURIComponent(userMatch[1]));
    if (!target) return send(404, { error: 'user not found' });
    if (target.role === 'admin') {
      const admins = listUsers().filter((u) => u.role === 'admin' && !u.disabled_at);
      if (admins.length === 1 && admins[0].id === target.id) {
        return send(400, { error: 'cannot delete the last active admin' });
      }
    }
    const key = getGatewayKey(target.id);
    if (key) {
      try {
        await gateway.login();
        await gateway.revokeApiKey(key.gateway_key_id);
      } catch (err) {
        return send(502, { error: `gateway unreachable: ${err.message}` });
      }
    }
    logAudit({ action: 'user.delete', actorId: admin.id, actorEmail: admin.email, targetId: target.id, targetEmail: target.email, meta: { gatewayKeyId: key?.gateway_key_id || null } });
    deleteUser(target.id);
    return send(200, { deleted: true, id: target.id });
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
      logAudit({ action: 'key.revoke', actorId: admin.id, actorEmail: admin.email, targetId: target.id, targetEmail: target.email, meta: { gatewayKeyId: key.gateway_key_id } });
      return send(200, { revoked: true });
    } catch (err) {
      return send(502, { error: `gateway unreachable: ${err.message}` });
    }
  }

  if (rotateMatch && method === 'POST') {
    const target = getUserById(decodeURIComponent(rotateMatch[1]));
    if (!target) return send(404, { error: 'user not found' });
    const existing = getGatewayKey(target.id);
    if (!existing) return send(404, { error: 'no gateway key for user' });
    const quota = getQuota(target.id);
    try {
      await gateway.login();
      await gateway.revokeApiKey(existing.gateway_key_id);
      const fresh = await gateway.createApiKey(`distro-user-${target.id.slice(0, 8)}`, {
        dailyUsageLimitUsd: quota.spend_cap_usd ?? undefined,
        weeklyUsageLimitUsd: quota.spend_cap_usd != null ? quota.spend_cap_usd * 7 : undefined,
      });
      const key = setGatewayKey(target.id, { gatewayKeyId: fresh.id, gatewayKey: fresh.key });
      logAudit({ action: 'key.rotate', actorId: admin.id, actorEmail: admin.email, targetId: target.id, targetEmail: target.email, meta: { from: existing.gateway_key_id, to: key.gateway_key_id } });
      return send(200, { rotated: true, gatewayKeyId: key.gateway_key_id });
    } catch (err) {
      return send(502, { error: `gateway unreachable: ${err.message}` });
    }
  }

  return send(405, { error: 'method not allowed' });
}
