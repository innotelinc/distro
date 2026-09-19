# Control-plane roadmap

> Progress: **M0–M5 are DONE** (service + gateway client + identity +
> per-user keys + quotas + usage sync + admin console + Magnate billing).
> Integration option A (browser holds key) was chosen; see docs/ops.md.
>
> **0.3.0 (M7) is IN PROGRESS** — the Shares identity/storage slice is
> shipped below; build-plane convergence remains open.
>
> **0.2.0 (M6) is DONE (19 September 2026)** — hardening the surface that
> shipped in 0.1: auth rate limit, the gateway-version pin, and per-model
> usage. The session-model reconciliation moved to M7, where it is the same
> work as the server-side session bridge.
>
> **Live deployment note — 17 September 2026.** The Cerulean edge now serves
> `distro.innotel.us`, `cp.distro.innotel.us`, and
> `admin.distro.innotel.us` over HTTPS to the control plane on port 20140;
> the admin hostname is provisioned idempotently through NPM and its DNS A
> record is managed by Cerulean/Technitium.
>
> **Authentik sign-in fixed on that deployment.** The console answers on more
> than one origin while the provider had a single registered callback (the LAN
> URL), so a sign-in started on a public host returned to a different origin and
> the host-only `distro_oidc_state` cookie never came back — every attempt ended
> with *"Sign-in failed: invalid or expired state"*. `OIDC_REDIRECT_URI` is now
> a comma-separated list of registered callbacks and the control plane uses the
> request's own origin when it is on that list (canonical entry otherwise), so a
> forged `Host` header cannot aim an Authorization code off the list. Covered by
> `test/oidc-redirect.test.mjs`; verified live on all three hostnames — the flow
> reaches Authentik's login and returns to the origin it started on.
>
> **Operations note — same day.** The control plane stayed up through an estate
> capacity pass that stopped every container with nothing to do on four hosts
> (~48 GB reclaimed; see ips `docs/service-audit.md` §5). `scripts/docker-cleanup.sh`
> (mirrored from ips, canonical there) now runs nightly at 04:17 on every docker
> host: build cache with a 2 GB floor, dangling/unreferenced images, containers
> exited for more than a day, oversized logs — volumes and same-day parked
> containers are never touched.

Milestones are ordered so each one is runnable and shippable on its own.
Estimated sizes are relative; revisit against the pinned gateway version.

## M6 — 0.2.0: hardening ✅

- [x] **Rate limit the password endpoints.** `/api/auth/signup` and
      `/api/auth/login` accept a password on a public route; nothing stopped
      scripted guessing or mass signup. A fixed-window limiter (per client IP,
      `CONTROL_AUTH_RATE_LIMIT` per `CONTROL_AUTH_RATE_WINDOW_MS`, defaults
      10/60s) now answers `429`. Process-local by design — the distributed
      limiter is the edge — and disabled by setting the limit to 0. Applies
      only while the break-glass password path is enabled; the Authentik path
      is unaffected.
- [x] **Gateway-version pin: OmniRoute 3.8.51** — the release the inventory
      (`docs/gateway-api-inventory.md`) and the `usage_history` ledger read were
      verified against. `GATEWAY_EXPECTED_VERSION` (default `3.8.51`, empty =
      check off) is compared with what the gateway reports
      (`GatewayClient.version()`: `/api/monitoring/health`, then `/api/health`;
      defensive extraction, since neither payload is a contract this plane
      owns). Probed at boot and before every usage sync (`src/gatewayVersion.js`).
      **Warn-only by decision:** a mismatch logs, fires one
      `gateway.version-mismatch` webhook alert per cooldown, and shows red in
      the console's *Gateway version* card — the sync still runs, because the
      schema-drift guard already turns a real incompatibility into a warning
      and chat usage reports + key spend caps carry accounting. "Could not
      tell" is reported as *unchecked*, never as a verdict. Also printed by
      `control.mjs gateway-check`. Covered by `test/gateway-version.test.mjs`.
- [x] **Per-key model-level usage** — this was never blocked on OmniRoute: the
      ledger read already grouped by `(api_key_id, model)` and chat usage
      reports already carried `model`; `sync.js` was discarding the dimension.
      New `usage_models` table (one row per user/day/model, replaced by the
      ledger sync, added to by usage reports); `usage_cache` stays the quota
      authority. Surfaced as `models` on `GET /api/me/usage`, `usageModelsToday`
      on the admin users list, `models` on `/api/admin/stats`, plus a *Model
      usage — today* panel (share-of-spend bars) and top-models under each
      user's Today cell in `/admin`.
- [x] Reconcile the two session models (control-plane bearer token vs Studio
      cookie) — **moved to M7**, not done here: Studio's cookie lives in Olympus, so this is
      cross-repository and is the same work as the server-side session bridge
      there.

## M7 — 0.3.0: build-plane convergence and Shares UX

- [x] Widen the admin console to use the available desktop viewport and keep
      the users, queue, audit, alerts, identity, and Shares sections visible in
      one operator surface.
- [x] Mirror the configured Authentik group into local membership tables;
      create the group through Authentik's API when it is missing, provision
      missing local accounts, and reconcile membership on the first admin-panel
      load or with **Sync group users**.
