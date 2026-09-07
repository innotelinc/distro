# Distro — first build & testing walkthrough

Goal: prove the whole chain once — browser → Distro web → OmniRoute gateway →
upstream provider — and see quota/usage/admin working.

## 0. Prereqs

```bash
docker compose ps            # all four healthy: gateway, redis, web, control-plane
make doctor                  # gateway dashboard/API + web reachable
```

The stack binds **0.0.0.0**: on the host use `127.0.0.1`, from another machine
use the host's LAN IP (`hostname -I`).

| What | Direct URL |
|---|---|
| Distro web app | `http://<host>:5173` (landing `/`, workspace `/app`, login `/login`) |
| Admin console | `http://<host>:20140/admin` |
| OmniRoute dashboard | `http://<host>:20128` |
| OpenAI-compatible API | `http://<host>:20129/v1/...` (keys required) |

## 1. The happy path (browser)

1. Open the web app → **Start building** → you land on `/login`.
2. **Create an account** (min 8-char password). The account gets its own
   gateway API key minted automatically (visible later in the OmniRoute
   dashboard's API keys, named `distro-user-…`).
3. In the workspace pick a model from the gateway catalog (the default is
   pinned via `VITE_DEFAULT_MODEL`; if unset the UI auto-selects the first
   chat-capable model once the catalog loads).
4. Ask it to build something trivial ("a page with my name and a button").
   Expect: a streamed reply, files written to the file tree, `npm install` /
   `npm run dev` running in the terminal, and a live preview.
5. Chat again to see usage accrue:
   - `Admin console → Users` row shows today's requests/tokens (synced from
     the gateway's per-key ledger every `CONTROL_SYNC_INTERVAL_MS`).
   - `GET /api/me/usage` with your session token returns the same numbers.

Prefer no accounts? **Skip for now (host key)** on `/login` → single-operator
mode using the operator key from `.env` (`OPENAI_LIKE_API_KEY`); that traffic
is never quota-gated.

## 2. Quota enforcement (M3) — how to see the 429

1. Admin console → set **Req/day = 1** on a user → Save.
2. That user sends one message (succeeds), then another:
   the web app returns **HTTP 429** `{"error":"Daily quota reached …"}` and
   nothing is sent to the provider (no tokens burned). Clear the cap by
   emptying the field and saving.
3. The gateway key itself carries USD spend caps (`quota.spend_cap_usd` is
   applied as `dailyUsageLimitUsd` on mint/rotate) — the hard backstop even
   if the control plane is unreachable.

## 3. Admin console (M5)

`http://<host>:20140/admin`, sign in with an admin account. From there:

- stats cards (users, today requests/tokens/spend),
- per-user limits (plan, req/day, tokens/day, spend/day) — Save applies live,
- enable/disable (disable revokes the gateway key immediately; the user's
  next turn gets 401 from the gateway),
- revoke / rotate a user's key (after rotate the user must sign out/in to
  pick up the fresh key),
- role changes (last-admin guard) and account deletion (revokes key, cascades),
- the audit log panel below the users table.

`DELETE /api/admin/users/:id` is what you use to remove a test account — try
it with a throwaway signup; the key is revoked and all rows cascade.

## 4. Backups

```bash
make backup     # snapshots control-plane + gateway SQLite into ./backups/
```

Uses each app's online SQLite backup (no downtime); host copies kept 14 days.
Cron it (see docs/ops.md). `make doctor` after restore.

## 5. Serving through nginx proxy manager (TLS / hostnames)

