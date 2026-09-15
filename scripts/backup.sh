#!/usr/bin/env bash
# Back up the Distro state DB (the control plane) to ./backups.
#
# Uses each app's own SQLite online-backup path (better-sqlite3 .backup) so the
# files are consistent even while services are live. Writes a timestamped copy
# inside each service's data volume, then copies it out to ./backups on the
# host. Schedule with cron, e.g.:
#   0 3 * * * cd /opt/distro && ./scripts/backup.sh >> /var/log/distro-backup.log 2>&1
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT_DIR="${BACKUP_DIR:-$ROOT/backups}"
mkdir -p "$OUT_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"

echo "--- distro backup $STAMP ---"

# 1. Control-plane DB (accounts, keys, quotas, usage, audit)
docker compose exec -T control-plane node bin/control.mjs backup /data/backups
docker compose cp control-plane:/data/backups/. "$OUT_DIR/control-plane/" 2>/dev/null \
  || (docker cp "distro-control-plane:/data/backups/." "$OUT_DIR/control-plane/")
echo "control-plane backups -> $OUT_DIR/control-plane/"

# 2. Gateway DB — NOT backed up here. The gateway is the shared platform
#    service (Server 2): its settings, encrypted provider keys and
#    usage_history/call_logs live in its own volume, and backing that up is the
#    platform operators' job. Distro's only copy of anything gateway-side is the
#    per-user usage ledger the control plane caches in its own usage_cache
#    (covered by the control-plane backup above).
echo "gateway DB: remote (platform service) — not backed up here"

# Prune old host backups (keep 14)
find "$OUT_DIR" -name '*.sqlite' -mtime +14 -delete 2>/dev/null || true

echo "--- done: $(du -sh "$OUT_DIR" | cut -f1) in $OUT_DIR ---"
