#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# Innotel mesh bootstrap — provisions the platform-stack WireGuard mesh on any
# server, based on which Innotel products are installed (or to be installed).
#
# What it does:
#   1. Detects this server's number (1-5) from the products present under
#      ${DEV_ROOT:-/usr/src/dev} and the hostname; `--server N` overrides.
#   2. Ensures the platform stack's .env carries the mesh section: mesh IPs
#      (10.10.N.1), this server's WG keypair, MESH_PORT, the Consul gossip
#      key, and the Consul role (server on Server 1, client elsewhere).
#   3. Generates this server's WireGuard keypair if one isn't set yet.
#   4. On Server 1 (hub): starts the existing hub-mode mesh via stack.sh.
#      On Servers 2-5 (clients): writes mesh/wg/data/wg_confs/wg0.conf (a
#      static client conf dialing the hub) + a client-mode compose fragment,
#      then starts the mesh. The Consul agent joins the hub at 10.10.1.1.
#   5. Verifies: tunnel handshake + Consul reachable (unless --no-verify).
#
# Usage:
#   scripts/mesh-setup.sh [--server N] [--hub-pubkey <key>] [--stack DIR]
#                         [--no-verify] [--dry-run]
#
#   --server N        Skip product detection; this server is N (1-5).
#   --hub-pubkey KEY  Hub (Server 1) WireGuard public key — needed on clients.
#   --stack DIR       Path to the innotel-platform-stack checkout
#                     (default: ${DEV_ROOT}/innotel-platform-stack).
#   --no-verify       Don't wait for the tunnel/Consul after starting.
#   --dry-run         Print what would be written/started; change nothing.
#
# Order matters on a fresh mesh: run this on Server 1 FIRST, then on each
# client with the hub's public key. The hub prints the exact client command.
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Locate the platform stack ────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEV_ROOT="$(cd "${REPO_DIR}/.." && pwd)"
STACK_DIR="${DEV_ROOT}/innotel-platform-stack"
SERVER_N=""
HUB_PUBKEY=""
NO_VERIFY=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --server)      SERVER_N="$2"; shift 2 ;;
    --hub-pubkey)  HUB_PUBKEY="$2"; shift 2 ;;
    --stack)       STACK_DIR="$2"; shift 2 ;;
    --no-verify)   NO_VERIFY=1; shift ;;
    --dry-run)     DRY_RUN=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

ENV_FILE="${STACK_DIR}/.env"
CLIENT_COMPOSE="${STACK_DIR}/mesh/docker-compose.client.yml"
WG_DATA="${STACK_DIR}/mesh/wg/data"
WG_CLIENT_CONF="${WG_DATA}/wg_confs/wg0.conf"

# ── Helpers ───────────────────────────────────────────────────────────────────
info() { echo -e "\033[1;34m[mesh]\033[0m $*"; }
ok()   { echo -e "\033[1;32m[mesh]\033[0m $*"; }
warn() { echo -e "\033[1;33m[mesh]\033[0m $*"; }
err()  { echo -e "\033[1;31m[mesh]\033[0m $*" >&2; }

env_upsert() { # idempotent KEY=VALUE write into an env file
  local file="$1" key="$2" value="$3"
  [ -f "$file" ] || touch "$file"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

env_get() { # first match of KEY in the env file
  grep "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true
}

# ── 1. Detect server number ──────────────────────────────────────────────────
# Group names mirror the platform-stack groups/ dirs (used for env var names).
group_name_for() {
  case "$1" in
    1) echo "PRIMARY" ;; 2) echo "VOICE" ;; 3) echo "MEDIA" ;;
    4) echo "SOCIAL" ;; 5) echo "DEV" ;;
  esac
}

