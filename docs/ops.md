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
docker compose up -d --build web

# 4. verify end-to-end
make doctor
# open http://127.0.0.1:5173 → the default provider is the gateway
# (OpenAILike → pick a model the gateway exposes) → ask it to build a tiny app
```

## Topology & ports

| Service | Bind | Ports | Notes |
|---|---|---|---|
| `gateway` (OmniRoute) | 127.0.0.1 | 20128 dashboard · 20129 OpenAI-compatible API · 20132 live WS | internal-only |
| `redis` | compose net | (none published) | gateway rate-limiter backend |
| `web` (Distro) | 127.0.0.1 | 5173 | the public surface — front with your TLS reverse proxy |

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

Front `web` (:5173) only. nginx example:

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

## Where multi-tenant plugs in

See `docs/multi-tenant.md`. Short version: user auth + per-user gateway keys +
quota/usage surfacing get added in Phase 2, on top of this same compose
layout (control-plane service joins the network; the web app's single
`OPENAI_LIKE_API_KEY` becomes per-user keys issued at login).
