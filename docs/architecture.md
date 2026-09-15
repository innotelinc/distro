# Distro — Architecture

**Distro** is the ecosystem's tenancy service for AI app building: accounts,
one OmniRoute gateway key per user, quota/usage enforcement, spend tracking,
an admin console, and an audit log. Its builder surface — the rebranded
bolt.diy in-browser IDE that used to live in `apps/web` — is **retired**
(build-plane convergence §5.2): one web UI, Olympus's Studio, serves the
ecosystem, and it consumes this control plane over its service API.

## Components

| Layer | Upstream / code | Role |
|---|---|---|
| Tenancy / control plane | `apps/control-plane` (this repo, plain Node + SQLite) | Accounts, per-user gateway keys, quotas/usage, audit log, admin console, optional Authentik OIDC, Magnate entitlements, Atlas git-export config. |
| Builder surface | Studio (Olympus, Group 4) — not in this repo | The web UI users build in. Calls this control plane's `/api/internal/*` service routes per model turn. |
| Model routing / gateway | [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — consumed REMOTELY as a platform service (Innotel platform stack, Server 2; Consul service `omniroute`). Distro runs no gateway of its own. | One OpenAI-compatible endpoint (`/v1/*`) across many upstream providers with fallback, token/cost accounting and format translation. |

```
┌──────────────────────────────────────────────┐
│  Builder surface (Studio, Olympus)           │
│  the one web UI of the ecosystem             │
└──────────────┬───────────────┬───────────────┘
               │               │  /v1/chat/completions
               │               ▼  (the user's own key)
               │   ┌──────────────────────────────┐
               │   │       OmniRoute gateway      │
               │   │  dashboard + API :20128      │
               │   │  routing · fallback · usage  │
               │   └──────────────┬───────────────┘
               │                  ▼
               │       upstream providers
               │  (Anthropic, OpenAI, Gemini, …)
               │ /api/internal/*   (service token)
               ▼
┌──────────────────────────────────────────────┐
│        Distro control plane  :20140          │
│  identity · per-user keys · quota · usage    │
│  audit · admin console · billing entitlements│
└──────────────────────────────────────────────┘
```

## The service API (what Studio consumes)

Configuration is `CONTROL_PLANE_INTERNAL_URL` + `CONTROL_INTERNAL_TOKEN`
(both fail closed: an unset token answers `503` on these routes rather than
leaving them open). Per model turn, the builder surface:

1. **Identity.** `POST /api/internal/identity` — the signed-in Authentik
   subject becomes (or provisions) a control-plane account; the response
   carries that account's gateway key. `users.oidc_sub` is the join; a
   conflicting email answers `409` rather than silently rebinding.
2. **Quota.** `GET /api/internal/quota-check` decides, before dispatch,
   whether the turn may proceed (fail-open by design; the gateway key's own
   spend cap is the hard backstop).
3. **Dispatch.** The model call goes to OmniRoute with the **user's own
   gateway key** — attributable, capped, revocable per user.
4. **Record.** `POST /api/internal/usage-report` after the turn, plus audit
   rows (`POST /api/internal/audit`) for build/publish/export — the three
   actions that touch a public name or a repo.

The admin console at `/admin` remains the operator's view: per-user limits,
enable/disable (disable revokes the key immediately), revoke/rotate, roles,
audit log, and the read-only build-queue view (`BUILD_QUEUE_DIR`).

## Where the code lives

```
.
├── apps/control-plane/  the tenancy service (Distro's deliverable)
├── licenses/            retained upstream license texts (bolt.diy)
├── docker-compose.yml   control plane as one stack (the gateway is remote)
├── Makefile             up/down/doctor/bootstrap/backup/typecheck …
├── scripts/             bootstrap, health checks, NPM host provisioning, vault tooling
└── docs/                this doc, multi-tenant design, ops runbook, upstream record
```

## Key security decisions

- The gateway is REMOTE (platform OmniRoute, Server 2): Distro holds only
  gateway-issued keys — one service key to mint/revoke user keys, plus one
  per user — and never upstream provider keys. Running no gateway is also
  what keeps 20128 off this box; that port and the dashboard behind it belong
  to the platform host.
- Upstream provider API keys live **only** in the gateway (its own encrypted
  store on the platform host).
- Secrets come from Cerulean Vault as `vault://` references, resolved by the
  control plane at import (`apps/control-plane/src/secrets.js`) — a
  reference that cannot resolve stops the boot instead of degrading into an
  empty credential.
- The service routes are token-gated and fail closed; quota checks are
  fail-open with the gateway key's spend cap as the hard backstop.

## Retired: the bolt.diy front door

`apps/web` — a rebranded fork of stackblitz-labs/bolt.diy (browser IDE,
WebContainer sandbox, live preview, file tree, terminal) — was Distro's
builder surface until the convergence. It is deleted from this repo:

- **Why:** three app-builder front doors (Studio, Distro's fork, Atlas's
  Chef fork) for one ecosystem; the convergence keeps one web UI (Studio)
  and one engine. Distro's durable contribution was always the multi-tenant
  layer on top of the gateway — that is what survives.
- **What survives:** the control plane, its admin console, and its service
  API (which Studio consumes); the WebContainer-specific affordances worth
  keeping (a file tree, a terminal pane) are tracked as Studio work.
- **The record:** git history of this repo, `docs/upstream.md`,
  `THIRD_PARTY_NOTICES.md` and the retained license text in `licenses/`.

## History

The repo began as bolt.diy (forked, rebranded) + a bundled OmniRoute. The
bundled gateway was removed first (convergence §4.1 — one OmniRoute serves
the ecosystem), then the front door (§5.2). What remains is the part every
other change kept depending on: tenancy.
