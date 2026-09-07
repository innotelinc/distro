# Distro Control Plane

> Status: **M0–M5 implemented and running** — a small Node service providing
> Distro accounts, **one OmniRoute gateway API key per user**, server-side
> quota enforcement (M3), usage accounting for chat traffic (M4) and an admin
> console at `/admin` (M5). The web-app integration is live (login, per-user
> keys, quota gate, usage reporting).
>
> Known M4 gap: OmniRoute's request logs lack per-key attribution, so usage
> from direct `/v1` calls can't be synced per user yet — chat traffic is fully
> accounted. See [docs/roadmap.md](docs/roadmap.md).

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
| Gateway client | `src/gateway.js` | management login, create/list/revoke keys against the dashboard API (verified v3.8.51) |
| Identity (M1) | `POST /api/auth/signup`, `/api/auth/login`, `/api/auth/logout`, `GET /api/me` | first account = admin; otherwise role from `ADMIN_EMAILS` |
| Per-user keys (M2) | signup mints a key; `GET /api/me/gateway-key`; `POST /api/me/gateway-key/rotate` | key lifecycle driven through the gateway dashboard API |
| Quota gate (M3) | `GET /api/internal/quota-check` + `POST /api/internal/usage-report` | the web app identifies the user by their gateway key and enforces/records before/after each chat turn (`DISTRO_ENFORCE_QUOTA`) |
| Admin API (M5) | users list/stats, PATCH (disable, quota, role), revoke/rotate key, DELETE user | disabling/deleting revokes the gateway key; last-admin guard |
| Admin console (M5) | `GET /admin` → `src/admin.html` | no build step, no CDNs; login as an admin |
| CLI | `bin/control.mjs` | `health`, `create-admin`, `users`, `gateway-check` |

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

# Internal — auth by the user's gateway key (`Authorization: Bearer sk-…`),
# called server-side by the Distro web app; never exposed to browser JS.
GET    /api/internal/quota-check                                  → { allowed, reasons, quota, usageToday }
POST   /api/internal/usage-report  { tokensIn, tokensOut, requests } → { ok, usageToday }

# Admin — auth by session token; admin role required (first signup or ADMIN_EMAILS)
GET    /api/admin/stats                                           → aggregate today totals
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
`GATEWAY_ADMIN_PASSWORD`, `ADMIN_EMAILS`. The compose service wires these from
the root `.env` (`GATEWAY_ADMIN_PASSWORD=${INITIAL_PASSWORD}`) and mounts a
`control-data` volume.

## Still to do

- M4 remainder: a per-key usage read from OmniRoute (blocked — its request
  logs carry no key attribution) to also account direct `/v1` traffic.
- M5 remainder: audit log (signups, key rotations, quota changes), DB backup
  automation, billing hooks (only if paid tiers are in scope).

Full breakdown + open questions: [docs/roadmap.md](docs/roadmap.md).
Design rationale: [docs/multi-tenant.md](../../docs/multi-tenant.md).
Gateway endpoints used: [docs/gateway-api-inventory.md](docs/gateway-api-inventory.md).
