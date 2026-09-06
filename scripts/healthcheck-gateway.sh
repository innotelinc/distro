#!/usr/bin/env bash
# Quick gateway health checks from the host.
#   dashboard      http://127.0.0.1:20128        (expects HTTP 200)
#   api /v1/models http://127.0.0.1:20129/v1/models
#   chat smoke     POST /v1/chat/completions     (only if OPENAI_LIKE_API_KEY is set)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

api_key="$(grep -E '^OPENAI_LIKE_API_KEY=' .env 2>/dev/null | head -1 | cut -d= -f2- || true)"

echo "--- gateway container ---"
docker compose ps gateway redis

echo "--- dashboard (127.0.0.1:20128) ---"
code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:20128/ || true)"
echo "HTTP $code"

echo "--- OpenAI-compatible API /v1/models (127.0.0.1:20129) ---"
if [[ -n "$api_key" && "$api_key" != "CHANGEME" ]]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $api_key" http://127.0.0.1:20129/v1/models || true)"
  echo "HTTP $code (authenticated)"
else
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:20129/v1/models || true)"
  echo "HTTP $code (no OPENAI_LIKE_API_KEY set in .env — expected 401/403)"
fi

echo "--- /v1/chat/completions smoke test ---"
if [[ -n "$api_key" && "$api_key" != "CHANGEME" ]]; then
  curl -sS -m 60 http://127.0.0.1:20129/v1/chat/completions \
    -H "Authorization: Bearer $api_key" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Reply with the single word: pong"}],"max_tokens":8}' \
    | head -c 600
  echo
else
  echo "skipped (set OPENAI_LIKE_API_KEY to run the smoke test)"
fi
