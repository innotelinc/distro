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
  migrate(db);
  return db;
}

/**
 * Columns added after a database may exist already.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing database, so a column
 * added to schema.sql lands on fresh installs and nowhere else. Each step here
 * is idempotent — it reads the table's columns first — so running it on every
 * boot is the migration: there is no version table to fall out of date.
 *
 * It runs AFTER schema.sql, which is why an index over a new column belongs
 * here and not there: on a database that predates the column, schema.sql's
 * `CREATE INDEX` would run before the `ALTER TABLE` and fail the boot on exactly
 * the deployments the migration exists for. (The legacy-schema test in
 * `test/internal-api.test.mjs` pins this.)
 */
function migrate(database) {
  const columns = new Set(database.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!columns.has('oidc_sub')) {
    database.exec('ALTER TABLE users ADD COLUMN oidc_sub TEXT');
  }
  // Partial, so the many rows with no subject are not competing for one NULL slot.
  database.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc_sub ON users(oidc_sub) WHERE oidc_sub IS NOT NULL',
  );

  // Build plane (M7): a builds/day quota and the counter it is judged against.
  const quotaColumns = new Set(database.prepare('PRAGMA table_info(quotas)').all().map((c) => c.name));
  if (!quotaColumns.has('builds_per_day')) {
    database.exec('ALTER TABLE quotas ADD COLUMN builds_per_day INTEGER');
  }
  const usageColumns = new Set(database.prepare('PRAGMA table_info(usage_cache)').all().map((c) => c.name));
  if (!usageColumns.has('builds')) {
    database.exec('ALTER TABLE usage_cache ADD COLUMN builds INTEGER NOT NULL DEFAULT 0');
  }
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

/**
 * The account bound to an Authentik subject, or undefined.
 *
 * This is the lookup a sibling platform's `sub` resolves through: identity
 * comes from Cerulean's Authentik (one IdP), the account and its per-user
 * gateway key live here (one tenancy layer), and this column is the one join
 * between them.
 */
export function getUserByOidcSub(sub) {
  const value = String(sub || '').trim();
  if (!value) return undefined;
  return getDb().prepare('SELECT * FROM users WHERE oidc_sub = ?').get(value);
}

