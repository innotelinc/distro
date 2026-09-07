# Distro — Operations Runbook

Target style: self-hosted, root-on-Ubuntu, single host, `docker compose`.

## First boot (tl;dr)

```bash
# 0. prerequisites
docker --version && docker compose version     # Docker Engine + Compose v2

# 1. clone the repo, then bootstrap
./scripts/bootstrap.sh                          # creates .env, generates secrets,
                                                # discovers the REMOTE gateway (env
                                                # override or Consul), prints next steps
#    (alternatively: skip bootstrap and pull pre-built images — see GHCR section)
```
# 2. in a browser: register providers + issue a gateway key
#    REMOTE (platform stack): dashboard on Server 2 :20128 — discover it with
#      ./stack.sh discover omniroute
#    LOCAL fallback only: http://127.0.0.1:20128 (login = INITIAL_PASSWORD)
#    → register upstream API keys (Anthropic/OpenAI/…)
#    → Settings → API Keys → create a key

# 3. put the key + gateway URL in .env, start the web app
OPENAI_LIKE_API_KEY=<gateway-key>            # edit .env
OPENAI_LIKE_API_BASE_URL=http://10.10.2.1:20129/v1   # the gateway's /v1

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

## Pre-built images (GHCR)

Every release publishes Docker images to the GitHub Container Registry:

| Image | GHCR path |
|---|---|
| Control plane | `ghcr.io/innotelinc/distro/control-plane` |
| Web app | `ghcr.io/innotelinc/distro/web` |

Tags: `:latest` (tracks `main`) and `:<semver>` (e.g. `:0.1.0`).  To use them
instead of building locally:

**1. Log in to GHCR** (required for private repos; optional but recommended
for public — avoids Docker Hub rate-limit confusion):

```bash
# with a GitHub personal access token (classic) that has read:packages scope
docker login ghcr.io -u <github-username> -p <pat-token>

# or, if you have the gh CLI installed:
gh auth token | docker login ghcr.io -u <github-username> --password-stdin
```

**2. Replace `build:` with `image:` in your compose file:**

```yaml
services:
  web:
    image: ghcr.io/innotelinc/distro/web:0.1.0   # or :latest
    # drop the build: block
  control-plane:
    image: ghcr.io/innotelinc/distro/control-plane:0.1.0
```

**3. Pull and start:**

```bash
docker compose pull && docker compose up -d
```

Note: the web image expects `VITE_DISTRO_GATEWAY_ONLY=true` and
`VITE_DISTRO_CONTROL_PLANE=true` at build time (baked into the default
GHCR image), so no additional build-args are needed when pulling.

## Topology & ports

| Service | Bind | Ports | Notes |
|---|---|---|---|
| `gateway` (OmniRoute, profile `local-gateway`) | `GATEWAY_BIND_HOST` (default 0.0.0.0) | 20128 dashboard · 20129 OpenAI-compatible API · 20132 live WS | LOCAL fallback only. The DEFAULT gateway is the shared platform OmniRoute (Server 2, Consul service `omniroute`) — pin it with `OPENAI_LIKE_API_BASE_URL`/`GATEWAY_DASHBOARD_URL` or let Consul discover it |
| `redis` (profile `local-gateway`) | compose net | (none published) | rate-limiter backend for the LOCAL gateway fallback only |
| `web` (Distro) | `WEB_BIND_HOST` (default 0.0.0.0) | 5173 | app at `/app`, landing at `/` — front with your TLS reverse proxy |
| `control-plane` | `CONTROL_BIND_HOST` (default 0.0.0.0) | 20140 API · `/admin` console | accounts/quotas/keys — admin console requires an admin login |

All services bind **0.0.0.0 by default** so the whole stack is reachable from
other machines on the LAN (`http://<host-ip>:5173`, `…:20140/admin`). Set
`WEB_BIND_HOST`/`CONTROL_BIND_HOST` (and, for the local fallback gateway,
`GATEWAY_BIND_HOST`) to `127.0.0.1` in `.env` to pull any of them back to
loopback-only. `LIVE_WS_ALLOWED_ORIGINS` controls which origins may open the
(LOCAL) gateway's live workspace websocket.

