#!/usr/bin/env bash
# Keep the gateway snapshot readable between refreshes.
#
# gateway-usage-sync streams a copy into storage.sqlite.tmp and renames it into
# place. The rename is atomic, but an interrupted stream still gets renamed, and
# then every reader sees SQLITE_CORRUPT until the next cycle. This keeps the
# last snapshot that passed quick_check and puts it back when the live file
# stops passing, so the control plane never reads a truncated store.
set -euo pipefail

dir=/opt/distro/data/gateway-data
live=$dir/storage.sqlite
good=$dir/storage.sqlite.good

verify() {
  python3 - "$1" <<'PY'
import sqlite3, sys
try:
    c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
    print(c.execute("pragma quick_check").fetchone()[0])
except Exception as e:
    print(f"error: {e}")
PY
}

state=$(verify "$live")
if [ "$state" = "ok" ]; then
  cp -c -- "$live" "$good.tmp" 2>/dev/null || cp -- "$live" "$good.tmp"
  chmod 444 "$good.tmp"
  mv -f -- "$good.tmp" "$good"
  exit 0
fi

echo "$(date -Is) live store unreadable ($state)"
if [ ! -f "$good" ]; then
  echo "$(date -Is) no verified snapshot to restore from"
  exit 1
fi
/opt/distro/scripts/gateway-db-install.sh "$good"
echo "$(date -Is) restored the last verified snapshot"

