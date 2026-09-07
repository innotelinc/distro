-- Distro control-plane schema (SQLite-first; portable to Postgres).
-- Prerelease — refine during implementation (apps/control-plane/docs/roadmap.md).

PRAGMA foreign_keys = ON;

-- Accounts
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,                 -- uuid
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                    -- argon2id/bcrypt (>=12 rounds)
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  disabled_at   TEXT                              -- NULL = active
);

-- One gateway API key per user (the OmniRoute key id/key are stored here).
-- Distro NEVER stores upstream provider keys — only gateway-issued keys.
CREATE TABLE IF NOT EXISTS gateway_keys (
  id             TEXT PRIMARY KEY,                -- local uuid
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gateway_key_id TEXT NOT NULL,                   -- id returned by POST /api/keys
  gateway_key    TEXT,                            -- plaintext key (sk-…). Encrypt at
                                                  -- rest (AES-GCM, key from env) or
                                                  -- store server-side only and keep
                                                  -- this column NULL if proxying via
                                                  -- control plane instead.
  label          TEXT NOT NULL DEFAULT 'default',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at     TEXT,
  last_used_at   TEXT,
  UNIQUE (user_id, label)
);

-- Quotas (authoritative copy enforced by Distro middleware).
CREATE TABLE IF NOT EXISTS quotas (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan             TEXT NOT NULL DEFAULT 'free',
  requests_per_day INTEGER,                       -- NULL = unlimited
  tokens_per_day   INTEGER,
  spend_cap_usd    REAL,                          -- soft cap; gateway enforces hard cap
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Daily usage snapshot synced from the gateway's per-key accounting.
CREATE TABLE IF NOT EXISTS usage_cache (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,                      -- YYYY-MM-DD
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  requests    INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, date)
);

-- Sessions (opaque tokens; JWT optional per M1 decision).
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,                       -- sha256 of the bearer token
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit log (M5): signups, key lifecycle, quota/role/disable changes.
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  actor_id      TEXT,                              -- user id or NULL (system/CLI)
  actor_email   TEXT,
  action        TEXT NOT NULL,                     -- e.g. signup, disable, quota.change, key.revoke
  target_id     TEXT,
  target_email  TEXT,
  meta          TEXT                               -- JSON details (limits, key ids, …)
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

-- Alert history (webhook deliveries for quota denials / sync failures).
-- Recorded only when CONTROL_ALERT_WEBHOOK_URL is configured; 'cooldown'
-- rows mean the event fired again inside the per-key cooldown window.
CREATE TABLE IF NOT EXISTS alert_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  key           TEXT NOT NULL,                     -- event id, e.g. quota.denied / sync.failed
  status        TEXT NOT NULL,                     -- sent | failed | cooldown
  title         TEXT,
  message       TEXT,
  meta          TEXT,                              -- JSON details
  reason        TEXT                               -- why (cooldown / http 500 / error text)
);
CREATE INDEX IF NOT EXISTS idx_alert_created ON alert_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gateway_keys_user ON gateway_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_cache_user_date ON usage_cache(user_id, date);

-- Project templates (starter apps users can clone)
CREATE TABLE IF NOT EXISTS templates (
  id            TEXT PRIMARY KEY,                 -- uuid
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  description   TEXT,
  category      TEXT NOT NULL DEFAULT 'general',  -- general, react, nextjs, svelte, etc.
  icon          TEXT,                             -- emoji or icon name
  files         TEXT NOT NULL DEFAULT '{}',        -- JSON: {path: content} starter files
  prompt        TEXT,                             -- initial prompt to scaffold the app
  highlighted   INTEGER NOT NULL DEFAULT 0,       -- 1 = featured on template picker
  active        INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);

-- Saved workspaces (server-side persistence for projects)
CREATE TABLE IF NOT EXISTS workspaces (
  id            TEXT PRIMARY KEY,                 -- uuid
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  template_id   TEXT REFERENCES templates(id),    -- if cloned from a template
  files         TEXT NOT NULL DEFAULT '{}',        -- JSON: {path: content} full snapshot
  messages      TEXT NOT NULL DEFAULT '[]',        -- JSON: chat history
  metadata      TEXT NOT NULL DEFAULT '{}',        -- JSON: {gitUrl, gitBranch, ...}
  is_public     INTEGER NOT NULL DEFAULT 0,       -- 1 = visible to other users
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces(user_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_public ON workspaces(is_public) WHERE is_public = 1;

-- Project sharing (access control for team collaboration)
CREATE TABLE IF NOT EXISTS project_shares (
  id            TEXT PRIMARY KEY,                 -- uuid
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shared_with   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission    TEXT NOT NULL DEFAULT 'view' CHECK (permission IN ('view', 'edit', 'admin')),
  shared_by     TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, shared_with)
);
CREATE INDEX IF NOT EXISTS idx_shares_workspace ON project_shares(workspace_id);
CREATE INDEX IF NOT EXISTS idx_shares_user ON project_shares(shared_with);
