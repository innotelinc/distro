#!/usr/bin/env bash
# Install a gateway SQLite snapshot without ever showing a reader a torn file.
#
# A plain `cp` truncates the target and rewrites it in place, so the control
# plane can open it mid-copy and report "database disk image is malformed"
# (seen at 21:13 and 22:34 on 2026-11-25). This copies beside the target,
# verifies the copy, then renames it into place: rename(2) is atomic, so a
# reader sees either the old file or the new one, never a partial one.
set -euo pipefail

target=/opt/distro/data/gateway-data/storage.sqlite
src=${1:-}
if [ -z "$src" ]; then
  echo "usage: $(basename "$0") <snapshot.sqlite>" >&2
  exit 2
fi
[ -f "$src" ] || { echo "no such snapshot: $src" >&2; exit 2; }

dir=$(dirname "$target")
tmp="$dir/.storage.sqlite.incoming"
trap 'rm -f "$tmp"' EXIT

cp -- "$src" "$tmp"
python3 - "$tmp" <<'PY'
import sqlite3, sys
p = sys.argv[1]
c = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
r = c.execute("pragma quick_check").fetchone()[0]
if r != "ok":
    sys.exit(f"refusing to install: quick_check says {r}")
print("verified snapshot: usage_history rows=%d" % c.execute("select count(*) from usage_history").fetchone()[0])
PY
chmod 444 "$tmp"
chown root:root "$tmp"
mv -f -- "$tmp" "$target"
trap - EXIT
echo "installed atomically: $target"

