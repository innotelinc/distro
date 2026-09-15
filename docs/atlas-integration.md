# Distro ↔ Atlas Integration

**The builder surface is where you build (Studio). Atlas is where you ship.
Distro is the tenancy layer underneath the building.**

These platforms are separate by design — single-responsibility architecture —
but work together as a seamless workflow.

## The workflow

```
┌─────────────────────────────────────────────────────────────┐
│          BUILDER SURFACE (Studio) + DISTRO CONTROL PLANE    │
│  "Build it, accounted for"                                  │
│                                                             │
│  1. Describe app in natural language (Studio)               │
│  2. AI writes code; Distro's control plane gates the turn   │
│     (identity → quota-check → user's own gateway key)       │
│  3. Iterate, refine — usage reported per turn               │
│  4. Happy? → Export to Git                                  │
└──────────────────────────┬──────────────────────────────────┘
                           │ git push
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                         ATLAS                               │
│  "Ship it"                                                  │
│                                                             │
│  5. Code lands in Gitea repo                                │
│  6. Convex backend, if the plan chose that target           │
│  7. CI/CD builds + tests                                    │
│  8. Deploy to production                                    │
└─────────────────────────────────────────────────────────────┘
```

## Integration points

### 1. Export to Git (builder surface → Atlas)

The builder surface can push the current project to an Atlas/Gitea remote:

```bash
# In Studio: Export → Git
# Export config is served by the Distro control plane:
GET /api/export/config     # → { configured, url, remote }
POST /api/export/validate  # validates the remote URL (SSH or HTTPS)
```

**Setup:**
1. Create a repo in Atlas/Gitea
2. Set `ATLAS_URL` + `ATLAS_GIT_REMOTE` in Distro `.env`
3. The builder surface pushes the project to the remote

### 2. Convex backend (Atlas)

Apps that target Convex get a backend on Atlas's self-hosted Convex
(Chef retired as a *builder*; Convex stays as a plan-selectable target):

```
# The generated client reads CONVEX_URL; packaging passes a
# deployment-scoped CONVEX_DEPLOY_KEY as a build arg — never an ENV.
# → functions land in the same repo the builder surface exported to
```

### 3. Shared infrastructure

| Service | Distro uses | Atlas uses |
|---|---|---|
| OmniRoute | Model routing for agent | Model routing for Chef |
| Magnate | Subscription billing (RevenueOps) | Subscription billing (paid dev seats) |
| Cerulean (Authentik) | User SSO / DNS / TLS | User SSO / DNS / TLS |
| Cerulean Vault | Secrets | Secrets |
| NPM Edge | Public routing | Public routing |

### 4. Cross-platform references

- **Builder surface** → Atlas: "Export to Git" pushes to Gitea
- **Atlas** → builder surface: "Open in Studio" for the repo's project
- **Both** share the same user accounts (Authentik) and billing (Magnate)
- **Distro** underpins the building: per-user gateway keys, quotas, audit

## Environment variables

Distro needs to know where Atlas lives:

```bash
# .env (Distro)
ATLAS_URL=https://atlas.innotel.us          # Atlas/Gitea base URL
ATLAS_GIT_REMOTE=git@atlas.innotel.us       # Git SSH host for exports
```

## Deployment

Both platforms run on the same WireGuard mesh and share the stack's platform
services:

- **Distro** — Group 5 (Server 5): control plane (tenancy); consumes the shared OmniRoute gateway (Server 2) via Consul
- **Atlas** — Group 5 (Server 5): Gitea, Convex

They share the same server and discover each other over the compose network /
WireGuard mesh:

```bash
# Distro discovers Atlas
./stack.sh discover atlas   # → 10.10.5.1:3000

# The mesh discovers Distro's control plane
./stack.sh discover distro  # → 10.10.5.1:20140
```

### Shared Magnate + Cerulean wiring

Both platforms point at the same Magnate instance for billing and the same
Cerulean Authentik for identity. The relevant env vars:

```bash
# Magnate (RevenueOps) — both Distro and Atlas use it
MAGNATE_URL=https://magnate.innotel.us
MAGNATE_ENTITLEMENTS_TOKEN=<shared-secret>   # must equal Magnate's ENTITLEMENTS_API_TOKEN

# Cerulean Authentik (IdentityOps / TrustOps) — both Distro and Atlas
OIDC_ISSUER_URL=https://auth.cerulean.innotel.us/application/o/<app>/
OIDC_CLIENT_ID=<app>-gitea|distro|chef
OIDC_CLIENT_SECRET=<from Cerulean>
```

- Distro's control plane reaches Magnate's `/api/entitlements` for per-user
  subscription checks and `/api/admin/plans` for the plans list / checkout.
- Atlas's Chef codegen reaches the shared OmniRoute gateway for model calls;
  Atlas never stores upstream provider keys.
- DNS + wildcard TLS for both platforms' public hosts is provisioned by
  Cerulean (RFC 2136 BIND zone updates + DNS-01).

## Summary

| Platform | Role | Runtime | Output |
|---|---|---|---|
| **Studio** | Build | Olympus (Group 4) | Source code |
| **Distro** | Tenancy for the build | Control plane (Group 5) | Accounts, keys, quotas, audit |
| **Atlas** | Ship | Convex + Gitea CI/CD | Deployed app |

They're better together — but each does one job well.
