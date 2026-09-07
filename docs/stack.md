# 🧩 Distro — Platform Stack Role

**Classification: BuilderOps**

Self-hosted AI app-building platform: describe an application and Distro's
agent writes, runs, previews, and iterates on a full-stack codebase in the
browser — no local dev environment required.

This page declares Distro's role in the
[**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) —
the canonical single-responsibility architecture. The stack is defined in
exactly one place; this page links each product to it and states what this
platform owns, consumes, provides, and explicitly does not own.

## Owns

- The in-browser builder shell (fork of bolt.diy): chat-to-code agent UI,
  WebContainer sandbox, live preview, file tree, terminal
- Running and iterating on the apps a user asks for (in-browser execution)
- Multi-tenant accounts for the builder (Distro control plane): signup/login,
  one OmniRoute gateway key per user, quota/usage enforcement, admin console
- Per-user model spend accounting and webhook alerting

## Provides

- An AI app-building front door for the ecosystem: browser → Distro →
  OmniRoute gateway → upstream models
- Per-user gateway keys + quotas so builder traffic is attributable and capped

## Consumes

- OmniRoute — the AI plane (OpenAI-compatible gateway to upstream model
  providers). Distro never holds upstream provider keys.
- NPM Edge — public TLS routing and hostnames (`slots.innotel.us`: web at `/`,
  control plane at `/cp`)
- Infisical — secrets target for gateway/control-plane credentials (currently
  `.env` on the host; see convergence note)
- Magnate — subscription billing (RevenueOps). Distro checks entitlements via
  Magnate's server-to-server `/api/entitlements` and fetches plans from
  `/api/admin/plans`; it never holds Stripe keys and runs no billing stack
  locally (Magnate is discovered via Consul like the gateway). Magnate itself
  is Cerulean/Authentik-first (subscriber accounts + passwords live in
  Cerulean's Authentik).
- Cerulean — TrustOps: Authentik SSO (optional OIDC sign-in for the Distro
  control plane), DNS automation (RFC 2136 BIND zone updates) and TLS
  certificate lifecycle (wildcard Let's Encrypt via DNS-01 challenge). The
  `scripts/npm-proxy-hosts.py` script provisions NPM proxy hosts and
  wildcard certs for `*.innotel.us`. Cerulean also hosts the shared Authentik
  instance the whole stack signs in through.

## Explicitly does NOT own

- Identity (Authentik / Cerulean) — Distro runs its own control-plane accounts
  today; Cerulean's Authentik SSO is the convergence target
- Secrets (Infisical)
- Storage (ONYX)
- The LLM gateway itself (OmniRoute) — it is an ecosystem extension
  (`extensions/llm`) that any group may enable
- Billing (Magnate) — Distro consumes it, Magnate owns the revenue ledger
- DNS / TLS / trust (Cerulean) — Distro consumes it, Cerulean owns it
- Git hosting / code review / CI / AI app building (Atlas) — Distro exports to
  Atlas/Gitea; Atlas is the stack's CodeOps home

> **Current state:** Distro consumes the shared platform OmniRoute gateway
> (Server 2, Consul service `omniroute`) — no local gateway is bundled by
> default; a local fallback lives behind the compose profile
> `local-gateway` for offline/single-host use. Convergence targets: move
> secrets into Infisical and adopt Cerulean's Authentik as the identity
> provider, with Magnate (billing) + Cerulean (trust/DNS/TLS) + Atlas
> (git export) wired in.

## Cross-platform integration

| Flow | Path |
|---|---|
| Billing | Distro control plane → Magnate `/api/entitlements` + `/api/admin/plans` |
| Identity (optional) | Cerulean Authentik OIDC → Distro `/api/auth/oidc/*` |
| DNS / TLS | Cerulean BIND (nsupdate + TSIG, DNS-01) → NPM Edge → Distro hosts |
| Git export | Distro WebContainer → Atlas/Gitea remote (`ATLAS_URL` + `ATLAS_GIT_REMOTE`) |
| Model plane | Distro agent → OmniRoute gateway → upstream providers (shared with Atlas Chef) |
