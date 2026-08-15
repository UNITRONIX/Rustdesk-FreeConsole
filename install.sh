#!/usr/bin/env bash
# =============================================================================
# BetterDesk — one-line installer (Linux)
#
# Docker (default — official all-in-one GHCR image, fully automated):
#   curl -fsSL https://raw.githubusercontent.com/UNITRONIX/BetterDesk/main/install.sh | sudo bash
#
# Docker legacy (two-container split images):
#   curl -fsSL .../install.sh | sudo bash -s -- --split
#
# Native (git clone + betterdesk.sh --auto):
#   curl -fsSL https://raw.githubusercontent.com/UNITRONIX/BetterDesk/main/install.sh | sudo bash -s -- --native
#
# Options (pass after "bash -s --"):
#   --docker | --native          Installation mode (default: docker)
#   --split                      Legacy two-container layout (server + console images)
#   --install-dir PATH             Install directory (default: /opt/betterdesk)
#   --version TAG                  Docker image tag / release baseline (default: 3.5.38)
#   --branch BRANCH                Git branch for native install (default: main)
#   --relay-mode auto|local|public Relay auto-detection strategy
#   --relay-servers IP[:port]      Fixed relay address (overrides --relay-mode)
#   --admin-password PASS          Set admin password (Docker: ADMIN_PASSWORD env)
#   --skip-docker-install          Do not install Docker when missing
#   --skip-firewall                Skip UFW/firewalld/iptables configuration
#   --rescue                       Safe repair: permissions, restart, health checks
#   --diagnose                     Read-only diagnostics for Docker deployments
#   --repair-permissions           Only repair Docker data/volume permissions
#   --purge                        With --uninstall: also remove Docker volumes
#   --uninstall                    Remove BetterDesk Docker installation
#   --help                         Show usage
#
# Environment overrides (same names as flags where applicable):
#   BETTERDESK_REPO, BETTERDESK_BRANCH, BETTERDESK_VERSION, INSTALL_DIR,
#   RELAY_MODE, RELAY_SERVERS, ADMIN_PASSWORD, BETTERDESK_RAW_BASE
# =============================================================================

set -euo pipefail

VERSION="1.0.0"
BETTERDESK_REPO="${BETTERDESK_REPO:-UNITRONIX/BetterDesk}"
BETTERDESK_BRANCH="${BETTERDESK_BRANCH:-main}"
BETTERDESK_VERSION="${BETTERDESK_VERSION:-3.5.38}"
BETTERDESK_RAW_BASE="${BETTERDESK_RAW_BASE:-https://raw.githubusercontent.com/${BETTERDESK_REPO}/${BETTERDESK_BRANCH}}"
INSTALL_DIR="${INSTALL_DIR:-/opt/betterdesk}"
INSTALL_MODE="docker"
DOCKER_LAYOUT="single"
RELAY_MODE="${RELAY_MODE:-auto}"
RELAY_SERVERS="${RELAY_SERVERS:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SKIP_DOCKER_INSTALL=false
SKIP_FIREWALL=false
DO_UNINSTALL=false
DO_PURGE=false
DO_RESCUE=false
RESCUE_ACTION="rescue"

# Docker quick-start ports (single: 21121 API; split adds 21114)
DOCKER_PORTS_SINGLE="21115 21116 21117 21118 21119 21121 5000"
DOCKER_PORTS_SPLIT="21114 21115 21116 21117 21118 21119 5000"

# ── Output helpers ────────────────────────────────────────────────────────────

if [ -t 1 ]; then
    C_RESET='\033[0m'
    C_BOLD='\033[1m'
    C_DIM='\033[2m'
    C_RED='\033[0;31m'
    C_GREEN='\033[0;32m'
    C_YELLOW='\033[1;33m'
    C_CYAN='\033[0;36m'
    C_WHITE='\033[1;37m'
else
    C_RESET='' C_BOLD='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW='' C_CYAN='' C_WHITE=''
fi

log()  { echo -e "${C_CYAN}[install]${C_RESET} $*"; }
ok()   { echo -e "${C_GREEN}✓${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}!${C_RESET} $*" >&2; }
die()  { echo -e "${C_RED}✗${C_RESET} $*" >&2; exit 1; }

usage() {
    sed -n '4,27p' "$0" | sed 's/^# \?//'
    exit 0
}

# ── Argument parsing ──────────────────────────────────────────────────────────

