SHELL := /bin/bash

.PHONY: help up down logs ps build bootstrap doctor \
        discover-gateway mesh-setup clean backup typecheck

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

bootstrap: ## First-run setup: .env, gateway discovery, guided next steps
	./scripts/bootstrap.sh

up: ## Build and start the stack (control plane)
	docker compose up -d --build

down: ## Stop the stack
	docker compose down

logs: ## Tail logs for all services
	docker compose logs -f --tail=200

ps: ## Service status
	docker compose ps

discover-gateway: ## Consul-discover the remote gateway + Magnate and pin their URLs in .env
	./scripts/discover-gateway.sh

mesh-setup: ## Enroll this server in the platform-stack WireGuard mesh
	./scripts/mesh.sh join

mesh-download: ## Fetch this server's member repos into their group dirs
	./scripts/mesh.sh download

mesh-leave: ## Drain this server out of the mesh (PURGE=1 also drops its state)
	./scripts/mesh.sh leave $(if $(PURGE),--purge,)

build: ## Build images without starting
	docker compose build

doctor: ## Verify the remote gateway reachability from the host
	./scripts/healthcheck-gateway.sh

backup: ## Back up the control-plane DB to ./backups
	./scripts/backup.sh

typecheck: ## Syntax-check the control-plane sources (node --check)
	@for f in apps/control-plane/src/*.js apps/control-plane/bin/*.mjs; do node --check "$$f"; done
	@echo "control-plane sources parse"
