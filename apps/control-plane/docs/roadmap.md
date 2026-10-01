# Control-plane roadmap

> Progress: **M0–M6 are DONE** (service + gateway client + identity +
> per-user keys + quotas + usage sync + admin console + Magnate billing +
> hardening). **0.3.0 (M7) is IN PROGRESS, and M8 (1.0) is underway** — the
> Shares identity/storage slice is shipped and the build plane has been retired;
> what remains in M7 is the server-side session bridge. **M8 is complete**: the
> restore drill, the account-facing usage view, the failure alerts, the threat
> model for the plane, and the version/upgrade posture have all shipped — which is
> the 1.0 claim, *an operator can run this for other people*, met.
>
> **Target: 1.0** — the tenancy layer under the ecosystem's one builder
> surface, Genie: every model call attributable, capped and revocable per
> account, with the operator able to answer "who, how much, what did it cost"
> without a shell.
>
> **0.2.0 (M6) is DONE (19 September 2026)** — hardening the surface that
> shipped in 0.1: auth rate limit, the gateway-version pin, and per-model
> usage. The session-model reconciliation moved to M7, where it is the same
> work as the server-side session bridge.
>
> **Build plane retired — 30 September 2026.** Distro's builder surface is
> **Genie**, and the build plane existed to serve the one it replaced:
> `src/buildQueue.js` and its read-only `/api/admin/build-queue` view,
> `POST /api/internal/build-check`, the `builds_per_day` quota dimension and
> the console's build pipeline are gone, and gateway keys are now minted as
> `genie-user-<id8>`. Two columns (`quotas.builds_per_day`,
> `usage_cache.builds`) and the `build.*` audit rows are **kept**: an audit row
> is evidence, the migrations leave a restored backup with the same schema as
> a fresh deploy, and nothing reads either one. The Distro-side complication
> this removes is the largest one in the file: with no build plane to mirror,
> the control plane's whole job is the identity → quota → turn → usage/audit
> loop Genie already drives.
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

## M7 — 0.3.0: the Genie loop and the console (in progress)

- [x] Widen the admin console to use the available desktop viewport and keep
      the users, audit, alerts, identity, and Shares sections visible in one
      operator surface.
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
- [x] **Retire the build plane** (30 September 2026). The queue mirror, the
      `build-check` route, the `builds_per_day` quota and the pipeline view are
      removed; the builder audit panel stays as history. Covered by
      `test/internal-api.test.mjs`, which proves the retired columns still
      arrive on a legacy database and are never written.
      The **copy went with the code**: the plan this service seeds into Magnate
      no longer advertises "unlimited app builds" and an in-browser preview — it
      describes the tenancy layer it actually sells — and the landing page no
      longer promises a read-only *build queue view* that was retired with the
      plane. A retired feature that survives in a price list and a marketing
      card is not history; it is a claim, and one a buyer could hold you to.
- [x] Add a gateway-version compatibility check to usage sync (shipped with the
      M6 pin: `checkGatewayVersion` runs before every `syncUsageFromGateway`).
      Quota enforcement does not consult it by design — the decision is served
      from `usage_cache`, which stays correct whichever accounting path fills it.
- [ ] **Replace the remaining browser-held gateway-key assumptions with a
      scoped server-side session bridge**, preserving per-user attribution.
      This is now cross-repo with **Genie**: reconciling the control-plane
      bearer token with Genie's Authentik session is the same bridge seen from
      the other side, and Genie's own roadmap carries its half.
