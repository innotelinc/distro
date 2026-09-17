# Control-plane roadmap

> Progress: **M0–M5 are DONE** (service + gateway client + identity +
> per-user keys + quotas + usage sync + admin console + Magnate billing).
> Integration option A (browser holds key) was chosen; see docs/ops.md.
>
> **0.2.0 (M6) is open** — hardening the surface that shipped in 0.1: the
> auth rate limit below is the first slice, and the open questions at the
> bottom are the working list.

Milestones are ordered so each one is runnable and shippable on its own.
Estimated sizes are relative; revisit against the pinned gateway version.

## M6 — 0.2.0: hardening (shipped)

- [x] **Rate limit the password endpoints.** `/api/auth/signup` and
      `/api/auth/login` accept a password on a public route; nothing stopped
      scripted guessing or mass signup. A fixed-window limiter (per client IP,
      `CONTROL_AUTH_RATE_LIMIT` per `CONTROL_AUTH_RATE_WINDOW_MS`, defaults
      10/60s) now answers `429`. Process-local by design — the distributed
      limiter is the edge — and disabled by setting the limit to 0. Applies
      only while the break-glass password path is enabled; the Authentik path
      is unaffected.
- [ ] Decide the gateway-version pin before the next milestone (see Open
      questions) so per-key usage granularity is known in advance.
- [ ] Per-key model-level usage once OmniRoute exposes it (extends M4).
- [ ] Reconcile the two session models (control-plane bearer token vs Studio
      cookie) as the tenancy layer converges — see the build-plane doc.

## M7 — 0.3.0: build-plane convergence (next)

- [ ] Make Distro the durable source of per-identity quotas and audit events for
      Olympus build, preview, publish, and export actions.
- [ ] Add a gateway-version compatibility check to usage sync and quota enforcement
      before enabling model-level accounting.
- [ ] Replace the remaining browser-held gateway-key assumptions with a scoped
      server-side session bridge while preserving per-user attribution.
- [x] Add acceptance coverage for an Olympus preview/build lifecycle: queued,
      picked up, failed with an actionable reason, retried, and completed. The Olympus
      runner now records queue state and delivery URLs, rejects empty-agent artifacts,
      retries rate-limited tool calls, and keeps preview credentials scoped to delivery.
- [ ] Add cross-repository acceptance automation so Distro can periodically verify the
      live Olympus runner heartbeat, a queued smoke build, and the resulting preview
      URL without exposing provider or Cerulean credentials. Current live checks confirm
      the runner is active and queue pickup is working; the remaining acceptance blocker
      is shared OmniRoute model capacity, not the Distro control plane.

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
- [x] Decide integration option A vs B (chosen: **A — browser holds key**).
      Web app fetches `/me/gateway-key` at login and uses it as its
      `OpenAILike` key; quota gating lives in the web-app middleware calling
      `/api/internal/quota-check` (M3).
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
      NOTE: requires the gateway's data dir mounted read-only at
      `GATEWAY_DATA_DIR`. With the shared remote gateway there is no such
      volume, so the interval defaults to 0 (off) and usage reports + key spend
      caps carry the accounting.
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
- [x] Billing: Magnate integration (`src/billing.js`) — entitlements check,
      plans list, checkout forwarding, plan auto-seed on boot, free-tier
      quota gating (`gatedQuota`), `/billing` web route + header link.
      Env: `MAGNATE_URL` / `MAGNATE_ENTITLEMENTS_TOKEN` / `MAGNATE_BILLING_SLUG`;
      runbook: docs/ops.md § "Magnate billing integration".

## Open questions to resolve before/at M7

- Gateway version drift: re-verify the inventory endpoints against the shared
  platform gateway's version before each milestone.
- Whether OmniRoute exposes per-key **model-level** usage (M4 granularity).
- Option A vs B above (user-agent key handling / proxy) — affects M2–M4.
- Where the quota check lives if option A is chosen (web app middleware needs
  to call the control plane on every `/api/chat`).
