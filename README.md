<div align="center">

# Distro

**Tenancy service for AI app building — BuilderOps.**

Accounts, one OmniRoute gateway key per user, quota/usage enforcement, spend
tracking, and an admin console — the multi-tenant layer the ecosystem's
builder surface (Olympus Studio) consumes for every model turn.

[![CI](https://github.com/innotelinc/distro/actions/workflows/ci.yml/badge.svg)](https://github.com/innotelinc/distro/actions/workflows/ci.yml)
[![Conformity](https://github.com/innotelinc/distro/actions/workflows/conform.yml/badge.svg)](https://github.com/innotelinc/distro/actions/workflows/conform.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

> **About Distro** — Distro began as an assembly of two MIT-licensed projects:
> bolt.diy (in-browser IDE) + OmniRoute (AI routing gateway). In the build-plane
> convergence it shed the surfaces other platforms own — the bundled gateway
> first (§4.1), then the bolt.diy front door (§5.2) — and now ships the part
> that was always its own: the **multi-tenant control plane**. Upstream
> attribution is retained in
> [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). **Landing page (the
> product's history and gallery):**
> [innotelinc.github.io/distro](https://innotelinc.github.io/distro)

## What it is

- **Multi-tenant control plane** (`apps/control-plane`, plain Node + SQLite) —
  accounts, one gateway key per user, quota/usage enforcement, an admin
  console, and an audit log.
- **A token-gated service API** — `POST /api/internal/identity`,
  `GET /api/internal/quota-check`, `POST /api/internal/usage-report`,
  `POST /api/internal/audit` — which the builder surface (Studio) calls
  before and after every model turn, keyed to the signed-in Authentik
  subject.

OmniRoute remains the shared AI plane: Distro holds only gateway-issued keys
(one service key to mint/revoke user keys, plus one per user) and never
upstream provider keys.

```
┌────────────────────────────┐   /v1/*   ┌──────────────────────────────┐
│  Builder surface (Studio)  ├──────────►│         OmniRoute            │
│  the one web UI            │ user's own│  routing · fallback ·        ├──► upstream
│        │                   │  API key  │  usage accounting · MCP      │    providers
│        ▼ /api/internal/*   │           └──────────────────────────────┘
│  ┌──────────────────────┐  │
│  │  Distro control plane│◄─┘
│  │  accounts · keys ·   │
│  │  quotas · audit ·    │
│  │  admin console       │
│  └──────────────────────┘
```

## Why Distro

| Problem | Distro answer |
| --- | --- |
| No accountability per user | Per-user gateway keys — every model call is attributable, capped, revocable |
| Runaway spend | Quota enforcement per turn + USD spend caps on the keys themselves (the hard backstop) |
| No operator visibility | Admin console: limits, enable/disable, revoke/rotate, roles, audit log, build-queue view |
| Ecosystem sprawl | One tenancy layer behind one web UI — identity in Authentik, building in Studio, gateway in OmniRoute |
| Identity you don't control | Optional Authentik SSO through Cerulean |
| Billing you don't control | Optional Magnate subscriptions — entitlements checked server-to-server |

## Platform stack

Distro is registered in the [**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack)
as **BuilderOps** — its role (owns / provides / consumes / does not own) is
declared in [docs/stack.md](docs/stack.md).

## Quickstart (self-hosted, Docker)

```bash
cp .env.example .env          # or: ./scripts/bootstrap.sh (generates secrets)
./scripts/bootstrap.sh        # discovers the gateway, prints guided next steps
```

`.env` is gitignored and holds this deployment's gateway key and database
credentials — **never commit it**, and never paste its values into an issue, a
commit message or a doc. `.env.example` is the tracked template; production
values belong in Cerulean Vault (`vault://` references, resolved at startup).

1. Open the OmniRoute dashboard on the platform host (Server 2, `:20128`), sign
   in, and register upstream provider API keys. Distro runs no gateway of its
   own, so this is a one-time step on the platform, not per Distro deployment.
2. Issue a gateway API key (Dashboard → API Keys) and set
   `OPENAI_LIKE_API_KEY` in `.env` — the **service key** the control plane
   uses to mint and revoke each user's key.
3. Start the control plane and verify:

```bash
docker compose up -d --build
make doctor
# admin console: http://127.0.0.1:20140/admin
```

Point the builder surface at it (Olympus Studio):
`CONTROL_PLANE_INTERNAL_URL=http://<host>:20140` +
`CONTROL_INTERNAL_TOKEN=<the token bootstrap.sh generated>`.

## Documentation

| Doc | What it covers |
|---|---|
| [docs/stack.md](docs/stack.md) | Distro's role in the Innotel Platform Stack (BuilderOps) |
| [docs/architecture.md](docs/architecture.md) | the control plane, the service API, where the retired front door went |
| [docs/ops.md](docs/ops.md) | first boot, ports, secrets, day-2 ops, sizing, reverse proxy, Authentik SSO |
| [docs/upstream.md](docs/upstream.md) | the upstream record: what was consumed, what was retired, license/attribution |
| [docs/multi-tenant.md](docs/multi-tenant.md) | design: accounts, per-user quotas, usage visibility |
| [docs/testing.md](docs/testing.md) | verification walkthrough: accounts, 429s, service API, admin console |
| [docs/atlas-integration.md](docs/atlas-integration.md) | git-export config consumed by the builder surface |
| [apps/control-plane](apps/control-plane/README.md) | control plane: schema, gateway API inventory, milestone roadmap |

## Repo layout

```
apps/control-plane/  the tenancy service — accounts, per-user gateway keys, quotas/usage, admin console
licenses/            retained upstream license texts (bolt.diy)
web/landing/         static landing + screenshot gallery (GitHub Pages) — the product's history
docker-compose.yml   control plane as one stack (the gateway is the shared platform service)
Makefile             up / down / doctor / bootstrap / backup / …
scripts/             bootstrap · backup · healthcheck-gateway · npm-proxy-hosts
.githooks/           attribution guard (shared with CI)
docs/                stack · architecture · ops · upstream · multi-tenant · testing
```

## Status

Shipped and verified on the live stack: multi-tenant control plane with
per-user gateway keys, quota enforcement, spend tracking, alert webhooks,
backups, and an admin console; Authentik SSO; Magnate entitlement checks;
the token-gated service API Studio consumes (identity → quota → turn →
usage/audit).

Roadmap beyond this (documented in the control-plane roadmap): billing hooks
if paid tiers ever come in scope.

## Notes

- `CONTROL_BIND_HOST` (20140) is the only binding; the gateway is remote, so
  no gateway port is published here, and the retired web app's `:5173` is
  gone with it.
- Upstream provider keys live only in the gateway's store on the platform host.
  Distro holds gateway-issued keys (`OPENAI_LIKE_API_KEY`, plus one per user
  minted by the control plane).

## License

MIT. Distro's new material is MIT (root [`LICENSE`](LICENSE)); the upstream
projects remain MIT with their licenses retained in-tree
([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md),
[`licenses/`](licenses/)).

*Distro — the tenancy service for AI app building. © 2026*

## 🏛️ Platform stack

Distro is the ecosystem's **BuilderOps** platform — the tenancy layer under AI
app building — in the [**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) —
the canonical single-responsibility architecture where Authentik owns identity,
Cerulean Vault owns secrets, Cerulean owns trust, ONYX owns storage, Magnate owns
revenue, and every other platform is a business function that consumes them. See
[docs/stack.md](docs/stack.md) for this platform's owns/consumes boundaries.
