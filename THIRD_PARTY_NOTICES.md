# Third-Party Notices

Distro is a product assembled from the following open-source projects. Both
are MIT-licensed; their full license texts are retained in-tree.

## bolt.diy

- Project: https://github.com/stackblitz-labs/bolt.diy (branch `stable`)
- License: MIT — Copyright (c) 2024 StackBlitz, Inc. and bolt.diy contributors
- License text: [`apps/web/LICENSE`](apps/web/LICENSE)
- Used as: `apps/web` — the Distro front door (rebranded fork: in-browser
  agent IDE, WebContainer sandbox, live preview, terminal, git/deploy).

## OmniRoute

- Project: https://github.com/diegosouzapw/OmniRoute (default branch)
- License: MIT — Copyright (c) 2026 diegosouzapw
- License text: https://github.com/diegosouzapw/OmniRoute/blob/main/LICENSE
  (no source checkout is vendored in this repo)
- Used as: the AI model routing gateway providing the single
  OpenAI-compatible `/v1/*` endpoint Distro calls. Consumed remotely as a
  platform service (Innotel platform stack, Server 2; Consul service
  `omniroute`); the LOCAL fallback (compose profile `local-gateway`) runs the
  published image `diegosouzapw/omniroute` (tag pinned via
  `OMNIROUTE_IMAGE_TAG` in `.env`).

## Notes

- Pinned upstream revisions are recorded in
  [`docs/upstream-snapshot.txt`](docs/upstream-snapshot.txt).
- Distro's own original material (docs, scripts, branding) is MIT under the
  root [`LICENSE`](LICENSE).
- Per the MIT terms, attribution is retained via these license/notice files;
  the live product UI carries no upstream branding.
