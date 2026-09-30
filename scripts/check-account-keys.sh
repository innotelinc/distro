#!/usr/bin/env bash
# Do the accounts' gateway keys still open the gateway?
#
# A key is minted once, on the gateway, and never re-verified afterwards. So a
# gateway whose store was restored, migrated or rebuilt leaves every account
# looking configured here while the gateway has never heard of it — and the
# builder surface reports that as "every model in the chain failed to answer",
# which reads like a quota or a provider problem and is neither. This asks the
# gateway directly, one account at a time.
#
#   ./scripts/check-account-keys.sh             # report; exit 1 on a refusal
#   ./scripts/check-account-keys.sh --fix       # rotate the refused keys
#   ./scripts/check-account-keys.sh --alert     # also fire the webhook alert
#
# Schedule it so a broken key is found before somebody's turn is:
#   23 6 * * * cd /opt/distro && ./scripts/check-account-keys.sh --alert >> /var/log/distro-keys-check.log 2>&1
#
# A refusal is loud on purpose: the check exits non-zero, so cron mails it, a
# timer unit fails, and `make keys-check` says so. --fix is the human saying
# "rotate it", and exits 0 because the finding is then resolved.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "--- account gateway keys $(date -Is) ---"

if (($# > 0)); then
  docker compose exec -T control-plane node bin/control.mjs keys-check "$@"
else
  docker compose exec -T control-plane node bin/control.mjs keys-check
fi
