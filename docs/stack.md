# 🧩 Distro — Platform Stack Role

**Classification: BuilderOps**

The tenancy service for AI app building: accounts, one OmniRoute gateway key
per user, quota/usage enforcement, spend tracking, and an admin console. Its
builder surface — the rebranded bolt.diy in-browser IDE — is retired
(convergence §5.2); one web UI, Olympus Studio, serves the ecosystem and
consumes this control plane's service API per model turn.

This page declares Distro's role in the
[**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) —
the canonical single-responsibility architecture. The stack is defined in
exactly one place; this page links each product to it and states what this
platform owns, consumes, provides, and explicitly does not own.

## Owns

- Multi-tenant accounts for AI app building (Distro control plane):
  signup/login, one OmniRoute gateway key per user, quota/usage enforcement,
  admin console
- Per-user model spend accounting and webhook alerting
- The token-gated service API (`/api/internal/*`) the builder surface calls

## Provides

- Tenancy for the ecosystem's builder surface: identity → account + per-user
  gateway key, quota gating before each turn, usage/audit recording after it
- Per-user gateway keys + quotas so builder traffic is attributable and capped

## Consumes

- OmniRoute — the AI plane (OpenAI-compatible gateway to upstream model
  providers). Distro never holds upstream provider keys; its service key only
  mints and revokes per-user keys via the gateway's dashboard API.
- NPM Edge — public TLS routing and hostnames: control plane at `/cp` (and
  the admin console). The retired web app's `slots.` host is gone.
- Cerulean Vault — the secret store (SecretOps). `.env` carries
  `vault://<mount>/<path>#<key>` references rather than values, resolved by
  the control plane at import (`apps/control-plane/src/secrets.js`).
- Magnate — subscription billing (RevenueOps). Distro checks entitlements via
  Magnate's server-to-server `/api/entitlements` and fetches plans from
  `/api/admin/plans`; it never holds Stripe keys and runs no billing stack
  locally (Magnate is discovered via Consul like the gateway). Magnate itself
  is Cerulean/Authentik-first (subscriber accounts + passwords live in
  Cerulean's Authentik).
- Cerulean — TrustOps: Authentik SSO (OIDC sign-in for the control plane),
  DNS automation (RFC 2136 BIND zone updates) and TLS certificate lifecycle
  (wildcard Let's Encrypt via DNS-01 challenge). The `scripts/npm-proxy-hosts.py`
  script provisions NPM proxy hosts and wildcard certs for `*.innotel.us`.
  Cerulean hosts the shared Authentik instance the whole stack signs in through,
  and Distro is a **pattern A** consumer of it under the platform standard
  ([`ips/docs/sign-in-posture.md`](../../../ips/docs/sign-in-posture.md)):
  OIDC-native, no login of its own, provider carrying the standard
  `openid`/`profile`/`email`/`groups` mappings and `issuer_mode: per_provider`.
  `scripts/verify-sso.py` proves it, and `ips/scripts/check-sign-in-posture.sh`
  runs it with every other zone's.

## Explicitly does NOT own

- The builder web UI — Olympus Studio is the ecosystem's one web UI; Distro's
  bolt.diy fork (`apps/web`) is retired (§5.2), its license text retained in
  `licenses/`
- In-browser app execution (WebContainer) — went with the front door; the
  studio-side equivalents (file tree, terminal pane) are Studio work
- Identity (Authentik / Cerulean) — Distro runs its own control-plane accounts
  today; Cerulean's Authentik SSO is the convergence target
- Secrets (Cerulean Vault)
- Storage (ONYX)
- The LLM gateway itself (OmniRoute) — it is an ecosystem extension
  (`extensions/llm`) that any group may enable
- Billing (Magnate) — Distro consumes it, Magnate owns the revenue ledger
- DNS / TLS / trust (Cerulean) — Distro consumes it, Cerulean owns it
- Git hosting / code review / CI / AI app building (Atlas) — the builder
  surface exports to Atlas/Gitea; Atlas is the stack's CodeOps home

> **Current state:** Distro consumes the shared platform OmniRoute gateway
> (Server 2, Consul service `omniroute`) and bundles **no** gateway of its own —
> the `local-gateway` profile was removed (convergence §4.1) and the builder
> front door retired (§5.2), so there is no offline/single-host fallback and no
> Distro web app. Secrets live in **Cerulean Vault** with `vault://` references
> resolved at startup (§6.1). Remaining convergence target: adopt Cerulean's
> Authentik as the identity provider for the control plane, with Magnate
> (billing) + Cerulean (trust/DNS/TLS) + Atlas (git export) already wired in.
>
> **Convergence:** see the [**build-plane convergence plan**](https://github.com/innotelinc/innotel-platform-stack/blob/main/docs/convergence-onyx-olympus-distro-atlas.md)
> — one web UI (Studio), one terminal UI, one full-stack app builder, one
> OmniRoute. Distro's part is done: the `local-gateway` profile is removed
> (§4.1) and the control plane **is** the builder's tenancy layer (§5), now the
> repo's only deliverable.

## Cross-platform integration

| Flow | Path |
|---|---|
| Tenancy (build) | Studio → Distro `/api/internal/{identity,quota-check,usage-report,audit}` (service token) |
| Billing | Distro control plane → Magnate `/api/entitlements` + `/api/admin/plans` |
| Identity (optional) | Cerulean Authentik OIDC → Distro `/api/auth/oidc/*` |
| DNS / TLS | Cerulean BIND (nsupdate + TSIG, DNS-01) → NPM Edge → Distro hosts |
| Git export | builder surface → Atlas/Gitea remote (`ATLAS_URL` + `ATLAS_GIT_REMOTE` config in the control plane) |
| Model plane | builder surface → OmniRoute gateway (each user's own key) → upstream providers (shared with Atlas) |
