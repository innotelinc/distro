# Distro Control Plane

> Status: **M0–M5 implemented and running** — accounts, **one OmniRoute
> gateway API key per user**, server-side quota enforcement (M3), usage
> visibility backed by the gateway's own per-key ledger (M4) and an admin
> console with audit log + backups (M5). Web-app integration is live (login,
> per-user keys, quota gate, usage reports). Remaining: billing hooks only if
> paid tiers are in scope.
>
> M4 detail: the gateway's HTTP usage logs drop key attribution, but its
> SQLite `usage_history` carries `api_key_id` — given the gateway's data dir
> mounted read-only at `GATEWAY_DATA_DIR`, the control plane syncs per-key
> aggregates into `usage_cache` (`CONTROL_SYNC_INTERVAL_MS`, or `control.mjs
> usage-sync`). The shared gateway is remote, so that mount is absent by
> default and the interval is 0.
> See [docs/gateway-api-inventory.md](docs/gateway-api-inventory.md).

The control plane is Distro's Phase 2 multi-tenant layer: Distro accounts,
**one gateway API key per user**, quota enforcement and usage visibility on
top of the shared OmniRoute gateway.

Why per-user gateway keys: OmniRoute already does token/cost accounting,
quota windows and rate limiting **per API key**, so mapping
`distro_user ↔ gateway_key` gives per-user attribution and enforcement for
free — no gateway forking required.

## What is implemented (this milestone)

| Area | Where | Notes |
|---|---|---|
| Service skeleton | `src/server.js`, `src/http.js`, `Dockerfile` | plain Node HTTP, no framework; zero public ports in compose |
| SQLite store | `src/db.js` + `schema.sql` | users, sessions, gateway_keys, quotas, usage_cache |
| Passwords | `src/passwords.js` | scrypt (node:crypto), no deps |
| Gateway client | `src/gateway.js` | management login, create/list/revoke keys against the dashboard API (verified v3.8.51); `version()` probes `/api/monitoring/health` → `/api/health` |
| Gateway-version pin (M6) | `src/gatewayVersion.js` + `GATEWAY_EXPECTED_VERSION` (default `3.8.51`) | checked at boot and before every usage sync; mismatch = warn + `gateway.version-mismatch` alert + red card in `/admin`, never a stop. `control.mjs gateway-check` prints it |
| Per-model usage (M6) | `usage_models` table; `models` on `GET /api/me/usage` and `/api/admin/stats`, `usageModelsToday` on admin users | filled by chat usage reports that name a `model` and replaced by the gateway-ledger sync; `usage_cache` stays the quota authority. *Model usage — today* panel in `/admin` |
| Identity (M1) | `POST /api/auth/signup`, `/api/auth/login`, `/api/auth/logout`, `GET /api/me` | first account = admin; otherwise role from `ADMIN_EMAILS` |
| Authentik SSO | `src/oidc.js` + `/api/auth/oidc/{config,start,callback}` | OIDC authorization-code login via Authentik (popup posts the session back to the app); SSO accounts get an unusable `sso:` password hash, auto-provisioned with their own gateway key. Verified against a local OIDC mock |
| Per-user keys (M2) | signup mints a key; `GET /api/me/gateway-key`; `POST /api/me/gateway-key/rotate` | key lifecycle driven through the gateway dashboard API |
| Quota gate (M3) | `GET /api/internal/quota-check` + `POST /api/internal/usage-report` | the web app identifies the user by their gateway key and enforces/records before/after each chat turn (`DISTRO_ENFORCE_QUOTA`) |
| Build-plane quota (M7) | `POST /api/internal/build-check` | service token + Authentik `sub`: may this identity `build.*` now? Shares the chat caps (same key); `build.start` is judged against `builds_per_day` and counted with `consume: true`; refusals are `build.denied` audit rows + the quota alert |
| Tenancy for the builder (convergence §5.2) | `POST /api/internal/identity` + `POST /api/internal/audit` | service-to-service (`x-control-internal-token` = `CONTROL_INTERNAL_TOKEN`): resolves an Authentik `sub` to an account (creating it and minting its key on first sight, `users.oidc_sub` is the join), so Studio can key its library on the control-plane user id, spend the user's own key, and write build/publish/export rows into `audit_log` |
| Usage sync (M4) | `src/sync.js` + `src/gatewayUsage.js` | scheduled/CLI sync of the gateway's per-key ledger into `usage_cache` (needs the gateway data dir mounted ro at `GATEWAY_DATA_DIR`; off for the remote gateway) |
| Admin API (M5) | users list/stats, PATCH (disable, quota, role), revoke/rotate key, DELETE user, audit list | disabling/deleting revokes the gateway key; last-admin guard |
| Admin console (M5) | `GET /admin` → `src/admin.html` | no build step, no CDNs; login as an admin |
| Build-queue view (§5.2) | `src/buildQueue.js` + `GET /api/admin/build-queue` | read-only render of Studio's queue (`STUDIO_BUILD_QUEUE_DIR`): jobs merged from request+status files, the runner's heartbeat, per-state counts. Never writes, claims or cancels — the runner stays the only writer |
| Authentik group mapping | `src/authentik.js` + `/api/admin/identity-groups/*` | mirrors the configured Authentik group, creates it when missing, provisions missing local users and replaces the local membership cache |
| Cloud storage providers and pools | `cloud_storage_providers`, `storage_pools` + `/api/admin/storage-{providers,pools}` | Shares GUI can register providers and create logical pools rooted at a provider path; stores metadata and Vault references only, never raw provider credentials |
| Audit log (M5) | `audit_log` table + `GET /api/admin/audit` | signups, key lifecycle, quota/role/disable changes, deletes. `?action=<prefix>` narrows to a namespace (`build.` = rows Studio writes), `?user=<id>` to rows an account performed or was the target of |
| Build-plane audit by user (M7) | "Build plane — audit by user" panel in `/admin` | per-user view of `build.*` rows (start/preview/publish/export) with user + action filters and a **Build audit** shortcut per user row; http(s) preview/publish URLs are linkified |
| Alert history | `alert_log` table + `GET /api/admin/alerts` | every webhook attempt (sent/failed) recorded; cooldown-suppressed repeats are not |
| Spend rollups | `usage7d` on users, `week` on stats, admin console columns/cards | rolling 7-day totals from the gateway-ledger usage cache |
| Backups (M5) | `make backup` → `scripts/backup.sh` | online `.backup()` of control + gateway DBs into `./backups/` |
| CLI | `bin/control.mjs` | `health`, `create-admin`, `users`, `gateway-check`, `usage-sync`, `test-alert`, `backup` |

