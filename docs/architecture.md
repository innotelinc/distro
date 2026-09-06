# Distro — Architecture

**Distro** is a self-hosted AI app-building platform: describe an app in plain
language and an AI agent writes, runs, previews, and iterates on a full-stack
codebase in your browser — no local dev environment required.

It is a product assembled from two MIT-licensed upstream projects:

| Layer | Upstream | Role |
|---|---|---|
| Builder / IDE / agent UI | [bolt.diy](https://github.com/stackblitz-labs/bolt.diy) (`stable`) — forked into `apps/web` | The in-browser IDE: chat-to-code, WebContainer sandbox, live preview, file tree, terminal, git/deploy. Rebranded as **Distro**. |
| Model routing / gateway | [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — run from its published image (source checkout kept in `vendor/`) | One OpenAI-compatible endpoint (`/v1/*`) that routes across many upstream providers with fallback, token/cost accounting and format translation. |

```
┌──────────────────────────────────────────────┐
│                Distro (apps/web)             │
│   rebranded bolt.diy browser IDE             │
│   chat-to-code · WebContainer · preview      │
└──────────────────┬───────────────────────────┘
                   │  POST /v1/chat/completions
                   │  (OpenAI-compatible, AI SDK)
                   ▼
┌──────────────────────────────────────────────┐
│              OmniRoute gateway               │
│   dashboard :20128 · API :20129 · WS :20132  │
│   routing · fallback · token/cost tracking   │
└──────────────────┬───────────────────────────┘
                   ▼
        upstream providers (Anthropic, OpenAI,
         Gemini, DeepSeek, free tiers, …)
```

## The integration seam

OmniRoute speaks the OpenAI API shape, and bolt.diy ships an **OpenAILike**
provider (`apps/web/app/lib/modules/llm/providers/openai-like.ts`) that
accepts an arbitrary `baseURL` + key and fetches its model list from
`GET {baseURL}/models`. That makes the whole gateway a configuration change,
not an adapter:

- `OPENAI_LIKE_API_BASE_URL` → the gateway's OpenAI-compatible endpoint
  (must include `/v1`), e.g. `http://gateway:20129/v1` inside the compose
  network or `http://127.0.0.1:20129/v1` from the host.
- `OPENAI_LIKE_API_KEY` → an API key issued by the OmniRoute dashboard.

Distro-specific defaults added on top of upstream bolt.diy:

- `OpenAILike` is registered first in the provider registry
  (`app/lib/modules/llm/registry.ts`), so `LLMManager.getDefaultProvider()`
  returns it and fresh sessions default to it.
- It starts **enabled** out of the box (`app/lib/stores/settings.ts`), unlike
  the other URL-configurable local providers.
- `VITE_DEFAULT_MODEL` overrides the preselected model id
  (`app/utils/constants.ts`) so an operator can pin a model their gateway
  always exposes.

All LLM traffic flows server-side: the browser calls Distro's own routes
(`/api/chat`, `/api/models`), which run inside the Cloudflare-pages/workerd
runtime and talk to the gateway with the operator key. The browser never holds
upstream provider keys.

## Where the code lives

```
.
├── apps/web/          Distro — rebranded bolt.diy fork (pnpm, Remix + Cloudflare Pages)
├── docker-compose.yml gateway + web as one stack (gateway ports bound to 127.0.0.1)
├── Makefile           up/down/doctor/bootstrap/sync-upstream …
├── scripts/           bootstrap, health checks, upstream sync, brand-asset generator
├── docs/              this doc, multi-tenant design, ops runbook, upstream sync notes
└── vendor/            git-ignored upstream working copies (OmniRoute source, bolt.diy ref)
```

## Key security decisions (v1)

- The gateway's published ports bind to **127.0.0.1**. Distro's web app is the
  only public surface; put your TLS reverse proxy in front of `:5173`.
- Upstream provider API keys live **only** in the gateway's encrypted SQLite
  volume (`gateway-data`, env secrets `API_KEY_SECRET`/`JWT_SECRET`). Distro
  holds a single gateway-issued key.
- OmniRoute container memory is raised above its default pin
  (`GATEWAY_MAX_OLD_SPACE_MB=4096`) because coding-agent traffic carries
  large, overlapping contexts.

## Deliberate scope choices

- `apps/web` keeps upstream code identifiers, CSS tokens (`--bolt-*`) and
  storage keys so syncing with upstream `stable` stays mechanical. Rebranding
  touches only user-visible copy + product identity.
- The OmniRoute source tree (~294 MB) is **not committed**; the stack runs the
  pinned published image and `scripts/sync-upstream.sh` fetches source on
  demand. `docs/upstream.md` explains the trade-off.
- The desktop (Electron) build ships from upstream config; only branding was
  renamed. Verifying/publishing desktop artifacts is a later-phase task.

## Roadmap shape (from the Distro master plan)

1. ~~Gateway online~~ → this scaffold (boot + verify).
1. ~~Rebrand & wire~~ → this scaffold.
1. Product hardening → **multi-tenant** auth, per-user quotas and usage
   visibility on top of the gateway (see `docs/multi-tenant.md`), deploy
   targets, rate limiting.
1. Differentiation → curated model/fallback ladder for coding, prompt tuning
   per model family, project templates, saved workspaces, team sharing.