detect_server() {
  # Product dirs → server (group) number per innotel-platform-stack groups/.
  # Group 5 (dev) hosts Distro; group 1 (primary) hosts Authentik/AthenIQ;
  # group 2 (voice) hosts Capstone/Zeus/OmniRoute; group 4 (social) hosts
  # Rizzaura/ONYX.
  local host
  host="$(hostname | tr '[:upper:]' '[:lower:]')"
  case "$host" in
    *onyx*|*riz*)          echo 4; return ;;
    *distro*|*atlas*|*oasis*) echo 5; return ;;
    *authentik*|*cerulean*|*magnate*|*atheniq*) echo 1; return ;;
    *capstone*|*zeus*)     echo 2; return ;;
    *monarch*|*jellyfin*)  echo 3; return ;;
  esac
  local dir name n
  for dir in "${DEV_ROOT}"/*/; do
    name="$(basename "$dir")"
    case "$name" in
      distro|atlas|oasis)      n=5 ;;
      authentiq|cerulean|magnate|atheniq) n=1 ;;
      gliz|capstone|zeus)      n=2 ;;
      game|onyx|rizzaura)      n=4 ;;
      monarch|jellyfin)        n=3 ;;
      *) continue ;;
    esac
    info "Detected product '${name}' → server ${n}"
    echo "$n"; return
  done
  echo ""
}

if [ -z "$SERVER_N" ]; then
  SERVER_N="$(detect_server)"
  if [ -z "$SERVER_N" ]; then
    err "Cannot determine server number from hostname or products under ${DEV_ROOT}."
    err "Pass --server N (1-5) explicitly."
    exit 1
  fi
fi
case "$SERVER_N" in
  1|2|3|4|5) ;;
  *) err "Invalid server number: '${SERVER_N}' (expected 1-5)."; exit 1 ;;
esac

GROUP_NAME="$(group_name_for "$SERVER_N")"
MESH_IP="10.10.${SERVER_N}.1"
if [ "$SERVER_N" = "1" ]; then
  CONSUL_SERVER_ADDR="$MESH_IP"
  CONSUL_SERVER_FLAG="-server=true -bootstrap-expect=1"
else
  CONSUL_SERVER_ADDR="10.10.1.1"
  CONSUL_SERVER_FLAG="-server=false"
fi

info "Server ${SERVER_N} (group ${GROUP_NAME}) → mesh IP ${MESH_IP}"

# ── 2. Ensure the platform-stack .env exists and carries the mesh section ────
[ -d "$STACK_DIR" ] || { err "Platform stack not found at ${STACK_DIR} (--stack to override)."; exit 1; }
if [ ! -f "$ENV_FILE" ]; then
  if [ -f "${STACK_DIR}/.env.example" ]; then
    cp "${STACK_DIR}/.env.example" "$ENV_FILE"
    ok "Created ${ENV_FILE} from .env.example"
  else
    err "No ${ENV_FILE} and no .env.example in ${STACK_DIR}."
    exit 1
  fi
fi

env_upsert "$ENV_FILE" MESH_NETWORK "10.10.0.0/16"
env_upsert "$ENV_FILE" MESH_PORT "51820"
for n in 1 2 3 4 5; do
  env_upsert "$ENV_FILE" "SERVER_${n}_$(group_name_for "$n")_IP" "10.10.${n}.1"
  # Fill blank public IPs only — never clobber an existing value (e.g. the
  # hub's SERVER_1_PUBLIC_IP in .env.example).
  if [ -z "$(env_get "SERVER_${n}_PUBLIC_IP")" ]; then
    if [ "$n" = "$SERVER_N" ]; then
      # This server's public IP — auto-detect from the primary interface.
      detected_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' | head -1 || true)"
      if [ -n "$detected_ip" ]; then
        env_upsert "$ENV_FILE" "SERVER_${n}_PUBLIC_IP" "$detected_ip"
        ok "Set SERVER_${n}_PUBLIC_IP=${detected_ip} (auto-detected)"
      else
        warn "Could not auto-detect this server's public IP — set SERVER_${n}_PUBLIC_IP in ${ENV_FILE}."
      fi
    else
      env_upsert "$ENV_FILE" "SERVER_${n}_PUBLIC_IP" ""
    fi
  fi
done
env_upsert "$ENV_FILE" "SERVER_${SERVER_N}_${GROUP_NAME}_IP" "$MESH_IP"

# Consul gossip encrypt key — required for cross-node gossip (consul keygen).
if [ -z "$(env_get REGISTRY_ENCRYPT_KEY)" ]; then
  key="$(docker run --rm hashicorp/consul:1.19 keygen 2>/dev/null || true)"
  if [ -n "$key" ]; then
    env_upsert "$ENV_FILE" REGISTRY_ENCRYPT_KEY "$key"
    ok "Generated Consul gossip key"
  else
    warn "Could not generate REGISTRY_ENCRYPT_KEY (docker unavailable?) — set it manually: docker run --rm hashicorp/consul:1.19 keygen"
  fi
fi

# Consul role: server on Server 1, client everywhere else (stack.sh exports
# these per group; we pin them so the mesh compose gets them even on a bare
# `mesh` start).
env_upsert "$ENV_FILE" CONSUL_SERVER_FLAG "$CONSUL_SERVER_FLAG"
env_upsert "$ENV_FILE" CONSUL_SERVER_ADDR "$CONSUL_SERVER_ADDR"
env_upsert "$ENV_FILE" REGISTRY_ADDR "10.10.1.1:8500"

# ── 3. This server's WG keypair (generate once, reuse) ───────────────────────
gen_keypair() {
  local priv pub
  if command -v wg >/dev/null 2>&1; then
    priv="$(wg genkey)"
    pub="$(printf '%s' "$priv" | wg pubkey)"
  elif docker exec mesh-wireguard wg --version >/dev/null 2>&1; then
    # Reuse the mesh container's wg binary — no image pull needed.
    priv="$(docker exec mesh-wireguard wg genkey)"
    pub="$(docker exec mesh-wireguard sh -c "printf '%s' '$priv' | wg pubkey")"
  else
    # Fallback: pull the linuxserver image (kept local afterwards).
    priv="$(timeout 60 docker run --rm linuxserver/wireguard:latest sh -c 'wg genkey' 2>/dev/null || true)"
    if [ -z "$priv" ]; then
      err "Cannot generate WireGuard keys (no 'wg' binary, no mesh container, docker pull failed)."
      exit 1
    fi
    pub="$(docker run --rm -e PRIV="$priv" linuxserver/wireguard:latest sh -c 'printf %s "$PRIV" | wg pubkey')"
  fi
  echo "${priv} ${pub}"
}

PRIV="$(env_get "SERVER_${SERVER_N}_WG_PRIVATE_KEY")"
PUB="$(env_get "SERVER_${SERVER_N}_WG_PUBLIC_KEY")"
if [ -z "$PRIV" ] || [ -z "$PUB" ] && [ "$DRY_RUN" = "1" ]; then
  warn "DRY-RUN — skipping keypair generation."
elif [ -z "$PRIV" ] || [ -z "$PUB" ]; then
  info "Generating WireGuard keypair for server ${SERVER_N}..."
  KP="$(gen_keypair)"
  PRIV="${KP%% *}"
  PUB="${KP##* }"
  env_upsert "$ENV_FILE" "SERVER_${SERVER_N}_WG_PRIVATE_KEY" "$PRIV"
  env_upsert "$ENV_FILE" "SERVER_${SERVER_N}_WG_PUBLIC_KEY" "$PUB"
  ok "Keypair generated — public key: ${PUB}"
else
  ok "Using existing keypair (pub ${PUB})"
fi

# ── 4. Hub vs client wiring ──────────────────────────────────────────────────
if [ "$SERVER_N" = "1" ]; then
  # Hub: PEERS covers the other servers; the platform-stack mesh compose is
  # hub-mode and generates peerN.conf under mesh/wg/data on first start.
  env_upsert "$ENV_FILE" MESH_PEERS "4"
  env_upsert "$ENV_FILE" SERVER_PUBLIC_IP "$(env_get SERVER_1_PUBLIC_IP)"
  ok "This is the hub. Peer configs are generated under ${WG_DATA}/ — distribute peerN.conf to each client."
else
  # Client: write a static wg0.conf dialing the hub + a client-mode compose.
  if [ -z "$HUB_PUBKEY" ]; then
    HUB_PUBKEY="$(env_get SERVER_1_WG_PUBLIC_KEY)"
  fi
  if [ -z "$HUB_PUBKEY" ]; then
    warn "Hub (Server 1) WireGuard public key unknown."
    warn "Run this script on Server 1 first, then re-run here with:"
    warn "  $0 --hub-pubkey <SERVER_1_WG_PUBLIC_KEY>"
    exit 1
  fi
  HUB_PUB_IP="$(env_get SERVER_1_PUBLIC_IP)"
  [ -n "$HUB_PUB_IP" ] || HUB_PUB_IP="$CONSUL_SERVER_ADDR"
  MESH_PORT_VAL="$(env_get MESH_PORT)"; [ -n "$MESH_PORT_VAL" ] || MESH_PORT_VAL="51820"

  mkdir -p "${WG_DATA}/wg_confs"
  cat > "$WG_CLIENT_CONF" <<EOF
# Static client config for server ${SERVER_N} (generated by scripts/mesh-setup.sh)
[Interface]
PrivateKey = ${PRIV}
Address = ${MESH_IP}/32
DNS = 1.1.1.1

[Peer]
# Hub (Server 1)
PublicKey = ${HUB_PUBKEY}
Endpoint = ${HUB_PUB_IP}:${MESH_PORT_VAL}
AllowedIPs = 10.10.0.0/16
PersistentKeepalive = 25
EOF
  ok "Wrote client conf: ${WG_CLIENT_CONF}"

  cat > "$CLIENT_COMPOSE" <<EOF
# Generated by distro scripts/mesh-setup.sh — client-mode mesh for non-hub
# servers. WireGuard dials the hub; Consul joins 10.10.1.1 over the tunnel.
name: innotel-mesh-client

services:
  wireguard:
    image: linuxserver/wireguard:latest
    container_name: mesh-wireguard
    cap_add: [NET_ADMIN, SYS_MODULE]
    environment:
      - PUID=0
      - PGID=0
      - TZ=UTC
      # Empty PEERS = client mode: the image keeps the mounted static
      # wg_confs/wg0.conf and starts the tunnel as a client (no peer gen).
      - PEERS=
    volumes:
      - ${WG_DATA}/wg_confs:/config/wg_confs
      - /lib/modules:/lib/modules
    sysctls:
      - net.ipv4.conf.all.src_valid_mark=1
      - net.ipv4.ip_forward=1
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wg", "show", "wg0"]
      interval: 30s
      timeout: 5s
      retries: 3
    networks:
      - mesh-net

  consul:
    image: hashicorp/consul:1.19
    container_name: mesh-consul
    restart: unless-stopped
    volumes:
      - ${STACK_DIR}/mesh/registry/data:/consul/data
    ports:
      - "8500:8500"
      - "8600:8600/udp"
    command: >
      agent
        -bind=0.0.0.0
        -client=0.0.0.0
        -datacenter=innotel
        -data-dir=/consul/data
        -ui
        -retry-join=${CONSUL_SERVER_ADDR}
        ${CONSUL_SERVER_FLAG}
    healthcheck:
      test: ["CMD", "consul", "members"]
      interval: 15s
      timeout: 5s
      retries: 3
    networks:
      - mesh-net

networks:
  mesh-net:
    name: innotel-mesh-net
EOF
  ok "Wrote client compose: ${CLIENT_COMPOSE}"
fi

# ── 5. Start + verify ────────────────────────────────────────────────────────
if [ "$DRY_RUN" = "1" ]; then
  ok "DRY-RUN — not starting anything."
  exit 0
fi

if [ "$SERVER_N" = "1" ]; then
  ( cd "$STACK_DIR" && ./stack.sh mesh )
else
  ( cd "$STACK_DIR" && docker compose -f "$CLIENT_COMPOSE" up -d )
fi

if [ "$NO_VERIFY" = "1" ]; then
  ok "Mesh started (verification skipped)."
  exit 0
fi

info "Waiting for the tunnel to come up (up to 60s)..."
tunnel_ok=0
for _ in $(seq 1 30); do
  if docker exec mesh-wireguard wg show wg0 2>/dev/null | grep -q 'latest handshake'; then
    tunnel_ok=1
    break
  fi
  sleep 2
done
if [ "$tunnel_ok" = "1" ]; then
  ok "WireGuard tunnel: handshake established."
else
  warn "No handshake yet — the hub must be running and reachable on UDP port ${MESH_PORT_VAL:-51820}."
fi

if curl -s --max-time 5 "http://${CONSUL_SERVER_ADDR}:8500/v1/status/leader" | grep -q '"'; then
  ok "Consul reachable at ${CONSUL_SERVER_ADDR}:8500"
else
  warn "Consul not reachable yet at ${CONSUL_SERVER_ADDR}:8500."
fi

ok "Mesh setup complete for server ${SERVER_N}."