## HTTP API

All endpoints return JSON. Auth = `Authorization: Bearer <token>` from login.

```
GET    /health
POST   /api/auth/signup            { email, password, plan? }      → 201 user+quota (mints gateway key)
POST   /api/auth/login             { email, password }             → 200 { token, user }
POST   /api/auth/logout
GET    /api/me                                                    → user, quota, usageToday
GET    /api/me/gateway-key                                        → { gatewayKeyId, gatewayKey }   (option A)
POST   /api/me/gateway-key/rotate                                 → fresh key (old one revoked)
GET    /api/me/usage                                              → today snapshot (M4: cache only)
GET    /api/me/quota-status                                       → { allowed, reasons, quota }

# Auth (session token) — same as the web UI; `GET /api/me` returns the current user

# Authentik SSO (optional, OIDC) — popup flow
GET    /api/auth/oidc/config                                      → { enabled, provider, issuerHost }
GET    /api/auth/oidc/start                                       → 302 to Authentik authorize
GET    /api/auth/oidc/callback                                    → exchanges code, posts session to opener

# Internal — called server-side by a sibling platform; never exposed to browser JS.
# Quota routes: auth by the user's gateway key (`Authorization: Bearer sk-…`).
GET    /api/internal/quota-check                                  → { allowed, reasons, quota, usageToday }
POST   /api/internal/usage-report  { tokensIn, tokensOut, requests } → { ok, usageToday }

# Internal — service-to-service, auth by `x-control-internal-token`
# (= CONTROL_INTERNAL_TOKEN). Unset token = these are OFF (503), never open.
# identity resolves an Authentik subject to an account + its gateway key,
# provisioning the account on first sight (409 if the email is bound to a
# DIFFERENT subject — never silently rebound).
POST   /api/internal/identity      { sub, email, name? }           → user, oidcSub, created, gatewayKeyId, gatewayKey, quota, usageToday
POST   /api/internal/audit         { action, sub?, actorEmail?, targetId?, targetEmail?, meta? } → 201 { ok: true }
                                                                    action must match ^[a-z][a-z0-9._-]{0,79}$
                                                                    (build.start, build.publish, build.export, …)

# Admin — auth by session token; admin role required (first signup or ADMIN_EMAILS)
# `/api/admin/build-queue` is read-only: it renders Studio's queue directory
# (STUDIO_BUILD_QUEUE_DIR, unset = the panel says it is not mounted) so the
# builder's work is visible where the users and quotas already are. It never
# writes, claims or cancels a job — the runner stays the only writer.
GET    /api/admin/stats                                           → aggregate today totals
GET    /api/admin/identity-groups                                 → local Authentik group mappings
POST   /api/admin/identity-groups/sync                            → create/find configured group and sync members
GET    /api/admin/storage-providers                              → provider metadata for Shares
POST   /api/admin/storage-providers                              → add provider metadata
PATCH  /api/admin/storage-providers/:id                          → edit provider metadata
DELETE /api/admin/storage-providers/:id                          → remove provider metadata
GET    /api/admin/storage-pools                                  → list storage pools
POST   /api/admin/storage-pools                                  → create a pool for a provider
DELETE /api/admin/storage-pools/:id                              → remove a pool
GET    /api/shares/storage-providers                             → enabled providers for signed-in Shares views
GET    /api/shares/storage-pools                                 → enabled pools for signed-in Shares views
GET    /api/admin/build-queue                                     → read-only view of the builder's queue:
                                                                    { configured, dir, readable, runner, counts, jobs }
                                                                    (configured=false when STUDIO_BUILD_QUEUE_DIR is unset)
GET    /api/admin/users                                           → users + quotas + usageToday + key
PATCH  /api/admin/users/:id       { disabled?, quota?, role? }    → disable/delete revokes gateway key
POST   /api/admin/users/:id/revoke-key
POST   /api/admin/users/:id/rotate-key
DELETE /api/admin/users/:id                                      → revokes key, removes account
GET    /admin                                                     → admin console (static HTML)

CORS is enabled so the Distro web UI can call this API directly from the
browser (`CONTROL_CORS_ORIGIN` restrict, default `*`). The control-plane port
publishes on `CONTROL_BIND_HOST` (default 0.0.0.0, same as the gateway).
```