**Remote gateway (default).** The AI plane is the platform OmniRoute on
Server 2 of the Innotel platform stack. Distro discovers it via Consul
(`CONTROL_CONSUL_URL`, service `omniroute`) or pins it explicitly:

```
OPENAI_LIKE_API_BASE_URL=http://10.10.2.1:20129/v1   # web app → gateway API
GATEWAY_DASHBOARD_URL=http://10.10.2.1:20128         # control plane → admin API (optional; Consul by default)
```

Verify with `make doctor`. To run everything self-contained instead (offline
box, air-gapped lab), enable the bundled fallback:
`docker compose --profile local-gateway up -d`.

If the gateway and the web app run on *different* hosts without Consul, don't
use the root compose `web` service: run `apps/web` standalone (see
`apps/web/README.md`) and set `OPENAI_LIKE_API_BASE_URL` to the gateway's
host, e.g. `https://gateway.example.com/v1`. Keep the dashboard on a private
network.

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
- **Usage is chat-report-authoritative in remote-gateway mode**: the control
  plane syncs the gateway's own per-key ledger (`usage_history` in the gateway
  SQLite volume, mounted read-only) into `usage_cache` every
  `CONTROL_SYNC_INTERVAL_MS` — but that volume only exists when the gateway
  runs LOCALLY (profile `local-gateway`). With the remote platform gateway the
  interval defaults to 0 (off) and quota accounting uses chat-traffic usage
  reports plus key spend caps. Local deployments can re-enable the scheduled
  sync by setting `CONTROL_SYNC_INTERVAL_MS`. Manual run:
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

- **Upgrading the (LOCAL fallback) gateway**: bump `OMNIROUTE_IMAGE_TAG` in
  `.env`, then `docker compose --profile local-gateway up -d gateway`. Check
  the upstream changelog (pinned version notes in docs/upstream.md) for schema
  migrations — the SQLite volume is upgraded in place, so back it up first.
  The REMOTE platform gateway is upgraded by the platform operators
  (server 2); Distro only needs the right `OPENAI_LIKE_API_BASE_URL`/key.
- **Upgrading Distro web**: `git pull` (or apply upstream bolt.diy changes per
  `docs/upstream.md`), then `docker compose up -d --build web`.  Alternatively,
  pull the latest GHCR image: `docker compose pull web && docker compose up -d web`.
  To pin a release version, set `image:` in the web service and remove `build:`.
- **Updating the vendor snapshot** (source checkout for reference/dev):
  `make sync-upstream`.

## Sizing

- The LOCAL gateway container's Node heap is set via
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

### Cerulean / Authentik SSO (optional)

Distro's control plane can sign users in through Cerulean's Authentik instead of
email/password. Cerulean is the stack's **TrustOps** platform: it hosts the
shared Authentik instance, automates DNS (RFC 2136 BIND nsupdate + TSIG), and
issues wildcard Let's Encrypt certs via DNS-01. Atlas, Magnate and the rest of
the stack sign in through the same Authentik.

In Cerulean's Authentik: create an application + provider of type **OAuth2/OIDC
Provider** with scopes `openid email profile`, then set these in Distro `.env`
(control plane reads them on recreate — no rebuild):

```
OIDC_ISSUER_URL=https://auth.cerulean.innotel.us/application/o/distro/
OIDC_CLIENT_ID=<from Cerulean>
OIDC_CLIENT_SECRET=<from Cerulean>
OIDC_REDIRECT_URI=https://app.example.com/cp/api/auth/oidc/callback
```

The redirect URI is the control-plane callback **as the browser sees it**
(`/cp/...` under the same-origin proxy layout, or
`http://<host>:20140/api/auth/oidc/callback` on direct LAN). Paste the same
URL as the provider's redirect URI in Authentik. Leave all four empty to
disable SSO — the button disappears from `/login`.

