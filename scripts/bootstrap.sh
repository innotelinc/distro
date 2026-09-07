#!/usr/bin/env bash
# Distro first-run bootstrap:
#   1. create .env from .env.example, generating secrets when empty
#   2. start the OmniRoute gateway (+redis)
#   3. wait for it to come up and print the next steps
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "==> creating .env from .env.example"
  cp .env.example .env
fi

# Fill in empty secrets (delimiter | is safe for base64/hex output)
fill_secret() {
  local key="$1" value="$2"
  if grep -qE "^${key}=$" .env; then
    sed -i "s|^${key}=$|${key}=${value}|" .env
  fi
}
fill_secret JWT_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
fill_secret API_KEY_SECRET "$(openssl rand -hex 32)"

echo "==> starting redis + gateway (first pull may take a while)"
docker compose up -d redis gateway

echo "==> waiting for the gateway to become healthy"
for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}' distro-gateway 2>/dev/null || echo starting)"
  if [[ "$status" == "healthy" ]]; then
    echo "==> gateway is healthy"
    break
  fi
  if [[ "$status" == "unhealthy" ]]; then
    echo "!! gateway reported unhealthy — check: docker compose logs gateway"
    exit 1
  fi
  sleep 2
done

cat <<'EOF'

────────────────────────────────────────────────────────────────────────
 Gateway is up. Next steps (once per deployment):

 1. Open the OmniRoute dashboard:  http://127.0.0.1:20128
    Sign in with the admin password in .env (INITIAL_PASSWORD).

 2. Register upstream provider API keys in the dashboard so the gateway
    has at least one model to route to (Anthropic, OpenAI, free tiers, …).

 3. Issue a gateway API key (Dashboard → API Keys) and put it in .env:

      OPENAI_LIKE_API_KEY=<gateway key>

 4. Start the Distro web app and verify end-to-end:

      docker compose up -d --build web
      make doctor
      # open http://127.0.0.1:5173, pick the OpenAILike/Distro provider

 Upstream provider keys NEVER go into Distro — they live in the gateway's
 SQLite volume (gateway-data). See docs/ops.md and docs/architecture.md.
────────────────────────────────────────────────────────────────────────
EOF
