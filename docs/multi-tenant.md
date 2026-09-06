# Distro — Multi-Tenant Design

Distro is being built **multi-tenant** (Phase 2 of the master plan): accounts,
per-user quotas and usage visibility sitting in front of the shared OmniRoute
gateway. This document is the design the scaffold is shaped around. The v1
scaffold is single-operator: one gateway-issued key in the web app's
environment, no user layer. Every seam below is chosen so multi-tenancy can be
added without forking OmniRoute or bolt.diy again.

## Mental model

```
Browser → Distro web (auth'd user session)
             │ per-user gateway API key (short-lived)
             ▼
        OmniRoute gateway
             │  token + cost accounting per key
             ▼
        upstream providers
```

Two trust boundaries matter:

1. **User ↔ Distro**: who is allowed to use the platform (accounts, login,
   per-user quotas, rate limits).
2. **Distro ↔ OmniRoute**: how each request is attributed to a user for quota
   enforcement and billing.

OmniRoute already tracks tokens/cost per API key, so the cheapest correct
design is **one gateway API key per Distro user**, minted/revoked
programmatically. Distro then reads usage back from the gateway's accounting
to show users their consumption and to enforce quotas.

## Components to build (Phase 2)

### 1. Identity + gateway provisioning (the "control plane")

A small control-plane service (or module inside the web app) that:

- manages Distro accounts (signup, login, sessions),
- calls the gateway's admin API to **create/rotate/revoke a gateway API key
  per user** at signup/disable,
- stores the mapping `distro_user_id ↔ gateway_key_id` in Distro's own DB
  (SQLite/Postgres). The plaintext gateway key may live only in the Distro
  server's encrypted store, or the gateway may issue scoped keys the control
  plane can look up.

Where this lives: either a new `apps/control-plane` service or an auth
middleware + DB added inside `apps/web`. Decision point — see below.

### 2. Per-user quotas and rate limits

Two enforcement layers, defense in depth:

- **Distro-side (coarse)**: middleware on `/api/chat` and `/api/models`
  checks the session's quota (requests/day, tokens/day, spend cap) before the
  request is proxied. Cheap to implement, cheap to reason about.
- **Gateway-side (fine-grained)**: OmniRoute's own quota/rate-limit features
  on the per-user key, so a user cannot exceed limits even if Distro is
  bypassed. Requires reading OmniRoute's admin API for key-scoped limits —
  validate which knobs v3.8.x exposes before building.

### 3. Usage visibility

- Distro queries the gateway for per-key usage (tokens in/out, cost, model
  breakdown) and renders it per user (sidebar widget + settings page).
- If fine-grained reporting is needed (per-project/per-chat), Distro tags each
  request with an `X-Distro-*` header or model suffix convention and reads it
  back — check what OmniRoute records before inventing metadata.

### 4. Model policy

Multi-tenant operators typically want to control which models users can pick.
Options, in order of preference:

- Configure **fallback ladders** in OmniRoute and give users a small curated
  set of model ids (the gateway's own catalog is 350+ providers — too much
  choice for end users).
- Restrict the provider list Distro exposes (the scaffold keeps upstream
  providers; a `VITE_DISTRO_RESTRICT_PROVIDERS=OpenAILike`-style flag can gate
  the registry at build time).
- Hide model choice entirely behind one "smart default" per tier.

## Schema sketch (Distro DB)

```
users            id, email, password_hash, role, created_at, disabled_at
gateway_keys     id, user_id, gateway_key_id (FK into gateway), label,
                 created_at, revoked_at
usage_cache      user_id, date, tokens_in, tokens_out, cost, model, …  (sync)
quotas           user_id, plan, requests_per_day, spend_cap_usd, …
```

## Open decisions to resolve before building

- **Where does the control plane live?** Separate small service (cleaner
  security boundary, one more deployable) vs. inside `apps/web` (fewer moving
  parts, but the web app then needs a DB + admin routes).
- **Does OmniRoute's admin API support key provisioning + key-scoped quota +
  per-key usage reads out of the box?** If yes, the design above is nearly
  free. If its API is dashboard-only, the control plane may need to script the
  dashboard or drive the gateway's internal API — verify against the pinned
  version before committing.
- **Billing** (Stripe-style plans) or internal seat limits only? Distro's
  master plan defers billing until quotas/usage exist.
- **Which upstream providers** get registered on day one and whether free-tier
  providers are acceptable (the master plan allows free-tier-first).

## What the scaffold already assumes

- The web app talks to exactly one OpenAI-compatible endpoint (`/v1/*`) via
  `OPENAI_LIKE_API_BASE_URL/KEY` — replacing that one env key with a per-user
  key issued by the control plane is a runtime change, not an architecture
  change.
- Upstream provider keys stay out of the web app entirely.
- Docs/runbook assume one admin operator; the ops runbook notes where user
  provisioning will plug in.
