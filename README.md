# Distro

**Self-hosted AI app-building platform.** Describe an application in natural
language and Distro's AI agent writes, runs, previews, and iterates on a
full-stack codebase in your browser — no local dev environment required.

Distro is not built from scratch. It assembles two MIT-licensed open-source
projects and operates them as one service:

- **[bolt.diy](https://github.com/stackblitz-labs/bolt.diy)** (`stable`) —
  the in-browser IDE (chat-to-code, WebContainer sandbox, live preview, file
  tree, terminal, git/deploy). Forked and rebranded into [`apps/web`](apps/web/).
- **[OmniRoute](https://github.com/diegosouzapw/OmniRoute)** — the AI routing
  gateway. One OpenAI-compatible `/v1/*` endpoint in front of hundreds of
  upstream providers, with fallback and token/cost accounting.

bolt.diy's **OpenAILike** provider plugs directly into OmniRoute's
OpenAI-compatible endpoint — no custom adapter code. That seam is the whole
integration: Distro's agent only ever talks to OmniRoute, and OmniRoute is the
only place upstream provider keys live.

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│        Distro (web)          │  /v1/* │         OmniRoute            │
│   rebranded bolt.diy IDE     ├───────►│   routing · fallback ·       ├──► upstream
│   chat · WebContainer ·      │ OpenAI │   usage accounting · MCP     │    providers
│   preview · terminal · git   │ compat │                              │
└──────────────────────────────┘        └──────────────────────────────┘
```

## Quickstart (self-hosted, Docker)

```bash
cp .env.example .env          # or: ./scripts/bootstrap.sh (generates secrets)
./scripts/bootstrap.sh        # starts gateway, prints guided next steps
```

1. Open the OmniRoute dashboard at **http://127.0.0.1:20128**, sign in with
   `INITIAL_PASSWORD` from `.env`, and register upstream provider API keys.
2. Issue a gateway API key (Dashboard → API Keys) and set
   `OPENAI_LIKE_API_KEY` in `.env`.
3. Start the Distro web app and verify:

```bash
docker compose up -d --build web
make doctor
# open http://127.0.0.1:5173
```

Open http://127.0.0.1:5173 → **Start building** (the workspace lives at
`/app`). Distro is gateway-only by default: the only provider is OmniRoute,
and the model picker lists whatever your gateway exposes.

## Documentation

| Doc | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | how the two upstreams fit together, the integration seam, where Distro's defaults live |
| [docs/ops.md](docs/ops.md) | first boot, ports, secrets, day-2 ops, sizing, reverse proxy |
| [docs/upstream.md](docs/upstream.md) | pinning + updating bolt.diy/OmniRoute, license/attribution |
| [docs/multi-tenant.md](docs/multi-tenant.md) | Phase 2 design: accounts, per-user quotas, usage visibility |
| [apps/web/README.md](apps/web/README.md) | the bolt.diy fork itself (rebrand + gateway defaults, standalone run) |

## Repo layout

```
apps/web/            Distro — rebranded bolt.diy fork (the front door)
docker-compose.yml   gateway (OmniRoute image) + web, gateway bound to loopback
Makefile             up / down / doctor / bootstrap / sync-upstream / …
scripts/             bootstrap · healthcheck-gateway · sync-upstream · gen-brand-assets
docs/                architecture · ops · upstream · multi-tenant
vendor/              git-ignored upstream working copies (OmniRoute source etc.)
```

## Notes & roadmap

- Status: **Phase 0/1 complete** — gateway boots, Distro rebranded and wired to
  the gateway, gateway-only mode + landing page shipped; next is Phase 2
  (multi-tenant auth/quotas, deploy targets) and Phase 3 differentiation
  (model fallback ladder, prompt tuning, templates/workspaces). See the docs.
- Routes: `/` is a landing page; the workspace is `/app` (saved chats at
  `/chat/:id`). Gateway ports publish on the LAN (`GATEWAY_BIND_HOST`, default
  `0.0.0.0`) — keep the dashboard password strong.
- The gateway container heap defaults to 4096 MB (`GATEWAY_MAX_OLD_SPACE_MB`)
  because coding-agent traffic is memory-hungry; upstream's default pin is
  smaller and OOMs under load.
- Upstream provider keys live only in the gateway's SQLite volume. Distro
  holds a single gateway-issued key (`OPENAI_LIKE_API_KEY`).
- Desktop (Electron) packaging is inherited from upstream and only rebranded
  in config; it is not yet part of the verified path.

## License

MIT. Distro's new material is MIT (root [`LICENSE`](LICENSE)); both upstream
projects remain MIT with their licenses retained in-tree. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
