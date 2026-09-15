#!/usr/bin/env bash
# Quick gateway health checks. Works for the REMOTE platform gateway and the
# LOCAL fallback alike:
#   - resolves the dashboard/API base from GATEWAY_DASHBOARD_URL /
#     GATEWAY_API_URL / OPENAI_LIKE_API_BASE_URL (.env or environment), then
#     consul discovery (CONTROL_CONSUL_URL), then local compose addresses
#   - checks the dashboard, the OpenAI-compatible /v1/models endpoint and a
#     chat smoke test (only if OPENAI_LIKE_API_KEY is set)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

envget() { grep -E "^${1}=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }

api_key="$(envget OPENAI_LIKE_API_KEY)"
dashboard="${GATEWAY_DASHBOARD_URL:-$(envget GATEWAY_DASHBOARD_URL)}"
api="${GATEWAY_API_URL:-$(envget GATEWAY_API_URL)}"
api_base="${OPENAI_LIKE_API_BASE_URL:-$(envget OPENAI_LIKE_API_BASE_URL)}"

# Resolve the API base (…/v1) — explicit > derived > consul > local fallback.
if [[ -z "$api_base" && -n "$api" ]]; then
  api_base="${api%/}"
  [[ "$api_base" != */v1 ]] && api_base="$api_base/v1"
fi
if [[ -z "$api_base" || -z "$dashboard" ]]; then
  consul="${CONTROL_CONSUL_URL:-$(envget CONTROL_CONSUL_URL)}"
  consul="${consul:-http://10.10.1.1:8500}"
  if entry="$(curl -fsS -m 5 "${consul}/v1/health/service/omniroute?passing=true" 2>/dev/null)" && [[ "$entry" != "[]" ]]; then
    host="$(node -e 'const e=JSON.parse(process.argv[1]);const s=e[0]?.Service,n=e[0]?.Node;console.log(s?.Address||n?.Address||"")' "$entry" 2>/dev/null || true)"
    if [[ -n "$host" ]]; then
      dashboard="${dashboard:-http://${host}:20128}"
      api_base="${api_base:-http://${host}:20128/v1}"
      echo "--- gateway via consul: $host ---"
    fi
  fi
fi
# No local gateway: this stack runs none, so the default target is the platform
# gateway on the mesh (Server 2) unless .env pins another address.
dashboard="${dashboard:-http://10.10.2.1:20128}"
api_base="${api_base:-http://10.10.2.1:20128/v1}"

echo "--- local gateway container: none (remote gateway mode) ---"

echo "--- dashboard ($dashboard) ---"
code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$dashboard/" || true)"
echo "HTTP $code"

echo "--- OpenAI-compatible API /v1/models ($api_base) ---"
if [[ -n "$api_key" && "$api_key" != "CHANGEME" ]]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "Authorization: Bearer $api_key" "$api_base/models" || true)"
  echo "HTTP $code (authenticated)"
else
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$api_base/models" || true)"
  echo "HTTP $code (no OPENAI_LIKE_API_KEY service key in .env — expected 401/403)"
fi

echo "--- /v1/chat/completions smoke test ---"
if [[ -n "$api_key" && "$api_key" != "CHANGEME" ]]; then
  # Override with a model your gateway exposes, e.g. GATEWAY_SMOKE_MODEL=gemini-2.5-flash
  model="${GATEWAY_SMOKE_MODEL:-gpt-4o-mini}"
  echo "(model: $model)"
  curl -sS -m 90 "$api_base/chat/completions" \
    -H "Authorization: Bearer $api_key" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: pong\"}],\"max_tokens\":8}" \
    | head -c 600
  echo
else
  echo "skipped (set the OPENAI_LIKE_API_KEY service key to run the smoke test)"
fi
