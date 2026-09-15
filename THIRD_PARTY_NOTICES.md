# Third-Party Notices

Distro's live product is the multi-tenant control plane (tenancy service:
accounts, per-user gateway keys, quotas/usage, admin console). Its surfaces
are assembled from the open-source projects below; where a component is no
longer shipped, its license text is retained in-tree as the record of the
version that was used.

## bolt.diy

- Project: https://github.com/stackblitz-labs/bolt.diy (branch `stable`)
- License: MIT — Copyright (c) 2024 StackBlitz, Inc. and bolt.diy contributors
- License text: [`licenses/bolt.diy.LICENSE`](licenses/bolt.diy.LICENSE)
- Used as: the retired builder front door (`apps/web`, a rebranded fork:
  in-browser agent IDE, WebContainer sandbox, live preview, terminal,
  git/deploy). Retired as a surface in the build-plane convergence (§5.2);
  one web UI (Studio) serves the ecosystem. Retained here as the record.

## OmniRoute

- Project: https://github.com/diegosouzapw/OmniRoute (default branch)
- License: MIT — Copyright (c) 2026 diegosouzapw
- License text: https://github.com/diegosouzapw/OmniRoute/blob/main/LICENSE
  (no source checkout is vendored in this repo)
- Used as: the AI model routing gateway providing the single
  OpenAI-compatible `/v1/*` endpoint Distro calls. Consumed remotely as a
  platform service (Innotel platform stack, Server 2; Consul service
  `omniroute`). Distro runs no OmniRoute image of its own and pins no tag —
  the published `diegosouzapw/omniroute` image is the platform's.

## Notes

- Pinned upstream revisions are recorded in
  [`docs/upstream-snapshot.txt`](docs/upstream-snapshot.txt).
- Distro's own original material (docs, scripts, branding) is MIT under the
  root [`LICENSE`](LICENSE).
- Per the MIT terms, attribution is retained via these license/notice files;
  the live product UI carries no upstream branding.
