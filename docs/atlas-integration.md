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
| Magnate | Subscription billing | Subscription billing |
| Authentik | User SSO | User SSO |
| Infisical | Secrets | Secrets |
| Cerulean | DNS + TLS certs | DNS + TLS certs |
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

Both platforms run on the same WireGuard mesh:

- **Distro** — Group 5 (Server 5): web app + control plane; consumes the shared OmniRoute gateway (Server 2) via Consul
- **Atlas** — Group 5 (Server 5): Gitea, Chef, Convex

They share the same server and discover each other via Consul:

```bash
# Distro discovers Atlas
./stack.sh discover atlas   # → 10.10.5.1:3000

# Atlas discovers Distro
./stack.sh discover distro  # → 10.10.5.1:5173
```

## Summary

| Platform | Role | Runtime | Output |
|---|---|---|---|
| **Distro** | Build | WebContainer (browser) | Source code |
| **Atlas** | Ship | Convex + Gitea CI/CD | Deployed app |

They're better together — but each does one job well.
