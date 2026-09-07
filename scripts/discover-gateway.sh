#!/usr/bin/env bash
# Consul-discover the platform OmniRoute gateway (service "omniroute") and
# pin its URLs into .env:
#
#   OPENAI_LIKE_API_BASE_URL=http://<host>:20129/v1   (web app → gateway API)
#   GATEWAY_DASHBOARD_URL=http://<host>:20128         (control plane → admin API)
#
# Usage:
#   scripts/discover-gateway.sh           # fill only EMPTY values
#   scripts/discover-gateway.sh --force   # overwrite even pinned values
#
# Exit codes: 0 = discovered + written, 1 = consul unreachable / not found.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

if [[ ! -f .env ]]; then
  echo "ERROR: no .env — run ./scripts/bootstrap.sh first"
  exit 1
fi

envget() { grep -E "^${1}=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }

consul="${CONTROL_CONSUL_URL:-$(envget CONTROL_CONSUL_URL)}"
consul="${consul:-http://10.10.1.1:8500}"

echo "==> querying consul ($consul, service omniroute)…"
if ! entry="$(curl -fsS -m 5 "${consul}/v1/health/service/omniroute?passing=true" 2>/dev/null)"; then
  echo "ERROR: consul unreachable at $consul"
  exit 1
fi
if [[ "$entry" == "[]" ]]; then
  echo "ERROR: no healthy 'omniroute' instances registered in consul"
  exit 1
fi

host="$(node -e 'const e=JSON.parse(process.argv[1]);const s=e[0]?.Service,n=e[0]?.Node;console.log(s?.Address||n?.Address||"")' "$entry" 2>/dev/null || true)"
if [[ -z "$host" ]]; then
  echo "ERROR: consul entry missing an address"
  exit 1
fi

dashboard="http://${host}:20128"
api="http://${host}:20129/v1"

set_pin() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" .env; then
    if [[ "$FORCE" -eq 1 ]] || grep -qE "^${key}=$" .env; then
      sed -i "s|^${key}=.*|${key}=${val}|" .env
      echo "==> wrote ${key}=${val}"
    else
      echo "==> ${key} already set in .env (use --force to overwrite)"
    fi
  else
    echo "${key}=${val}" >> .env
    echo "==> appended ${key}=${val}"
  fi
}

set_pin OPENAI_LIKE_API_BASE_URL "$api"
set_pin GATEWAY_DASHBOARD_URL "$dashboard"

echo
echo "Gateway discovered: ${dashboard} (dashboard) / ${api} (API)"
echo "Restart the stack to pick it up: docker compose up -d control-plane web"
