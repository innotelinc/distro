# Distro — Operations Runbook

Target style: self-hosted, root-on-Ubuntu, single host, `docker compose`.

## First boot (tl;dr)

```bash
# 0. prerequisites
docker --version && docker compose version     # Docker Engine + Compose v2

# 1. clone the repo, then bootstrap
./scripts/bootstrap.sh                          # creates .env, generates secrets,
                                                # starts redis + gateway, prints next steps
# 2. in a browser: register providers + issue a gateway key
#    dashboard http://127.0.0.1:20128  (login = INITIAL_PASSWORD from .env)
#    → register upstream API keys (Anthropic/OpenAI/…)
#    → Settings → API Keys → create a key

# 3. put the key in .env, start the web app
OPENAI_LIKE_API_KEY=<gateway-key>   # edit .env

# model preselection + build heap (optional)
VITE_DEFAULT_MODEL=gemini/gemini-2.5-flash   # catalog id, prefix included; empty = auto-pick
BUILD_HEAP_MB=4096                           # V8 heap cap for building apps/web
docker compose up -d --build web

# 4. verify end-to-end
make doctor
# open http://127.0.0.1:5173 (landing) → Start building → /app
# Distro is gateway-only: pick any model the gateway exposes → ask it to
# build a tiny app
```

## Topology & ports

| Service | Bind | Ports | Notes |
|---|---|---|---|
| `gateway` (OmniRoute) | `GATEWAY_BIND_HOST` (default 0.0.0.0) | 20128 dashboard · 20129 OpenAI-compatible API · 20132 live WS | LAN-accessible; protect with the admin password + gateway keys |
| `redis` | compose net | (none published) | gateway rate-limiter backend |
| `web` (Distro) | `WEB_BIND_HOST` (default 0.0.0.0) | 5173 | app at `/app`, landing at `/` — front with your TLS reverse proxy |
| `control-plane` | `CONTROL_BIND_HOST` (default 0.0.0.0) | 20140 API · `/admin` console | accounts/quotas/keys — admin console requires an admin login |

All services bind **0.0.0.0 by default** so the whole stack is reachable from
other machines on the LAN (`http://<host-ip>:5173`, `…:20140/admin`, `…:20128`).
Set `WEB_BIND_HOST`/`CONTROL_BIND_HOST`/`GATEWAY_BIND_HOST` to `127.0.0.1` in
`.env` to pull any of them back to loopback-only. `LIVE_WS_ALLOWED_ORIGINS`
controls which origins may open the gateway's live workspace websocket.

If the gateway and the web app run on *different* hosts, don't use the root
compose `web` service: run `apps/web` standalone (see `apps/web/README.md`)
and set `OPENAI_LIKE_API_BASE_URL` to the gateway's host, e.g.
`https://gateway.example.com/v1`. Keep the dashboard on a private network.

## Secrets

| Where | What |
|---|---|
| `.env` `JWT_SECRET` | gateway dashboard sessions — `openssl rand -base64 48` |
| `.env` `API_KEY_SECRET` | encrypts upstream provider keys at rest in the gateway DB |
| `.env` `INITIAL_PASSWORD` | first dashboard login; change it in the dashboard afterwards |
| `.env` `OPENAI_LIKE_API_KEY` | gateway-issued key the Distro agent uses |
| gateway volume `gateway-data` | SQLite DB with encrypted provider keys + usage ledger |

Never put upstream provider keys in `.env` or anywhere in Distro — they live
only in the gateway's DB volume. Back up `gateway-data` (and `redis-data` if
you care about rate-limit state) with your normal volume backups.

## Day-2 operations

```bash
make ps              # status
make logs            # tail everything (add a service name to narrow)
make doctor          # gateway + web health
docker compose exec gateway node healthcheck.mjs   # gateway self-check
```

- **Admin console** (multi-tenant): `http://<host>:20140/admin` — sign in with
  an admin account (first signup on the instance is admin; promote more via
  the console). Manage users, per-user daily limits (requests/tokens/spend),
  gateway keys, and read the audit log there.
- **Quota enforcement**: `DISTRO_ENFORCE_QUOTA=true` (default) makes the web
  app ask the control plane before each chat turn (429 when over a daily
  cap) and report usage after it. Gateway-key spend caps still apply even if
  the control plane is down.
