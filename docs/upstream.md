# Distro — Tracking Upstream

Distro is assembled from two MIT-licensed projects. This page documents how
the repo pins them, how to update, and how attribution is handled.

## Pinned state

| Project | Branch / ref | Used as | Pin mechanism |
|---|---|---|---|
| stackblitz-labs/bolt.diy | `stable` (v1.0.0, May 2025) | `apps/web` — a **fork with Distro edits committed in-tree** | git history of this repo |
| diegosouzapw/OmniRoute | default branch (v3.8.51, Sep 2026) | remote platform service (Consul `omniroute`); LOCAL fallback = published image `diegosouzapw/omniroute` | platform operators; `OMNIROUTE_IMAGE_TAG` in `.env` for the local fallback |

Current SHAs are recorded in `docs/upstream-snapshot.txt` (refreshed by
`make sync-upstream`).

## Why OmniRoute source isn't committed

OmniRoute is consumed as a remote platform service; there is no vendored
checkout at all (the old ~294 MB `vendor/omniroute` snapshot was removed).
The local fallback runs the published image only, pinned by
`OMNIROUTE_IMAGE_TAG` in `.env` (compose profile `local-gateway`). Gateway
upgrades are the platform operators' concern; Distro only needs
`OPENAI_LIKE_API_BASE_URL` + a gateway key.

## Updating bolt.diy → apps/web

`apps/web` is a real fork: rebranding + Distro defaults are committed on top
of upstream `stable`. Sync workflow:

```bash
make sync-upstream                 # refresh vendor/bolt.diy-upstream (stable)
# Review what changed upstream since your fork:
git -C vendor/bolt.diy-upstream log --oneline -20
diff -rq vendor/bolt.diy-upstream apps/web --exclude=.git \
  | grep -v -E '\.(png|ico|jpg|svg|lock)$' | head -50
```

Then cherry-pick upstream changes manually. The fork deliberately keeps the
following untouched so diffs stay small and rebase-friendly:

- code identifiers & protocol tags (`boltArtifact`, `boltAction`,
  `BoltShell`, `boltTerminal`, `MODIFICATIONS_TAG_NAME`, …),
- CSS/design tokens (`--bolt-elements-*`, `bg-bolt-*`),
- localStorage/IndexedDB keys (`bolt_theme`, `boltHistory`, `provider_settings`,
  `bolt_user_profile`, `bolt-event-logs-*` export naming is cosmetic and was
  renamed),
- upstream docs (`docs/`, `FAQ.md`, …) — read-only references.

Files Distro deliberately diverges in (branding + defaults):

```
app/lib/modules/llm/registry.ts      # OpenAILike registered first = default
app/lib/stores/settings.ts           # OpenAILike enabled out of the box
app/utils/constants.ts               # VITE_DEFAULT_MODEL override
app/lib/common/prompts/*.ts          # agent persona = "Distro"
app/components/header/Header.tsx     # Distro wordmark
pre-start.cjs · package.json · wrangler.toml · electron-builder.yml
public/favicon.* + apple-touch icons
app/routes/_index.tsx · git.tsx · api.system.app-info.ts · several copy spots
```

A merge from upstream may touch those files — resolve in favor of the Distro
version, re-applying the intent above.

## OmniRoute updates

There is no vendored OmniRoute checkout anymore: the gateway is consumed as a
remote platform service (Innotel platform stack, Server 2; Consul service
`omniroute`). Gateway upgrades are the platform operators' concern — Distro
only needs a working `OPENAI_LIKE_API_BASE_URL` + key.

For the LOCAL fallback (compose profile `local-gateway`, published image only):

```bash
# read the upstream changelog for migrations/breaking env changes at
# https://github.com/diegosouzapw/OmniRoute/blob/main/CHANGELOG.md
```

Then bump `OMNIROUTE_IMAGE_TAG` in `.env` and
`docker compose --profile local-gateway up -d gateway`.
Back up the `gateway-data` volume first.

## Licensing & attribution

Both upstreams are MIT. Compliance approach:

- `apps/web/LICENSE` — the untouched upstream bolt.diy MIT license
  (StackBlitz, Inc. and bolt.diy contributors) is retained in-tree.
- `THIRD_PARTY_NOTICES.md` (repo root) — names both projects, their licenses,
  and where their license texts live.
- This repo's own new material (docs, scripts, Distro branding) is MIT under
  the root `LICENSE`.
- The live product UI carries no StackBlitz/Bolt branding; attribution lives
  in the license/notice files, per the MIT terms.

## Versioning note

`apps/web/package.json` keeps version `1.0.0` (matching the forked stable
tag), so the in-app "updates" tab — which still points at the upstream
`stackblitz-labs/bolt.diy` release feed — reports no phantom upgrade. Point
that feed at Distro's own releases once this repo has tags.