NPM (this repo's recommended front door) proxies hostnames → `host:port`.
The app itself needs **no websocket** proxying — the sandbox/preview runs in
the browser via WebContainers. The simplest layout is ONE public hostname for
the whole product:

| NPM host | Forward to | Notes |
|---|---|---|
| `app.example.com` | `http://<host>:5173` | Distro web app (public) |
| `app.example.com` **+ advanced location** | `http://<host>:20140` | see the `/cp` snippet below (control plane on the same origin) |
| `gateway.example.com` | `http://<host>:20128` | OmniRoute dashboard — keep private/restricted |

**Same-origin `/cp` layout (recommended).** Browsers on an HTTPS page cannot
call a raw `:20140` port behind the proxy, so when the web app is served on a
proxied HTTPS host it automatically looks for the control plane at the same
origin under `/cp` — no CORS, no second host, no env to set. Add this to the
NPM host's **Advanced** tab (nginx custom config):

```nginx
location /cp/ {
    proxy_pass http://<host-lan-ip>:20140/;   # trailing / strips the /cp prefix
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
}
```

Then `https://app.example.com` serves everything: the web app at `/`, login
at `/cp/api/auth/login`, the admin console at `/cp/admin`. Login on any
plain-HTTP origin (LAN/localhost) keeps using `http://<host>:20140` directly,
so localhost still works without the snippet.

**Separate-host layout (optional).** If you prefer a dedicated
`admin.example.com → :20140` host instead, keep the default auto-resolution
OFF by baking the control plane's base: `.env`
`VITE_CONTROL_PLANE_URL=https://admin.example.com` → rebuild web, and lock
CORS with `CONTROL_CORS_ORIGIN=https://app.example.com` → restart
control-plane.

Optionally set the app's public HTTPS origin for the header indicator's
one-click link: `.env` `VITE_PUBLIC_ORIGIN=https://app.example.com` →
rebuild web.

**This mode is verified live** (local nginx + self-signed certs for
`app.distro.test` / `admin.distro.test`, proxy-mode env set, stack rebuilt): a
headless-browser E2E signing up over HTTPS — signup → workspace → gateway-key
adoption → build prompt → artifact — passes end-to-end through the proxy. CORS
is strict-origin: when `CONTROL_CORS_ORIGIN` is set, only requests whose
`Origin` matches get the allow-origin header, and preflights from any other
origin get `403` (no CORS grant). Reverted to LAN defaults after the test; the
running stack binds direct-LAN mode as shipped.

Nginx tips that mattered in the test: use `proxy_buffering off` on the app
server block (the chat endpoint streams; buffering delays first tokens) and
set `Connection ""` with HTTP/1.1 rather than upgrade headers unless you also
proxy WebSockets (bolt.diy previews run in-browser, so no WS needed for the
IDE itself).

## 6. Checks & troubleshooting

- `make doctor` — gateway dashboard/API/chat smoke + web reachability.
- `docker compose logs control-plane | grep usage-sync` — sync status.
- `docker compose exec control-plane node bin/control.mjs usage-sync` — manual sync.
- A chat returns 401 instantly → the account's key was revoked/rotated:
  sign out/in (adopts the fresh key) or have an admin check the console.
- Model errors mentioning image/embedding models → pick a chat model in the
  selector; unavailable presets auto-correct to a chat-capable model now.
- The OmniRoute dashboard remains the place to register upstream providers
  and read gateway-level logs; Distro never holds those provider keys.

### Live preview / terminal stay disconnected (chat works)

WebContainer (the in-browser runtime behind the preview and terminal) only
runs on a **trustworthy origin**: browsers ignore the COOP/COEP headers that
enable cross-origin isolation, and block service workers, on plain-HTTP
origins other than localhost. So:

- `http://localhost:5173` and `http://127.0.0.1:5173` → full shell works.
- `https://app.example.com` (your nginx proxy manager host) → full shell works.
- `http://<lan-ip-or-hostname>:5173` → **chat works, preview/terminal never
  connect** — this is a browser security rule, not a Distro bug.

The shell now shows an amber notice in that case, and the terminal pane
prints an explanation instead of hanging. Fix: open the app over HTTPS
(proxy host) or localhost. (Verified: headless Chromium on `127.0.0.1` boots
WebContainer and the preview iframe connects with the running app; the same
session on `http://172.x.x.x` reports `crossOriginIsolated: false`.)
