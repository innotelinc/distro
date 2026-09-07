SHELL := /bin/bash

.PHONY: help up down logs ps gateway-up web-up build bootstrap doctor \
        sync-upstream typecheck format clean backup

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

bootstrap: ## First-run setup: .env, gateway boot, distro build
	./scripts/bootstrap.sh

up: ## Build and start the full stack (gateway + web)
	docker compose up -d --build

down: ## Stop the stack
	docker compose down

logs: ## Tail logs for all services
	docker compose logs -f --tail=200

ps: ## Service status
	docker compose ps

gateway-up: ## Start only the OmniRoute gateway
	docker compose up -d redis gateway

web-up: ## Rebuild and start only Distro web
	docker compose up -d --build web

build: ## Build images without starting
	docker compose build

doctor: ## Verify gateway + web health from the host
	./scripts/healthcheck-gateway.sh
	@echo "--- web ---"
	@curl -fsS -o /dev/null -w "GET http://127.0.0.1:5173/ -> HTTP %{http_code}\n" http://127.0.0.1:5173/ || echo "web not reachable yet"

sync-upstream: ## Refresh local upstream checkouts (apps/web ref + vendor/omniroute)
	./scripts/sync-upstream.sh

backup: ## Back up control-plane + gateway DBs to ./backups
	./scripts/backup.sh

typecheck: ## Typecheck the Distro web app (needs pnpm + installed deps)
	cd apps/web && pnpm run typecheck

format: ## Prettier over the Distro web app
	cd apps/web && pnpm run lint:fix
