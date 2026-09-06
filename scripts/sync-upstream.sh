#!/usr/bin/env bash
# Refresh local upstream snapshots and record pinned commit SHAs.
#
#   vendor/bolt.diy-upstream   shallow clone of stackblitz-labs/bolt.diy
#                              (stable) — reference only, never applied
#                              automatically on top of our Distro edits
#   vendor/omniroute           shallow clone of diegosouzapw/OmniRoute
#                              (default branch) — working copy for running /
#                              building the gateway from source
#
# Both live under vendor/ which is git-ignored: the committed repo pins the
# gateway image tag (OMNIROUTE_IMAGE_TAG in .env) instead of vendoring
# ~294 MB of upstream. See docs/upstream.md for the update workflow.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/vendor"
cd "$ROOT/vendor"

BOLT_BRANCH="${BOLT_BRANCH:-stable}"

refresh() {
  local dir="$1" url="$2" branch="$3"
  if [[ -d "$dir/.git" ]]; then
    echo "==> updating $dir ($url, $branch)"
    git -C "$dir" fetch --depth 1 origin "$branch"
    git -C "$dir" reset --hard "origin/$branch"
  else
    echo "==> cloning $dir ($url, $branch)"
    git clone --depth 1 --branch "$branch" "$url" "$dir"
  fi
}

refresh bolt.diy-upstream https://github.com/stackblitz-labs/bolt.diy.git "$BOLT_BRANCH"
refresh omniroute https://github.com/diegosouzapw/OmniRoute.git HEAD

# Record SHAs so docs/upstream.md stays honest about what is vendored.
{
  echo "# Automatically updated by scripts/sync-upstream.sh — do not edit."
  echo "bolt.diy branch: $BOLT_BRANCH"
  echo "bolt.diy sha: $(git -C bolt.diy-upstream rev-parse HEAD)"
  echo "omniroute branch: $(git -C omniroute symbolic-ref --short HEAD || echo detached)"
  echo "omniroute sha: $(git -C omniroute rev-parse HEAD)"
} > .upstream-snapshot.txt
cp .upstream-snapshot.txt "$ROOT/docs/upstream-snapshot.txt"

echo
echo "Snapshot recorded in vendor/.upstream-snapshot.txt and docs/upstream-snapshot.txt"
echo
echo "Note: apps/web is a Distro fork with local edits. To see what upstream"
echo "changed since your fork, diff vendor/bolt.diy-upstream against apps/web"
echo "and cherry-pick manually. There is intentionally no auto-overwrite."
