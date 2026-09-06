# Distro — Tracking Upstream

Distro is assembled from two MIT-licensed projects. This page documents how
the repo pins them, how to update, and how attribution is handled.

## Pinned state

| Project | Branch / ref | Used as | Pin mechanism |
|---|---|---|---|
| stackblitz-labs/bolt.diy | `stable` (v1.0.0, May 2025) | `apps/web` — a **fork with Distro edits committed in-tree** | git history of this repo |
| diegosouzapw/OmniRoute | default branch (v3.8.51, Sep 2026) | runtime = published image `diegosouzapw/omniroute`; source = `vendor/omniroute` | `OMNIROUTE_IMAGE_TAG` in `.env` |

Current SHAs are recorded in `docs/upstream-snapshot.txt` (refreshed by
`make sync-upstream`).

## Why OmniRoute source isn't committed

The OmniRoute tree is ~294 MB (13k+ files, 100 MB+ of docs/tests). Distro does
not modify it — it runs the published image — so committing it would add a
frozen copy that churns on every upstream bump for no delta value. Instead:

- the **image tag** is pinned in `.env` (`OMNIROUTE_IMAGE_TAG`), which is the
  real runtime contract, and
- `vendor/omniroute` keeps a working source checkout on disk for
  development/debugging and reading the changelog. It is git-ignored.

If you prefer a committed fork of OmniRoute (e.g. you start patching it),
`git rm` the ignore, un-ignore `vendor/omniroute`, and commit the snapshot —
nothing else changes.

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

## Updating OmniRoute

```bash
make sync-upstream                   # refresh vendor/omniroute
git -C vendor/omniroute log -1       # review the new SHA
# read the changelog for migrations/breaking env changes:
sed -n '1,120p' vendor/omniroute/CHANGELOG.md
```

Then bump `OMNIROUTE_IMAGE_TAG` in `.env` and `docker compose up -d gateway`.
Back up the `gateway-data` volume first. If you run from source instead of the
image, its own `docker-compose.yml` / `docs/ENVIRONMENT.md` (inside the
checkout) are authoritative.

## Licensing & attribution

Both upstreams are MIT. Compliance approach:

- `apps/web/LICENSE` — the untouched upstream bolt.diy MIT license
  (StackBlitz, Inc. and bolt.diy contributors) is retained in-tree.
- `vendor/omniroute/LICENSE` — upstream MIT license travels with the checkout.
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