while [ $# -gt 0 ]; do
    case "$1" in
        --docker) INSTALL_MODE="docker"; shift ;;
        --split) DOCKER_LAYOUT="split"; shift ;;
        --native) INSTALL_MODE="native"; shift ;;
        --install-dir) INSTALL_DIR="$2"; shift 2 ;;
        --version) BETTERDESK_VERSION="$2"; shift 2 ;;
        --branch) BETTERDESK_BRANCH="$2"; BETTERDESK_RAW_BASE="https://raw.githubusercontent.com/${BETTERDESK_REPO}/${BETTERDESK_BRANCH}"; shift 2 ;;
        --relay-mode) RELAY_MODE="$2"; shift 2 ;;
        --relay-servers) RELAY_SERVERS="$2"; shift 2 ;;
        --admin-password) ADMIN_PASSWORD="$2"; shift 2 ;;
        --skip-docker-install) SKIP_DOCKER_INSTALL=true; shift ;;
        --skip-firewall) SKIP_FIREWALL=true; shift ;;
        --rescue) DO_RESCUE=true; RESCUE_ACTION="rescue"; shift ;;
        --diagnose|--diagnostics) DO_RESCUE=true; RESCUE_ACTION="diagnose"; shift ;;
        --repair-permissions) DO_RESCUE=true; RESCUE_ACTION="repair-permissions"; shift ;;
        --purge) DO_PURGE=true; shift ;;
        --uninstall) DO_UNINSTALL=true; shift ;;
        -h|--help) usage ;;
        *) die "Unknown option: $1 (use --help)" ;;
    esac
done

# ── Preflight ─────────────────────────────────────────────────────────────────

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        die "This installer must run as root. Re-run with: sudo bash"
    fi
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

get_public_ip() {
    local ip
    ip=$(curl -4 -fsS --max-time 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]') && [ -n "$ip" ] && echo "$ip" && return
    ip=$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null | tr -d '[:space:]') && [ -n "$ip" ] && echo "$ip" && return
    ip=$(curl -4 -fsS --max-time 5 https://ifconfig.me/ip 2>/dev/null | tr -d '[:space:]') && [ -n "$ip" ] && echo "$ip" && return
    echo "127.0.0.1"
}

get_local_ip() {
    local ip
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' | head -1)
    [ -n "$ip" ] && echo "$ip" && return
    ip=$(ip -4 addr show scope global 2>/dev/null | grep -oP 'inet \K[0-9.]+' | head -1)
    [ -n "$ip" ] && echo "$ip" && return
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ -n "$ip" ] && echo "$ip" && return
    echo "127.0.0.1"
}

is_private_ip() {
    case "$1" in
        127.*|10.*|192.168.*) return 0 ;;
        172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 0 ;;
        *) return 1 ;;
    esac
}

resolve_relay_address() {
    if [ -n "$RELAY_SERVERS" ]; then
        warn "Using fixed relay address: $RELAY_SERVERS"
        echo "$RELAY_SERVERS"
        return
    fi

    local ip
    case "${RELAY_MODE}" in
        local|lan)
            ip=$(get_local_ip)
            log "Relay mode 'local': using LAN IP $ip"
            ;;
        public|wan)
            ip=$(get_public_ip)
            log "Relay mode 'public': using public IP $ip"
            ;;
        auto|*)
            ip=$(get_public_ip)
            if is_private_ip "$ip"; then
                warn "Auto-detected private/loopback IP: $ip"
                warn "Internet clients may fail relay connections. Set --relay-servers YOUR.PUBLIC.IP or use --relay-mode local for LAN-only."
            fi
            ;;
    esac

    # Include relay port when only an IP was detected.
    case "$ip" in
        *:*) echo "$ip" ;;
        *) echo "${ip}:21117" ;;
    esac
}

fetch_url_to_file() {
    local url="$1"
    local dest="$2"
    local min_bytes="${3:-512}"
    local max_bytes="${4:-1048576}"

    if ! curl -fsSL --max-time 120 --proto '=https' --tlsv1.2 -o "$dest" "$url"; then
        die "Failed to download: $url"
    fi

    local size
    size=$(stat -c%s "$dest" 2>/dev/null || wc -c <"$dest")
    if [ "${size:-0}" -lt "$min_bytes" ] || [ "${size:-0}" -gt "$max_bytes" ]; then
        die "Downloaded file has unexpected size (${size} bytes): $url"
    fi
}

