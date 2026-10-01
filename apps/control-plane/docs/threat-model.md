# Control plane — threat model

> Written before somebody has to reason about it during an incident. It is the M8
> answer to one question: **the plane mints gateway keys and reads a SQLite file
> the gateway also reads — what does that mean for the service token, the console's
> session, the Vault references and the backup directory?**
>
> It is deliberately about what this process *is*, not a list of everything the
> stack could do. Where a control has a limit, the limit is stated beside it,
> because a threat model that only lists green ticks is one nobody trusts.

## 1. What the plane holds

| It holds | Because |
| --- | --- |
| Accounts (email, role, plan, `oidc_sub`) | the tenancy layer under Genie |
| One gateway API key per account | OmniRoute's own per-key accounting is the attribution |
| Quotas and a usage cache (`usage_cache`, `usage_models`) | the gate and the account's own view |
| An audit log (`audit_log`, `alert_log`) | who did what, and every alert attempt |
| Storage **provider metadata** and **pool** rows | Shares; each row names a `credential_ref`, never a credential |

## 2. What it must **never** hold

- **Upstream model provider keys.** Those live in the gateway's store on the
  platform host and nowhere else. Distro spells this out in
  [ops.md](../../../docs/ops.md) § Secrets, and the plane's compose mounts **no**
  gateway volume for exactly this reason.
- **Raw storage-provider credentials.** A provider row carries a
  `credential_ref` that names a value in the deployment's secret store; the plane
  stores the reference and never the secret.
- **A user's password in the clear.** `src/passwords.js` is scrypt over
  `node:crypto`; an SSO account gets an unusable `sso:` hash rather than a
  password it could ever verify.
- **A session token in the clear.** `src/auth.js` stores `sha256(token)`, so a
  copy of the database is a list of ended sessions, not a set of credentials that
  work.
- **The Vault token.** It comes from `VAULT_TOKEN` or, preferably,
  `VAULT_TOKEN_FILE`; it is used and discarded, never written to the database.

## 3. Trust boundaries

```
   browser (Distro web / admin console)
        │  bearer session token, CORS-restricted            ── boundary A
        ▼
   ┌───────────────────────┐   x-control-internal-token    ── boundary B
   │   control plane       │◀──────────── Genie (builder surface)
   │   (port 20140)        │
   └───────┬───────────────┘
           │  service key (OPENAI_LIKE_API_KEY) + dashboard login
           ▼                                          ── boundary C
   ┌───────────────────────┐
   │  OmniRoute gateway    │  mints/revokes per-account keys
   │  (remote, :20128)     │
   └───────────────────────┘
           ▲
           │  control.sqlite read by the plane, and the gateway's own
           │  usage_history read (read-only) at GATEWAY_DATA_DIR   ── boundary D
   ┌───────────────────────┐
   │  Cerulean Vault       │  `vault://` references resolve at boot ── boundary E
   └───────────────────────┘
```

- **A — the browser.** A session is a bearer token; CORS is `*` by default and
  should be pinned to the Distro origin (`CONTROL_CORS_ORIGIN`) wherever the
  console is reachable from more than one place.
- **B — the service token.** `CONTROL_INTERNAL_TOKEN`, presented by Genie as
  `x-control-internal-token`, compared with `timingSafeEqual`. **Unset means the
  `/api/internal` identity and audit routes are OFF (503), never open** — a
  deployment that has not named a token has not accepted service traffic.
- **C — the gateway.** The plane authenticates with the dashboard password and
  mints keys through the management API; it never reads the gateway's data
  directory in the shipped stack.
- **D — the shared SQLite file.** `control.sqlite` is the plane's; the gateway's
  `usage_history` is read only when `GATEWAY_DATA_DIR` is mounted read-only,
  which the remote-gateway default does not do.
- **E — Vault.** `vault://<mount>/<path>#<key>` values are resolved once, on
  import, before any config module reads `process.env`; a reference that cannot be
  resolved is fatal at startup rather than a literal string used later as a
  secret.

## 4. Adversaries and the residual behind each control

The residual is the part that matters: it is what is still true after the control.

| Adversary | Failure mode | Control | Residual |
| --- | --- | --- | --- |
| **A peer on the LAN** | reaches `:20140` and tries the internal routes | `CONTROL_INTERNAL_TOKEN` unset ⇒ those routes are 503, not open; a set token is compared in constant time | The plane still binds `0.0.0.0` by default. It is meant to sit behind the Cerulean edge; a LAN host that can reach the port can still call the public auth and admin routes. |
| **A stolen console session** | acts as an admin until the token expires | tokens are stored hashed; logout revokes; a session has a TTL | A bearer token is a bearer token: anyone who has it is the admin until it expires or is revoked. Bind the console behind TLS and a VPN/host allowlist. |
| **A forged `Host` header** | aims an OIDC authorization code at an attacker origin | `OIDC_REDIRECT_URI` is a comma-separated allowlist; the request's own origin is used only when it is on that list | Any origin the operator adds to the list is trusted by construction. Keep the list to the hostnames you actually serve. |
| **A leaked `.env`** | reads every credential the plane holds | `.env` carries `vault://` references, not values, wherever SecretOps is in use | The Vault **token** and the gateway dashboard password must still be present somewhere in the environment. A leaked process environment is a leaked `.env`. |
| **Someone with the backup directory** | restores the record and reads it | backups are the record and the evidence together; sessions are hashed, passwords are scrypt | A backup is the whole plane, including the hashed keys and the audit log. `./backups/` needs the same access control as the volume, and a rehearsed restore is how you find out what is in it. |
| **The gateway itself** | a compromised gateway answers a key-mint with something else | the plane verifies the gateway **version** at boot and before every usage sync and warns loudly on a mismatch | The plane trusts the gateway's management API by design. A hostile gateway is the platform's incident, not this service's. |
| **A cross-tenant caller** | reads another account's usage | every query is scoped by account; `GET /api/me/usage` reads the caller's own rows | Isolation is enforced in the application over one SQLite file. A query that forgot its account id would be a cross-tenant read; the mitigation is that the scoping lives in one place and is tested, not that the database enforces it. |

## 5. What is deliberately not here

- **Row-level security / a database per account.** Both accounts' rows live in one
  SQLite file. If Distro ever holds data you would not co-locate, this is the next
  layer, and it is not built.
- **A gateway data-directory read in the shipped stack.** The M4 usage sync is off
  (`CONTROL_SYNC_INTERVAL_MS=0`) because the gateway is remote; the read-only
  mount is an operator's deliberate choice, and the threat is then the gateway's
  own store.
- **An audit-log integrity mechanism.** `audit_log` is append-only by convention
  and by the code's own writes; it is **not** hash-chained the way Sentinel's
  evidence log is. An operator who needs tamper-evidence across products should
  export through the platform's evidence path rather than treat this table as one.
  This is stated here rather than implied by the word "audit".