- [x] Add admin-managed cloud storage providers and provider-linked storage
      pools for S3-compatible, Google Drive, Dropbox, OneDrive, and WebDAV
      connections. Only secret references are stored; raw credentials never
      enter the UI or API response.
- [x] Include enabled storage providers and pools in authenticated Shares/
      workspace responses for the builder surface.


- [ ] Make Distro the durable source of per-identity quotas and audit events for
      Olympus build, preview, publish, and export actions.
  - [x] **First slice (19 September 2026): build-plane audit per user in the
        console.** `GET /api/admin/audit` takes `?action=<prefix>` (namespace,
        e.g. `build.`; escaped LIKE so `_`/`%` cannot widen it) and `?user=<id>`
        (rows the account performed *or* was the target of). `/admin` gains a
        "Build plane — audit by user" panel with user and action filters, a
        per-row **Build audit** shortcut in the users table, and http(s)-only
        linkification of `previewUrl`/`publishedUrl` metadata. Covered in
        `test/internal-api.test.mjs`.
  - [x] **Second slice (19 September 2026): the build plane asks before it
        builds.** `POST /api/internal/build-check` (service token; body
        `{ sub, action, consume?, targetId?, slug? }`) resolves the Authentik
        subject the way `/identity` does (unknown = 404, never a provisioning),
        applies the entitlement-gated quota and answers the same
        `{ allowed, reasons, quota, usageToday }` shape as the chat check.
        Decisions: every `build.*` action shares the chat caps (same gateway
        key underneath); only `build.start` is judged against the new
        **`builds_per_day`** quota and, with `consume: true`, counted in
        `usage_cache.builds`. A refusal writes a `build.denied` audit row (it
        lands in the console's build-plane panel) and raises the existing
        quota alert. Console: *Builds/day* column, builds-today badge, presets
        (free 5 / pro 50). Both columns arrive on legacy databases through
        `migrate()`; covered in `test/internal-api.test.mjs`.
  - [ ] Next: Studio calls `build-check` before enqueueing and reports the
        build's model spend under the user's key (cross-repo; the Distro side
        is in place).
- [x] Add a gateway-version compatibility check to usage sync (shipped with the
      M6 pin: `checkGatewayVersion` runs before every `syncUsageFromGateway`).
      Quota enforcement does not consult it by design — the decision is served
      from `usage_cache`, which stays correct whichever accounting path fills it.
- [ ] Replace the remaining browser-held gateway-key assumptions with a scoped
      server-side session bridge while preserving per-user attribution. This
      absorbs the former M6 item: reconciling the control-plane bearer token
      with Studio's cookie is the same bridge, seen from the other side
      (cross-repo with Olympus).
- [x] Add acceptance coverage for an Olympus preview/build lifecycle: queued,
      picked up, failed with an actionable reason, retried, and completed. The Olympus
      runner now records queue state and delivery URLs, rejects empty-agent artifacts,
      retries rate-limited tool calls, and keeps preview credentials scoped to delivery.
- [ ] Add cross-repository acceptance automation so Distro can periodically verify the
      live Olympus runner heartbeat, a queued smoke build, and the resulting preview
      URL without exposing provider or Cerulean credentials. Current live checks confirm
      the runner is active, queue pickup works, `resume-generator` builds successfully,
      and its preview returns HTTP 200. The remaining hardening item is sustained shared
      OmniRoute model capacity, not the Distro control plane.

### Added while M7 is open (shipped 17 September 2026)

- [x] **OIDC callback lists** — `OIDC_REDIRECT_URI` takes a comma-separated list;
      the flow returns to the origin it started on (covered by
      `test/oidc-redirect.test.mjs`). Fixed the live "invalid or expired state"
      failures on the public admin host.
- [x] **All three public origins provisioned through Cerulean** —
      `admin.distro.innotel.us` joins `distro.`/`cp.distro.` with DNS managed by
      Technitium and TLS at the NPM edge; `scripts/npm-proxy-hosts.py` now accepts
      Cerulean's `NPM_EMAIL`/`NPM_PASSWORD` credentials and the provisioning is
      idempotent from either stack's `.env`.

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

## Open questions — resolved

- ~~Gateway version drift~~ → pinned at 3.8.51 and checked at runtime (M6).
  Re-verifying the inventory before moving the pin is now the documented step.
- ~~Whether OmniRoute exposes per-key model-level usage~~ → it does, in the
  `usage_history` ledger; stored in `usage_models` (M6).
- ~~Option A vs B~~ → A (browser holds key), chosen at M2; the M7 session
  bridge is the path away from it.
- ~~Where the quota check lives~~ → web-app middleware calling
  `/api/internal/quota-check` (M3).

## M7 progress notes (2026-09-18)

- [x] **Console story + pipeline view**: the admin console now opens with
      "What Distro is" (gateway control plane: who may call, how much they
      may spend, what it cost) plus the integration map (Authentik SSO,
      OmniRoute keys/quotas, Magnate entitlements, Olympus Studio build ops,
      Cerulean Vault secrets), and a build-pipeline view (queued → building
      → verified → live, runner status, latest-build banner with deep link)
      driven by the read-only queue API. Deployed and verified on .46.
- [x] **Estate surface**: `req.magnate.innotel.us` (Jellyseerr door on .56)
      provisioned through Cerulean — DNS A record + NPM proxy host with the
      magnate wildcard cert (id 45) — closing the last 404 in the media
      group's public surface.