validate_compose_quick() {
    local file="$1"
    local layout="${2:-single}"
    grep -q 'services:' "$file" || die "Invalid compose file (missing services:)"
    if [ "$layout" = "split" ]; then
        grep -q 'ghcr.io/unitronix/betterdesk-server' "$file" || die "Invalid compose file (unexpected content)"
        grep -q 'ghcr.io/unitronix/betterdesk-console' "$file" || die "Invalid compose file (unexpected content)"
    else
        grep -q 'ghcr.io/unitronix/betterdesk:' "$file" || die "Invalid compose file (unexpected content)"
        grep -q 'BETTERDESK_DOCKER_LAYOUT=single' "$file" || die "Invalid compose file (missing single layout marker)"
    fi
}

# ── Docker helpers ────────────────────────────────────────────────────────────

check_docker() {
    command -v docker >/dev/null 2>&1 || return 1
    docker info >/dev/null 2>&1 || return 2
    return 0
}

check_docker_compose() {
    if docker compose version >/dev/null 2>&1; then
        COMPOSE_CMD=(docker compose)
        return 0
    fi
    if command -v docker-compose >/dev/null 2>&1; then
        COMPOSE_CMD=(docker-compose)
        return 0
    fi
    return 1
}

install_docker_engine() {
    log "Installing Docker..."
    require_command curl

    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc 2>/dev/null \
            || curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
        chmod a+r /etc/apt/keyrings/docker.asc

        local distro codename
        if [ -f /etc/os-release ]; then
            # shellcheck disable=SC1091
            . /etc/os-release
            distro="${ID:-ubuntu}"
            codename="${VERSION_CODENAME:-$(lsb_release -cs 2>/dev/null || echo bookworm)}"
        else
            distro="ubuntu"
            codename="jammy"
        fi

        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${distro} ${codename} stable" \
            > /etc/apt/sources.list.d/docker.list
        apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y -q docker docker-compose-plugin
    elif command -v yum >/dev/null 2>&1; then
        yum install -y -q docker docker-compose-plugin
    else
        die "Unsupported package manager. Install Docker manually: https://docs.docker.com/engine/install/"
    fi

    systemctl enable docker >/dev/null 2>&1 || true
    systemctl start docker
    ok "Docker installed"
}

configure_firewall() {
    [ "$SKIP_FIREWALL" = true ] && { log "Skipping firewall configuration"; return 0; }

    local port created=0
    local docker_ports="$DOCKER_PORTS_SINGLE"
    if [ "$DOCKER_LAYOUT" = "split" ]; then
        docker_ports="$DOCKER_PORTS_SPLIT"
    fi

    log "Configuring firewall (if active)..."

    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi "active"; then
        for port in $docker_ports; do
            if [ "$port" = "21116" ]; then
                ufw allow 21116/tcp comment "BetterDesk signal TCP" >/dev/null 2>&1 && created=$((created + 1)) || true
                ufw allow 21116/udp comment "BetterDesk signal UDP" >/dev/null 2>&1 && created=$((created + 1)) || true
            elif ! ufw status 2>/dev/null | grep -qE "^${port}[/ ]"; then
                ufw allow "${port}/tcp" comment "BetterDesk port ${port}" >/dev/null 2>&1 && created=$((created + 1)) || true
            fi
        done
        ufw reload >/dev/null 2>&1 || true
    elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
        for port in $docker_ports; do
            if [ "$port" = "21116" ]; then
                firewall-cmd --permanent --add-port=21116/tcp >/dev/null 2>&1 && created=$((created + 1)) || true
                firewall-cmd --permanent --add-port=21116/udp >/dev/null 2>&1 && created=$((created + 1)) || true
            else
                firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 && created=$((created + 1)) || true
            fi
        done
        firewall-cmd --reload >/dev/null 2>&1 || true
    else
        log "No active UFW/firewalld detected — skipping firewall rules"
        return 0
    fi

    if [ "$created" -gt 0 ]; then
        ok "Created $created firewall rule(s)"
    else
        ok "Firewall rules already present"
    fi
}

wait_for_http() {
    local url="$1"
    local label="$2"
    local attempts="${3:-60}"
    local i

    for i in $(seq 1 "$attempts"); do
        if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
            ok "$label is ready"
            return 0
        fi
        sleep 2
    done
    warn "$label did not become ready in time ($url)"
    return 1
}

