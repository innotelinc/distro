#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# seed-distro-plan.sh — Create the "distro" plan in the REMOTE Magnate instance
#
# Magnate runs on the platform stack (server 1); Distro talks to it over HTTP.
# The control plane auto-seeds this plan on boot when billing is configured
# (apps/control-plane/src/billing.js → seedDistroPlan). Use this script to
# (re-)run the seed manually without restarting the control plane:
#
#   ./scripts/seed-distro-plan.sh
#
# Magnate URL resolution: $MAGNATE_URL → .env → consul (service "magnate").
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

envget() { grep -E "^${1}=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }

url="${MAGNATE_URL:-$(envget MAGNATE_URL)}"
if [[ -z "$url" ]]; then
  consul="${CONTROL_CONSUL_URL:-$(envget CONTROL_CONSUL_URL)}"
  consul="${consul:-http://10.10.1.1:8500}"
  service="${MAGNATE_CONSUL_SERVICE:-$(envget MAGNATE_CONSUL_SERVICE)}"
  service="${service:-magnate}"
  echo "==> MAGNATE_URL not set — discovering via consul ($consul, service $service)…"
  if entry="$(curl -fsS -m 5 "${consul}/v1/health/service/${service}?passing=true" 2>/dev/null)" && [[ "$entry" != "[]" ]]; then
    host="$(node -e 'const e=JSON.parse(process.argv[1]);const s=e[0]?.Service,n=e[0]?.Node;console.log(s?.Address||n?.Address||"")' "$entry" 2>/dev/null || true)"
    port="$(node -e 'const e=JSON.parse(process.argv[1]);console.log(e[0]?.Service?.Port||3010)' "$entry" 2>/dev/null || echo 3010)"
    [[ -n "$host" ]] && url="http://${host}:${port}"
  fi
fi

if [[ -z "$url" ]]; then
  echo "ERROR: Magnate not configured and not discoverable via consul."
  echo "       Set MAGNATE_URL in .env (e.g. MAGNATE_URL=http://10.10.1.1:3010)."
  exit 1
fi
url="${url%/}"

token="${MAGNATE_ENTITLEMENTS_TOKEN:-$(envget MAGNATE_ENTITLEMENTS_TOKEN)}"
slug="${MAGNATE_BILLING_SLUG:-$(envget MAGNATE_BILLING_SLUG)}"
slug="${slug:-distro}"

auth=()
[[ -n "$token" ]] && auth=(-H "Authorization: Bearer ${token}")

echo "==> Checking for existing '${slug}' plan in Magnate at $url…"
check="$(curl -fsS -m 5 "${auth[@]}" "${url}/api/entitlements?plan=${slug}" 2>/dev/null || true)"
if [[ -n "$check" ]] && [[ "$check" != *'"plan_not_found"'* ]]; then
  echo "==> Plan '${slug}' already exists in Magnate — nothing to do."
  exit 0
fi

echo "==> Creating '${slug}' plan via Magnate admin API…"
payload=$(cat <<EOF
{
  "name": "Distro",
  "slug": "${slug}",
  "description": "AI app-building platform — unlimited builds, all models.",
  "priceMonthlyCents": 1999,
  "priceYearlyCents": 19990,
  "features": [
    "Unlimited app builds",
    "Access to all AI models via OmniRoute",
    "Live preview & terminal in-browser",
    "Priority support"
  ],
  "highlighted": true,
  "active": true
}
EOF
)
status="$(curl -fsS -m 10 -o /dev/null -w '%{http_code}' -X POST "${auth[@]}" \
  -H 'Content-Type: application/json' -d "$payload" "${url}/api/admin/plans" 2>/dev/null || echo 000)"

case "$status" in
  200|201) echo "==> Created '${slug}' plan in Magnate ✓" ;;
  409)     echo "==> Plan '${slug}' already exists (HTTP 409) — nothing to do." ;;
  000)     echo "ERROR: Magnate unreachable at $url"; exit 1 ;;
  *)       echo "ERROR: Magnate admin API returned HTTP $status (check MAGNATE_ENTITLEMENTS_TOKEN / admin access)"; exit 1 ;;
esac

echo "==> Done. Distro checks entitlements via:"
echo "    GET ${url}/api/entitlements?plan=${slug}&user=<email>"
