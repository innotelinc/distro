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

CREATE INDEX IF NOT EXISTS idx_gateway_keys_user ON gateway_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_cache_user_date ON usage_cache(user_id, date);