fetch_admin_credentials() {
    # Prefer helper (#195); fall back to cat as betterdesk when image lacks the binary (#299).
    local service="$1"
    local compose_file="$INSTALL_DIR/docker/docker-compose.yml"
    local out=""

    out=$("${COMPOSE_CMD[@]}" -f "$compose_file" exec -T "$service" \
        betterdesk-show-admin-credentials 2>/dev/null || true)
    if [ -n "$out" ]; then
        printf '%s\n' "$out"
        return 0
    fi

    out=$("${COMPOSE_CMD[@]}" -f "$compose_file" exec -T -u betterdesk "$service" \
        sh -c 'cat /opt/rustdesk/.admin_credentials 2>/dev/null || cat /app/data/.admin_credentials 2>/dev/null' \
        2>/dev/null || true)
    if [ -n "$out" ]; then
        printf '%s\n' "$out"
        return 0
    fi
    return 1
}

print_docker_summary() {
    local relay="$1"
    local host_ip="${relay%%:*}"
    local creds=""
    local pubkey=""
    local api_port="21121"
    local exec_service="betterdesk"

    if [ "$DOCKER_LAYOUT" = "split" ]; then
        api_port="21114"
        exec_service="console"
        creds=$(fetch_admin_credentials console || true)
        pubkey=$("${COMPOSE_CMD[@]}" -f "$INSTALL_DIR/docker/docker-compose.yml" exec -T server \
            sh -c 'cat /opt/rustdesk/id_ed25519.pub 2>/dev/null' 2>/dev/null || true)
    else
        creds=$(fetch_admin_credentials betterdesk || true)
        pubkey=$("${COMPOSE_CMD[@]}" -f "$INSTALL_DIR/docker/docker-compose.yml" exec -T betterdesk \
            sh -c 'cat /opt/rustdesk/id_ed25519.pub 2>/dev/null' 2>/dev/null || true)
    fi

    echo ""
    echo -e "${C_CYAN}╔══════════════════════════════════════════════════════════════╗${C_RESET}"
    echo -e "${C_CYAN}║${C_RESET}  ${C_BOLD}BetterDesk Docker installation complete${C_RESET}                     ${C_CYAN}║${C_RESET}"
    echo -e "${C_CYAN}╠══════════════════════════════════════════════════════════════╣${C_RESET}"
    echo -e "${C_CYAN}║${C_RESET}  Layout:       ${C_WHITE}${DOCKER_LAYOUT} container(s)${C_RESET}"
    echo -e "${C_CYAN}║${C_RESET}  Web panel:    ${C_WHITE}http://${host_ip}:5000${C_RESET}"
    echo -e "${C_CYAN}║${C_RESET}  API health:   ${C_WHITE}http://${host_ip}:${api_port}/api/health${C_RESET}"
    echo -e "${C_CYAN}║${C_RESET}  Relay:        ${C_WHITE}${relay}${C_RESET}"
    echo -e "${C_CYAN}║${C_RESET}  Install dir:  ${C_WHITE}${INSTALL_DIR}/docker${C_RESET}"
    echo -e "${C_CYAN}║${C_RESET}  Image tag:    ${C_WHITE}${BETTERDESK_VERSION}${C_RESET}"
    if [ -n "$pubkey" ]; then
        echo -e "${C_CYAN}║${C_RESET}  Public key:   ${C_WHITE}${pubkey:0:32}...${C_RESET}"
    fi
    echo -e "${C_CYAN}╠══════════════════════════════════════════════════════════════╣${C_RESET}"
    echo -e "${C_CYAN}║${C_RESET}  ${C_YELLOW}RustDesk client settings:${C_RESET}"
    echo -e "${C_CYAN}║${C_RESET}    ID server:    ${C_WHITE}${host_ip}:21116${C_RESET}"
    echo -e "${C_CYAN}║${C_RESET}    Relay server: ${C_WHITE}${relay}${C_RESET}"
    echo -e "${C_CYAN}║${C_RESET}    API server:   ${C_WHITE}http://${host_ip}:${api_port}${C_RESET}"
    echo -e "${C_CYAN}╠══════════════════════════════════════════════════════════════╣${C_RESET}"
    if [ -n "$creds" ]; then
        echo -e "${C_CYAN}║${C_RESET}  ${C_BOLD}Admin credentials:${C_RESET}"
        while IFS= read -r line; do
            [ -n "$line" ] && echo -e "${C_CYAN}║${C_RESET}    ${C_WHITE}${line}${C_RESET}"
        done <<< "$creds"
    else
        echo -e "${C_CYAN}║${C_RESET}  Admin creds:   ${C_DIM}docker compose -f ${INSTALL_DIR}/docker/docker-compose.yml exec ${exec_service} betterdesk-show-admin-credentials${C_RESET}"
    fi
    echo -e "${C_CYAN}╚══════════════════════════════════════════════════════════════╝${C_RESET}"
    echo ""
    log "Manage: cd ${INSTALL_DIR}/docker && ${COMPOSE_CMD[*]} ps|logs|restart"
}

