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

# 3. put the service key + gateway URL in .env, start the control plane
OPENAI_LIKE_API_KEY=<gateway-key>            # edit .env — mints/revokes per-user keys
OPENAI_LIKE_API_BASE_URL=http://host.docker.internal:20128/v1   # the gateway's /v1 — distro runs ON the gateway host
docker compose up -d --build

# 4. verify
make doctor
# admin console: http://127.0.0.1:20140/admin (first signup is admin)
# point the builder surface (Studio) at CONTROL_PLANE_INTERNAL_URL +
# CONTROL_INTERNAL_TOKEN — see "Tenancy for the builder" below
```

## Pre-built images (GHCR)

Every release publishes Docker images to the GitHub Container Registry:

| Image | GHCR path |
|---|---|
| Control plane | `ghcr.io/innotelinc/distro/control-plane` |

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
  control-plane:
    image: ghcr.io/innotelinc/distro/control-plane:0.1.0   # or :latest
    # drop the build: block
```

**3. Pull and start:**

```bash
docker compose pull && docker compose up -d
```

## Topology & ports

| Service | Bind | Ports | Notes |
|---|---|---|---|
| `control-plane` | `CONTROL_BIND_HOST` (default 0.0.0.0) | 20140 API · `/admin` console | accounts/quotas/keys — admin console requires an admin login |

There is **no `gateway` service**: the AI plane is the shared platform OmniRoute
(Server 2, Consul service `omniroute`), pinned with `OPENAI_LIKE_API_BASE_URL` /
`GATEWAY_DASHBOARD_URL` or discovered via Consul. The bundled `local-gateway`
profile (gateway + redis) was removed — one OmniRoute serves the ecosystem, so
there is no fallback to start and no gateway port to bind here.

The **builder web app is retired** (convergence §5.2): one web UI (Studio)
serves the ecosystem, so there is no `:5173` binding — the control plane's
`20140` is this stack's only port. It binds **0.0.0.0 by default** so the LAN
can reach `…:20140/admin`; set `CONTROL_BIND_HOST=127.0.0.1` in `.env` to pull
it back to loopback-only.

**Remote gateway (default).** The AI plane is the platform OmniRoute on
Server 2 of the Innotel platform stack. Distro discovers it via Consul
(`CONTROL_CONSUL_URL`, service `omniroute`) or pins it explicitly:

```
OPENAI_LIKE_API_BASE_URL=http://host.docker.internal:20128/v1   # service key → gateway API (and dashboard: same port)
GATEWAY_DASHBOARD_URL=http://host.docker.internal:20128         # control plane → admin API (optional; Consul by default)
```

The docker0 alias is the right address **because distro's control plane runs on
the gateway's own host** and names the gateway's own port. Both forms in that
pair are corrected by the same rule: a caller *not* on the gateway's host dials
the SSO proxy in front of it (`http://192.168.1.46:20129/v1`, which exempts `/v1`)
— the gateway's `:20128` answers on its host's loopback and bridge alone, so a LAN
target there is dead.

Verify with `make doctor`. Running self-contained (an offline box or an
air-gapped lab) means running a gateway on that box too — Distro ships no
bundled fallback, so point `OPENAI_LIKE_API_BASE_URL` at whatever gateway is
there.

### WireGuard mesh (platform stack)

The remote gateway and Magnate live on the Innotel platform stack's WireGuard
mesh (`10.10.0.0/16`) — servers reach each other by mesh IP (e.g. OmniRoute at
`10.10.2.1`) over the tunnel, with Consul at `10.10.1.1:8500` as the registry.
`scripts/mesh.sh` is the mesh control plane; it is mirrored verbatim into
every member repo (`ips/scripts/mesh.sh` is canonical). It works on **any**
server — it reads the server number from its own path inside a group dir
(`<root>/N-<group>/<repo>/scripts/mesh.sh`), from the repo it lives in, or
from the hostname, and `--server N` overrides detection.