- **Usage is gateway-authoritative**: the control plane syncs the gateway's
  own per-key ledger (`usage_history` in the gateway SQLite volume, mounted
  read-only) into `usage_cache` every `CONTROL_SYNC_INTERVAL_MS` (default
  2 min). Manual run:
  `docker compose exec control-plane node bin/control.mjs usage-sync`.
- **Audit**: signups, key rotations/revokes, quota/role/disable changes and
  deletions are recorded in `audit_log` and shown in the admin console
  (`GET /api/admin/audit`).
- **Backups**: `make backup` (or `./scripts/backup.sh`) snapshots both the
  control-plane and gateway SQLite stores — each via the app's own online
  `better-sqlite3 .backup()`, so no downtime — into `./backups/`
  (git-ignored; prune keeps 14 days). Cron example:
  `0 3 * * * cd /opt/distro && ./scripts/backup.sh >> /var/log/distro-backup.log 2>&1`
  Restore: copy a `backups/control-plane/control-*.sqlite` to the
  `control-data` volume path (`/data/control.sqlite`) with the stack stopped;
  the gateway copy goes to `/app/data/storage.sqlite` on `gateway-data`.

- **Upgrading the gateway**: bump `OMNIROUTE_IMAGE_TAG` in `.env`, then
  `docker compose up -d gateway`. Check the upstream changelog
  (`vendor/omniroute/CHANGELOG.md` after `make sync-upstream`) for schema
  migrations — the SQLite volume is upgraded in place, so back it up first.
- **Upgrading Distro web**: `git pull` (or apply upstream bolt.diy changes per
  `docs/upstream.md`), then `docker compose up -d --build web`.
- **Updating the vendor snapshot** (source checkout for reference/dev):
  `make sync-upstream`.

## Sizing

- The OmniRoute container's Node heap is set via
  `GATEWAY_MAX_OLD_SPACE_MB` (default **4096**; upstream's own compose pins
  2048 and its docs warn the default container is tuned for dashboard/light
  chat — coding-agent traffic with large overlapping contexts will OOM a
  1 GB heap). Watch `docker stats` and `docker compose logs gateway` for
  heap/OOM errors and raise if needed.
- Distro web is a Cloudflare-pages/workerd runtime + static client; it is
  light. The browser does the heavy lifting (WebContainer runs in the tab).
- 7 GB RAM is workable for a small single-host deployment; give the box headroom
  for the gateway at 4 GB heap plus builds (`docker compose build`).

## Reverse proxy (TLS)

Front `web` (:5173) only; nginx proxy manager (NPM) host entries work the
same way. Two details verified in testing: add `proxy_buffering off;` so
`/api/chat` streams (buffering delays first tokens), and leave websocket
upgrade headers out unless you proxy them — the IDE/preview runs in the
browser, so no WS is needed for the app itself. If you also give the admin
console its own hostname, proxy `:20140` the same way and set
`CONTROL_CORS_ORIGIN` (see below). nginx example:

```nginx
server {
  listen 443 ssl;
  server_name distro.example.com;
  # ssl_certificate …; ssl_certificate_key …;
  location / {
    proxy_pass http://127.0.0.1:5173;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";   # WebContainer/terminal websockets
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 600s;
  }
}
```

Do **not** expose ports 20128/20129/20132 publicly — the gateway is
internal-only; Distro is the only surface.

### Multi-tenant control plane behind TLS

The browser logs in against the control plane directly (option A per-user
gateway keys), so when `web` is served over HTTPS the control-plane base URL
must also be HTTPS or browsers block it as mixed content. Two settings:

- `VITE_CONTROL_PLANE_URL=https://admin.example.com` (build-time; baked into
the client bundle → rebuild web: `docker compose up -d --build web`).
- `CONTROL_CORS_ORIGIN=https://app.example.com` (runtime; strict-origin CORS
on the control plane — only that exact origin gets the allow header, and
preflights from any other origin get 403). Leave both empty for direct-LAN
use, where the app auto-derives `http://<app-hostname>:20140` and CORS is
permissive `*`.

## Where multi-tenant plugs in

See `docs/multi-tenant.md`. Short version: user auth + per-user gateway keys +
quota/usage surfacing get added in Phase 2, on top of this same compose
layout (control-plane service joins the network; the web app's single
`OPENAI_LIKE_API_KEY` becomes per-user keys issued at login).
