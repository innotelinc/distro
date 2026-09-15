# Distro — Upstream Record

Distro was assembled from two MIT-licensed projects. This page records what
was consumed, what was retired, and how attribution is handled. It is a
record now, not a sync guide: the bolt.diy fork is deleted from this repo and
there is no vendored source to update.

## Pinned state (historical)

| Project | Branch / ref | Was used as | Where it went |
|---|---|---|---|
| stackblitz-labs/bolt.diy | `stable` (v1.0.0, May 2025) | `apps/web` — a **fork with Distro edits committed in-tree** (rebrand + gateway-only defaults) | **Retired** with the front door (convergence §5.2). Recoverable from this repo's git history; license text retained at `licenses/bolt.diy.LICENSE`. |
| diegosouzapw/OmniRoute | default branch (v3.8.51, Sep 2026) | remote platform service (Consul `omniroute`) — Distro runs no image of its own | Still consumed, unchanged — the gateway is the platform's. |

The last fork SHA is recorded in `docs/upstream-snapshot.txt`; `vendor/` (the
git-ignored reference checkout used for diffs) is obsolete.

## Why the fork was retired, not kept

Three app-builder front doors had grown up across the ecosystem (Olympus
Studio, Distro's bolt.diy fork, Atlas's Chef fork), each with its own agent,
account model and gateway wiring. The convergence keeps **one web UI
(Studio)** and one engine; Distro's durable contribution was always the
multi-tenant layer on top of the gateway, and that is what survives as the
repo's deliverable. The WebContainer affordances worth keeping (a file tree,
a terminal pane) are tracked as Studio work.

## Why OmniRoute source isn't committed

OmniRoute is consumed as a remote platform service; there is no vendored
checkout at all (the old ~294 MB `vendor/omniroute` snapshot was removed) and
no bundled image either — the `local-gateway` profile is gone, because one
OmniRoute serves the ecosystem. Gateway upgrades are the platform operators'
concern; Distro only needs `OPENAI_LIKE_API_BASE_URL` + the service key.

## Licensing & attribution

Both upstreams are MIT. Compliance approach:

- `licenses/bolt.diy.LICENSE` — the untouched upstream bolt.diy MIT license
  (StackBlitz, Inc. and bolt.diy contributors), retained in-tree as the
  record of the version that was used.
- `THIRD_PARTY_NOTICES.md` (repo root) — names both projects, their licenses,
  and where their license texts live, including the retirement of the fork.
- This repo's own material (docs, scripts, the control plane) is MIT under
  the root `LICENSE`.
- The live product (the control plane and its admin console) carries no
  StackBlitz/Bolt branding; attribution lives in the license/notice files,
  per the MIT terms.