```bash
make mesh-setup          # or: ./scripts/mesh.sh join
./scripts/mesh.sh status # what this host is, and whether the mesh is up
```

`mesh.sh join` does:

1. Detects the server number (1-5) and provisions the platform stack's `.env`
   (`<root>/ips/.env`) with the mesh section: `10.10.N.1` IPs, this server's
   WireGuard keypair, `MESH_PORT`, the Consul gossip key, and the Consul role
   (server on Server 1, client elsewhere).
2. **Server 1 (hub):** starts the existing hub-mode mesh compose; peer configs
   are generated under `mesh/wg/data/` — distribute `peerN.conf` to clients.
3. **Servers 2-5 (clients):** writes a static client `wg0.conf` dialing the
   hub (needs the hub's public key: `--hub-pubkey <SERVER_1_WG_PUBLIC_KEY>`, or
   run `./stack.sh mesh` on Server 1 first and copy the key) plus a client-mode
   compose fragment, then starts the mesh and waits for a handshake.
4. Verifies the tunnel handshake and Consul leader (`--no-verify` to skip).

The other verbs: `mesh.sh leave [--purge]` drains this host, and
`mesh.sh download | install` fetch the member repos into their group dirs.

Order matters on a fresh mesh: run it on **Server 1 first**, then on each
client. `--dry-run` prints what would be written without starting anything.
Once the tunnel is up, `make discover-gateway` pins the remote OmniRoute (and
Magnate) URLs into `.env` and `docker compose up -d control-plane` moves
the stack onto the platform services.

## Secrets

| Where | What |
|---|---|
| `.env` `INITIAL_PASSWORD` | the shared gateway's dashboard login — the control plane mints keys through it |
| `.env` `OPENAI_LIKE_API_KEY` | the service key: mints/revokes each user's gateway key (the builder surface spends the per-user keys) |

Never put upstream provider keys in `.env` or anywhere in Distro — they live
only in the gateway's own store on the platform host. This stack's only volume
is `control-data` (accounts, keys, quotas, usage, audit).

## Day-2 operations

```bash
make ps              # status
make logs            # tail everything (add a service name to narrow)
make doctor          # remote gateway health
```

- **Admin console** (multi-tenant): `http://<host>:20140/admin` — sign in with
  an admin account (first signup on the instance is admin; promote more via
  the console). Manage users, per-user daily limits (requests/tokens/spend),
  gateway keys, and read the audit log there.
- **Quota enforcement**: the builder surface asks the control plane
  (`GET /api/internal/quota-check`) before each model turn (429 when over a
  daily cap) and reports usage after it. Gateway-key spend caps still apply
  even if the control plane is down.
- **Tenancy for the builder** (build-plane convergence §5.2): Olympus's Studio
  resolves a signed-in Authentik subject to an account here
  (`POST /api/internal/identity`) and spends that user's own gateway key, with
  `quota-check`/`usage-report` around each turn. Those three routes are
  authenticated the way their callers are: the quota pair by the user's gateway
  key, identity/audit by `CONTROL_INTERNAL_TOKEN` (`x-control-internal-token`,
  generated by `./scripts/bootstrap.sh`). **Unset turns the last two off** (503)
  rather than open — they mint and read credentials. Every provisioned account
  is audited (`user.provisioned` / `user.oidc-link`), and a build, publish or
  export writes an audit row from Studio.
- **Build queue (read-only)**: the console's *Build queue* panel renders Studio's
  queue — jobs (merged from request + status files), the runner's heartbeat and
  per-state counts — so the builder's work is visible where the users and quotas
  are. Set `STUDIO_BUILD_QUEUE_DIR` to Studio's queue directory **and mount it
  into this container**; unset means the panel says the queue is not visible
  here. It is a reader only: it never writes, claims or cancels a job, and
  Studio's `make build-runner-list` stays the authoritative answer.