- [x] **Cross-repository acceptance automation.** A scheduled check that proves
      the deployment still works end to end — Genie signs a subject in through
      Authentik, the control plane provisions it, the turn is gated and its
      usage recorded, and the audit row lands — without exposing provider or
      Cerulean credentials. The M7 runner-heartbeat and preview-URL checks went
      with the build plane.
      **The plane's half shipped (2026-10-01):** `control.mjs acceptance`
      (`src/acceptance.js`, `scripts/acceptance-check.sh`, `make acceptance`,
      `systemd/distro-acceptance.{service,timer}`, daily at 06:41) walks the loop
      a turn takes against the live deployment — a subject resolves to an account
      and keeps the same one on a second call, that account's own gateway key
      answers `quota-check`, a turn's usage is reported and reads back through the
      route the accounting uses — and exits non-zero on the first broken step. It
      is driven over the real HTTP handler on a temporary database by
      `test/internal-api.test.mjs`, so the check cannot pass against a stub. The
      sign-in half lives with the surface that signs in: `verify-sso.py` already
      drives a real Authentik code flow and
      `ontrak-genie/scripts/verify-tenancy.mjs` proves two accounts are isolated
      once signed in. **Both halves now run as one check (2026-10-01):**
      `make cross-check` (`scripts/cross-repo-check.sh`) runs the plane half and
      then the console half, and the daily `distro-acceptance.timer` was
      repointed at it, so a break that spans the repos — a session the plane will
      not accept, an account bound to the wrong subject — is caught by the same
      timer rather than by a person. The console half needs a Genie checkout
      (`GENIE_DIR`, else a sibling/`/opt` search), and where there is none it is
      reported as **SKIP by name** rather than counted a pass, leaving the plane
      half to decide the exit code. The accounts the console signs in as are named
      by the plane itself (`control.mjs accounts`, from the accounts bound to an
      identity), so what is proved is that the *actual* accounts resolve — a check
      with its own invented subject would prove the console mints a cookie and
      nothing more.

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

## M8 — 1.0: the tenancy layer, finished ✅

The 1.0 claim is narrow and testable: **an operator can run this for other
people.** Everything below is in service of that, and nothing below is a new
feature for its own sake.

- [x] **A restore that has been rehearsed.** `make backup` writes verified
      SQLite snapshots; nothing proved they came *back*. `make restore-rehearsal`
      (`scripts/restore-rehearsal.sh`) takes a fresh backup, then boots the
      **newest and the oldest** snapshot in a scratch container on its own port —
      the newest is what a real restore would use, the oldest is the one most
      likely to be a surprise — and asks each the questions that matter: does it
      answer `/health`, does it know the accounts, does it carry the schema and
      the history. Read-only with respect to the live stack (its own port,
      directory and container name, all removed at the end), and honest about
      its limit: the gateway side is the platform's to restore, not this
      rehearsal's. Procedure in `docs/ops.md` § *Restoring*.
- [x] **Operator visibility that reaches out.** The existing webhook alerts
      cover quota denials and gateway-version drift. 1.0 adds the two failures
      an operator finds out about too late. **The usage sync not having run** is
      now a watchdog on the sync's own schedule: when the sync is scheduled
      (`CONTROL_SYNC_INTERVAL_MS` > 0), a pass older than three intervals or five
      minutes (`CONTROL_SYNC_STALE_MS`) raises `sync.stale` — distinct from
      `sync.failed`, which fires on one bad pass while a wedged timer fires on
      none. **The control plane being unreachable from Genie's side** cannot be
      reported at the moment it happens — the caller is the only witness and it
      is the one that cannot get through — so Genie records the window and
      reports it on the next call that succeeds, or on its own timer, through a
      new service route `POST /api/internal/alert`; the plane pages the operator
      as `controlplane.unreachable`, and its per-event cooldown turns a retry
      storm into one alert. Covered by `test/sync-stale.test.mjs`,
      `test/alert-report.test.mjs`, and Genie's
      `src/test/controlplane-outage.test.ts`.