## Run

As part of the stack:

```bash
docker compose up -d --build control-plane
docker compose exec control-plane node bin/control.mjs gateway-check
docker compose exec control-plane node bin/control.mjs users
```

Configuration (from env): `PORT`/`HOST` (default `20140`/`0.0.0.0`),
`CONTROL_DB_PATH` (`/data/control.sqlite` in the image), `GATEWAY_DASHBOARD_URL`,
`GATEWAY_ADMIN_PASSWORD`, `ADMIN_EMAILS`, `CONTROL_INTERNAL_TOKEN` (the
service-to-service token Studio presents; unset disables those endpoints),
`CONTROL_SYNC_INTERVAL_MS` (M4 sync
period; 0 disables), `GATEWAY_DATA_DIR` (unset by default — see below),
`AUTHENTIK_API_URL`, `AUTHENTIK_API_TOKEN`, and `AUTHENTIK_GROUP_NAME` for
automatic group membership mapping. Cloud provider credentials are represented
by `credential_ref` values pointing into the deployment's secret store.
The
compose service wires these from the root `.env`
(`GATEWAY_ADMIN_PASSWORD=${INITIAL_PASSWORD}`) and mounts a `control-data`
volume. It mounts **no** gateway volume: the gateway is the shared remote
service, so `GATEWAY_DATA_DIR` stays unset and the M4 sync is off
(`CONTROL_SYNC_INTERVAL_MS=0`) unless you mount a gateway data dir read-only
yourself.

## Tests

```bash
cd apps/control-plane && npm install && npm test
```

`node --test test/*.test.mjs` — no framework, one native dependency
(`better-sqlite3`), and the same HTTP handler the server mounts. The internal API
is tested against a real SQLite file because the parts worth checking are the ones
a stub would hide: the schema migration (a database created before `oidc_sub`
existed), the subject ↔ account join, which credential each route demands, and
that an unset `CONTROL_INTERNAL_TOKEN` turns the provisioning routes **off**
rather than leaving them open. The gateway is the one thing faked, since minting a
key is a call to another service.

## Still to do

- Billing hooks / paid tiers, if ever in scope.
- Actual provider-specific sync/mount workers: this milestone registers safe
  provider metadata and secret references; ONYX or a dedicated worker should
  perform file operations using those references.

Full breakdown + open questions: [docs/roadmap.md](docs/roadmap.md).
Design rationale: [docs/multi-tenant.md](../../docs/multi-tenant.md).
Gateway endpoints used: [docs/gateway-api-inventory.md](docs/gateway-api-inventory.md).
