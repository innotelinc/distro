#!/usr/bin/env bash
# Rehearse a Distro restore, in a scratch container, against this host's own
# backups — without touching the live stack.
#
# A backup that has never been restored is a hope, not a backup: it may be a
# truncated copy, or a database the boot migrations no longer apply to. This
# boots one somewhere harmless and asks it the only questions that matter — does
# it answer, does it know the accounts, does it have the schema and the history.
# The newest backup is the one a real restore would use; the oldest is the one
# most likely to be a surprise.
#
#   ./scripts/restore-rehearsal.sh
#
# Read-only with respect to the live stack: its own port, its own throwaway
# directory, its own container name, all removed at the end. The gateway side is
# deliberately not rehearsed — those keys live in the gateway's store, which is
# the platform's to back up (see docs/ops.md).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

IMAGE="${CONTROL_IMAGE:-distro-control-plane:local}"
LIVE_URL="http://127.0.0.1:${CONTROL_PORT:-20140}"
SCRATCH_PORT="${REHEARSAL_PORT:-20141}"
NAME=distro-restore-check
SCRATCH_DIR=/tmp/distro-restore-rehearsal

echo "=== the live stack, as it is now ==="
docker exec distro-control-plane node bin/control.mjs users
echo "live /health: $(curl -s -o /dev/null -w '%{http_code}' "$LIVE_URL/health")"

echo
echo "=== a fresh backup, taken while the stack is live ==="
./scripts/backup.sh | tail -2
# `ls -t ... | head` risks SIGPIPE under `pipefail` and trips SC2012; order by
# mtime with find and read the ends from the sorted list instead.
mapfile -t _backups < <(find backups/control-plane -maxdepth 1 -name 'control-*.sqlite' \
  -printf '%T@ %p\n' | sort -n | cut -d' ' -f2-)
NEWEST="${_backups[-1]:-}"
OLDEST="${_backups[0]:-}"
echo "newest: $NEWEST"
echo "oldest: $OLDEST"

rehearse() { # <label> <backup-file>
  local label="$1" file="$2"
  echo
  echo "=== restore $label ($file) on :$SCRATCH_PORT ==="
  rm -rf "$SCRATCH_DIR"
  mkdir -p "$SCRATCH_DIR"
  cp "$file" "$SCRATCH_DIR/control.sqlite"
  # The image runs as uid 1000; this directory is the rehearsal's own, not a
  # volume any stack owns.
  chmod -R 777 "$SCRATCH_DIR"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" \
    -p "127.0.0.1:$SCRATCH_PORT:20140" \
    -v "$SCRATCH_DIR:/data" \
    "$IMAGE" >/dev/null

  local i=0
  while [ "$i" -lt 30 ]; do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$SCRATCH_PORT/health")" = "200" ]; then break; fi
    i=$((i + 1))
    sleep 1
  done
  echo "scratch /health: $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$SCRATCH_PORT/health")"

  echo "accounts in the restored copy:"
  docker exec "$NAME" node bin/control.mjs users

  echo "schema and history in the restored copy:"
  docker exec "$NAME" node --input-type=module -e '
    import Database from "better-sqlite3";
    const db = new Database(process.env.CONTROL_DB_PATH, { readonly: true });
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).join(",");
    const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    console.log("  users columns:      ", cols("users"));
    console.log("  quotas columns:     ", cols("quotas"));
    console.log("  usage_cache columns:", cols("usage_cache"));
    console.log("  rows: users=" + count("users") + " gateway_keys=" + count("gateway_keys") + " audit=" + count("audit_log"));
    const last = db.prepare("SELECT action, created_at FROM audit_log ORDER BY created_at DESC LIMIT 1").get();
    console.log("  last audit row:     ", last === undefined ? "(none)" : `${last.action} at ${last.created_at}`);
  '

  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH_DIR"
}

rehearse "the newest backup" "$NEWEST"
rehearse "the oldest backup on this host" "$OLDEST"

echo
echo "=== the live stack, after both rehearsals ==="
docker exec distro-control-plane node bin/control.mjs users
echo "live /health: $(curl -s -o /dev/null -w '%{http_code}' "$LIVE_URL/health")"
echo "scratch containers left behind: $(docker ps -a --filter "name=$NAME" --format '{{.Names}}' | wc -l)"