SSO accounts are auto-provisioned on first sign-in (role: admin if the email is
in `ADMIN_EMAILS` or it is the first account, otherwise `user`), get their own
gateway key, and cannot use password login (their stored hash is an unusable
`sso:` sentinel). The login page runs the flow in a popup and stores the session
exactly like password login, so quotas and the admin console work unchanged. New
SSO signups land in the audit log as `user.oidc-signup` (existing users:
`user.oidc-login`).

### Why the live preview/terminal need HTTPS (or localhost)

The preview and terminal run on WebContainer, which browsers only allow on
**trustworthy origins**: plain HTTP from a LAN IP/hostname makes the browser
ignore the app's COOP/COEP headers (`crossOriginIsolated: false`) and blocks
service workers, so WebContainer can't boot there — chat still works, but the
preview/terminal never connect. This is a browser security rule. Full-shell
access therefore requires `http://localhost:5173`, `http://127.0.0.1:5173`,
or an HTTPS reverse-proxy hostname. The shell shows an amber notice and the
terminal pane prints the reason when it detects this condition.

### Multi-tenant control plane behind TLS

The browser logs in against the control plane directly (option A per-user
gateway keys), so when `web` is served over HTTPS the control-plane base URL
must also be HTTPS or browsers block it. Two layouts:

- **Same-origin `/cp` (default, no env).** On a proxied HTTPS host the app
auto-resolves the control plane to the same origin under `/cp`; add one
advanced nginx location `location /cp/ { proxy_pass http://<host>:20140/; … }`
(trailing `/` strips the prefix) to the app's NPM host. No CORS involved.
Admin console rides along at `https://<host>/cp/admin`.
- **Separate host (optional).** `VITE_CONTROL_PLANE_URL=https://admin.example.com`
(build-time, baked into the client bundle → `docker compose up -d --build web`)
plus `CONTROL_CORS_ORIGIN=https://app.example.com` (runtime, strict-origin: only
that exact origin gets the allow header; other preflights get 403).

Direct-LAN/localhost use needs neither: the app derives
`http://<app-hostname>:20140` and CORS is permissive `*`. `VITE_PUBLIC_ORIGIN`
(same rebuild) sets the public HTTPS origin used by the header indicator's
one-click link when you're on a plain-HTTP origin.

### Authentik SSO (optional)

Sign-in with Authentik instead of email/password. In Authentik: create an
application and a provider of type **OAuth2/OIDC Provider** with scopes
`openid email profile`, then set these in `.env` (control plane picks them up
on recreate — no rebuild):

```
OIDC_ISSUER_URL=https://auth.example.com/application/o/distro/
OIDC_CLIENT_ID=<from Authentik>
OIDC_CLIENT_SECRET=<from Authentik>
OIDC_REDIRECT_URI=https://app.example.com/cp/api/auth/oidc/callback
```

The redirect URI is the control-plane callback **as the browser sees it**
(`/cp/...` under the same-origin proxy layout, or
`http://<host>:20140/api/auth/oidc/callback` on direct LAN). Paste the same
URL as the provider's redirect URI in Authentik. Leave all four empty to
disable SSO — the button disappears from `/login`.

SSO accounts are auto-provisioned on first sign-in (role: admin if the email
is in `CONTROL_ADMIN_EMAILS` or it is the first account, otherwise `user`),
get their own gateway key, and cannot use password login (their stored hash
is an unusable `sso:` sentinel). The login page runs the flow in a popup and
stores the session exactly like password login, so quotas and the admin
console work unchanged. New SSO signups land in the audit log as
`user.oidc-signup` (existing users: `user.oidc-login`).

## Magnate billing integration (optional)