install_docker_mode() {
    local compose_dir="${INSTALL_DIR}/docker"
    local compose_file="${compose_dir}/docker-compose.yml"
    local env_file="${compose_dir}/.env"
    local relay tmp_compose compose_src layout_label api_health_url

    if [ "$DOCKER_LAYOUT" = "split" ]; then
        compose_src="docker-compose.quick.yml"
        layout_label="split (legacy)"
        api_health_url="http://127.0.0.1:21114/api/health"
    else
        compose_src="docker-compose.quick.single.yml"
        layout_label="single (official)"
        api_health_url="http://127.0.0.1:21121/api/health"
    fi

    log "BetterDesk Docker installer v${VERSION} (${layout_label}, images: ${BETTERDESK_VERSION})"

    if ! check_docker; then
        if [ "$SKIP_DOCKER_INSTALL" = true ]; then
            die "Docker is not available. Install Docker or remove --skip-docker-install"
        fi
        install_docker_engine
    fi
    check_docker || die "Docker daemon is not running"
    check_docker_compose || die "Docker Compose plugin is not available"

    mkdir -p "$compose_dir"
    relay=$(resolve_relay_address)

    log "Downloading ${compose_src}..."
    tmp_compose=$(mktemp)
    trap 'rm -f "$tmp_compose"' RETURN
    fetch_url_to_file "${BETTERDESK_RAW_BASE}/${compose_src}" "$tmp_compose" 1024 131072
    validate_compose_quick "$tmp_compose" "$DOCKER_LAYOUT"
    install -m 0644 "$tmp_compose" "$compose_file"

    log "Writing ${env_file}..."
    cat > "$env_file" <<EOF
# Generated by BetterDesk install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
BETTERDESK_IMAGE_TAG=${BETTERDESK_VERSION}
BETTERDESK_DOCKER_LAYOUT=${DOCKER_LAYOUT}
RELAY_SERVERS=${relay}
EOF
    if [ -n "$ADMIN_PASSWORD" ]; then
        printf 'ADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD" >> "$env_file"
    fi
    chmod 0600 "$env_file"

    log "Pulling images..."
    (cd "$compose_dir" && "${COMPOSE_CMD[@]}" --env-file .env pull)

    log "Starting containers..."
    (cd "$compose_dir" && "${COMPOSE_CMD[@]}" --env-file .env up -d)

    configure_firewall

    log "Waiting for services..."
    local health_failed=0
    wait_for_http "$api_health_url" "BetterDesk API" 90 || health_failed=1
    wait_for_http "http://127.0.0.1:5000/login" "Web console" 60 || health_failed=1
    if [ "$health_failed" -ne 0 ]; then
        die "BetterDesk containers did not pass health checks; inspect ${compose_dir}/docker-compose.yml logs before retrying"
    fi

    print_docker_summary "$relay"
}

rescue_docker_mode() {
    local rescue_dir="${INSTALL_DIR}/rescue"
    local rescue_script="${rescue_dir}/betterdesk-docker.sh"
    local rescue_url="${BETTERDESK_RAW_BASE}/betterdesk-docker.sh"
    local rescue_flag

    case "$RESCUE_ACTION" in
        diagnose) rescue_flag="--diagnose" ;;
        repair-permissions) rescue_flag="--repair-permissions" ;;
        rescue|*) rescue_flag="--rescue" ;;
    esac

    log "Preparing BetterDesk Docker rescue toolkit..."
    require_command curl
    if [ "$RESCUE_ACTION" != "diagnose" ]; then
        check_docker || die "Docker is not available or the daemon is not running"
        check_docker_compose || die "Docker Compose plugin is not available"
    fi

    mkdir -p "$rescue_dir"
    fetch_url_to_file "$rescue_url" "$rescue_script.tmp" 4096 524288
    install -m 0755 "$rescue_script.tmp" "$rescue_script"
    rm -f "$rescue_script.tmp"
    ok "Rescue script ready: $rescue_script"

    log "Running Docker rescue action: $RESCUE_ACTION"
    DATA_DIR="${DATA_DIR:-}" COMPOSE_FILE="${COMPOSE_FILE:-}" \
        "$rescue_script" "$rescue_flag"
}