- [x] **Per-account usage the account can see.** The ledger is written and the
      console shows it to an operator; `GET /api/me/usage` shows a user their
      own spend. 1.0 makes the user-facing half usable: the response now carries
      today **and** the rolling window it sits in (`CONTROL_USAGE_WINDOW_DAYS`,
      default 7, summed from the daily `usage_cache` rows that already exist),
      the caps the account is measured against (`caps.plan` / `.requestsPerDay` /
      `.tokensPerDay` / `.spendCapUsd`, `null` meaning uncapped), and the
      allow/deny verdict with its reasons — from the *same* `decideQuota` the
      gate calls, so the number a person reads and the number that refuses their
      next turn cannot disagree. That last property is the point: a quota whose
      two readings differ is a quota nobody trusts. Covered by
      `test/me-usage.test.mjs` (today vs window, a day outside the window, the
      reached cap reading as reached, an empty account, and one account not
      reading another's).
- [x] **A documented threat model for the plane.**
      [docs/threat-model.md](threat-model.md) is the page, written before somebody
      has to reason about it during an incident. It states what the plane holds and
      what it **must never** hold (upstream provider keys, raw storage credentials,
      a clear password or session token, the Vault token), draws the five trust
      boundaries (the browser and its CORS origin, the service token, the gateway,
      the shared SQLite file, Vault), and — the part that matters — pairs each
      control with its **residual**: a bearer session is a bearer session, the
      console still binds `0.0.0.0` by default, a backup *is* the whole plane
      including the hashed keys and the audit log, and tenant isolation is
      application-enforced over one file. It also says the two easy untruths out
      loud: there is no row-level security, and `audit_log` is **not** hash-chained
      the way Sentinel's evidence log is, so the word "audit" here is not
      tamper-evidence.
- [x] **Version and upgrade posture.** A single place, `docs/ops.md` § *Upgrading
      the control plane, and the gateway pin*: which OmniRoute release the plane is
      verified against (`GATEWAY_EXPECTED_VERSION`, default `3.8.51`, checked at
      boot and before every sync — a loud warning, never a stop), a symptom→cause
      table for what breaks when the gateway moves, and the roll-forward/roll-back
      procedure. The pin is mechanism; this is the runbook around it. It records
      the schema's real property rather than a hoped-for one: migrations are
      **additive and idempotent** and applied at boot (no version table, no down
      migration), so an older image on a newer file tolerates it — and a backup is
      still the first step, because the schema is additive and the *data* is not.

## M0 — Service skeleton + gateway client ✅

- [x] Stand up `apps/control-plane` as a small Node service (plain Node HTTP,
      no framework) with its own `package.json`, health endpoint, config from
      env, and a SQLite store loaded from `schema.sql`.
- [x] Add it to the root compose network (`control-plane` service; no public
      port; only the builder surface and gateway can reach it).
- [x] Implement `gatewayClient` wrapping the inventory in
      `docs/gateway-api-inventory.md`: login (service session), create key,
      list keys, revoke key. (Per-key usage read deferred to M4.)
- [x] Acceptance: control plane can mint and revoke a gateway key via its own
      CLI/script (`scripts/`), reusing the exact calls proven in the scaffold.

## M1 — Identity ✅

- [x] Signup + login + logout with sessions (opaque bearer tokens, hashed at
      rest; see `schema.sql`).
- [x] Admin role bootstrap (first user or `ADMIN_EMAILS` env).
- [x] `/health`, error envelope.
- [x] Acceptance: two users can sign up and get distinct sessions; disabled
      users can't log in (verified live).

## M2 — Per-user gateway keys ✅ (key lifecycle)

- [x] On signup: mint a gateway key via the gateway client, store mapping in
      `gateway_keys` (verified: key authenticates on /v1/models).
- [x] On disable/delete: revoke gateway key (verified: key 401s after disable).
- [x] Key rotation endpoint (`POST /api/me/gateway-key/rotate`).
- [x] Decide integration option A vs B (chosen: **A — browser holds key**).
      The builder surface fetches the user's key and uses it as its
      `OpenAILike` key; quota gating lives in its middleware calling
      `/api/internal/quota-check` (M3). The M7 session bridge is the path away
      from A.
- [x] Acceptance: each user's requests are attributed to their own gateway key
      (key-per-user visible in the gateway dashboard).

## M3 — Quotas ✅ (server-side gate + key spend caps)

- [x] Server-side enforcement middleware in the builder surface: a turn calls
      `GET /api/internal/quota-check` (identity = the user's gateway key)
      before streaming; 429 with reasons when over. Fail-open if the control
      plane is unreachable; host-key ("skip for now") traffic is never gated.
      Toggle: `DISTRO_ENFORCE_QUOTA`.
- [x] Hard spend cap on each per-user gateway key at mint/rotate
      (`dailyUsageLimitUsd`, `weeklyUsageLimitUsd`) — the backstop when the
      gateway is called directly.
- [x] Acceptance: capped user's turn returns HTTP 429 with reasons
      (verified over HTTP against the running stack); admin can change the
      cap and it applies without key rotation (null clears a limit).

## M4 — Usage visibility ✅ (chat reports + authoritative gateway-ledger sync)

- [x] `POST /api/internal/usage-report` — the builder surface records every
      finished turn (tokens in/out + call count) against the user after
      streaming (real-time fill between syncs).
- [x] **Authoritative sync from the gateway's own ledger**: `usage_history`
      rows carry `api_key_id`, so the control plane reads the gateway SQLite
      volume (mounted ro) and replaces each user's `usage_cache` with the
      gateway's per-key aggregates for the day — covering ALL traffic under
      the key (chat, direct /v1, dashboard usage), not just console turns.
      Scheduled via `CONTROL_SYNC_INTERVAL_MS`; CLI: `control.mjs usage-sync`.
      NOTE: requires the gateway's data dir mounted read-only at
      `GATEWAY_DATA_DIR`. With the shared remote gateway there is no such
      volume, so the interval defaults to 0 (off) and usage reports + key spend
      caps carry the accounting.
- [x] `GET /me/usage` (today snapshot) and quota decisions consume it, so
      daily request/token caps are gateway-authoritative after each sync.
- [x] Minimal UI: admin console usage columns (`/admin`).
- [x] Schema-drift guard: a failed gateway read warns and never crashes;
      usage reports keep caps working meanwhile.

Verified live: sync matched the operator's account key against the gateway
ledger (per-key rows → usage_cache) and left unmapped keys (host key, deleted
test accounts) untouched.

## M5 — Hardening & operator UX ✅

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
      SQLite store via its online `better-sqlite3 .backup()` (verified
      `integrity_check: ok`) into `./backups/`.
- [x] Key health: `make keys-check` (`scripts/check-account-keys.sh`) asks the
      gateway to accept each stored key and exits non-zero when one is refused;
      `systemd/distro-keys-check.{service,timer}` runs it daily.
- [x] Billing: Magnate integration (`src/billing.js`) — entitlements check,
      plans list, checkout forwarding, plan auto-seed on boot, free-tier
      quota gating (`gatedQuota`). Env: `MAGNATE_URL` /
      `MAGNATE_ENTITLEMENTS_TOKEN` / `MAGNATE_BILLING_SLUG`; runbook:
      docs/ops.md § "Magnate billing integration".

## Open questions — resolved

- ~~Gateway version drift~~ → pinned at 3.8.51 and checked at runtime (M6).
  Re-verifying the inventory before moving the pin is now the documented step.
- ~~Whether OmniRoute exposes per-key model-level usage~~ → it does, in the
  `usage_history` ledger; stored in `usage_models` (M6).
- ~~Option A vs B~~ → A (the surface holds the key), chosen at M2; the M7
  session bridge is the path away from it.
- ~~Where the quota check lives~~ → the builder surface's middleware calling
  `/api/internal/quota-check` (M3).
- ~~Does Distro meter builds?~~ → no. The build plane was retired on
  30 September 2026; the caps that matter are requests, tokens and spend.
