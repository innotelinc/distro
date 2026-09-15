# Distro — testing & verification walkthrough

Goal: prove the tenancy service end to end — accounts, per-user gateway keys,
quota enforcement, usage accounting, the admin console, and the service API
the builder surface (Studio) consumes.

## 0. Prereqs

```bash
docker compose ps            # control-plane healthy
make doctor                  # remote gateway dashboard/API reachable
```

The stack binds **0.0.0.0** by default: on the host use `127.0.0.1`, from
another machine use the host's LAN IP (`hostname -I`).

| What | Direct URL |
|---|---|
| Admin console | `http://<host>:20140/admin` |
| Control-plane API | `http://<host>:20140/api/*` |
| OmniRoute dashboard (remote) | `http://<host>:20128` |
| OpenAI-compatible API (remote) | `http://<host>:20128/v1/...` |

## 1. Accounts and keys

1. Sign up the first account (min 8-char password) — it bootstraps as an
   admin, or seed admins with `CONTROL_ADMIN_EMAILS`.
2. The account gets its own gateway API key minted automatically (visible in
   the OmniRoute dashboard's API keys, named `distro-user-…`).
3. `GET /api/me/usage` with the session token returns that account's
   requests/tokens/spend.

## 2. Quota enforcement — how to see the 429

1. Admin console → set **Req/day = 1** on a user → Save.
2. Have the builder surface speak with that user's key twice: the first turn
   succeeds, the next is denied **HTTP 429** `{"error":"Daily quota reached …"}`
   and nothing is sent to the provider (no tokens burned). Clear the cap by
   emptying the field and saving.
3. The gateway key itself carries USD spend caps (`quota.spend_cap_usd` is
   applied as `dailyUsageLimitUsd` on mint/rotate) — the hard backstop even
   if the control plane is unreachable (quota-check is deliberately
   fail-open).

## 3. The service API (what Studio consumes)

With `CONTROL_INTERNAL_TOKEN` set (Distro's `bootstrap.sh` generates it):

1. `POST /api/internal/identity` with an Authentik subject → provisions (or
   finds) the account and returns its gateway key. Repeat → same account, no
   duplicates. A subject claiming an existing account's email with a
   different subject → `409`.
2. `GET /api/internal/quota-check` before a model call; deny → the surface
   must not dispatch. Empty quota → allow.
3. `POST /api/internal/usage-report` after the call → the user's usage row
   and the admin console's stats move.
4. `POST /api/internal/audit` with `build.start` / `build.publish` /
   `build.export` → the audit panel shows the rows.
5. All four with no/`wrong` token → `503`/`401`; the routes fail closed.

## 4. Admin console

`http://<host>:20140/admin`, sign in with an admin account. From there:

- stats cards (users, today requests/tokens/spend),
- per-user limits (plan, req/day, tokens/day, spend/day) — Save applies live,
- enable/disable (disable revokes the gateway key immediately),
- revoke / rotate a user's key,
- role changes (last-admin guard) and account deletion (revokes key, cascades),
- the audit log panel, and the read-only build-queue view
  (`STUDIO_BUILD_QUEUE_DIR` mounted `:ro`; unset renders an explanatory
  empty panel, never an error page).

`DELETE /api/admin/users/:id` removes a test account — try it with a
throwaway signup; the key is revoked and all rows cascade.

## 5. Tests

```bash
cd apps/control-plane && npm install && npm test
```

Covers the schema migration (including the `oidc_sub` upgrade path on an
existing database), identity provisioning/conflict, quota gating, usage
reports, audit writes, and the build-queue reader.

## 6. Backups

```bash
make backup     # snapshots the control-plane SQLite into ./backups/
```

Online SQLite backup (no downtime); host copies kept 14 days. Cron it (see
docs/ops.md). `make doctor` after restore.

## 7. Serving through nginx proxy manager (TLS / hostnames)

NPM proxies hostnames → `host:port`. The service API is plain JSON — no
websocket proxying needed.

| NPM host | Forward to | Notes |
|---|---|---|
| `app.example.com` | `http://<host>:20140` | control plane (admin console at `/admin`) |
| `gateway.example.com` | `http://<host>:20128` | OmniRoute dashboard — keep private/restricted |

Lock CORS to the builder surface's origin:
`CONTROL_CORS_ORIGIN=https://<studio-host>` → restart control-plane. When
set, only requests whose `Origin` matches get the allow-origin header, and
preflights from any other origin get `403` (no CORS grant).

## 8. Checks & troubleshooting

- `make doctor` — remote gateway dashboard/API/chat smoke.
- `docker compose logs control-plane | grep usage-sync` — sync status (off by
  default: `CONTROL_SYNC_INTERVAL_MS=0`, the gateway is remote).
- `docker compose exec control-plane node bin/control.mjs usage-sync` —
  manual sync (needs a read-only gateway data mount at `GATEWAY_DATA_DIR`).
- A builder turn returns 401 instantly → the account's key was
  revoked/rotated: re-resolve the identity (returns the fresh key) or have an
  admin check the console.
- The OmniRoute dashboard remains the place to register upstream providers
  and read gateway-level logs; Distro never holds those provider keys.