uninstall_docker_mode() {
    local compose_dir="${INSTALL_DIR}/docker"
    local compose_file="${compose_dir}/docker-compose.yml"

    require_root
    check_docker_compose || die "Docker Compose not available"

    if [ ! -f "$compose_file" ]; then
        die "No Docker installation found at ${compose_dir}"
    fi

    log "Stopping BetterDesk Docker stack..."
    if [ "$DO_PURGE" = true ]; then
        (cd "$compose_dir" && "${COMPOSE_CMD[@]}" --env-file .env down -v)
        ok "Containers and volumes removed"
    else
        (cd "$compose_dir" && "${COMPOSE_CMD[@]}" --env-file .env down)
        ok "Containers stopped (volumes preserved — re-run with --purge to delete data)"
    fi
}

# ── Native install ────────────────────────────────────────────────────────────

install_native_mode() {
    local repo_dir="${INSTALL_DIR}/source"
    local relay

    log "BetterDesk native installer v${VERSION}"

    require_command git
    relay=$(resolve_relay_address)

    if [ -d "$repo_dir/.git" ]; then
        log "Updating existing clone in ${repo_dir}..."
        git -C "$repo_dir" fetch --depth 1 origin "$BETTERDESK_BRANCH"
        git -C "$repo_dir" checkout "$BETTERDESK_BRANCH"
        git -C "$repo_dir" pull --ff-only origin "$BETTERDESK_BRANCH" || true
    else
        log "Cloning ${BETTERDESK_REPO} (${BETTERDESK_BRANCH})..."
        rm -rf "$repo_dir"
        git clone --depth 1 --branch "$BETTERDESK_BRANCH" \
            "https://github.com/${BETTERDESK_REPO}.git" "$repo_dir"
    fi

    chmod +x "${repo_dir}/betterdesk.sh"

    log "Running betterdesk.sh --auto..."
    export RELAY_MODE RELAY_SERVERS="$relay"
    if [ -n "$ADMIN_PASSWORD" ]; then
        export ADMIN_PASSWORD
    fi
    (cd "$repo_dir" && ./betterdesk.sh --auto --relay-servers "$relay")

    ok "Native installation finished. See ${repo_dir} for logs and credentials."
}

uninstall_native_mode() {
    local repo_dir="${INSTALL_DIR}/source"
    local native_installer="${repo_dir}/betterdesk.sh"

    require_root
    if [ ! -x "$native_installer" ]; then
        die "Native installer not found at ${native_installer}; nothing was removed"
    fi

    log "Running native uninstall (data is preserved unless --purge is supplied)..."
    local args=(--auto --uninstall)
    if [ "$DO_PURGE" = true ]; then
        args+=(--purge)
    fi
    (cd "$repo_dir" && "$native_installer" "${args[@]}")
}

rescue_native_mode() {
    local repo_dir="${INSTALL_DIR}/source"

    warn "Native rescue is handled by betterdesk.sh on the installed host."
    if [ -x "$repo_dir/betterdesk.sh" ]; then
        echo "Run the interactive native repair toolkit with:"
        echo "  sudo ${repo_dir}/betterdesk.sh"
        echo "Then choose: Repair Installation or Diagnostics."
        return 0
    fi

    die "Native checkout not found at ${repo_dir}. Re-run without --rescue to install, or use --docker for Docker rescue."
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
    echo ""
    echo -e "${C_BOLD}BetterDesk installer v${VERSION}${C_RESET}"
    echo ""

    if [ "$DO_UNINSTALL" = true ]; then
        case "$INSTALL_MODE" in
            docker) uninstall_docker_mode ;;
            native) uninstall_native_mode ;;
            *) die "Unknown install mode: $INSTALL_MODE" ;;
        esac
        exit 0
    fi

    require_root

    if [ "$DO_RESCUE" = true ]; then
        case "$INSTALL_MODE" in
            docker) rescue_docker_mode ;;
            native) rescue_native_mode ;;
            *) die "Unknown install mode: $INSTALL_MODE" ;;
        esac
        exit 0
    fi

    case "$INSTALL_MODE" in
        docker) install_docker_mode ;;
        native) install_native_mode ;;
        *) die "Unknown install mode: $INSTALL_MODE" ;;
    esac
}

main "$@"
