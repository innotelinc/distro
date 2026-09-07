#!/usr/bin/env bash
# Refresh local upstream snapshots and record pinned commit SHAs.
#
#   vendor/bolt.diy-upstream   shallow clone of stackblitz-labs/bolt.diy
#                              (stable) — reference only, never applied
#                              automatically on top of our Distro edits
#
# Note: there is intentionally no vendor/omniroute anymore — the AI gateway is
# a platform service (remote OmniRoute, discovered via Consul). The runtime
# tracks the published image via OMNIROUTE_IMAGE_TAG in .env; see docs/ops.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/vendor"
cd "$ROOT/vendor"

BOLT_BRANCH="${BOLT_BRANCH:-stable}"

if [[ -d bolt.diy-upstream/.git ]]; then
  echo "==> updating bolt.diy-upstream ($BOLT_BRANCH)"
  git -C bolt.diy-upstream fetch --depth 1 origin "$BOLT_BRANCH"
  git -C bolt.diy-upstream reset --hard "origin/$BOLT_BRANCH"
else
  echo "==> cloning bolt.diy-upstream (stable)"
  git clone --depth 1 --branch "$BOLT_BRANCH" https://github.com/stackblitz-labs/bolt.diy.git bolt.diy-upstream
fi

# Record SHAs so docs/upstream.md stays honest about what is vendored.
{
  echo "# Automatically updated by scripts/sync-upstream.sh — do not edit."
  echo "bolt.diy branch: $BOLT_BRANCH"
  echo "bolt.diy sha: $(git -C bolt.diy-upstream rev-parse HEAD)"
} > .upstream-snapshot.txt
cp .upstream-snapshot.txt "$ROOT/docs/upstream-snapshot.txt"

echo
echo "Snapshot recorded in vendor/.upstream-snapshot.txt and docs/upstream-snapshot.txt"
echo
echo "Note: apps/web is a Distro fork with local edits. To see what upstream"
echo "changed since your fork, diff vendor/bolt.diy-upstream against apps/web"
echo "and cherry-pick manually. There is intentionally no auto-overwrite."
