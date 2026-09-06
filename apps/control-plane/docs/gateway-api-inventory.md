# OmniRoute endpoint inventory (for the control plane)

All dashboard routes live on the gateway's dashboard port (`:20128`), the
OpenAI-compatible API on `:20129`. Auth = session cookie obtained from
`POST /api/auth/login`. Verified against OmniRoute v3.8.51 (image
`diegosouzapw/omniroute:latest` as of Sep 2026).

Legend: ✅ verified in this scaffold · 🔎 verify at build time

| Method & path | Purpose | Status |
|---|---|---|
| `POST /api/auth/login` | `{password}` → `{success:true}` + session cookie | ✅ |
| `POST /api/keys` | create gateway key `{name, modelAccessMode?, allowedModels?, scopes?}` → `201 {key,id,machineId,…}` | ✅ |
| `GET /api/keys` | list keys (needed: user→key reconciliation) | ✅ file exists — confirm payload |
| `DELETE /api/keys/[id]` | revoke a key (user disable/offboard) | 🔎 |
| `POST /api/keys/[id]/regenerate` | rotate a key without changing its id/limits | 🔎 |
| `GET|PUT /api/keys/[id]/usage-limits` | per-key spend/request limits (fine-grained quota layer) | 🔎 |
| `GET /api/v1/registered-keys` | registered keys incl. scopes/connections | 🔎 |
| `POST /api/v1/registered-keys/[id]/revoke` | revoke via the v1 surface | 🔎 |
| `GET /api/usage/request-logs` | per-key request/usage logs | 🔎 |
| `GET /api/usage/utilization` | usage aggregation (dashboards) | 🔎 |
| `GET /api/usage/quota` | quota state | 🔎 |
| `POST /api/usage/budget` | budget/quota windows per key | 🔎 |
| `GET /api/usage/logs` | usage ledger | 🔎 |
| providers `POST|PUT /api/providers/[id]` etc. | register upstream credentials (operator-only) | 🔎 |
| `POST /api/oauth/[provider]/paste-credentials` | paste-style credential entry for cookie providers | 🔎 |
| `GET /v1/models` | model catalog (auth via gateway key) | ✅ (401→200 once key set) |
| `POST /v1/chat/completions` | chat completions (auth via gateway key) | ✅ (auth verified; final hop needs an upstream credential) |

Two items the implementation session must confirm against the pinned image:

1. The exact **per-key usage read** shape (which endpoint returns
   tokens/cost *per key id* for a date range — most likely a filter on
   `/api/usage/*`).
2. The **provider credential write** endpoint used by the dashboard's
   "add API key" flow, if the control plane should provision operators too
   (otherwise keep that manual in the dashboard — recommended v1).

## Session/cookie notes

- Login guard may rate-limit after failures; keep a single control-plane
  service account session and reuse it (or mint a long-lived admin token if
  OmniRoute exposes one).
- JWT_SECRET signs sessions; rotating it invalidates dashboard sessions.
