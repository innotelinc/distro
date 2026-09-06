# Distro Control Plane (planning)

> Status: **planned** — schema, API inventory and task breakdown are committed
> here so the implementation session starts fast. Nothing in this directory is
> runnable yet.

The control plane is Distro's Phase 2 multi-tenant layer: Distro accounts,
**one gateway API key per user**, quota enforcement and usage visibility on
top of the shared OmniRoute gateway.

Why per-user gateway keys: OmniRoute already does token/cost accounting,
quota windows and rate limiting **per API key**, so mapping
`distro_user ↔ gateway_key` gives per-user attribution and enforcement for
free — no gateway forking required.

See also:

- [docs/multi-tenant.md](../../docs/multi-tenant.md) — the design rationale
  and trust boundaries.
- [docs/gateway-api-inventory.md](docs/gateway-api-inventory.md) — OmniRoute
  dashboard/API endpoints the control plane will drive (several verified
  against v3.8.51 in this scaffold).
- [schema.sql](schema.sql) — proposed Distro DB (users, gateway_keys, quotas,
  usage cache).
- [docs/roadmap.md](docs/roadmap.md) — milestone-by-milestone task breakdown.

## Shape of the build

A small service (Fastify/Express/plain Node — decision in roadmap M0) that:

1. authenticates Distro users (signup/login, sessions),
2. mints/rotates/revokes a gateway API key per user through the gateway's
   dashboard API (same calls `scripts/` used during scaffold verification),
3. proxies or tags LLM traffic so each request carries the user's key,
4. reads per-key usage back from the gateway for quota UI and billing.

It joins the existing compose network as a new service; the web app's single
`OPENAI_LIKE_API_KEY` becomes a per-session key injected by the control plane
(see roadmap M2/M3 for the two integration options).

## Verification notes already proven in the scaffold (v3.8.51)

- `POST /api/auth/login` with `{"password": ...}` returns `{"success":true}`
  and a session cookie.
- `POST /api/keys` with `{"name","modelAccessMode":"all"}` returns
  `201` + `{ key, id, machineId, … }` — the key authenticates on
  `/v1/chat/completions` and `/v1/models`.
- Changing the admin password on a live DB requires writing the bcrypt hash
  into the `key_value` settings table (or `node /app/bin/reset-password.mjs`
  from a host where the CLI deps resolve); `INITIAL_PASSWORD` only seeds fresh
  databases. (Container exec path documented in docs/ops.md.)
