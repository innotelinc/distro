#!/usr/bin/env bash
# Does the tenancy loop still work, end to end, on *this* deployment?
#
# A deployment looks healthy while a piece of the loop is quietly dead: a key the
# gateway forgot, a plane that stopped writing accounting, an internal route that
# answered 503 because a token went missing. None of that shows until somebody's
# turn fails, and by then it is reported as a model problem. This walks the loop
# the way a turn does — a subject resolves to an account, its own key answers the
# quota gate, usage is reported and reads back — and exits non-zero on the first
# step that breaks.
#
# It is the plane's half of the M7 cross-repository acceptance item; the sign-in
# half lives with the surface that signs in
# (`ontrak-genie/scripts/verify-tenancy.mjs`), so neither needs an Authentik,
# provider or Cerulean credential.
#
# It uses one dedicated account (`ACCEPTANCE_EMAIL`, default
# `acceptance@distro.invalid`) and reports one turn's usage against it, so it is
# self-contained. Schedule it so a break is found before somebody's turn is:
#
#   17 6 * * * cd /opt/distro && ./scripts/acceptance-check.sh >> /var/log/distro-acceptance.log 2>&1
#
# A failure is loud on purpose: the check exits non-zero, so cron mails it and a
# timer unit fails.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "--- acceptance $(date -Is) ---"
docker compose exec -T control-plane node bin/control.mjs acceptance