- **Usage is chat-report-authoritative in remote-gateway mode**: the control
  plane can sync the gateway's own per-key ledger (`usage_history` in the
  gateway SQLite volume, mounted read-only) into `usage_cache` every
  `CONTROL_SYNC_INTERVAL_MS` — but this stack does not mount that volume, since
  the gateway is remote, so the interval defaults to 0 (off) and quota
  accounting uses chat-traffic usage reports plus key spend caps. Set
  `CONTROL_SYNC_INTERVAL_MS` only if a gateway data dir is mounted read-only at
  `GATEWAY_DATA_DIR`. Manual run:
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
  `control-data` volume path (`/data/control.sqlite`) with the stack stopped.
  There is no gateway copy to restore — that store belongs to the remote
  gateway and is backed up on the platform host.

- **Upgrading the gateway**: the gateway is the shared platform service, so its
  upgrades are the platform operators' (Server 2) — there is no image tag or
  profile to bump here. Distro only needs the right
  `OPENAI_LIKE_API_BASE_URL`/key. See docs/upstream.md for the pinning notes.
- **Upgrading the control plane**: `git pull`, then
  `docker compose up -d --build control-plane`. Alternatively, pull the latest
  GHCR image: `docker compose pull control-plane && docker compose up -d control-plane`.
  To pin a release version, set `image:` and remove `build:`.

## Sizing

- The gateway runs on the platform host, so its Node heap is not sized here.
  Worth knowing when asking for a change there: coding-agent traffic carries
  large, overlapping contexts, and upstream's container is tuned for
  dashboard/light chat (it pins 2048 MB, and upstream's docs warn a 1 GB heap
  OOMs under this load).
- The control plane is small — plain Node + a SQLite file; a few hundred MB is
  plenty. Size the box for whatever else shares it (on the platform stack that
  is Atlas + Oasis; the gateway lives on the platform host).

## Reverse proxy (TLS)

Front the control plane (`:20140`); nginx proxy manager (NPM) host entries
work the same way. The service API is plain JSON — no websocket proxying
needed. nginx example:

```nginx
server {
  listen 443 ssl;
  server_name cp.example.com;
  # ssl_certificate …; ssl_certificate_key …;
  location / {
    proxy_pass http://127.0.0.1:20140;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 600s;
  }
}
```

Do **not** expose port 20128 publicly — the gateway (API and dashboard) is
internal-only. The public face of building is Studio; this stack exposes the
tenancy API and the admin console.

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
`sso:` sentinel). The admin console's sign-in runs the flow and stores the
session exactly like password login, so quotas and the console work unchanged.
New SSO signups land in the audit log as `user.oidc-signup` (existing users:
`user.oidc-login`).

This OIDC client config is for humans signing into the console. The builder
surface (Studio) resolves its users server-to-server instead —
`POST /api/internal/identity` with `CONTROL_INTERNAL_TOKEN` — which needs no
OIDC client at all.

### Multi-tenant control plane behind TLS

The admin console is served by the control plane itself, so fronting `:20140`
with TLS (above) covers it. `CONTROL_CORS_ORIGIN` matters only for browser
calls from another origin: Studio calls these routes server-side (no CORS),
so set it to the Studio origin only if something browser-side calls the API
cross-origin. Strict-origin: only that exact origin gets the allow header;
other preflights get 403.

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

The builder surface builds apps (Studio, Olympus); Atlas is the stack's
**CodeOps** home (Gitea + Convex — Chef retired as a builder). When
`ATLAS_URL` + `ATLAS_GIT_REMOTE` are both set in Distro `.env`, the control
plane exposes:

- `GET /api/export/config` → `{ configured, url, remote }`
- `POST /api/export/validate` → validates the remote URL (SSH or HTTPS)

The builder surface (Studio) consumes these to push a project to an
Atlas/Gitea remote. Atlas itself consumes the same Magnate + Cerulean services
Distro does, so billing and identity are shared across the stack.

## Where multi-tenant plugs in

See `docs/multi-tenant.md` for the design history. Current shape: the control
plane is the tenancy service — user auth + per-user gateway keys + quota/usage
surfacing are live, consumed through the service API (`/api/internal/*`) by
the builder surface, and managed in the admin console.
