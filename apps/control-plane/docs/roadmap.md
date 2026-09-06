# Control-plane roadmap

Milestones are ordered so each one is runnable and shippable on its own.
Estimated sizes are relative; revisit against the pinned gateway version.

## M0 — Service skeleton + gateway client (0.5–1 session)

- [ ] Stand up `apps/control-plane` as a small Node service (Fastify recommended;
      plain Node acceptable) with its own `package.json`, health endpoint,
      config from env, and a SQLite store loaded from `schema.sql`.
- [ ] Add it to the root compose network (`control-plane` service; no public
      port; only the web app and gateway can reach it).
- [ ] Implement `gatewayClient` wrapping the inventory in
      `docs/gateway-api-inventory.md`: login (service session), create key,
      list keys, revoke key, read usage.
- [ ] Acceptance: control plane can mint and revoke a gateway key via its own
      CLI/script (`scripts/`), reusing the exact calls proven in the scaffold.

## M1 — Identity (1 session)

- [ ] Signup + login + logout with sessions (opaque bearer tokens, hashed at
      rest; see `schema.sql`).
- [ ] Admin role bootstrap (first user or `ADMIN_EMAILS` env).
- [ ] `/health`, error envelope, rate limiting on auth endpoints.
- [ ] Acceptance: two users can sign up and get distinct sessions; disabled
      users can't log in.

## M2 — Per-user gateway keys (1 session)

- [ ] On signup: mint a gateway key via the gateway client, store mapping in
      `gateway_keys`.
- [ ] On disable/delete: revoke gateway key.
- [ ] Key rotation endpoint (admin + user self-service).
- [ ] Decide integration option A vs B:
      - **A (browser holds key)**: web app calls control plane
        `/me/gateway-key` at login and uses it as its `OpenAILike` key. Simplest
        to implement; key is visible to the user (acceptable — it's their key).
      - **B (server proxy)**: control plane terminates /v1 and stamps each
        request with the session's key. More work; key never reaches the
        browser; enables server-side quotas naturally.
- [ ] Acceptance: user A's requests are attributed to A's gateway key in the
      gateway dashboard (usage per key).

## M3 — Quotas (1 session)

- [ ] Coarse enforcement middleware in the web app / control plane:
      requests/day, tokens/day, spend cap from `quotas` before proxying.
- [ ] Map gateway usage-limits onto the per-user key (`/api/keys/[id]/usage-limits`)
      for hard enforcement when the gateway is bypassed.
- [ ] Acceptance: a user over their daily cap gets a clear error; admin can
      change plan and it applies without key rotation.

## M4 — Usage visibility (0.5–1 session)

- [ ] Sync `usage_cache` from gateway per-key usage on a schedule.
- [ ] `GET /me/usage` (today, 30-day totals, per-model if gateway exposes it).
- [ ] Minimal UI: usage widget in the Distro settings sidebar (or a small
      control-plane page).
- [ ] Acceptance: usage shown matches the gateway dashboard per key ± sync lag.

## M5 — Hardening & operator UX (1 session)

- [ ] Admin endpoints/UI: list users, disable, set quota/plan, view usage.
- [ ] Billing hook points (Stripe etc.) behind a `billing` interface — only if
      paid tiers are in scope.
- [ ] Audit log (signups, key rotations, quota changes), backups of the
      control-plane DB, docs runbook section.
- [ ] Acceptance: a second operator can administer the platform from the
      dashboard without touching compose/DB.

## Open questions to resolve before/at M2

- Gateway version drift: re-verify the inventory endpoints on the pinned
  `OMNIROUTE_IMAGE_TAG` before each milestone.
- Whether OmniRoute exposes per-key **model-level** usage (M4 granularity).
- Option A vs B above (user-agent key handling / proxy) — affects M2–M4.
- Where the quota check lives if option A is chosen (web app middleware needs
  to call the control plane on every `/api/chat`).
