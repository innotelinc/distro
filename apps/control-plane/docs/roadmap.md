# Control-plane roadmap

> Progress: **M0, M1 and the M2 key-lifecycle slice are DONE** (service +
> gateway client + identity + mint-on-signup/rotate/revoke, verified live
> against the gateway). Remaining below are M3+ and the web-app integration.

Milestones are ordered so each one is runnable and shippable on its own.
Estimated sizes are relative; revisit against the pinned gateway version.

## M0 — Service skeleton + gateway client ✅

- [x] Stand up `apps/control-plane` as a small Node service (plain Node HTTP,
      no framework) with its own `package.json`, health endpoint, config from
      env, and a SQLite store loaded from `schema.sql`.
- [x] Add it to the root compose network (`control-plane` service; no public
      port; only the web app and gateway can reach it).
- [x] Implement `gatewayClient` wrapping the inventory in
      `docs/gateway-api-inventory.md`: login (service session), create key,
      list keys, revoke key. (Per-key usage read deferred to M4.)
- [x] Acceptance: control plane can mint and revoke a gateway key via its own
      CLI/script (`scripts/`), reusing the exact calls proven in the scaffold.

## M1 — Identity ✅

- [x] Signup + login + logout with sessions (opaque bearer tokens, hashed at
      rest; see `schema.sql`).
- [x] Admin role bootstrap (first user or `ADMIN_EMAILS` env).
- [x] `/health`, error envelope. (Rate limiting on auth endpoints still TODO.)
- [x] Acceptance: two users can sign up and get distinct sessions; disabled
      users can't log in (verified live).

## M2 — Per-user gateway keys ✅ (key lifecycle)

- [x] On signup: mint a gateway key via the gateway client, store mapping in
      `gateway_keys` (verified: key authenticates on /v1/models).
- [x] On disable/delete: revoke gateway key (verified: key 401s after disable).
- [x] Key rotation endpoint (`POST /api/me/gateway-key/rotate`).
- [ ] Decide integration option A vs B (needed before web integration):
      - **A (browser holds key)**: web app calls control plane
        `/me/gateway-key` at login and uses it as its `OpenAILike` key. Simplest
        to implement; key is visible to the user (acceptable — it's their key).
      - **B (server proxy)**: control plane terminates /v1 and stamps each
        request with the session's key. More work; key never reaches the
        browser; enables server-side quotas naturally.
- [x] Acceptance: each user's requests are attributed to their own gateway key
      (key-per-user visible in the gateway dashboard).

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
