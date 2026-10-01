#!/usr/bin/env bash
# Walk the tenancy loop across *both* repositories, as one scheduled check.
#
# The M7 item is deliberately two halves that meet at the wire: Distro's plane
# proves a subject resolves to an account, that account's own key answers the
# quota gate, and a turn's usage is reported and reads back
# (`scripts/acceptance-check.sh`); Genie proves the *console* signs two real
# accounts in and gives each its own workspace, chat list and record
# (`ontrak-genie/scripts/verify-tenancy.mjs`). Each half passes perfectly while
# the join is broken — a session the plane will not accept, an account bound to
# the wrong subject — and that failure has no home in either repo's suite, which
# is exactly why the roadmap asked for them to run together.
#
# So this runs both, in that order, and fails if either does. The sign-in half
# needs the console's repo (its script) and its session secret, so it can only
# run where those live: set `GENIE_DIR` to the console's checkout, or leave it
# unset and let the sibling/`/opt` search find one. When neither is present the
# console half is reported as SKIP by name and the plane half alone decides the
# exit code — a check that silently "passed" the half it never ran is worse than
# one that says it could not reach it.
#
# The two accounts are named by the plane itself (`control.mjs accounts`), not
# carried here: the point is that the accounts people use resolve, so a check
# with its own invented subject would prove the wrong thing.
#
#   GENIE_DIR=/opt/ontrak-genie ./scripts/cross-repo-check.sh
#
# Schedule it the way the plane's own check is scheduled:
#
#   41 6 * * * cd /opt/distro && ./scripts/cross-repo-check.sh >> /var/log/distro-cross-repo.log 2>&1
#
# A failure is loud on purpose: the script exits non-zero, so cron mails it and a
# timer unit fails.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "--- plane half $(date -Is) ---"
# The plane's own check, unchanged: a subject resolves to an account, its key
# answers the gate, one turn of usage is reported and reads back.
./scripts/acceptance-check.sh

# ── the console half ────────────────────────────────────────────────────────
# Where the console's checkout is. An explicit `GENIE_DIR` (or `GENIE_VERIFY`
# pointing straight at the script) wins; otherwise try the places a deployment
# actually puts it.
find_genie() {
  if [[ -n "${GENIE_VERIFY:-}" && -f "${GENIE_VERIFY}" ]]; then
    printf '%s' "$(cd "$(dirname "${GENIE_VERIFY}")/.." && pwd)"
    return 0
  fi
  local candidate
  for candidate in "${GENIE_DIR:-}" /opt/ontrak-genie "$ROOT/../ontrak-genie" /usr/src; do
    [[ -n "$candidate" && -f "$candidate/scripts/verify-tenancy.mjs" ]] || continue
    (cd "$candidate" && pwd)
    return 0
  done
  return 1
}

if ! GENIE="$(find_genie)"; then
  echo "cross-repo: SKIP the console half — no Genie checkout found." >&2
  echo "cross-repo: set GENIE_DIR to the console's checkout to run both halves together." >&2
  exit 0
fi

echo "--- console half $(date -Is) (${GENIE}) ---"

# The plane names the accounts. Fewer than two linked accounts is not a green
# result: two accounts are what the isolation claim is made of, so a deployment
# that cannot name two has the cross-repo question unanswered, which is a failure
# of this check rather than a skip.
ACCOUNTS="$(docker compose exec -T control-plane node bin/control.mjs accounts 2>/dev/null | tr -d '\r')"
if [[ "$(printf '%s\n' "$ACCOUNTS" | grep -c '=' || true)" -lt 2 ]]; then
  echo "cross-repo: the plane names fewer than two accounts with a bound identity." >&2
  echo "cross-repo: sign in through the console once before relying on this check." >&2
  exit 1
fi

pairs=()
while IFS= read -r line; do
  [[ -n "$line" ]] && pairs+=(--account "$line")
done <<<"$ACCOUNTS"

# Run it from the console's own directory so it reads *that* deployment's `.env`
# (its session secret and URL) rather than this one's.
(
  cd "$GENIE"
  node scripts/verify-tenancy.mjs "${pairs[@]}"
)

echo "cross-repo: both halves passed $(date -Is)"
