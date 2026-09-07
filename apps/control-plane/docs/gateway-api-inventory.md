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

## Per-key usage — resolved via the gateway's own SQLite ledger (M4)

The HTTP surfaces for usage (**`GET /api/usage/request-logs`** and friends)
return rows WITHOUT key attribution — `getRecentLogs` selects
`timestamp, model, provider, account, tokens_in, tokens_out, status` from
`call_logs` and drops the key columns. That was the earlier dead end.

Direct DB read (implemented in `src/gatewayUsage.js`): the gateway stores a
row per proxied call in **`usage_history`** with **`api_key_id`** (and
`api_key_name`, `account_key`) plus `tokens_input/output`, `success`,
`status`, `timestamp` — the per-key ledger. `call_logs` carries the same
`api_key_id`/`api_key_name` columns with more detail (method/path/errors).

Mechanism: compose mounts `gateway-data:/gateway-data:ro` into the control
plane; `syncUsageFromGateway()` aggregates `usage_history` for today grouped
by `api_key_id`, maps ids to users via `gateway_keys.gateway_key_id`, and
replaces that user's `usage_cache` (authoritative — every chat turn also
flows through the gateway under the user's key). Schema drift is guarded:
a failed read logs a warning and the real-time chat usage reports keep
working. Tune with `CONTROL_SYNC_INTERVAL_MS` (ms; 0 = manual only,
`docker compose exec control-plane node bin/control.mjs usage-sync`).

Security note: this gives the control plane read access to the gateway DB
volume (provider keys stay encrypted with the gateway's `API_KEY_SECRET`);
it already holds the dashboard admin password, so the trust boundary is
unchanged in practice.

## Confirmed against the pinned image (v3.8.51 / Sep 2026)

1. The **per-key usage read** problem is solved by the direct ledger read
   above (HTTP endpoints lack the column).
2. The **provider credential write** endpoint used by the dashboard's
   "add API key" flow remains manual in the dashboard — recommended v1.
   (Endpoints seen: `POST /api/oauth/[provider]/paste-credentials`.)

## Session/cookie notes

- Login guard may rate-limit after failures; keep a single control-plane
  service account session and reuse it (or mint a long-lived admin token if
  OmniRoute exposes one).
- JWT_SECRET signs sessions; rotating it invalidates dashboard sessions.
