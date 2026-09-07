# Distro ↔ Atlas Integration

**Distro is where you build. Atlas is where you ship.**

These two platforms are separate by design — single-responsibility architecture —
but work together as a seamless workflow.

## The workflow

```
┌─────────────────────────────────────────────────────────────┐
│                        DISTRO                               │
│  "Build it live"                                            │
│                                                             │
│  1. Describe app in natural language                        │
│  2. AI writes code in-browser (WebContainer)                │
│  3. Live preview, iterate, refine                           │
│  4. Happy? → Export to Git                                  │
└──────────────────────────┬──────────────────────────────────┘
                           │ git push
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                         ATLAS                               │
│  "Ship it"                                                  │
│                                                             │
│  5. Code lands in Gitea repo                                │
│  6. Chef scaffolds Convex backend (optional)                │
│  7. CI/CD builds + tests                                    │
│  8. Deploy to production                                    │
└─────────────────────────────────────────────────────────────┘
```

## Integration points

### 1. Export to Git (Distro → Atlas)

Distro can push the current project to an Atlas/Gitea remote:

```bash
# In Distro's web UI: Export → Git
# Or via the control plane API:
POST /api/projects/export
{
  "remote": "git@atlas.innotel.us:username/project.git",
  "branch": "main"
}
```

**Setup:**
1. Create a repo in Atlas/Gitea
2. In Distro settings, add the Gitea remote
3. Distro pushes the WebContainer project to the remote

### 2. Chef scaffold (Atlas → Distro)

Atlas/Chef can generate a Convex backend for apps built in Distro:

```bash
# In Atlas: Chef → "Scaffold backend for Distro project"
# Chef generates:
#   - Convex schema (db/schema.ts)
#   - Auth integration
#   - API routes
#   - Realtime subscriptions
#   → Commits to the same repo Distro exported to
```

### 3. Shared infrastructure

| Service | Distro uses | Atlas uses |
|---|---|---|
| OmniRoute | Model routing for agent | Model routing for Chef |
| Magnate | Subscription billing (RevenueOps) | Subscription billing (paid dev seats) |
| Cerulean (Authentik) | User SSO / DNS / TLS | User SSO / DNS / TLS |
| Infisical | Secrets | Secrets |
| NPM Edge | Public routing | Public routing |

### 4. Cross-platform references

- **Distro** → Atlas: "Export to Git" button pushes to Gitea
- **Atlas** → Distro: "Build in Distro" link opens the current repo in Distro's IDE
- **Both** share the same user accounts (Authentik) and billing (Magnate)

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

- **Distro** — Group 5 (Server 5): web app + control plane; consumes the shared OmniRoute gateway (Server 2) via Consul
- **Atlas** — Group 5 (Server 5): Gitea, Chef, Convex

They share the same server and discover each other over the compose network /
WireGuard mesh:

```bash
# Distro discovers Atlas
./stack.sh discover atlas   # → 10.10.5.1:3000

# Atlas discovers Distro
./stack.sh discover distro  # → 10.10.5.1:5173
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
| **Distro** | Build | WebContainer (browser) | Source code |
| **Atlas** | Ship | Convex + Gitea CI/CD | Deployed app |

They're better together — but each does one job well.
