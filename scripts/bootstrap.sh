#!/usr/bin/env bash
# Distro first-run bootstrap:
#   1. create .env from .env.example, generating secrets when empty
#   2. locate the OmniRoute gateway (REMOTE platform service by default):
#        - GATEWAY_API_URL / GATEWAY_DASHBOARD_URL from .env, or
#        - Consul discovery (CONTROL_CONSUL_URL, service "omniroute")
#      only falls back to the bundled local gateway when neither works
#   3. print next steps
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "==> creating .env from .env.example"
  cp .env.example .env
fi

# Fill in empty secrets (delimiter | is safe for base64/hex output) — used by
# the control-plane sessions and the LOCAL gateway fallback profile only.
fill_secret() {
  local key="$1" value="$2"
  if grep -qE "^${key}=$" .env; then
    sed -i "s|^${key}=$|${key}=${value}|" .env
  fi
}
fill_secret JWT_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
fill_secret API_KEY_SECRET "$(openssl rand -hex 32)"

# env var from .env (or environment)
envget() { grep -E "^${1}=" .env 2>/dev/null | head -1 | cut -d= -f2-; }

GATEWAY_DASHBOARD_URL="$(envget GATEWAY_DASHBOARD_URL)"
GATEWAY_API_URL="$(envget GATEWAY_API_URL)"
CONTROL_CONSUL_URL="$(envget CONTROL_CONSUL_URL)"

GATEWAY_MODE="none"

if [[ -n "${GATEWAY_DASHBOARD_URL}${GATEWAY_API_URL}" ]]; then
  # Derive the dashboard base from whichever URL is set (API url carries /v1).
  base="${GATEWAY_DASHBOARD_URL:-${GATEWAY_API_URL%/v1}}"
  base="${base%/v1}"
  GATEWAY_MODE="env ($base)"
  if curl -fsS -o /dev/null -m 5 "${base}/" 2>/dev/null \
     || curl -fsS -o /dev/null -m 5 "${GATEWAY_API_URL:-$base/v1}/models" 2>/dev/null; then
    echo "==> gateway pinned via env: $base"
  else
    echo "!! pinned gateway at $base is not reachable (continuing anyway)"
  fi
else
  # Consul discovery (platform stack): service "omniroute" on server 2.
  consul="${CONTROL_CONSUL_URL:-http://10.10.1.1:8500}"
  echo "==> discovering gateway via consul ($consul, service omniroute)…"
  if entry="$(curl -fsS -m 5 "${consul}/v1/health/service/omniroute?passing=true" 2>/dev/null)" \
     && [[ "$entry" != "[]" ]]; then
    host="$(node -e 'const e=JSON.parse(process.argv[1]);const s=e[0]?.Service,n=e[0]?.Node;console.log(s?.Address||n?.Address||"")' "$entry" 2>/dev/null || true)"
    if [[ -n "$host" ]]; then
      GATEWAY_MODE="consul (http://${host}:20128)"
      echo "==> gateway discovered: http://${host}:20128 (dashboard), http://${host}:20129 (API)"
      # Pin the discovered gateway into .env so the web app and control plane
      # skip discovery on every boot. Only fills EMPTY values (never overwrites
      # an explicit operator choice).
      if grep -qE '^OPENAI_LIKE_API_BASE_URL=$' .env; then
        sed -i "s|^OPENAI_LIKE_API_BASE_URL=$|OPENAI_LIKE_API_BASE_URL=http://${host}:20129/v1|" .env
        echo "==> wrote OPENAI_LIKE_API_BASE_URL=http://${host}:20129/v1 to .env"
      fi
      if grep -qE '^GATEWAY_DASHBOARD_URL=$' .env; then
        sed -i "s|^GATEWAY_DASHBOARD_URL=$|GATEWAY_DASHBOARD_URL=http://${host}:20128|" .env
        echo "==> wrote GATEWAY_DASHBOARD_URL=http://${host}:20128 to .env"
      fi
    fi
  fi
fi

if [[ "$GATEWAY_MODE" == "none" ]]; then
  echo "!! no remote gateway found via env or consul"
  echo "   Starting the LOCAL fallback gateway instead (--profile local-gateway)."
  echo "   For the shared platform gateway, set GATEWAY_API_URL in .env, e.g."
  echo "     OPENAI_LIKE_API_BASE_URL=http://10.10.2.1:20129/v1"
  if grep -qE '^OPENAI_LIKE_API_BASE_URL=.+' .env; then
    echo "   NOTE: OPENAI_LIKE_API_BASE_URL is set in .env — empty it if you want"
    echo "         the web app to use the local fallback gateway instead."
  fi
  docker compose --profile local-gateway up -d redis gateway

  echo "==> waiting for the local gateway to become healthy"
  for _ in $(seq 1 60); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}' distro-gateway 2>/dev/null || echo starting)"
    if [[ "$status" == "healthy" ]]; then
      echo "==> local gateway is healthy"
      GATEWAY_MODE="local (http://127.0.0.1:20128)"
      break
    fi
    if [[ "$status" == "unhealthy" ]]; then
      echo "!! local gateway reported unhealthy — check: docker compose logs gateway"
      exit 1
    fi
    sleep 2
  done
fi

cat <<EOF

────────────────────────────────────────────────────────────────────────
 Gateway mode: $GATEWAY_MODE

 Next steps (once per deployment):

 1. Get a gateway API key:
      REMOTE  — open the OmniRoute dashboard (server 2 :20128), register
                upstream provider keys, then Settings → API Keys → create
      LOCAL   — open http://127.0.0.1:20128 (INITIAL_PASSWORD in .env) and
                do the same

 2. Put it in .env:

      OPENAI_LIKE_API_KEY=<gateway key>
      OPENAI_LIKE_API_BASE_URL=<gateway /v1 url>   # e.g. http://10.10.2.1:20129/v1

 3. Start the Distro web app and verify end-to-end:

      docker compose up -d --build
      make doctor
      # open http://127.0.0.1:5173, pick the OpenAILike/Distro provider

 Upstream provider keys NEVER go into Distro — they live in the gateway.
 See docs/ops.md and docs/architecture.md.
────────────────────────────────────────────────────────────────────────
EOF
