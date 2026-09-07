#!/usr/bin/env bash
# Back up the Distro state DBs (control plane + OmniRoute gateway) to ./backups.
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

# 2. Gateway DB (settings, encrypted provider keys, usage_history/call_logs).
#    Upstream keeps its own db_backups too; this adds a host copy.
docker compose exec -T gateway node -e "
const Database = require('better-sqlite3');
const fs = require('fs');
const dir = '/app/data/backups';
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const dest = dir + '/storage-' + stamp + '.sqlite';
const src = new Database('/app/data/storage.sqlite', { readonly: true });
src.backup(dest).then(() => { console.log('gateway backup written: ' + dest); process.exit(0); }).catch((e) => { console.error(e.message); process.exit(1); });
"
mkdir -p "$OUT_DIR/gateway"
docker compose exec -T gateway sh -c "ls -t /app/data/backups | head -1" > /tmp/distro-gw-latest.txt
LATEST="$(cat /tmp/distro-gw-latest.txt)"
docker compose cp "gateway:/app/data/backups/$LATEST" "$OUT_DIR/gateway/$LATEST"
echo "gateway backup -> $OUT_DIR/gateway/$LATEST"

# Prune old host backups (keep 14)
find "$OUT_DIR" -name '*.sqlite' -mtime +14 -delete 2>/dev/null || true

echo "--- done: $(du -sh "$OUT_DIR" | cut -f1) in $OUT_DIR ---"