/** Bind an account to a subject. Throws on a subject already bound elsewhere. */
export function setUserOidcSub(id, sub) {
  getDb().prepare('UPDATE users SET oidc_sub = ? WHERE id = ?').run(String(sub).trim(), id);
  return getUserById(id);
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

// ── audit log ────────────────────────────────────────────────────────────
export function logAudit({ actorId = null, actorEmail = null, action, targetId = null, targetEmail = null, meta = null }) {
  getDb()
    .prepare(
      `INSERT INTO audit_log (actor_id, actor_email, action, target_id, target_email, meta)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(actorId, actorEmail, action, targetId, targetEmail, meta ? JSON.stringify(meta) : null);
}

/**
 * Latest audit rows, newest first.
 *
 * `actionPrefix` narrows to one namespace (`build.` is the build plane: rows
 * Studio writes through `/api/internal/audit`). `userId` narrows to rows the
 * account either performed or was the target of — build rows carry the
 * account as the actor (resolved from the Authentik `sub`), admin actions
 * carry it as the target, and a per-user view wants both.
 */
export function listAudit(limit = 200, { actionPrefix = null, userId = null } = {}) {
  const where = [];
  const params = [];
  if (actionPrefix) {
    // LIKE with an escape so a `_`/`%` in the prefix cannot widen the match.
    where.push("action LIKE ? ESCAPE '\\'");
    params.push(`${String(actionPrefix).replace(/[\\%_]/g, '\\$&')}%`);
  }
  if (userId) {
    where.push('(actor_id = ? OR target_id = ?)');
    params.push(userId, userId);
  }
  const sql =
    'SELECT * FROM audit_log' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY id DESC LIMIT ?';
  return getDb()
    .prepare(sql)
    .all(...params, Math.max(1, Math.min(1000, limit)))
    .map((row) => ({
      ...row,
      meta: row.meta ? safeJsonParse(row.meta) : null,
    }));
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
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

/** Resolve the active user owning a gateway key id (M4 sync: the gateway's
 *  usage_history.api_key_id ↔ our gateway_keys.gateway_key_id). */
export function getUserByGatewayKeyId(keyId) {
  if (!keyId) return null;
  return (
    getDb()
      .prepare(
        `SELECT u.* FROM gateway_keys k JOIN users u ON u.id = k.user_id
         WHERE k.gateway_key_id = ? AND k.revoked_at IS NULL AND u.disabled_at IS NULL`,
      )
      .get(keyId) || null
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

export function recordUsage(userId, { date, tokensIn = 0, tokensOut = 0, requests = 0, costUsd = 0, model = null }) {
  const day = date || new Date().toISOString().slice(0, 10);
  const values = [Math.max(0, tokensIn), Math.max(0, tokensOut), Math.max(0, requests), Math.max(0, costUsd)];
  const database = getDb();
  database.transaction(() => {
    database
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
      .run(userId, day, ...values);
    // The per-model breakdown only when the caller named a model: a row under
    // '' would just be the total again.
    if (model) {
      database
        .prepare(
          `INSERT INTO usage_models (user_id, date, model, tokens_in, tokens_out, requests, cost_usd, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT (user_id, date, model) DO UPDATE SET
             tokens_in = tokens_in + excluded.tokens_in,
             tokens_out = tokens_out + excluded.tokens_out,
             requests = requests + excluded.requests,
             cost_usd = cost_usd + excluded.cost_usd,
             updated_at = datetime('now')`,
        )
        .run(userId, day, String(model).slice(0, 200), ...values);
    }
  })();
  return getUsageToday(userId);
}

// ── per-model usage (M6) ───────────────────────────────────────────────────
/** Today's rows for one user, biggest spender first. */
export function getModelUsageToday(userId) {
  return getDb()
    .prepare(
      `SELECT model, tokens_in, tokens_out, requests, cost_usd
       FROM usage_models WHERE user_id = ? AND date = date('now')
       ORDER BY cost_usd DESC, requests DESC, model`,
    )
    .all(userId);
}

/** Per-model totals across all users over the last `days` days (inclusive of today). */
export function modelUsageAll(days = 1) {
  return getDb()
    .prepare(
      `SELECT model,
              COALESCE(SUM(tokens_in), 0)  AS tokens_in,
              COALESCE(SUM(tokens_out), 0) AS tokens_out,
              COALESCE(SUM(requests), 0)   AS requests,
              COALESCE(SUM(cost_usd), 0)   AS cost_usd,
              COUNT(DISTINCT user_id)      AS users
       FROM usage_models
       WHERE date >= date('now', ?)
       GROUP BY model
       ORDER BY cost_usd DESC, requests DESC, model`,
    )
    .all(`-${Math.max(1, days) - 1} days`);
}

/** M6 sync: the gateway's per-(key, model) rows become today's breakdown for
 *  this user — replaced wholesale, like usage_cache, because the ledger saw
 *  every call under the key. Rows without a model are folded under ''. */
export function replaceModelUsageFromGateway(userId, rows) {
  const day = new Date().toISOString().slice(0, 10);
  const database = getDb();
  database.transaction(() => {
    database.prepare('DELETE FROM usage_models WHERE user_id = ? AND date = ?').run(userId, day);
    const insert = database.prepare(
      `INSERT INTO usage_models (user_id, date, model, tokens_in, tokens_out, requests, cost_usd, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (user_id, date, model) DO UPDATE SET
         tokens_in = tokens_in + excluded.tokens_in,
         tokens_out = tokens_out + excluded.tokens_out,
         requests = requests + excluded.requests,
         cost_usd = cost_usd + excluded.cost_usd,
         updated_at = datetime('now')`,
    );
    for (const row of rows) {
      insert.run(
        userId,
        day,
        String(row.model || '').slice(0, 200),
        Math.max(0, Number(row.tokensIn) || 0),
        Math.max(0, Number(row.tokensOut) || 0),
        Math.max(0, Number(row.requests) || 0),
        Math.max(0, Number(row.costUsd) || 0),
      );
    }
  })();
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
      builds_per_day: null,
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
  const bpd = fields.builds_per_day === undefined ? quota.builds_per_day : fields.builds_per_day;
  getDb()
    .prepare(
      `INSERT INTO quotas (id, user_id, plan, requests_per_day, tokens_per_day, spend_cap_usd, builds_per_day)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         plan = excluded.plan,
         requests_per_day = excluded.requests_per_day,
         tokens_per_day = excluded.tokens_per_day,
         spend_cap_usd = excluded.spend_cap_usd,
         builds_per_day = excluded.builds_per_day,
         updated_at = datetime('now')`,
    )
    .run(quota.id || randomUUID(), userId, plan, rpd, tpd, cap, bpd);
  return getQuota(userId);
}

/** Build plane (M7): one consumed build.start against today. Only this counter
 *  moves — the model calls the build then makes arrive as usage reports / the
 *  ledger sync like any other traffic under the user's key. */
export function recordBuild(userId) {
  const day = new Date().toISOString().slice(0, 10);
  getDb()
    .prepare(
      `INSERT INTO usage_cache (user_id, date, builds, updated_at)
       VALUES (?, ?, 1, datetime('now'))
       ON CONFLICT (user_id, date) DO UPDATE SET
         builds = builds + 1,
         updated_at = datetime('now')`,
    )
    .run(userId, day);
  return getUsageToday(userId);
}

export function getUsageToday(userId) {
  return (
    getDb()
      .prepare(
        `SELECT * FROM usage_cache
         WHERE user_id = ? AND date = date('now')`,
      )
      .get(userId) || { tokens_in: 0, tokens_out: 0, requests: 0, cost_usd: 0, builds: 0 }
  );
}

/** Rolling usage over the last `days` days (inclusive of today). */
export function usageFor(userId, days = 7) {
  return (
    getDb()
      .prepare(
        `SELECT COALESCE(SUM(tokens_in), 0) AS tokens_in,
                COALESCE(SUM(tokens_out), 0) AS tokens_out,
                COALESCE(SUM(requests), 0)   AS requests,
                COALESCE(SUM(cost_usd), 0)   AS cost_usd
         FROM usage_cache
         WHERE user_id = ? AND date >= date('now', ?)`,
      )
      .get(userId, `-${days - 1} days`) || { tokens_in: 0, tokens_out: 0, requests: 0, cost_usd: 0 }
  );
}

/** Rolling usage across all users over the last `days` days. */
export function usageAll(days = 7) {
  return (
    getDb()
      .prepare(
        `SELECT COALESCE(SUM(tokens_in), 0) AS tokens_in,
                COALESCE(SUM(tokens_out), 0) AS tokens_out,
                COALESCE(SUM(requests), 0)   AS requests,
                COALESCE(SUM(cost_usd), 0)   AS cost_usd
         FROM usage_cache
         WHERE date >= date('now', ?)`,
      )
      .get(`-${days - 1} days`) || { tokens_in: 0, tokens_out: 0, requests: 0, cost_usd: 0 }
  );
}

/** M4: make the gateway's own per-key aggregates authoritative for today.
 *  Every chat turn also flows through the gateway with the user's key, so
 *  this REPLACES (not adds to) the day's totals — chat-usage reports merely
 *  fill the gap between syncs. */
// ── alert history ─────────────────────────────────────────────────────────
export function logAlert({ key, status, title = null, message = null, meta = null, reason = null }) {
  return getDb()
    .prepare(
      `INSERT INTO alert_log (key, status, title, message, meta, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(key, status, title, message, meta ? JSON.stringify(meta) : null, reason);
}

export function listAlerts(limit = 100) {
  return getDb()
    .prepare('SELECT * FROM alert_log ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(limit);
}

export function replaceUsageFromGateway(userId, { tokensIn, tokensOut, requests, costUsd = 0 }) {
  const day = new Date().toISOString().slice(0, 10);
  getDb()
    .prepare(
      `INSERT INTO usage_cache (user_id, date, tokens_in, tokens_out, requests, cost_usd, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (user_id, date) DO UPDATE SET
         tokens_in = excluded.tokens_in,
         tokens_out = excluded.tokens_out,
         requests = excluded.requests,
         cost_usd = excluded.cost_usd,
         updated_at = datetime('now')`,
    )
    .run(
      userId,
      day,
      Math.max(0, tokensIn),
      Math.max(0, tokensOut),
      Math.max(0, requests),
      Math.max(0, Number(costUsd) || 0),
    );
  return getUsageToday(userId);
}

// ── templates ────────────────────────────────────────────────────────────
export function listTemplates(category = null) {
  if (category) {
    return getDb()
      .prepare('SELECT * FROM templates WHERE active = 1 AND category = ? ORDER BY sort_order, name')
      .all(category);
  }
  return getDb()
    .prepare('SELECT * FROM templates WHERE active = 1 ORDER BY sort_order, name')
    .all();
}

export function getTemplateBySlug(slug) {
  return getDb().prepare('SELECT * FROM templates WHERE slug = ? AND active = 1').get(slug);
}

export function getTemplateById(id) {
  return getDb().prepare('SELECT * FROM templates WHERE id = ?').get(id);
}

export function createTemplate({ name, slug, description, category, icon, files, prompt, highlighted, createdBy }) {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO templates (id, name, slug, description, category, icon, files, prompt, highlighted, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, name, slug, description || null, category || 'general', icon || null,
         JSON.stringify(files || {}), prompt || null, highlighted ? 1 : 0, createdBy || null);
  return getTemplateById(id);
}

// ── workspaces ───────────────────────────────────────────────────────────
export function listWorkspaces(userId) {
  return getDb()
    .prepare('SELECT * FROM workspaces WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId);
}

export function listPublicWorkspaces() {
  return getDb()
    .prepare('SELECT id, name, description, user_id, created_at, updated_at FROM workspaces WHERE is_public = 1 ORDER BY updated_at DESC LIMIT 50')
    .all();
}

export function getWorkspaceById(id) {
  return getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
}

export function createWorkspace(userId, { name, description, templateId, files, messages, metadata, isPublic }) {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, user_id, name, description, template_id, files, messages, metadata, is_public)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, name, description || null, templateId || null,
         JSON.stringify(files || {}), JSON.stringify(messages || []),
         JSON.stringify(metadata || {}), isPublic ? 1 : 0);
  return getWorkspaceById(id);
}

export function updateWorkspace(id, fields) {
  const set = ['updated_at = datetime("now")'];
  const params = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (['id', 'user_id', 'created_at'].includes(key)) continue;
    set.push(`${key} = ?`);
    params.push(typeof value === 'object' ? JSON.stringify(value) : value);
  }
  getDb().prepare(`UPDATE workspaces SET ${set.join(', ')} WHERE id = ?`).run(...params, id);
  return getWorkspaceById(id);
}

export function deleteWorkspace(id) {
  getDb().prepare('DELETE FROM workspaces WHERE id = ?').run(id);
}

// ── project shares ───────────────────────────────────────────────────────
export function shareWorkspace(workspaceId, sharedWithUserId, permission, sharedByUserId) {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO project_shares (id, workspace_id, shared_with, permission, shared_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, shared_with) DO UPDATE SET permission = excluded.permission`,
    )
    .run(id, workspaceId, sharedWithUserId, permission || 'view', sharedByUserId);
  return getWorkspaceShares(workspaceId);
}

export function getWorkspaceShares(workspaceId) {
  return getDb()
    .prepare(
      `SELECT ps.*, u.email AS shared_with_email
       FROM project_shares ps JOIN users u ON u.id = ps.shared_with
       WHERE ps.workspace_id = ?`,
    )
    .all(workspaceId);
}

export function getUserSharedWithMe(userId) {
  return getDb()
    .prepare(
      `SELECT w.id, w.name, w.description, w.user_id, w.created_at, w.updated_at,
              ps.permission, ps.shared_by, u.email AS owner_email
       FROM project_shares ps
       JOIN workspaces w ON w.id = ps.workspace_id
       JOIN users u ON u.id = w.user_id
       WHERE ps.shared_with = ?
       ORDER BY w.updated_at DESC`,
    )
    .all(userId);
}

export function removeShare(workspaceId, sharedWithUserId) {
  getDb()
    .prepare('DELETE FROM project_shares WHERE workspace_id = ? AND shared_with = ?')
    .run(workspaceId, sharedWithUserId);
}

// ── Authentik group mappings ─────────────────────────────────────────────
export function getIdentityGroup(provider, name) {
  return getDb().prepare('SELECT * FROM identity_groups WHERE provider = ? AND name = ?').get(provider, name);
}

export function upsertIdentityGroup({ id = randomUUID(), provider = 'authentik', externalId = null, name }) {
  getDb().prepare(`
    INSERT INTO identity_groups (id, provider, external_id, name, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT (provider, name) DO UPDATE SET
      external_id = COALESCE(excluded.external_id, identity_groups.external_id),
      updated_at = datetime('now')
  `).run(id, provider, externalId, name);
  return getIdentityGroup(provider, name);
}

export function replaceIdentityGroupMembers(groupId, members) {
  const database = getDb();
  const replace = database.transaction((rows) => {
    database.prepare('DELETE FROM identity_group_members WHERE group_id = ?').run(groupId);
    const insert = database.prepare(`
      INSERT OR IGNORE INTO identity_group_members (group_id, user_id, external_id)
      VALUES (?, ?, ?)
    `);
    for (const row of rows) insert.run(groupId, row.userId, row.externalId || null);
  });
  replace(members);
}

export function listIdentityGroups() {
  return getDb().prepare(`
    SELECT g.*, COUNT(m.user_id) AS member_count
    FROM identity_groups g LEFT JOIN identity_group_members m ON m.group_id = g.id
    GROUP BY g.id ORDER BY g.name
  `).all();
}

export function listIdentityGroupMembers(groupId) {
  return getDb().prepare(`
    SELECT u.id, u.email, u.oidc_sub, m.external_id
    FROM identity_group_members m JOIN users u ON u.id = m.user_id
    WHERE m.group_id = ? ORDER BY u.email
  `).all(groupId);
}

// ── cloud storage providers ──────────────────────────────────────────────
export function listCloudStorageProviders({ includeDisabled = true } = {}) {
  const sql = includeDisabled
    ? 'SELECT * FROM cloud_storage_providers ORDER BY name'
    : 'SELECT * FROM cloud_storage_providers WHERE enabled = 1 ORDER BY name';
  return getDb().prepare(sql).all();
}

export function getCloudStorageProvider(id) {
  return getDb().prepare('SELECT * FROM cloud_storage_providers WHERE id = ?').get(id);
}

export function createCloudStorageProvider({ name, providerType, endpoint, bucket, region, credentialRef, enabled = true }) {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO cloud_storage_providers
      (id, name, provider_type, endpoint, bucket, region, credential_ref, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, providerType, endpoint || null, bucket || null, region || null, credentialRef || null, enabled ? 1 : 0);
  return getCloudStorageProvider(id);
}

export function updateCloudStorageProvider(id, fields) {
  const allowed = ['name', 'provider_type', 'endpoint', 'bucket', 'region', 'credential_ref', 'enabled'];
  const set = [];
  const params = [];
  for (const key of allowed) {
    if (fields[key] === undefined) continue;
    set.push(`${key} = ?`);
    params.push(key === 'enabled' ? (fields[key] ? 1 : 0) : fields[key] || null);
  }
  if (set.length) {
    set.push("updated_at = datetime('now')");
    getDb().prepare(`UPDATE cloud_storage_providers SET ${set.join(', ')} WHERE id = ?`).run(...params, id);
  }
  return getCloudStorageProvider(id);
}

export function deleteCloudStorageProvider(id) {
  getDb().prepare('DELETE FROM cloud_storage_providers WHERE id = ?').run(id);
}

export function listStoragePools({ includeDisabled = true } = {}) {
  const where = includeDisabled ? '' : 'WHERE sp.enabled = 1 AND p.enabled = 1';
  return getDb().prepare(`
    SELECT sp.*, p.name AS provider_name, p.provider_type
    FROM storage_pools sp JOIN cloud_storage_providers p ON p.id = sp.provider_id
    ${where} ORDER BY sp.name
  `).all();
}

export function getStoragePool(id) {
  return getDb().prepare(`
    SELECT sp.*, p.name AS provider_name, p.provider_type
    FROM storage_pools sp JOIN cloud_storage_providers p ON p.id = sp.provider_id
    WHERE sp.id = ?
  `).get(id);
}

export function createStoragePool({ name, providerId, rootPath, capacityLabel, enabled = true }) {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO storage_pools (id, name, provider_id, root_path, capacity_label, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, providerId, rootPath || null, capacityLabel || null, enabled ? 1 : 0);
  return getStoragePool(id);
}

export function deleteStoragePool(id) {
  getDb().prepare('DELETE FROM storage_pools WHERE id = ?').run(id);
}
