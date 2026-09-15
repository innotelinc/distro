#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# mesh-setup.sh — DEPRECATED. Use scripts/mesh.sh instead.
# ══════════════════════════════════════════════════════════════════════════════
# The mesh bootstrap now lives in ONE place, mirroring every member repo:
#
#   scripts/mesh.sh join    [--server N] [--hub-pubkey KEY] [--stack DIR]
#                           [--no-verify] [--dry-run]
#   scripts/mesh.sh leave   [--purge]
#   scripts/mesh.sh download | install | status | discover
#
# Canonical copy: ips/scripts/mesh.sh (platform stack repo), refreshed into
# every repo by ips/scripts/sync-mesh.sh. This file only forwards, so no
# deployment has to change how it calls the bootstrap.
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

printf 'mesh-setup: deprecated — forwarding to scripts/mesh.sh join\n' >&2
exec "${HERE}/mesh.sh" join "$@"
