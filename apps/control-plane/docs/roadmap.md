# Control-plane roadmap

> Progress: **M0, M1 and the M2 key-lifecycle slice are DONE** (service +
> gateway client + identity + mint-on-signup/rotate/revoke, verified live
> against the gateway). Remaining below are M3+ and the web-app integration.

Milestones are ordered so each one is runnable and shippable on its own.
Estimated sizes are relative; revisit against the pinned gateway version.

## M0 — Service skeleton + gateway client ✅

- [x] Stand up `apps/control-plane` as a small Node service (plain Node HTTP,
      no framework) with its own `package.json`, health endpoint, config from
      env, and a SQLite store loaded from `schema.sql`.
- [x] Add it to the root compose network (`control-plane` service; no public
      port; only the web app and gateway can reach it).
- [x] Implement `gatewayClient` wrapping the inventory in
      `docs/gateway-api-inventory.md`: login (service session), create key,
      list keys, revoke key. (Per-key usage read deferred to M4.)
- [x] Acceptance: control plane can mint and revoke a gateway key via its own
      CLI/script (`scripts/`), reusing the exact calls proven in the scaffold.

## M1 — Identity ✅

- [x] Signup + login + logout with sessions (opaque bearer tokens, hashed at
      rest; see `schema.sql`).
- [x] Admin role bootstrap (first user or `ADMIN_EMAILS` env).
- [x] `/health`, error envelope. (Rate limiting on auth endpoints still TODO.)
- [x] Acceptance: two users can sign up and get distinct sessions; disabled
      users can't log in (verified live).

## M2 — Per-user gateway keys ✅ (key lifecycle)

- [x] On signup: mint a gateway key via the gateway client, store mapping in
      `gateway_keys` (verified: key authenticates on /v1/models).
- [x] On disable/delete: revoke gateway key (verified: key 401s after disable).
- [x] Key rotation endpoint (`POST /api/me/gateway-key/rotate`).
- [ ] Decide integration option A vs B (needed before web integration):
      - **A (browser holds key)**: web app calls control plane
        `/me/gateway-key` at login and uses it as its `OpenAILike` key. Simplest
        to implement; key is visible to the user (acceptable — it's their key).
      - **B (server proxy)**: control plane terminates /v1 and stamps each
        request with the session's key. More work; key never reaches the
        browser; enables server-side quotas naturally.
- [x] Acceptance: each user's requests are attributed to their own gateway key
      (key-per-user visible in the gateway dashboard).

## M3 — Quotas (done: server-side gate + key spend caps)

- [x] Server-side enforcement middleware in the web app: `/api/chat` calls
      `GET /api/internal/quota-check` (identity = the user's gateway key from
      the `apiKeys` cookie) before streaming; 429 with reasons when over.
      Fail-open if the control plane is unreachable; host-key ("skip for
      now") traffic is never gated. Toggle: `DISTRO_ENFORCE_QUOTA`.
- [x] Hard spend cap on each per-user gateway key at mint/rotate
      (`dailyUsageLimitUsd`, `weeklyUsageLimitUsd`) — the backstop when the
      gateway is called directly.
- [x] Acceptance: capped user's `/api/chat` returns HTTP 429 with reasons
      (verified over HTTP against the running stack); admin can change the
      cap and it applies without key rotation (null clears a limit).

## M4 — Usage visibility (done: chat reports + authoritative gateway-ledger sync)

- [x] `POST /api/internal/usage-report` — the web app records every finished
      chat turn (tokens in/out + call count) against the user after streaming
      (real-time fill between syncs).
- [x] **Authoritative sync from the gateway's own ledger**: `usage_history`
      rows carry `api_key_id`, so the control plane reads the gateway SQLite
      volume (mounted ro) and replaces each user's `usage_cache` with the
      gateway's per-key aggregates for the day — covering ALL traffic under
      the key (chat, direct /v1, dashboard usage), not just web chat turns.
      Scheduled via `CONTROL_SYNC_INTERVAL_MS`; CLI: `control.mjs usage-sync`.
- [x] `GET /me/usage` (today snapshot) and quota decisions consume it, so
      daily request/token caps are gateway-authoritative after each sync.
- [x] Minimal UI: admin console usage columns (`/admin`).
- [x] Schema-drift guard: a failed gateway read warns and never crashes;
      chat usage reports keep caps working meanwhile.

Verified live: sync matched the operator's account key against the gateway
ledger (per-key rows → usage_cache) and left unmapped keys (host key, deleted
test accounts) untouched.

## M5 — Hardening & operator UX (done except billing)

- [x] Admin console at `http://<host>:20140/admin` (no build step): stats
      cards, per-user quota editing, disable/enable (revokes key), revoke &
      rotate key, today usage columns. Backed by `/api/admin/*`.
- [x] Role management (`PATCH role`) with a last-admin guard and account
      deletion (`DELETE /api/admin/users/:id`, cascades + revokes key).
- [x] `GET /api/admin/stats` aggregate endpoint.
- [x] Audit log: `audit_log` table records signups, quota/role/disable
      changes, key revoke/rotate, deletes; `GET /api/admin/audit` + console
      panel. Append-only, survives user deletion.
- [x] Backups: `make backup` / `scripts/backup.sh` snapshots the control-plane
      and gateway SQLite stores via each app's online `better-sqlite3
      .backup()` (verified `integrity_check: ok`) into `./backups/`.
- [ ] Billing hook points (Stripe etc.) behind a `billing` interface — only if
      paid tiers are in scope.

## Open questions to resolve before/at M2

- Gateway version drift: re-verify the inventory endpoints on the pinned
  `OMNIROUTE_IMAGE_TAG` before each milestone.
- Whether OmniRoute exposes per-key **model-level** usage (M4 granularity).
- Option A vs B above (user-agent key handling / proxy) — affects M2–M4.
- Where the quota check lives if option A is chosen (web app middleware needs
  to call the control plane on every `/api/chat`).
