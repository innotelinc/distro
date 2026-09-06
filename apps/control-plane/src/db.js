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
    .run(
      quota.id || randomUUID(),
      userId,
      fields.plan ?? quota.plan,
      fields.requests_per_day ?? quota.requests_per_day,
      fields.tokens_per_day ?? quota.tokens_per_day,
      fields.spend_cap_usd ?? quota.spend_cap_usd,
    );
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
