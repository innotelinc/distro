# Distro Control Plane

> Status: **M0–M2 slice implemented and running** — a small Node service with
> accounts, sessions, and **one OmniRoute gateway API key per user**. The M3+
> quota middleware/usage sync and the web-app integration are still roadmap.

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
| Admin API | `GET /api/admin/users`, `PATCH /api/admin/users/:id` (disable/quota), `POST …/revoke-key` | disabling a user revokes their gateway key |
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
GET    /api/me/quota-status                                       → { allowed, reasons, quota }   (M3 coarse check)

CORS is enabled so the Distro web UI can call this API directly from the
browser (`CONTROL_CORS_ORIGIN` restrict, default `*`). The control-plane port
publishes on `CONTROL_BIND_HOST` (default 0.0.0.0, same as the gateway).
GET    /api/admin/users                                           → users + quotas + key presence
PATCH  /api/admin/users/:id       { disabled?, quota? }           → disable revokes gateway key
POST   /api/admin/users/:id/revoke-key
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

## Still to do (next milestones)

- M3: per-request quota middleware + gateway usage-limits on each user key,
  and the web-app integration (option A: web fetches `/api/me/gateway-key` at
  login; option B: control plane proxies /v1).
- M4: scheduled usage sync from the gateway into `usage_cache` and a usage UI.
- M5: admin UI, audit log, backups, billing hooks.

Full breakdown + open questions: [docs/roadmap.md](docs/roadmap.md).
Design rationale: [docs/multi-tenant.md](../../docs/multi-tenant.md).
Gateway endpoints used: [docs/gateway-api-inventory.md](docs/gateway-api-inventory.md).
