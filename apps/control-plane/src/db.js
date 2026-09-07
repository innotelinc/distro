import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

let db = null;

export function openDb(path = process.env.CONTROL_DB_PATH || join(here, '..', 'data', 'control.sqlite')) {
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = readFileSync(join(here, '..', 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}

export function getDb() {
  if (!db) {
    openDb();
  }
  return db;
}

// ── users ────────────────────────────────────────────────────────────────
export function userCount() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function createUser({ email, passwordHash, role }) {
  const id = randomUUID();
  getDb()
    .prepare(
      'INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)',
    )
    .run(id, email.toLowerCase(), passwordHash, role);
  return getUserById(id);
}

export function getUserByEmail(email) {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
}

export function getUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function listUsers() {
  return getDb().prepare('SELECT * FROM users ORDER BY created_at').all();
}

export function updateUser(id, fields) {
  const set = [];
  const params = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (key === 'role' || key === 'email') continue; // role/email managed elsewhere
    set.push(`${key} = ?`);
    params.push(value === null ? null : typeof value === 'string' ? value : JSON.stringify(value));
  }
  if (set.length === 0) return getUserById(id);
  getDb().prepare(`UPDATE users SET ${set.join(', ')} WHERE id = ?`).run(...params, id);
  return getUserById(id);
}

export function userIsDisabled(id) {
  const row = getUserById(id);
  return !row || !!row.disabled_at;
}

export function setUserRole(id, role) {
  if (role !== 'admin' && role !== 'user') throw new Error('invalid role');
  getDb().prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  return getUserById(id);
}

export function deleteUser(id) {
  // gateway_keys/quotas/usage_cache/sessions cascade via FK ON DELETE CASCADE
  getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
}

// ── sessions ─────────────────────────────────────────────────────────────
export function createSession(userId, tokenHash, expiresAt) {
  const id = randomUUID();
  getDb()
    .prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
    .run(id, userId, tokenHash, expiresAt);
  return id;
}

export function getUserBySession(tokenHash) {
  const row = getDb()
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.disabled_at IS NULL`,
    )
    .get(tokenHash);
  return row || null;
}

export function deleteSession(tokenHash) {
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

// ── gateway keys (one per user) ──────────────────────────────────────────
export function setGatewayKey(userId, { gatewayKeyId, gatewayKey, label = 'default' }) {
  getDb()
    .prepare(
      `INSERT INTO gateway_keys (id, user_id, gateway_key_id, gateway_key, label)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, label) DO UPDATE SET
         gateway_key_id = excluded.gateway_key_id,
         gateway_key = excluded.gateway_key,
         revoked_at = NULL`,
    )
    .run(randomUUID(), userId, gatewayKeyId, gatewayKey, label);
  return getGatewayKey(userId, label);
}

export function getGatewayKey(userId, label = 'default') {
  return getDb()
    .prepare(
      `SELECT * FROM gateway_keys
       WHERE user_id = ? AND label = ? AND revoked_at IS NULL`,
    )
    .get(userId, label);
}

export function revokeGatewayKey(userId, label = 'default') {
  getDb()
    .prepare(
      `UPDATE gateway_keys SET revoked_at = datetime('now')
       WHERE user_id = ? AND label = ? AND revoked_at IS NULL`,
    )
    .run(userId, label);
}

/** Resolve an active user from their plaintext gateway key (used by the web
 *  app's server-side quota middleware, which only ever sees the key from the
 *  apiKeys cookie — never a CP session token). */
export function getUserByGatewayKey(gatewayKey) {
  if (!gatewayKey) return null;
  return (
    getDb()
      .prepare(
        `SELECT u.* FROM gateway_keys k JOIN users u ON u.id = k.user_id
         WHERE k.gateway_key = ? AND k.revoked_at IS NULL AND u.disabled_at IS NULL`,
      )
      .get(gatewayKey) || null
  );
}

export function touchGatewayKey(userId, label = 'default') {
  getDb()
    .prepare(
      `UPDATE gateway_keys SET last_used_at = datetime('now')
       WHERE user_id = ? AND label = ? AND revoked_at IS NULL`,
    )
    .run(userId, label);
}

export function recordUsage(userId, { date, tokensIn = 0, tokensOut = 0, requests = 0, costUsd = 0 }) {
  const day = date || new Date().toISOString().slice(0, 10);
  getDb()
    .prepare(
      `INSERT INTO usage_cache (user_id, date, tokens_in, tokens_out, requests, cost_usd, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (user_id, date) DO UPDATE SET
         tokens_in = tokens_in + excluded.tokens_in,
         tokens_out = tokens_out + excluded.tokens_out,
         requests = requests + excluded.requests,
         cost_usd = cost_usd + excluded.cost_usd,
         updated_at = datetime('now')`,
    )
    .run(userId, day, Math.max(0, tokensIn), Math.max(0, tokensOut), Math.max(0, requests), Math.max(0, costUsd));
  return getUsageToday(userId);
}

// ── quotas + usage cache ────────────────────────────────────────────────
export function getQuota(userId) {
  return (
    getDb().prepare('SELECT * FROM quotas WHERE user_id = ?').get(userId) || {
      user_id: userId,
      plan: 'free',
      requests_per_day: null,
      tokens_per_day: null,
      spend_cap_usd: null,
    }
  );
}

export function upsertQuota(userId, fields) {
  const quota = getQuota(userId);
  // undefined = leave unchanged; explicit null = clear the limit.
  const plan = fields.plan === undefined ? quota.plan : fields.plan;
  const rpd = fields.requests_per_day === undefined ? quota.requests_per_day : fields.requests_per_day;
  const tpd = fields.tokens_per_day === undefined ? quota.tokens_per_day : fields.tokens_per_day;
  const cap = fields.spend_cap_usd === undefined ? quota.spend_cap_usd : fields.spend_cap_usd;
  getDb()
    .prepare(
      `INSERT INTO quotas (id, user_id, plan, requests_per_day, tokens_per_day, spend_cap_usd)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         plan = excluded.plan,
         requests_per_day = excluded.requests_per_day,
         tokens_per_day = excluded.tokens_per_day,
         spend_cap_usd = excluded.spend_cap_usd,
         updated_at = datetime('now')`,
    )
    .run(quota.id || randomUUID(), userId, plan, rpd, tpd, cap);
  return getQuota(userId);
}

export function getUsageToday(userId) {
  return (
    getDb()
      .prepare(
        `SELECT * FROM usage_cache
         WHERE user_id = ? AND date = date('now')`,
      )
      .get(userId) || { tokens_in: 0, tokens_out: 0, requests: 0, cost_usd: 0 }
  );
}