Distro can connect to [Magnate](https://github.com/innotelinc/magnate) for
subscription billing. Magnate is the stack's **RevenueOps** platform: it owns
Stripe, plans, the revenue ledger and subscriber accounts (Cerulean/Authentik-
first — passwords live in Cerulean's Authentik, not in Magnate's app DB). There
is no local Magnate — Distro consumes the platform-stack instance. Distro
checks entitlements via Magnate's server-to-server API and never holds Stripe
keys.

`MAGNATE_URL` resolution order: explicit env → Consul service discovery
(service `magnate`, filled in by bootstrap / `make discover-gateway`) →
billing disabled (free/self-hosted mode with local quotas only).

### Setup

1. **In Magnate**: create a plan with slug `distro` (or any slug — set
   `MAGNATE_BILLING_SLUG` to match). Connect Stripe and set pricing.
   If you want to gate the entitlements/purchase APIs, set Magnate's
   `ENTITLEMENTS_API_TOKEN`; then Distro must send the same value as
   `MAGNATE_ENTITLEMENTS_TOKEN`.

2. **In Distro `.env`** (or let Consul discovery fill `MAGNATE_URL`):
   ```
   MAGNATE_URL=https://magnate.innotel.us         # optional — auto-discovered via Consul
   MAGNATE_ENTITLEMENTS_TOKEN=<shared-secret>     # optional on trusted nets;
                                                  # must equal Magnate's ENTITLEMENTS_API_TOKEN
   MAGNATE_BILLING_SLUG=distro                  # default
   ```

3. Restart the control plane: `docker compose up -d control-plane`

### How it works

- **Entitlement check**: `GET /api/billing/entitlements` (Distro control plane)
  proxies to Magnate's `/api/entitlements?plan=distro&user=<email>`.
  Returns `{ entitled, plan, status, expires_at, source }`. The admin console
  shows this per user, and the quota middleware gates chat turns on it.
- **Plans list**: `GET /api/billing/plans` fetches plans from Magnate's
  `/api/admin/plans` (admin auth via `MAGNATE_ENTITLEMENTS_TOKEN` bearer when
  that token is set on the Magnate side).
- **Checkout**: `POST /api/billing/checkout` with `{ planSlug, interval }`
  forwards to Magnate's `/api/checkout` and returns a Stripe Checkout session
  URL.
- **Graceful degradation**: when Magnate is unreachable, entitlements return
  `{ entitled: null, source: 'unreachable' }` — Distro falls back to local
  quotas. No features are blocked by billing failures.

### Admin console

The admin dashboard (`/admin`) shows:
- **Billing status**: whether Magnate is configured and reachable
- **Per-user entitlements**: each user's subscription plan, status and expiry
- **Checkout link**: generates a Magnate checkout URL for a user

### Magnate + Cerulean relationship

Magnate is Cerulean/Authentik-first. Its `.env.sample` documents the shared
`ENTITLEMENTS_API_TOKEN` that gates `GET /api/entitlements` and `POST
/api/purchases`. Distro reuses the same token as `MAGNATE_ENTITLEMENTS_TOKEN`.
The Magnate storefront and admin panel live under `magnate.innotel.us`; DNS +
wildcard TLS for those hosts are provisioned by Cerulean the same way as every
other platform host.

## Atlas integration (git export)

Distro builds apps live in the browser; Atlas is the stack's **CodeOps** home
(Gitea repos + Chef AI app builder on self-hosted Convex). When
`ATLAS_URL` + `ATLAS_GIT_REMOTE` are both set in Distro `.env`, the control
plane exposes:

- `GET /api/export/config` → `{ configured, url, remote }`
- `POST /api/export/validate` → validates the remote URL (SSH or HTTPS)

The web app uses these to push the current WebContainer project to an
Atlas/Gitea remote (via ssh-agent or WebContainer's git API). Atlas itself
consumes the same Magnate + Cerulean services Distro does, so billing and
identity are shared across the stack.

## Where multi-tenant plugs in

See `docs/multi-tenant.md`. Short version: user auth + per-user gateway keys +
quota/usage surfacing get added in Phase 2, on top of this same compose
layout (control-plane service joins the network; the web app's single
`OPENAI_LIKE_API_KEY` becomes per-user keys issued at login).
