#!/bin/bash
#===============================================================================
#
#   BetterDesk Console Manager v3.3.32
#   All-in-One Interactive Tool for Docker
#
#   Features:
#     - Fresh installation with Docker Compose
#     - Update containers
#     - Repair/rebuild containers
#     - Validate installation
#     - Backup & restore volumes
#     - Reset admin password
#     - Build custom images
#     - Full diagnostics
#     - Migrate from existing RustDesk Docker
#     - PostgreSQL database support
#     - SQLite to PostgreSQL migration
#     - CDAP (Custom Device API Protocol) support
#
#   Usage: ./betterdesk-docker.sh
#          ./betterdesk-docker.sh --rescue
#          ./betterdesk-docker.sh --diagnose
#          ./betterdesk-docker.sh --repair-permissions
#
#===============================================================================

set -e

# Version
VERSION="3.3.32"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default paths (can be overridden by environment variables)
DATA_DIR="${DATA_DIR:-}"
BACKUP_DIR="${BACKUP_DIR:-/opt/betterdesk-backups}"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/docker-compose.yml}"

# Database configuration
USE_POSTGRESQL="${USE_POSTGRESQL:-false}"
DB_TYPE="${DB_TYPE:-sqlite}"
POSTGRESQL_URI="${POSTGRESQL_URI:-}"
POSTGRESQL_USER="${POSTGRESQL_USER:-betterdesk}"
POSTGRESQL_PASS="${POSTGRESQL_PASS:-}"
POSTGRESQL_DB="${POSTGRESQL_DB:-betterdesk}"
POSTGRESQL_HOST="${POSTGRESQL_HOST:-postgres}"  # Container name as host
POSTGRESQL_PORT="${POSTGRESQL_PORT:-5432}"
STORE_ADMIN_CREDENTIALS="${STORE_ADMIN_CREDENTIALS:-false}"

# Relay server configuration
#   auto   - detect public IP (default, best for internet-facing servers)
#   local  - use the host's LAN IP (best for LAN-only deployments)
#   public - force public IP detection
# RELAY_SERVERS env var always overrides this with a fixed value.
RELAY_MODE="${RELAY_MODE:-auto}"
RELAY_SERVERS="${RELAY_SERVERS:-}"

# Common data directory paths to search
COMMON_DATA_PATHS=(
    "/opt/betterdesk-data"
    "/var/lib/betterdesk"
    "/opt/rustdesk-data"
    "/var/lib/rustdesk"
    "$HOME/betterdesk-data"
)

# Container names
SERVER_CONTAINER="betterdesk-server"
CONSOLE_CONTAINER="betterdesk-console"
# Set by update_docker_from_github; consumed after container rebuild (#192)
LAST_UPDATE_REMOTE_SHA=""
# Legacy aliases for backwards compatibility in detect functions
HBBS_CONTAINER="$SERVER_CONTAINER"
HBBR_CONTAINER="$SERVER_CONTAINER"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
WHITE='\033[1;37m'
NC='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'

# Logging
LOG_FILE="/tmp/betterdesk_docker_$(date +%Y%m%d_%H%M%S).log"
CLI_ACTION=""
NONINTERACTIVE=false

#===============================================================================
# SELinux / Volume Helper Functions
#===============================================================================

# Create directory with proper permissions for Docker volumes
# Handles SELinux context on RHEL-based systems (AlmaLinux, CentOS, Rocky)
create_data_directory() {
    local dir_path="$1"
    
    mkdir -p "$dir_path" || {
        print_error "Failed to create directory: $dir_path"
        return 1
    }
    
    # Set proper ownership (root or current user)
    chmod 755 "$dir_path"
    
    # Handle SELinux on RHEL-based systems
    if command -v getenforce &> /dev/null; then
        if [ "$(getenforce 2>/dev/null)" = "Enforcing" ]; then
            # Apply SVirt sandbox context for Docker
            if command -v chcon &> /dev/null; then
                chcon -Rt svirt_sandbox_file_t "$dir_path" 2>/dev/null || true
                log "SELinux: Applied svirt_sandbox_file_t context to $dir_path"
            fi
        fi
    fi
    
    return 0
}

#===============================================================================
# Helper Functions
#===============================================================================

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

print_header() {
    clear 2>/dev/null || true
    echo -e "${CYAN}"
    echo "╔══════════════════════════════════════════════════════════════════╗"
    echo "║                                                                  ║"
    echo "║   ██████╗ ███████╗████████╗████████╗███████╗██████╗              ║"
    echo "║   ██╔══██╗██╔════╝╚══██╔══╝╚══██╔══╝██╔════╝██╔══██╗             ║"
    echo "║   ██████╔╝█████╗     ██║      ██║   █████╗  ██████╔╝             ║"
    echo "║   ██╔══██╗██╔══╝     ██║      ██║   ██╔══╝  ██╔══██╗             ║"
    echo "║   ██████╔╝███████╗   ██║      ██║   ███████╗██║  ██║             ║"
    echo "║   ╚═════╝ ╚══════╝   ╚═╝      ╚═╝   ╚══════╝╚═╝  ╚═╝             ║"
    echo "║                    ██████╗ ███████╗███████╗██╗  ██╗              ║"
    echo "║                    ██╔══██╗██╔════╝██╔════╝██║ ██╔╝              ║"
    echo "║                    ██║  ██║█████╗  ███████╗█████╔╝               ║"
    echo "║                    ██║  ██║██╔══╝  ╚════██║██╔═██╗               ║"
    echo "║                    ██████╔╝███████╗███████║██║  ██╗              ║"
    echo "║                    ╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝              ║"
    echo "║                                                                  ║"
    echo "║              Console Manager v${VERSION} (Docker)                ║"
    echo "╚══════════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

print_success() { echo -e "${GREEN}✓${NC} $1"; log "SUCCESS: $1"; }
print_error() { echo -e "${RED}✗${NC} $1"; log "ERROR: $1"; }
print_warning() { echo -e "${YELLOW}!${NC} $1"; log "WARNING: $1"; }
print_info() { echo -e "${BLUE}ℹ${NC} $1"; log "INFO: $1"; }
print_step() { echo -e "${MAGENTA}▶${NC} $1"; log "STEP: $1"; }

usage() {
    sed -n '4,22p' "$0" | sed 's/^# \?//'
    cat <<'EOF'

Non-interactive rescue options:
  --rescue              Safe repair: permissions, restart containers, health checks
  --diagnose            Read-only diagnostics without interactive prompts
  --repair-permissions  Only repair Docker bind/volume permissions and SELinux context
  --help                Show this help
EOF
}

parse_cli_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --rescue)
                CLI_ACTION="rescue"
                NONINTERACTIVE=true
                shift
                ;;
            --diagnose|--diagnostics)
                CLI_ACTION="diagnose"
                NONINTERACTIVE=true
                shift
                ;;
            --repair-permissions)
                CLI_ACTION="repair-permissions"
                NONINTERACTIVE=true
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                print_error "Unknown option: $1"
                usage
                exit 1
                ;;
        esac
    done
}

press_enter() {
    if [ "$NONINTERACTIVE" = true ]; then
        return 0
    fi
    echo ""
    echo -e "${CYAN}Press Enter to continue...${NC}"
    read -r
}

confirm() {
    local prompt="${1:-Continue?}"
    echo -e "${YELLOW}${prompt} [y/N]${NC} "
    read -r response
    [[ "$response" =~ ^[TtYy]$ ]]
}

#===============================================================================
# Interactive TUI (arrow-key navigable menu) — pure bash, no dependencies
#===============================================================================
# Result of tui_select() is returned in the global TUI_RESULT.
TUI_RESULT=""

tui_available() {
    [ "${BETTERDESK_CLASSIC_MENU:-0}" = "1" ] && return 1
    [ -t 0 ] && [ -t 1 ] || return 1
    return 0
}

_tui_restore() { printf '\033[?25h' 2>/dev/null; stty echo 2>/dev/null; }

# tui_select "Title" "Subtitle" item1 item2 ...
# Each item may embed a description after a literal $'\t' (tab).
# Navigation: Up/Down or k/j to move, Enter/Right to choose, q/Esc/0 to cancel.
tui_select() {
    local title="$1"; shift
    local subtitle="$1"; shift
    local items=("$@")
    local count=${#items[@]}
    local sel=0 key rest

    if ! tui_available || [ "$count" -eq 0 ]; then
        TUI_RESULT=""
        return 1
    fi

    printf '\033[?25l'
    trap '_tui_restore' INT TERM

    clear
    while true; do
        # Build the whole frame in a single buffer, then emit it with one write
        # to avoid renderers (notably the VS Code integrated terminal with GPU
        # acceleration) dropping individual glyphs on full-screen redraws.
        local buf=""
        buf+="\033[H"
        buf+="${CYAN}${BOLD}+--------------------------------------------------------------+${NC}\033[K\n"
        buf+="$(printf "${CYAN}${BOLD}|${NC} ${WHITE}${BOLD}%-60s${NC} ${CYAN}${BOLD}|${NC}" "$title")\033[K\n"
        if [ -n "$subtitle" ]; then
            buf+="$(printf "${CYAN}${BOLD}|${NC} ${DIM}%-60s${NC} ${CYAN}${BOLD}|${NC}" "$subtitle")\033[K\n"
        fi
        buf+="${CYAN}${BOLD}+--------------------------------------------------------------+${NC}\033[K\n"
        buf+="\033[K\n"

        local i label desc pad line
        for i in "${!items[@]}"; do
            label="${items[$i]%%$'\t'*}"
            desc=""
            [[ "${items[$i]}" == *$'\t'* ]] && desc="${items[$i]#*$'\t'}"
            pad=$(( 32 - ${#label} ))
            [ "$pad" -lt 1 ] && pad=1
            if [ "$i" -eq "$sel" ]; then
                line="$(printf "  ${GREEN}${BOLD}>${NC} ${GREEN}${BOLD}%s${NC}%*s${DIM}%s${NC}" "$label" "$pad" "" "$desc")"
            else
                line="$(printf "    ${WHITE}%s${NC}%*s${DIM}%s${NC}" "$label" "$pad" "" "$desc")"
            fi
            buf+="${line}\033[K\n"
        done

        buf+="\033[K\n"
        buf+="  ${DIM}Up/Down navigate   Enter select   q/Esc back${NC}\033[K\n"
        buf+="\033[J"

        printf '%b' "$buf"

        IFS= read -rsn1 key 2>/dev/null
        if [[ "$key" == $'\033' ]]; then
            read -rsn2 -t 0.05 rest 2>/dev/null
            key+="$rest"
        fi

        case "$key" in
            $'\033[A'|'k') sel=$(( (sel - 1 + count) % count )) ;;
            $'\033[B'|'j') sel=$(( (sel + 1) % count )) ;;
            ''|$'\033[C') TUI_RESULT="$sel"; _tui_restore; trap - INT TERM; return 0 ;;
            'q'|'Q'|'0'|$'\033') TUI_RESULT=""; _tui_restore; trap - INT TERM; return 2 ;;
            [1-9])
                local idx=$(( key - 1 ))
                if [ "$idx" -lt "$count" ]; then
                    TUI_RESULT="$idx"; _tui_restore; trap - INT TERM; return 0
                fi
                ;;
        esac
    done
}

#===============================================================================
# Modern UI helpers shared by every sub-menu
#===============================================================================
ui_panel_header() {
    local title="$1" subtitle="$2"
    clear 2>/dev/null || true
    local buf=""
    buf+="${CYAN}${BOLD}+--------------------------------------------------------------+${NC}\n"
    buf+="$(printf "${CYAN}${BOLD}|${NC} ${WHITE}${BOLD}%-60s${NC} ${CYAN}${BOLD}|${NC}" "$title")\n"
    if [ -n "$subtitle" ]; then
        buf+="$(printf "${CYAN}${BOLD}|${NC} ${DIM}%-60s${NC} ${CYAN}${BOLD}|${NC}" "$subtitle")\n"
    fi
    buf+="${CYAN}${BOLD}+--------------------------------------------------------------+${NC}\n"
    printf '%b' "$buf"
    echo ""
}

# menu_choose "Title" "Subtitle"
# Caller pre-populates parallel arrays _menu_items (Label\tDescription) and
# _menu_returns. The chosen value lands in MENU_CHOICE; on cancel the last
# entry's value is returned. Arrow-key TUI when available, styled numeric else.
MENU_CHOICE=""
menu_choose() {
    local title="$1" subtitle="$2"
    MENU_CHOICE=""
    local last_idx=$(( ${#_menu_returns[@]} - 1 ))
    [ "$last_idx" -lt 0 ] && last_idx=0

    if tui_available; then
        tui_select "$title" "$subtitle" "${_menu_items[@]}"
        local rc=$?
        if [ "$rc" -eq 0 ] && [ -n "$TUI_RESULT" ]; then
            MENU_CHOICE="${_menu_returns[$TUI_RESULT]}"
        else
            MENU_CHOICE="${_menu_returns[$last_idx]}"
        fi
        return 0
    fi

    ui_panel_header "$title" "$subtitle"
    local i label desc
    for i in "${!_menu_items[@]}"; do
        label="${_menu_items[$i]%%$'\t'*}"
        desc=""
        [[ "${_menu_items[$i]}" == *$'\t'* ]] && desc="${_menu_items[$i]#*$'\t'}"
        printf "  ${GREEN}${BOLD}%2s${NC}) ${WHITE}%-28s${NC} ${DIM}%s${NC}\n" \
            "${_menu_returns[$i]}" "$label" "$desc"
    done
    echo ""
    echo -ne "  ${CYAN}Select option:${NC} "
    read -r MENU_CHOICE
}

get_public_ip() {
    local ip
    ip=$(curl -4 -s --max-time 5 ifconfig.me 2>/dev/null) && [ -n "$ip" ] && echo "$ip" && return
    ip=$(curl -4 -s --max-time 5 icanhazip.com 2>/dev/null) && [ -n "$ip" ] && echo "$ip" && return
    ip=$(curl -s --max-time 5 ifconfig.me 2>/dev/null) && [ -n "$ip" ] && echo "$ip" && return
    ip=$(curl -s --max-time 5 icanhazip.com 2>/dev/null) && [ -n "$ip" ] && echo "$ip" && return
    echo "127.0.0.1"
}

# Detect the host's primary LAN/private IPv4 address (for LAN-only deployments).
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

# Resolve the relay server address according to RELAY_MODE / RELAY_SERVERS.
# Prints the address to stdout; warnings/info go to stderr.
#   auto   - detect public IP (default)
#   local  - use the host's LAN IP (LAN-only deployments)
#   public - force public IP detection
# RELAY_SERVERS env var always overrides this with a fixed value.
resolve_relay_ip() {
    if [ -n "$RELAY_SERVERS" ]; then
        echo "Using fixed relay address (RELAY_SERVERS): $RELAY_SERVERS" >&2
        echo "$RELAY_SERVERS"
        return
    fi

    local ip
    case "${RELAY_MODE:-auto}" in
        local|lan)
            ip=$(get_local_ip)
            echo "Relay mode 'local': using LAN IP $ip (LAN-only deployment)" >&2
            ;;
        public|wan)
            ip=$(get_public_ip)
            echo "Relay mode 'public': using public IP $ip" >&2
            ;;
        auto|*)
            ip=$(get_public_ip)
            if [ "$ip" = "127.0.0.1" ] || [[ "$ip" == 10.* ]] || [[ "$ip" == 192.168.* ]] || [[ "$ip" == 172.1[6-9].* ]] || [[ "$ip" == 172.2[0-9].* ]] || [[ "$ip" == 172.3[0-1].* ]]; then
                echo "WARNING: Auto-detected private/loopback IP: $ip" >&2
                echo "WARNING: Remote (internet) clients will NOT connect via relay with this address." >&2
                echo "         For internet access set RELAY_SERVERS=YOUR.PUBLIC.IP, or for LAN-only" >&2
                echo "         deployments set RELAY_MODE=local to silence this warning." >&2
            fi
            ;;
    esac
    echo "$ip"
}

sql_escape_literal() {
    local value="$1"
    printf "%s" "${value//\'/\'\'}"
}

#===============================================================================
# Detection Functions
#===============================================================================

check_docker() {
    if ! command -v docker &> /dev/null; then
        return 1
    fi
    
    if ! docker info &> /dev/null; then
        return 2
    fi
    
    return 0
}

check_docker_compose() {
    if docker compose version &> /dev/null; then
        COMPOSE_CMD="docker compose"
        return 0
    elif docker-compose --version &> /dev/null; then
        COMPOSE_CMD="docker-compose"
        return 0
    fi
    return 1
}

# Auto-detect data directory
auto_detect_docker_paths() {
    local found=false
    
    # If DATA_DIR is already set (via env var), validate it
    if [ -n "$DATA_DIR" ]; then
        if [ -d "$DATA_DIR" ] && [ -f "$DATA_DIR/db_v2.sqlite3" ]; then
            print_info "Using configured data path: $DATA_DIR"
            found=true
        else
            print_warning "Configured DATA_DIR ($DATA_DIR) is invalid or empty"
            DATA_DIR=""
        fi
    fi
    
    # Auto-detect if not found
    if [ -z "$DATA_DIR" ]; then
        for path in "${COMMON_DATA_PATHS[@]}"; do
            if [ -d "$path" ] && [ -f "$path/db_v2.sqlite3" ]; then
                DATA_DIR="$path"
                print_success "Detected data directory: $DATA_DIR"
                found=true
                break
            fi
        done
    fi
    
    # If still not found, use default for new installations
    if [ -z "$DATA_DIR" ]; then
        DATA_DIR="/opt/betterdesk-data"
        print_info "No data found. Default path: $DATA_DIR"
    fi
    
    # Check docker-compose.yml
    if [ -n "$COMPOSE_FILE" ] && [ -f "$COMPOSE_FILE" ]; then
        print_info "Using compose file: $COMPOSE_FILE"
    else
        # Try to find docker-compose.yml
        if [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
            COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
        elif [ -f "./docker-compose.yml" ]; then
            COMPOSE_FILE="./docker-compose.yml"
        fi
    fi
    
    return 0
}

# Interactive path configuration for Docker
configure_docker_paths() {
    local subtitle="data: ${DATA_DIR:-unset} | backup: ${BACKUP_DIR:-unset}"
    local _menu_items=(
        $'Auto-detect data directory\tProbe for an existing deployment'
        $'Set data directory\tEnter the data path manually'
        $'Set backup directory\tEnter the backup path manually'
        $'Set docker-compose.yml path\tPoint at a specific compose file'
        $'Reset to defaults\tRestore the default paths'
        $'Back\tReturn to the main menu'
    )
    local _menu_returns=( 1 2 3 4 5 0 )
    menu_choose "Docker Path Configuration" "$subtitle"
    local choice="$MENU_CHOICE"
    
    case $choice in
        1)
            DATA_DIR=""
            auto_detect_docker_paths
            press_enter
            configure_docker_paths
            ;;
        2)
            echo ""
            echo -n "Enter data directory path (e.g., /opt/betterdesk-data): "
            read -r new_path
            if [ -n "$new_path" ]; then
                if [ -d "$new_path" ]; then
                    DATA_DIR="$new_path"
                    print_success "Data directory set to: $DATA_DIR"
                else
                    print_warning "Directory does not exist: $new_path"
                    if confirm "Create this directory?"; then
                        mkdir -p "$new_path"
                        DATA_DIR="$new_path"
                        print_success "Created and set data directory: $DATA_DIR"
                    fi
                fi
            fi
            press_enter
            configure_docker_paths
            ;;
        3)
            echo ""
            echo -n "Enter backup directory path: "
            read -r new_path
            if [ -n "$new_path" ]; then
                if [ -d "$new_path" ]; then
                    BACKUP_DIR="$new_path"
                    print_success "Backup directory set to: $BACKUP_DIR"
                else
                    print_warning "Directory does not exist: $new_path"
                    if confirm "Create this directory?"; then
                        mkdir -p "$new_path"
                        BACKUP_DIR="$new_path"
                        print_success "Created and set backup directory: $BACKUP_DIR"
                    fi
                fi
            fi
            press_enter
            configure_docker_paths
            ;;
        4)
            echo ""
            echo -n "Enter docker-compose.yml path: "
            read -r new_path
            if [ -n "$new_path" ]; then
                if [ -f "$new_path" ]; then
                    COMPOSE_FILE="$new_path"
                    print_success "Compose file set to: $COMPOSE_FILE"
                else
                    print_error "File does not exist: $new_path"
                fi
            fi
            press_enter
            configure_docker_paths
            ;;
        5)
            DATA_DIR="/opt/betterdesk-data"
            BACKUP_DIR="/opt/betterdesk-backups"
            COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
            print_success "Paths reset to defaults"
            press_enter
            configure_docker_paths
            ;;
        0|"")
            return
            ;;
        *)
            print_error "Invalid option"
            press_enter
            configure_docker_paths
            ;;
    esac
}

detect_installation() {
    INSTALL_STATUS="none"
    SERVER_RUNNING=false
    HBBS_RUNNING=false
    HBBR_RUNNING=false
    CONSOLE_RUNNING=false
    IMAGES_BUILT=false
    DATA_EXISTS=false
    
    # Check if images exist (new Go architecture: betterdesk-server + betterdesk-console)
    if docker images | grep -q "betterdesk-server\|betterdesk-console"; then
        IMAGES_BUILT=true
        INSTALL_STATUS="partial"
    fi
    
    # Check data directory
    if [ -d "$DATA_DIR" ]; then
        DATA_EXISTS=true
    fi
    
    # Check containers
    if docker ps --format '{{.Names}}' | grep -q "$SERVER_CONTAINER"; then
        SERVER_RUNNING=true
        HBBS_RUNNING=true   # Alias for legacy checks
        HBBR_RUNNING=true   # Go server includes relay
    fi
    
    if docker ps --format '{{.Names}}' | grep -q "$CONSOLE_CONTAINER"; then
        CONSOLE_RUNNING=true
    fi
    
    if [ "$IMAGES_BUILT" = true ] && [ "$DATA_EXISTS" = true ] && \
       [ "$SERVER_RUNNING" = true ] && [ "$CONSOLE_RUNNING" = true ]; then
        INSTALL_STATUS="complete"
    fi
}

print_status() {
    detect_installation
    
    echo ""
    echo -e "${WHITE}${BOLD}═══ Status Docker ═══${NC}"
    echo ""
    
    # Docker status
    if check_docker; then
        echo -e "  Docker:         ${GREEN}✓ Installed and running${NC}"
    else
        echo -e "  Docker:         ${RED}✗ Not running${NC}"
    fi
    
    if check_docker_compose; then
        echo -e "  Docker Compose: ${GREEN}✓ Available${NC}"
    else
        echo -e "  Docker Compose: ${RED}✗ Not found${NC}"
    fi
    
    echo ""
    echo -e "${WHITE}${BOLD}═══ Image Status ═══${NC}"
    echo ""
    
    for image in "betterdesk-server" "betterdesk-console"; do
        if docker images --format '{{.Repository}}' | grep -q "^$image$"; then
            local size=$(docker images --format '{{.Size}}' "$image:latest" 2>/dev/null)
            echo -e "  $image: ${GREEN}✓ Built${NC} ($size)"
        else
            echo -e "  $image: ${RED}✗ Not found${NC}"
        fi
    done
    
    echo ""
    echo -e "${WHITE}${BOLD}═══ Container Status ═══${NC}"
    echo ""
    
    if [ "$SERVER_RUNNING" = true ]; then
        echo -e "  Server (Go):    ${GREEN}● Running${NC}  (signal + relay + API)"
    else
        echo -e "  Server (Go):    ${RED}○ Stopped${NC}"
    fi
    
    if [ "$CONSOLE_RUNNING" = true ]; then
        echo -e "  Web Console:    ${GREEN}● Running${NC}"
    else
        echo -e "  Web Console:    ${RED}○ Stopped${NC}"
    fi
    
    echo ""
    echo -e "${WHITE}${BOLD}═══ Configured Paths ═══${NC}"
    echo ""
    echo -e "  Data directory:   ${CYAN}$DATA_DIR${NC}"
    echo -e "  Backup directory: ${CYAN}$BACKUP_DIR${NC}"
    echo -e "  Compose file:     ${CYAN}$COMPOSE_FILE${NC}"
    
    echo ""
    echo -e "${WHITE}${BOLD}═══ Data Status ═══${NC}"
    echo ""
    
    if [ "$DATA_EXISTS" = true ]; then
        echo -e "  Database: ${GREEN}✓ Found in $DATA_DIR${NC}"
    else
        echo -e "  Database: ${YELLOW}! Not found${NC}"
    fi
    
    echo ""
}

#===============================================================================
# Installation Functions
#===============================================================================

install_docker() {
    print_step "Installing Docker..."
    
    if command -v apt-get &> /dev/null; then
        apt-get update -qq
        apt-get install -y -qq docker.io docker-compose-plugin
    elif command -v dnf &> /dev/null; then
        dnf install -y -q docker docker-compose-plugin
    elif command -v yum &> /dev/null; then
        yum install -y -q docker docker-compose-plugin
    else
        print_error "Unsupported system. Install Docker manually."
        return 1
    fi
    
    systemctl enable docker
    systemctl start docker
    
    print_success "Docker installed"
}

choose_database_type() {
    if [ "$AUTO_MODE" = true ]; then
        if [ "$USE_POSTGRESQL" = true ]; then
            print_info "Using PostgreSQL (auto mode)"
            DB_TYPE="postgresql"
        else
            print_info "Using SQLite (auto mode default)"
            DB_TYPE="sqlite"
        fi
        return
    fi
    
    echo ""
    local _menu_items=(
        $'SQLite\tDefault, simple, no extra setup'
        $'PostgreSQL\tRecommended for production (Docker container)'
    )
    local _menu_returns=( 1 2 )
    menu_choose "Select Database Type" "SQLite is recommended for most installs"
    local db_choice="$MENU_CHOICE"
    
    case "$db_choice" in
        2)
            DB_TYPE="postgresql"
            print_info "PostgreSQL selected"
            
            # Get PostgreSQL credentials
            echo ""
            read -p "PostgreSQL password for 'betterdesk' user [betterdesk123]: " pg_pass
            POSTGRESQL_PASS="${pg_pass:-betterdesk123}"
            ;;
        *)
            DB_TYPE="sqlite"
            print_info "SQLite selected"
            ;;
    esac
}

preserve_compose_database_config() {
    # Keep existing database mode/credentials when regenerating compose file
    # during update/repair so we do not accidentally switch backends.
    DB_TYPE="sqlite"

    if [ -f "$COMPOSE_FILE" ]; then
        if grep -qE '^\s*-\s*DB_TYPE=postgresql|^\s*POSTGRES_USER:' "$COMPOSE_FILE"; then
            DB_TYPE="postgresql"

            local detected_user detected_pass detected_db detected_uri
            detected_user=$(grep -E '^\s*POSTGRES_USER:' "$COMPOSE_FILE" | head -1 | sed -E 's/^\s*POSTGRES_USER:\s*//')
            detected_pass=$(grep -E '^\s*POSTGRES_PASSWORD:' "$COMPOSE_FILE" | head -1 | sed -E 's/^\s*POSTGRES_PASSWORD:\s*//')
            detected_db=$(grep -E '^\s*POSTGRES_DB:' "$COMPOSE_FILE" | head -1 | sed -E 's/^\s*POSTGRES_DB:\s*//')
            detected_uri=$(grep -E '^\s*-\s*DATABASE_URL=postgres' "$COMPOSE_FILE" | head -1 | sed -E 's/^\s*-\s*DATABASE_URL=//')

            [ -n "$detected_user" ] && POSTGRESQL_USER="$detected_user"
            [ -n "$detected_pass" ] && POSTGRESQL_PASS="$detected_pass"
            [ -n "$detected_db" ] && POSTGRESQL_DB="$detected_db"
            [ -n "$detected_uri" ] && POSTGRESQL_URI="$detected_uri"
        fi
    elif [ "$USE_POSTGRESQL" = "true" ]; then
        DB_TYPE="postgresql"
    fi

    if [ "$DB_TYPE" = "postgresql" ]; then
        print_info "Preserved database mode: PostgreSQL"
    else
        print_info "Preserved database mode: SQLite"
    fi
}

create_compose_file() {
        print_step "Creating docker-compose.yml..."

        # Start composing docker-compose.yml
        cat > "$COMPOSE_FILE" << EOF
version: '3.8'

services:
EOF

        # Add PostgreSQL service if selected
        if [ "$DB_TYPE" = "postgresql" ]; then
                cat >> "$COMPOSE_FILE" << EOF
    postgres:
        container_name: betterdesk-postgres
        image: postgres:16-alpine
        environment:
            POSTGRES_USER: $POSTGRESQL_USER
            POSTGRES_PASSWORD: $POSTGRESQL_PASS
            POSTGRES_DB: $POSTGRESQL_DB
        volumes:
            - postgres_data:/var/lib/postgresql/data
        healthcheck:
            test: ["CMD-SHELL", "pg_isready -U $POSTGRESQL_USER -d $POSTGRESQL_DB"]
            interval: 10s
            timeout: 5s
            retries: 5
        restart: unless-stopped
        networks:
            - betterdesk

EOF
        fi

        # Generate or preserve shared API key for Node.js <-> Go server communication
        local api_key
        if [ -f "$DATA_DIR/.api_key" ] && [ -s "$DATA_DIR/.api_key" ]; then
            api_key=$(cat "$DATA_DIR/.api_key")
            print_info "Preserved existing API key"
        else
            api_key=$(openssl rand -hex 32)
            echo "$api_key" > "$DATA_DIR/.api_key"
            chmod 600 "$DATA_DIR/.api_key"
            print_info "Generated API key for console <-> server communication"
        fi

        # Generate or preserve admin password (shared between Go server and Node.js console)
        local admin_password
        if [ -f "$DATA_DIR/.admin_credentials" ] && [ -s "$DATA_DIR/.admin_credentials" ]; then
            # Support both old format (admin:pass) and new format (Admin Password: pass)
            admin_password=$(grep -m1 '^Admin Password:' "$DATA_DIR/.admin_credentials" 2>/dev/null | sed 's/^Admin Password:[[:space:]]*//')
            if [ -z "$admin_password" ]; then
                admin_password=$(cut -d: -f2 "$DATA_DIR/.admin_credentials" 2>/dev/null)
            fi
        fi
        if [ -z "$admin_password" ]; then
            # Respect user-provided ADMIN_PASSWORD env var if set
            if [ -n "$ADMIN_PASSWORD" ]; then
                admin_password="$ADMIN_PASSWORD"
                print_info "Using custom admin password from ADMIN_PASSWORD env var"
            else
                # SECURITY (audit fix M-05, 2026-04-10): full hex entropy
                admin_password=$(openssl rand -hex 16)
            fi
            # Only clean auth.db on FRESH install (no existing credentials)
            if docker volume inspect "${PROJECT_NAME:-betterdesk}_console_data" >/dev/null 2>&1; then
                print_info "Cleaning old auth database from console_data volume..."
                docker run --rm -v "${PROJECT_NAME:-betterdesk}_console_data:/data" alpine \
                        sh -c "rm -f /data/auth.db /data/auth.db-wal /data/auth.db-shm" 2>/dev/null || true
            fi
        else
            print_info "Preserved existing admin password"
        fi
        DOCKER_ADMIN_PASSWORD="$admin_password"

        # Get relay server address according to RELAY_MODE / RELAY_SERVERS
        local server_ip
        server_ip=$(resolve_relay_ip)

        local signal_rate_limit="${SIGNAL_RATE_LIMIT_PER_IP:-20}"
        if ! [[ "$signal_rate_limit" =~ ^[0-9]+$ ]]; then
            print_warning "Invalid SIGNAL_RATE_LIMIT_PER_IP='$signal_rate_limit'; using 20"
            signal_rate_limit="20"
        fi

        # Add BetterDesk server (Go single binary - signal + relay + API)
        cat >> "$COMPOSE_FILE" << EOF
    server:
        container_name: $SERVER_CONTAINER
        build:
            context: .
            dockerfile: Dockerfile.server
        pull_policy: never
        command: ["/usr/local/bin/betterdesk-server", "-mode", "all", "-api-port", "21121", "-key-file", "/opt/rustdesk/id_ed25519"]
        ports:
            - "21121:21121"
            - "21115:21115"
            - "21116:21116"
            - "21116:21116/udp"
            - "21117:21117"
            - "21118:21118"
            - "21119:21119"
        volumes:
            - $DATA_DIR:/opt/rustdesk
EOF

        if [ "$DB_TYPE" != "postgresql" ]; then
                cat >> "$COMPOSE_FILE" << EOF
            - console_data:/app/data:ro
EOF
        fi

        cat >> "$COMPOSE_FILE" << EOF
        environment:
            - RELAY_SERVERS=$server_ip
            - INIT_ADMIN_PASS=$admin_password
            - SIGNAL_RATE_LIMIT_PER_IP=$signal_rate_limit
EOF

        if [ "$DB_TYPE" != "postgresql" ]; then
                cat >> "$COMPOSE_FILE" << EOF
            - AUTH_DB_PATH=/app/data/auth.db
EOF
        fi

        if [ "$DB_TYPE" = "postgresql" ]; then
                cat >> "$COMPOSE_FILE" << EOF
            - DB_URL=postgres://$POSTGRESQL_USER:$POSTGRESQL_PASS@postgres:5432/$POSTGRESQL_DB?sslmode=disable
        depends_on:
            postgres:
                condition: service_healthy
EOF
        fi

        cat >> "$COMPOSE_FILE" << EOF
        healthcheck:
            test: ["CMD", "curl", "-sf", "http://localhost:21121/api/health"]
            interval: 30s
            timeout: 10s
            retries: 3
            start_period: 15s
        restart: unless-stopped
        networks:
            - betterdesk

    console:
        container_name: $CONSOLE_CONTAINER
        build:
            context: .
            dockerfile: Dockerfile.console
        pull_policy: never
        ports:
            - "5000:5000"
        volumes:
            - $DATA_DIR:/opt/rustdesk:ro
            - console_data:/app/data
        environment:
            - NODE_ENV=production
            - PORT=5000
            - HOST=0.0.0.0
            - API_HOST=0.0.0.0
            - API_ENABLED=false
            - RUSTDESK_PATH=/opt/rustdesk
            - HBBS_API_URL=http://$SERVER_CONTAINER:21121/api
            - BETTERDESK_API_URL=http://$SERVER_CONTAINER:21121/api
            - SERVER_BACKEND=betterdesk
            - DATA_DIR=/app/data
            - DB_PATH=/opt/rustdesk/db_v2.sqlite3
            - PUB_KEY_PATH=/opt/rustdesk/id_ed25519.pub
            - API_KEY_PATH=/opt/rustdesk/.api_key
            - KEYS_PATH=/opt/rustdesk
            - DEFAULT_ADMIN_PASSWORD=$admin_password
            - FORCE_PASSWORD_UPDATE=true
            - WS_HBBS_HOST=$SERVER_CONTAINER
            - WS_HBBS_PORT=21116
            - WS_HBBR_HOST=$SERVER_CONTAINER
            - WS_HBBR_PORT=21117
            - DOCKER=true
EOF

        if [ "$DB_TYPE" = "postgresql" ]; then
                cat >> "$COMPOSE_FILE" << EOF
            - DB_TYPE=postgresql
            - DATABASE_URL=postgres://$POSTGRESQL_USER:$POSTGRESQL_PASS@postgres:5432/$POSTGRESQL_DB?sslmode=disable
        depends_on:
            postgres:
                condition: service_healthy
            server:
                condition: service_healthy
EOF
        else
                cat >> "$COMPOSE_FILE" << EOF
        depends_on:
            server:
                condition: service_started
EOF
        fi

        cat >> "$COMPOSE_FILE" << EOF
        healthcheck:
            test: ["CMD", "curl", "-sf", "http://localhost:5000/health"]
            interval: 30s
            timeout: 10s
            retries: 3
            start_period: 30s
        restart: unless-stopped
        networks:
            - betterdesk

networks:
    betterdesk:
        driver: bridge
EOF

        # Add volumes
        if [ "$DB_TYPE" = "postgresql" ]; then
                cat >> "$COMPOSE_FILE" << EOF

volumes:
    console_data:
    postgres_data:
EOF
        else
                cat >> "$COMPOSE_FILE" << EOF

volumes:
    console_data:
EOF
        fi

        print_success "docker-compose.yml created"
}

build_images() {
    print_step "Building Docker images..."
    
    cd "$SCRIPT_DIR"
    
    $COMPOSE_CMD build --no-cache
    
    print_success "Images built"
}

start_containers() {
    print_step "Starting containers..."
    
    cd "$SCRIPT_DIR"
    
    $COMPOSE_CMD up -d
    
    sleep 5
    
    # Inject shared API key into Go server database for Node.js <-> Go communication
    local api_key_file="$DATA_DIR/.api_key"
    if [ -f "$api_key_file" ]; then
        local api_key
        api_key=$(cat "$api_key_file")
        local api_key_sql
        api_key_sql=$(sql_escape_literal "$api_key")
        # Use sqlite3 inside the server container to insert the API key
        docker exec "$SERVER_CONTAINER" sh -c "
            if command -v sqlite3 >/dev/null 2>&1; then
                sqlite3 /opt/rustdesk/db_v2.sqlite3 \"INSERT OR REPLACE INTO server_config (key, value) VALUES ('api_key', '$api_key_sql');\" 2>/dev/null
            fi
        " 2>/dev/null || true
        # Also try from host if sqlite3 is available
        if [ -f "$DATA_DIR/db_v2.sqlite3" ] && command -v sqlite3 &>/dev/null; then
            sqlite3 "$DATA_DIR/db_v2.sqlite3" "INSERT OR REPLACE INTO server_config (key, value) VALUES ('api_key', '$api_key_sql');" 2>/dev/null || true
        fi
        print_info "API key synced to Go server database"
    fi
    
    detect_installation
    
    if [ "$SERVER_RUNNING" = true ] && [ "$CONSOLE_RUNNING" = true ]; then
        print_success "All containers running"
    else
        print_warning "Some containers might not be working properly"
    fi
}

stop_containers() {
    print_step "Stopping containers..."
    
    cd "$SCRIPT_DIR"
    
    $COMPOSE_CMD down 2>/dev/null || true
    
    print_success "Containers stopped"
}

create_admin_user() {
    print_step "Creating admin user..."
    
    # Use the password generated during compose file creation
    local admin_password="${DOCKER_ADMIN_PASSWORD}"
    if [ -z "$admin_password" ]; then
        # M-05: full hex entropy
        admin_password=$(openssl rand -hex 16)
    fi
    
    # Wait for database to be created
    sleep 3
    
    # Node.js console auto-creates admin user on startup if no users exist
    # We use the reset-password script to set a secure password
    # Arguments: <password> [username] — password first, then optional username
    docker exec "$CONSOLE_CONTAINER" node /app/scripts/reset-password.js "$admin_password" admin 2>/dev/null || {
        # If script fails, try via environment variable approach
        print_info "Setting admin password via API..."
        
        # The console will create admin:admin by default on first run
        # We need to change it to a secure random password
        sleep 2
        
        # Use curl to change password (requires internal API)
        # If this fails, admin will use default password which must be changed
        docker exec "$CONSOLE_CONTAINER" sh -c "
            if [ -f /app/scripts/reset-password.js ]; then
                node /app/scripts/reset-password.js '$admin_password' admin 2>/dev/null
            fi
        " 2>/dev/null || true
    }

    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║            PANEL LOGIN CREDENTIALS                     ║${NC}"
    echo -e "${GREEN}╠════════════════════════════════════════════════════════╣${NC}"
    echo -e "${GREEN}║  Login:    ${WHITE}admin${GREEN}                                     ║${NC}"
    echo -e "${GREEN}║  Password: ${WHITE}${admin_password}${GREEN}                         ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}"
    echo ""
    
    # Save credentials
    mkdir -p "$DATA_DIR"
    if [ "$STORE_ADMIN_CREDENTIALS" = "true" ]; then
        cat > "$DATA_DIR/.admin_credentials" << CREDEOF
Admin Username: admin
Admin Password: $admin_password
Generated by: BetterDesk Docker installer
Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)
CREDEOF
        chmod 600 "$DATA_DIR/.admin_credentials"
        print_info "Credentials saved in: $DATA_DIR/.admin_credentials"
    else
        print_warning "Credentials are not persisted by default (security hardening)."
    fi
}

do_install() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ FRESH DOCKER INSTALLATION ══════════${NC}"
    echo ""
    
    # Check Docker
    if ! check_docker; then
        print_warning "Docker is not installed or not running"
        if confirm "Do you want to install Docker?"; then
            install_docker
        else
            press_enter
            return
        fi
    fi
    
    if ! check_docker_compose; then
        print_error "Docker Compose is not available!"
        press_enter
        return
    fi
    
    detect_installation
    
    if [ "$INSTALL_STATUS" = "complete" ]; then
        print_warning "BetterDesk Docker is already installed!"
        if ! confirm "Do you want to reinstall?"; then
            return
        fi
        do_backup_silent
        stop_containers
    fi
    
    # Choose database type (SQLite or PostgreSQL)
    choose_database_type
    
    # Create data directory with proper permissions (handles SELinux)
    print_step "Creating data directories..."
    create_data_directory "$DATA_DIR" || {
        print_error "Failed to create data directory: $DATA_DIR"
        print_info "If you're on SELinux-enabled system (AlmaLinux, RHEL, CentOS):"
        print_info "  sudo setenforce 0  # Temporarily disable"
        print_info "  # Or: sudo chcon -Rt svirt_sandbox_file_t $DATA_DIR"
        press_enter
        return
    }
    create_data_directory "$BACKUP_DIR" || true
    
    # Always recreate compose file to include database configuration
    create_compose_file
    
    build_images
    start_containers
    create_admin_user

    # Configure firewall rules
    print_step "Configuring firewall rules..."
    configure_firewall_rules

    echo ""
    print_success "Docker installation completed successfully!"
    echo ""
    
    local server_ip
    server_ip=$(get_public_ip)
    local public_key=""
    if [ -f "$DATA_DIR/id_ed25519.pub" ]; then
        public_key=$(cat "$DATA_DIR/id_ed25519.pub" 2>/dev/null)
    fi

    local db_type_info="SQLite"
    if [ "$DB_TYPE" = "postgresql" ]; then
        db_type_info="PostgreSQL (Docker container)"
    fi
    
    echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║              INSTALLATION INFO                             ║${NC}"
    echo -e "${CYAN}╠════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${CYAN}║  Web Panel:     ${WHITE}http://$server_ip:5000${NC}"
    echo -e "${CYAN}║  Server ID:     ${WHITE}$server_ip${NC}"
    echo -e "${CYAN}║  Database:      ${WHITE}$db_type_info${NC}"
    echo -e "${CYAN}║  Data:          ${WHITE}$DATA_DIR${NC}"
    if [ -n "$public_key" ]; then
    echo -e "${CYAN}║  Key:           ${WHITE}${public_key:0:20}...${NC}"
    fi
    echo -e "${CYAN}╠════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${CYAN}║  ${WHITE}Required ports: 21115-21117 (TCP+UDP), 5000, 21121${NC}"
    echo -e "${CYAN}╠════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${CYAN}║  ${YELLOW}RustDesk Client configuration:${NC}"
    echo -e "${CYAN}║    ID Server:    ${WHITE}$server_ip${NC}"
    echo -e "${CYAN}║    Relay Server: ${WHITE}$server_ip${NC}"
    echo -e "${CYAN}║    Key:          ${WHITE}${public_key:-<generated on first start>}${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
    
    # Offer HTTPS Enterprise configuration for fresh installs
    echo ""
    print_info "🔒 Enterprise TLS enables full HTTPS on ALL ports (panel, signal, relay, API)"
    print_info "   Recommended for production. Requires RustDesk client >= 1.3.x"
    echo ""
    if confirm "Would you like to configure HTTPS Enterprise now? (Option 5 in SSL menu)"; then
        do_configure_ssl
    fi
    
    press_enter
}

#===============================================================================
# Update Functions
#===============================================================================

# GitHub repository configuration for online updates
UPDATE_GITHUB_OWNER="${UPDATE_GITHUB_OWNER:-UNITRONIX}"
UPDATE_GITHUB_REPO="${UPDATE_GITHUB_REPO:-BetterDesk}"
UPDATE_GITHUB_BRANCH="${UPDATE_GITHUB_BRANCH:-main}"

docker_update_env_file() {
    if [ -f "$SCRIPT_DIR/web-nodejs/.env" ]; then
        echo "$SCRIPT_DIR/web-nodejs/.env"
    elif [ -f "$SCRIPT_DIR/.env" ]; then
        echo "$SCRIPT_DIR/.env"
    else
        echo "$SCRIPT_DIR/web-nodejs/.env"
    fi
}

read_update_github_branch_from_env() {
    local env_file
    env_file=$(docker_update_env_file)
    if [ -f "$env_file" ]; then
        local val
        val=$(grep -E '^UPDATE_GITHUB_BRANCH=' "$env_file" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r"')
        if [ -n "$val" ]; then
            UPDATE_GITHUB_BRANCH="$val"
            export UPDATE_GITHUB_BRANCH
        fi
    fi
}

write_update_github_branch_to_env() {
    local branch="$1"
    local env_file
    env_file=$(docker_update_env_file)
    local env_dir
    env_dir=$(dirname "$env_file")
    mkdir -p "$env_dir"
    if [ ! -f "$env_file" ]; then
        touch "$env_file"
    fi
    if grep -qE '^UPDATE_GITHUB_BRANCH=' "$env_file" 2>/dev/null; then
        sed -i "s/^UPDATE_GITHUB_BRANCH=.*/UPDATE_GITHUB_BRANCH=${branch}/" "$env_file"
    else
        printf '\nUPDATE_GITHUB_BRANCH=%s\n' "$branch" >> "$env_file"
    fi
    UPDATE_GITHUB_BRANCH="$branch"
    export UPDATE_GITHUB_BRANCH
    print_success "Update channel saved (GitHub branch: $branch)"
}

switch_update_channel() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ UPDATE CHANNEL ══════════${NC}"
    echo ""
    detect_installation
    if [ "$INSTALL_STATUS" = "none" ]; then
        print_error "BetterDesk Docker is not installed!"
        press_enter
        return
    fi
    read_update_github_branch_from_env
    print_info "Current GitHub branch: $UPDATE_GITHUB_BRANCH"
    echo ""
    local _menu_items=(
        $'Stable (main)\tProduction releases from the main branch'
        $'Development (dev)\tLatest work-in-progress from the dev branch'
        $'Back\tReturn without changes'
    )
    local _menu_returns=( main dev 0 )
    menu_choose "Update Channel" "Stable is recommended for production deployments"
    case "${MENU_CHOICE:-main}" in
        0) return ;;
        dev)
            print_warning "Development channel may include unstable changes."
            write_update_github_branch_to_env "dev"
            ;;
        *)
            write_update_github_branch_to_env "main"
            ;;
    esac
    print_info "Use Online update from GitHub to pull from the selected branch."
    press_enter
}

# Pull latest project files from GitHub before rebuilding Docker images.
# This ensures the Dockerfiles, compose files, and source code (Go server,
# Node.js console) are up-to-date before docker compose build.
update_docker_from_github() {
    local clone_dir="/tmp/betterdesk-docker-update-$$"
    rm -rf "$clone_dir"

    read_update_github_branch_from_env

    print_step "Downloading latest BetterDesk from GitHub..."
    if command -v git &>/dev/null; then
        local repo_url="https://github.com/${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO}.git"
        if ! git clone --depth 1 --single-branch --branch "$UPDATE_GITHUB_BRANCH" "$repo_url" "$clone_dir" 2>/dev/null; then
            print_error "git clone failed"
            rm -rf "$clone_dir"
            return 1
        fi
        print_success "Repository cloned (branch: $UPDATE_GITHUB_BRANCH)"
    else
        local tarball_url="https://github.com/${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO}/archive/refs/heads/${UPDATE_GITHUB_BRANCH}.tar.gz"
        local tarball_path="/tmp/betterdesk-docker-update-$$.tar.gz"
        print_info "git not available, downloading tarball..."
        if ! curl -fsSL --connect-timeout 15 --max-time 120 -o "$tarball_path" "$tarball_url"; then
            print_error "Download failed. Check internet connection."
            rm -f "$tarball_path"
            return 1
        fi
        mkdir -p "$clone_dir"
        if ! tar -xzf "$tarball_path" -C "$clone_dir" --strip-components=1; then
            print_error "Failed to extract update archive"
            rm -f "$tarball_path" && rm -rf "$clone_dir"
            return 1
        fi
        rm -f "$tarball_path"
        print_success "Source downloaded and extracted"
    fi

    # Validate
    if [ ! -f "$clone_dir/betterdesk-server/go.mod" ] || [ ! -f "$clone_dir/web-nodejs/server.js" ]; then
        print_error "Downloaded source is incomplete or invalid"
        rm -rf "$clone_dir"
        return 1
    fi

    local remote_version=""
    if [ -f "$clone_dir/VERSION" ]; then
        remote_version=$(cat "$clone_dir/VERSION" | tr -d '[:space:]')
        print_info "Remote version: $remote_version"
    fi

    # Update project files that Docker build needs
    print_step "Updating project files..."
    local files_updated=0

    # Update Go server source
    if [ -d "$SCRIPT_DIR/betterdesk-server" ]; then
        rm -rf "$SCRIPT_DIR/betterdesk-server.pre-update" 2>/dev/null || true
        mv "$SCRIPT_DIR/betterdesk-server" "$SCRIPT_DIR/betterdesk-server.pre-update" 2>/dev/null || true
    fi
    # Copy *contents* into a guaranteed dir. Copying the directory itself would
    # nest the new tree inside an existing betterdesk-server/ if the rename
    # above failed (e.g. a locked file), leaving inconsistent source that breaks
    # the Docker build with "undefined" Go errors (issue #158).
    mkdir -p "$SCRIPT_DIR/betterdesk-server"
    cp -rf "$clone_dir/betterdesk-server/." "$SCRIPT_DIR/betterdesk-server/"
    files_updated=$((files_updated + 1))

    # Update Node.js console source
    if [ -d "$SCRIPT_DIR/web-nodejs" ]; then
        # Preserve data/ and node_modules/ if they exist locally
        local preserve_dirs=("data" "node_modules")
        for pd in "${preserve_dirs[@]}"; do
            if [ -d "$SCRIPT_DIR/web-nodejs/$pd" ]; then
                mv "$SCRIPT_DIR/web-nodejs/$pd" "/tmp/betterdesk-docker-preserve-$$-$pd" 2>/dev/null || true
            fi
        done
        rm -rf "$SCRIPT_DIR/web-nodejs.pre-update" 2>/dev/null || true
        mv "$SCRIPT_DIR/web-nodejs" "$SCRIPT_DIR/web-nodejs.pre-update" 2>/dev/null || true
    fi
    # Copy *contents* into a guaranteed dir (see issue #158 note above).
    mkdir -p "$SCRIPT_DIR/web-nodejs"
    cp -rf "$clone_dir/web-nodejs/." "$SCRIPT_DIR/web-nodejs/"
    # Restore preserved directories
    for pd in "${preserve_dirs[@]}"; do
        if [ -d "/tmp/betterdesk-docker-preserve-$$-$pd" ]; then
            mv "/tmp/betterdesk-docker-preserve-$$-$pd" "$SCRIPT_DIR/web-nodejs/$pd" 2>/dev/null || true
        fi
    done
    rm -rf "$SCRIPT_DIR/web-nodejs.pre-update" 2>/dev/null || true
    rm -rf "$SCRIPT_DIR/betterdesk-server.pre-update" 2>/dev/null || true
    files_updated=$((files_updated + 1))

    # Update Dockerfiles and compose files
    for df in Dockerfile Dockerfile.server Dockerfile.console \
              docker-compose.yml docker-compose.single.yml docker-compose.quick.yml \
              docker/entrypoint.sh docker/supervisord.conf docker/server-entrypoint.sh docker/console-entrypoint.sh \
              betterdesk-docker.sh betterdesk.sh betterdesk.ps1 VERSION; do
        if [ -f "$clone_dir/$df" ]; then
            mkdir -p "$(dirname "$SCRIPT_DIR/$df")"
            cp "$clone_dir/$df" "$SCRIPT_DIR/$df"
            if [[ "$df" == *.sh ]]; then chmod +x "$SCRIPT_DIR/$df" 2>/dev/null || true; fi
            files_updated=$((files_updated + 1))
        fi
    done

    print_success "$files_updated project components updated from GitHub"

    # ---- Update SHA tracking for in-app updater (#192) ----
    LAST_UPDATE_REMOTE_SHA=""
    if command -v git &>/dev/null && [ -d "$clone_dir/.git" ]; then
        LAST_UPDATE_REMOTE_SHA=$(git -C "$clone_dir" rev-parse HEAD 2>/dev/null || true)
        if [ -n "$LAST_UPDATE_REMOTE_SHA" ]; then
            mkdir -p "$SCRIPT_DIR/web-nodejs/data"
            echo "$LAST_UPDATE_REMOTE_SHA" > "$SCRIPT_DIR/web-nodejs/data/.update_sha"
            echo "$LAST_UPDATE_REMOTE_SHA" > "$SCRIPT_DIR/web-nodejs/data/.agent_source_sha"
            rm -f "$SCRIPT_DIR/web-nodejs/data/.last_update_result.json"
            print_info "SHA tracking updated: ${LAST_UPDATE_REMOTE_SHA:0:7}"
        fi
    fi

    rm -rf "$clone_dir"
    return 0
}

# Push SHA baseline into the running console volume after container rebuild (#192).
sync_console_update_tracking_in_container() {
    local remote_sha="${1:-}"
    [ -n "$remote_sha" ] || return 0
    if ! docker ps --format '{{.Names}}' | grep -q "^${CONSOLE_CONTAINER}$"; then
        return 0
    fi
    docker exec "$CONSOLE_CONTAINER" sh -c \
        "mkdir -p /app/data && printf '%s\n' '$remote_sha' > /app/data/.update_sha && rm -f /app/data/.last_update_result.json" \
        2>/dev/null || true
}

do_update() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ DOCKER UPDATE ══════════${NC}"
    echo ""
    
    detect_installation
    
    if [ "$INSTALL_STATUS" = "none" ]; then
        print_error "BetterDesk Docker is not installed!"
        print_info "Use 'Fresh Installation' option"
        press_enter
        return
    fi
    
    local _menu_items=(
        $'Online update from GitHub\tDownload latest code + rebuild images'
        $'Local rebuild\tRebuild images from current local files'
        $'Switch update channel\tChoose stable (main) or development (dev) branch'
        $'Back\tReturn to the main menu'
    )
    local _menu_returns=( 1 2 3 0 )
    menu_choose "Update Method" "Online GitHub update is recommended"
    local update_method="${MENU_CHOICE:-1}"

    case "$update_method" in
        0) return ;;
        3)
            switch_update_channel
            return
            ;;
        2)
            # Legacy local rebuild
            print_info "Creating backup before update..."
            do_backup_silent
            preserve_compose_database_config
            create_compose_file
            stop_containers
            build_images
            start_containers
            print_success "Local update completed!"
            press_enter
            return
            ;;
    esac

    # ---- GitHub Pull + Docker Rebuild ----
    print_info "Creating backup before update..."
    do_backup_silent

    if ! update_docker_from_github; then
        print_error "GitHub download failed. Try option 2 (local rebuild) instead."
        press_enter
        return
    fi

    preserve_compose_database_config
    print_info "Regenerating docker-compose.yml with latest template..."
    create_compose_file
    
    stop_containers
    build_images
    start_containers
    sync_console_update_tracking_in_container "${LAST_UPDATE_REMOTE_SHA:-}"
    
    print_success "Docker update completed!"
    press_enter
}

#===============================================================================
# Repair Functions
#===============================================================================

do_repair() {
    detect_installation
    
    local _menu_items=(
        $'Rebuild images\tRecreate the Docker images'
        $'Restart containers\tStop and start the stack'
        $'Repair database\tRun database repair routines'
        $'Repair permissions\tFix Docker bind/volume ownership and SELinux context'
        $'Clean Docker\tPrune images and volumes'
        $'Full repair\tDo everything above'
        $'Back\tReturn to the main menu'
    )
    local _menu_returns=( 1 2 3 4 5 6 0 )
    menu_choose "Docker Repair" "Choose what to repair"
    local repair_choice="$MENU_CHOICE"
    
    case $repair_choice in
        1) 
            preserve_compose_database_config
            create_compose_file
            stop_containers
            build_images
            start_containers
            ;;
        2)
            stop_containers
            start_containers
            ;;
        3)
            repair_database_docker
            ;;
        4)
            repair_docker_permissions
            ;;
        5)
            if confirm "Are you sure you want to clean up unused Docker resources?"; then
                docker system prune -f
                print_success "Docker cleaned"
            fi
            ;;
        6)
            preserve_compose_database_config
            create_compose_file
            stop_containers
            docker system prune -f
            build_images
            start_containers
            repair_database_docker
            repair_docker_permissions
            print_success "Full repair completed!"
            ;;
        0) return ;;
    esac
    
    press_enter
}

repair_database_docker() {
    print_step "Repair database..."
    
    # Node.js console auto-initializes tables on startup.
    # Restarting the console container triggers full table check.
    docker restart "$CONSOLE_CONTAINER" 2>/dev/null || {
        print_warning "Console container is not running"
        return
    }
    
    sleep 5
    
    # Verify via health endpoint
    if docker exec "$CONSOLE_CONTAINER" curl -sf http://localhost:5000/health >/dev/null 2>&1; then
        print_success "Database repaired (console restarted, tables verified)"
    else
        print_warning "Console restarted but health check failed"
    fi
}

repair_named_volume_permissions() {
    local volume="$1"
    [ -n "$volume" ] || return 0

    if ! docker volume inspect "$volume" >/dev/null 2>&1; then
        return 0
    fi

    print_info "Repairing Docker volume permissions: $volume"
    docker run --rm -v "$volume:/target" alpine:3.20 sh -c '
        set -e
        mkdir -p /target
        chown -R 10001:10001 /target
        chmod -R u+rwX,g+rwX /target
    ' >/dev/null 2>&1 || {
        print_warning "Could not repair volume $volume (Docker may need to pull alpine:3.20)"
        return 1
    }
}

repair_docker_permissions() {
    print_step "Repairing Docker data permissions..."

    auto_detect_docker_paths

    if [ -n "$DATA_DIR" ]; then
        create_data_directory "$DATA_DIR" || {
            print_error "Failed to repair data directory: $DATA_DIR"
            return 1
        }

        # Containers drop to uid/gid 10001. Keep secrets readable to the
        # container user without making them world-readable.
        chown -R 10001:10001 "$DATA_DIR" 2>/dev/null || true
        chmod 755 "$DATA_DIR" 2>/dev/null || true
        for secret in ".api_key" ".admin_credentials" "id_ed25519"; do
            if [ -f "$DATA_DIR/$secret" ]; then
                chmod 600 "$DATA_DIR/$secret" 2>/dev/null || true
            fi
        done
        if [ -f "$DATA_DIR/id_ed25519.pub" ]; then
            chmod 644 "$DATA_DIR/id_ed25519.pub" 2>/dev/null || true
        fi
        print_success "Host data directory permissions repaired: $DATA_DIR"
    fi

    local repaired_volumes=0
    local volume
    while IFS= read -r volume; do
        [ -n "$volume" ] || continue
        if repair_named_volume_permissions "$volume"; then
            repaired_volumes=$((repaired_volumes + 1))
        fi
    done < <(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E '(^|_)(betterdesk-data|console-data|console_data|betterdesk.*data)$' || true)

    if [ "$repaired_volumes" -gt 0 ]; then
        print_success "Repaired $repaired_volumes Docker volume(s)"
    else
        print_info "No BetterDesk named Docker volumes found to repair"
    fi
}

run_compose_safe() {
    local action="$1"
    local compose_dir compose_name

    if [ ! -f "$COMPOSE_FILE" ]; then
        print_warning "Compose file not found: $COMPOSE_FILE"
        return 1
    fi

    compose_dir="$(cd "$(dirname "$COMPOSE_FILE")" && pwd)"
    compose_name="$(basename "$COMPOSE_FILE")"
    (cd "$compose_dir" && $COMPOSE_CMD -f "$compose_name" "$action")
}

restart_containers_safe() {
    print_step "Restarting BetterDesk containers safely..."

    if [ ! -f "$COMPOSE_FILE" ]; then
        print_warning "Compose file not found; trying docker restart for known containers"
        docker restart "$SERVER_CONTAINER" "$CONSOLE_CONTAINER" >/dev/null 2>&1 || {
            print_warning "Could not restart known containers"
            return 1
        }
        return 0
    fi

    local compose_dir compose_name
    compose_dir="$(cd "$(dirname "$COMPOSE_FILE")" && pwd)"
    compose_name="$(basename "$COMPOSE_FILE")"
    (cd "$compose_dir" && $COMPOSE_CMD -f "$compose_name" up -d) || {
        print_warning "docker compose up -d failed"
        return 1
    }
}

check_local_http() {
    local label="$1"
    local url="$2"

    printf "  %-28s " "$label:"
    if curl -sfo /dev/null --connect-timeout 3 "$url" 2>/dev/null; then
        echo -e "${GREEN}OK${NC} ($url)"
        return 0
    fi
    echo -e "${YELLOW}UNREACHABLE${NC} ($url)"
    return 1
}

print_rescue_diagnostics() {
    echo -e "${WHITE}${BOLD}══════════ DOCKER RESCUE DIAGNOSTICS ══════════${NC}"
    echo ""

    auto_detect_docker_paths

    if ! command -v docker >/dev/null 2>&1; then
        print_warning "Docker CLI is not installed or not in PATH"
        echo "  Compose file: $COMPOSE_FILE"
        echo "  DATA_DIR: $DATA_DIR"
        echo "  Next step: install Docker, then rerun --rescue"
        return 0
    fi

    if ! check_docker; then
        print_warning "Docker daemon is not running or not accessible"
        echo "  Compose file: $COMPOSE_FILE"
        echo "  DATA_DIR: $DATA_DIR"
        echo "  Next step: start Docker, then rerun --rescue"
        return 0
    fi

    detect_installation
    print_status

    echo ""
    echo -e "${WHITE}${BOLD}═══ Compose and volumes ═══${NC}"
    echo "  Compose file: $COMPOSE_FILE"
    if [ -f "$COMPOSE_FILE" ]; then
        echo -e "  Compose file exists: ${GREEN}yes${NC}"
    else
        echo -e "  Compose file exists: ${YELLOW}no${NC}"
    fi
    echo "  DATA_DIR: $DATA_DIR"
    if [ -d "$DATA_DIR" ]; then
        echo -e "  DATA_DIR writable: $(test -w "$DATA_DIR" && echo "${GREEN}yes${NC}" || echo "${YELLOW}no${NC}")"
    fi
    echo "  Docker volumes:"
    docker volume ls --format '    - {{.Name}}' 2>/dev/null | grep -E 'betterdesk|console' || echo "    none detected"

    echo ""
    echo -e "${WHITE}${BOLD}═══ Container logs (last 15 lines) ═══${NC}"
    for container in "$SERVER_CONTAINER" "$CONSOLE_CONTAINER"; do
        echo ""
        echo -e "${CYAN}--- $container ---${NC}"
        docker logs --tail 15 "$container" 2>&1 || echo "Container does not exist"
    done

    echo ""
    echo -e "${WHITE}${BOLD}═══ Local health checks ═══${NC}"
    check_local_http "Go API 21114" "http://127.0.0.1:21114/api/health" || true
    check_local_http "Go API 21121" "http://127.0.0.1:21121/api/health" || true
    check_local_http "Web console" "http://127.0.0.1:5000/health" || true

    echo ""
    echo -e "${WHITE}${BOLD}═══ Port listeners ═══${NC}"
    for port in 21114 21115 21116 21117 21121 5000; do
        printf "  Port %-5s " "$port"
        if ss -tulnp 2>/dev/null | grep -q ":${port} "; then
            echo -e "${GREEN}LISTENING${NC}"
        else
            echo -e "${YELLOW}NOT LISTENING${NC}"
        fi
    done
}

do_safe_rescue() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ SAFE DOCKER RESCUE ══════════${NC}"
    echo ""

    check_docker || {
        print_error "Docker is not installed or the daemon is not running"
        return 1
    }
    check_docker_compose || {
        print_error "Docker Compose is not available"
        return 1
    }

    repair_docker_permissions || true
    restart_containers_safe || true
    sleep 3
    repair_database_docker || true

    echo ""
    print_rescue_diagnostics
    echo ""
    print_success "Safe rescue completed. No data or volumes were deleted."
}

#===============================================================================
# Validation Functions
#===============================================================================

do_validate() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ DOCKER VALIDATION ══════════${NC}"
    echo ""
    
    local errors=0
    local warnings=0
    
    # Check Docker
    echo -e "${WHITE}Checking Docker...${NC}"
    echo ""
    
    echo -n "  Docker daemon: "
    if check_docker; then
        echo -e "${GREEN}✓ Running${NC}"
    else
        echo -e "${RED}✗ Not running${NC}"
        errors=$((errors + 1))
    fi
    
    echo -n "  Docker Compose: "
    if check_docker_compose; then
        echo -e "${GREEN}✓ Available${NC}"
    else
        echo -e "${RED}✗ Not found${NC}"
        errors=$((errors + 1))
    fi
    
    # Check images
    echo ""
    echo -e "${WHITE}Checking images...${NC}"
    echo ""
    
    for image in "betterdesk-server" "betterdesk-console"; do
        echo -n "  $image: "
        if docker images --format '{{.Repository}}' | grep -q "^$image$"; then
            echo -e "${GREEN}✓ Built${NC}"
        else
            echo -e "${RED}✗ Not found${NC}"
            errors=$((errors + 1))
        fi
    done
    
    # Check containers
    echo ""
    echo -e "${WHITE}Checking containers...${NC}"
    echo ""
    
    detect_installation
    
    echo -n "  Server (Go): "
    if [ "$SERVER_RUNNING" = true ]; then
        echo -e "${GREEN}● Running${NC}"
    else
        echo -e "${RED}○ Stopped${NC}"
        errors=$((errors + 1))
    fi
    
    echo -n "  Console: "
    if [ "$CONSOLE_RUNNING" = true ]; then
        echo -e "${GREEN}● Running${NC}"
    else
        echo -e "${RED}○ Stopped${NC}"
        errors=$((errors + 1))
    fi
    
    # Check data
    echo ""
    echo -e "${WHITE}Checking data...${NC}"
    echo ""
    
    echo -n "  Data directory: "
    if [ -d "$DATA_DIR" ]; then
        echo -e "${GREEN}✓ Exists${NC}"
    else
        echo -e "${RED}✗ Not found${NC}"
        errors=$((errors + 1))
    fi
    
    echo -n "  Database: "
    if [ -f "$DATA_DIR/db_v2.sqlite3" ]; then
        echo -e "${GREEN}✓ Exists${NC}"
    else
        echo -e "${YELLOW}! Will be created on first start${NC}"
        warnings=$((warnings + 1))
    fi
    
    # Check ports
    echo ""
    echo -e "${WHITE}Checking ports...${NC}"
    echo ""
    
    for port in 21115 21116 21117 5000 21121; do
        echo -n "  Port $port: "
        if ss -tlnp 2>/dev/null | grep -q ":$port " || netstat -tlnp 2>/dev/null | grep -q ":$port "; then
            echo -e "${GREEN}● Listening${NC}"
        else
            echo -e "${YELLOW}○ Free${NC}"
            warnings=$((warnings + 1))
        fi
    done
    
    # Summary
    echo ""
    echo -e "${WHITE}═══════════════════════════════════════${NC}"
    
    if [ $errors -eq 0 ] && [ $warnings -eq 0 ]; then
        echo -e "${GREEN}✓ Installation correct - no problems found${NC}"
    elif [ $errors -eq 0 ]; then
        echo -e "${YELLOW}! Found $warnings warnings${NC}"
    else
        echo -e "${RED}✗ Found $errors errors and $warnings warnings${NC}"
        echo ""
        echo -e "${CYAN}Use 'Repair' option to fix problems${NC}"
    fi
    
    press_enter
}

#===============================================================================
# Backup Functions
#===============================================================================

do_backup() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ DOCKER BACKUP ══════════${NC}"
    echo ""
    
    do_backup_silent
    
    print_success "Backup completed!"
    press_enter
}

do_backup_silent() {
    local backup_name="betterdesk_docker_backup_$(date +%Y%m%d_%H%M%S)"
    local backup_path="$BACKUP_DIR/$backup_name"
    
    mkdir -p "$backup_path"
    
    print_step "Creating backup: $backup_name"
    
    # Backup data directory
    if [ -d "$DATA_DIR" ]; then
        cp -r "$DATA_DIR"/* "$backup_path/" 2>/dev/null || true
        print_info "  - Dane ($DATA_DIR)"
    fi
    
    # Backup compose file
    if [ -f "$COMPOSE_FILE" ]; then
        cp "$COMPOSE_FILE" "$backup_path/"
        print_info "  - docker-compose.yml"
    fi
    
    # Create archive
    cd "$BACKUP_DIR"
    tar -czf "$backup_name.tar.gz" "$backup_name"
    rm -rf "$backup_name"
    
    print_success "Backup saved: $BACKUP_DIR/$backup_name.tar.gz"
}

#===============================================================================
# Password Reset Functions
#===============================================================================

do_reset_password() {
    detect_installation
    
    if [ "$CONSOLE_RUNNING" != true ]; then
        print_error "Console container is not running!"
        press_enter
        return
    fi
    
    local _menu_items=(
        $'Generate random password\tCreate a new strong password'
        $'Set custom password\tType the password yourself'
        $'Back\tReturn to the main menu'
    )
    local _menu_returns=( 1 2 0 )
    menu_choose "Admin Password Reset" "Console container: running"
    local pw_choice="$MENU_CHOICE"
    
    local new_password
    
    case $pw_choice in
        1)
            # M-05: full hex entropy
            new_password=$(openssl rand -hex 16)
            ;;
        2)
            echo ""
            read -sp "Enter new password (min. 8 characters): " new_password
            echo ""
            if [ ${#new_password} -lt 8 ]; then
                print_error "Password must be at least 8 characters!"
                press_enter
                return
            fi
            ;;
        0)
            return
            ;;
        *)
            return
            ;;
    esac
    
    # Update password using reset-password.js (supports both SQLite and PostgreSQL)
    # Update password using reset-password.js (supports both SQLite and PostgreSQL)
    # Arguments: <password> [username] — password first, then optional username
    docker exec "$CONSOLE_CONTAINER" node /app/scripts/reset-password.js "$new_password" admin 2>/dev/null || {
        print_warning "reset-password.js failed, trying inline fallback..."
        docker exec -e RESET_ADMIN_PASSWORD="$new_password" "$CONSOLE_CONTAINER" node -e "
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const path = require('path');

const dataDir = process.env.DATA_DIR || '/app/data';
const dbPath = path.join(dataDir, 'auth.db');
const resetPassword = process.env.RESET_ADMIN_PASSWORD || '';

const db = new Database(dbPath);
const hash = bcrypt.hashSync(resetPassword, 10);

const update = db.prepare('UPDATE users SET password_hash = ? WHERE username = ?');
const result = update.run(hash, 'admin');

if (result.changes === 0) {
    const insert = db.prepare('INSERT INTO users (username, password_hash, role, is_active, created_at) VALUES (?, ?, ?, 1, datetime(\"now\"))');
    insert.run('admin', hash, 'admin');
    console.log('Admin user created');
} else {
    console.log('Password updated');
}
db.close();
"
    }

    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║              NEW LOGIN CREDENTIALS                      ║${NC}"
    echo -e "${GREEN}╠════════════════════════════════════════════════════════╣${NC}"
    echo -e "${GREEN}║  Login:    ${WHITE}admin${GREEN}                                     ║${NC}"
    echo -e "${GREEN}║  Password: ${WHITE}${new_password}${GREEN}                         ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}"
    
    # Save credentials
    if [ "$STORE_ADMIN_CREDENTIALS" = "true" ]; then
        cat > "$DATA_DIR/.admin_credentials" << CREDEOF
Admin Username: admin
Admin Password: $new_password
Generated by: BetterDesk Docker password reset
Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)
CREDEOF
        chmod 600 "$DATA_DIR/.admin_credentials"
    fi
    
    press_enter
}

#===============================================================================
# Build Functions
#===============================================================================

do_build() {
    local _menu_items=(
        $'Rebuild all images\tServer + console containers'
        $'Rebuild server (Go)\tOnly the Go server image'
        $'Rebuild console (Node.js)\tOnly the console image'
        $'Back\tReturn to the main menu'
    )
    local _menu_returns=( 1 2 3 0 )
    menu_choose "Build Images" "Rebuild Docker images"
    local build_choice="$MENU_CHOICE"
    
    cd "$SCRIPT_DIR"
    
    case $build_choice in
        1)
            print_step "Building all images..."
            $COMPOSE_CMD build --no-cache
            ;;
        2)
            print_step "Building Server (Go)..."
            $COMPOSE_CMD build --no-cache server
            ;;
        3)
            print_step "Building Console (Node.js)..."
            $COMPOSE_CMD build --no-cache console
            ;;
        0)
            return
            ;;
    esac
    
    print_success "Build completed!"
    
    if confirm "Do you want to restart containers?"; then
        stop_containers
        start_containers
    fi
    
    press_enter
}

#===============================================================================
# Firewall Functions
#===============================================================================

configure_firewall_rules() {
    local required_ports="21115 21116 21117 5000 21121"
    local created=0
    local total=0

    if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "active"; then
        print_info "Configuring UFW firewall rules..."

        for port in $required_ports; do
            total=$((total + 1))
            if ! ufw status 2>/dev/null | grep -qE "^${port}[/ ]"; then
                if [ "$port" = "21116" ]; then
                    ufw allow 21116/tcp comment "BetterDesk ID Server TCP" 2>/dev/null && created=$((created + 1))
                    ufw allow 21116/udp comment "BetterDesk ID Server UDP" 2>/dev/null && created=$((created + 1))
                    total=$((total + 1))
                else
                    ufw allow "${port}/tcp" comment "BetterDesk port ${port}" 2>/dev/null && created=$((created + 1))
                fi
            fi
        done

        ufw reload 2>/dev/null

    elif command -v firewall-cmd &>/dev/null && systemctl is-active --quiet firewalld 2>/dev/null; then
        print_info "Configuring firewalld rules..."

        for port in $required_ports; do
            total=$((total + 1))
            local open_ports=$(firewall-cmd --list-ports 2>/dev/null)
            if ! echo "$open_ports" | grep -qE "${port}/tcp"; then
                if [ "$port" = "21116" ]; then
                    firewall-cmd --permanent --add-port=21116/tcp 2>/dev/null && created=$((created + 1))
                    firewall-cmd --permanent --add-port=21116/udp 2>/dev/null && created=$((created + 1))
                    total=$((total + 1))
                else
                    firewall-cmd --permanent --add-port="${port}/tcp" 2>/dev/null && created=$((created + 1))
                fi
            fi
        done

        firewall-cmd --reload 2>/dev/null

    elif command -v iptables &>/dev/null; then
        print_info "Configuring iptables rules..."

        for port in $required_ports; do
            total=$((total + 1))
            if ! iptables -L INPUT -n 2>/dev/null | grep -qE "dpt:${port}\b"; then
                if [ "$port" = "21116" ]; then
                    iptables -A INPUT -p tcp --dport 21116 -j ACCEPT 2>/dev/null && created=$((created + 1))
                    iptables -A INPUT -p udp --dport 21116 -j ACCEPT 2>/dev/null && created=$((created + 1))
                    total=$((total + 1))
                else
                    iptables -A INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null && created=$((created + 1))
                fi
            fi
        done

        if command -v iptables-save &>/dev/null; then
            iptables-save > /etc/iptables/rules.v4 2>/dev/null || \
            iptables-save > /etc/sysconfig/iptables 2>/dev/null || true
        fi
    else
        print_info "No active firewall detected — no rules to configure"
        return 0
    fi

    if [ $created -gt 0 ]; then
        print_success "Created $created firewall rule(s)"
    else
        print_success "All firewall rules already configured"
    fi

    return 0
}

#===============================================================================
# Diagnostics Functions
#===============================================================================

do_diagnostics() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ DOCKER DIAGNOSTICS ══════════${NC}"
    echo ""

    detect_installation
    print_status

    echo ""
    echo -e "${WHITE}${BOLD}═══ Container logs (last 15 lines) ═══${NC}"
    echo ""

    for container in "$SERVER_CONTAINER" "$CONSOLE_CONTAINER"; do
        echo -e "${CYAN}--- $container ---${NC}"
        docker logs --tail 15 "$container" 2>&1 || echo "Container does not exist"
        echo ""
    done

    echo -e "${WHITE}${BOLD}═══ Resource usage ═══${NC}"
    echo ""

    docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" 2>/dev/null | grep -E "NAME|betterdesk" || echo "No running containers found"

    echo ""
    echo -e "${WHITE}${BOLD}═══ Database statistics ═══${NC}"
    echo ""

    if [ "$CONSOLE_RUNNING" = true ]; then
        docker exec "$CONSOLE_CONTAINER" sh -c '
            STATS=$(curl -sf http://localhost:5000/health 2>/dev/null)
            if [ -n "$STATS" ]; then
                echo "  Console: healthy"
            else
                echo "  Console: health check failed"
            fi
        '
        if [ "$SERVER_RUNNING" = true ]; then
            docker exec "$SERVER_CONTAINER" sh -c '
                RESP=$(curl -sf http://localhost:21121/api/peers 2>/dev/null)
                if [ -n "$RESP" ]; then
                    echo "  Server API: responding"
                else
                    echo "  Server API: not responding"
                fi
            ' 2>/dev/null || echo "  Server API: container not accessible"
        fi
    else
        echo "  Console container is not running"
    fi

    # --- Port diagnostics ---
    echo ""
    echo -e "${WHITE}${BOLD}═══ Port diagnostics ═══${NC}"
    echo ""

    local port_issues=0
    local port_defs=(
        "21115:TCP:betterdesk-server:NAT Test"
        "21116:TCP:betterdesk-server:ID Server (TCP)"
        "21116:UDP:betterdesk-server:ID Server (UDP)"
        "21117:TCP:betterdesk-server:Relay Server"
        "5000:TCP:betterdesk-console:Web Console"
        "21121:TCP:betterdesk-server:HTTP API (client + REST, WAN)"
    )

    for entry in "${port_defs[@]}"; do
        IFS=':' read -r port proto expected desc <<< "$entry"

        local proc_info=""
        if [ "$proto" = "TCP" ]; then
            proc_info=$(ss -tlnp 2>/dev/null | grep ":${port} " | head -1)
            [ -z "$proc_info" ] && proc_info=$(netstat -tlnp 2>/dev/null | grep ":${port} " | head -1)
        else
            proc_info=$(ss -ulnp 2>/dev/null | grep ":${port} " | head -1)
            [ -z "$proc_info" ] && proc_info=$(netstat -ulnp 2>/dev/null | grep ":${port} " | head -1)
        fi

        printf "  Port %s/%s (%-18s): " "$port" "$proto" "$desc"

        if [ -n "$proc_info" ]; then
            local process_name=$(echo "$proc_info" | grep -oP 'users:\(\("\K[^"]+' 2>/dev/null || \
                                echo "$proc_info" | awk '{print $NF}')
            if echo "$process_name" | grep -qiE "docker|$expected"; then
                echo -e "${GREEN}OK${NC}"
            else
                echo -e "${RED}CONFLICT - used by $process_name${NC}"
                port_issues=$((port_issues + 1))
            fi
        else
            echo -e "${YELLOW}NOT LISTENING${NC}"
        fi
    done

    if [ $port_issues -gt 0 ]; then
        echo ""
        print_warning "$port_issues port conflict(s) detected!"
        echo -e "  ${YELLOW}Tip: Stop conflicting processes or change Docker port mappings${NC}"
    fi

    # --- Firewall diagnostics ---
    echo ""
    echo -e "${WHITE}${BOLD}═══ Firewall status ═══${NC}"
    echo ""

    local fw_type="none"
    local missing_rules=0
    local required_ports="21115 21116 21117 5000 21121"

    if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "active"; then
        fw_type="ufw"
        echo -e "  Firewall: ${YELLOW}UFW (active)${NC}"
        echo ""

        for port in $required_ports; do
            local status_line=$(ufw status 2>/dev/null | grep -E "^${port}[/ ]")
            printf "  Port %-5s: " "$port"
            if [ -n "$status_line" ]; then
                echo -e "${GREEN}ALLOWED${NC}"
            else
                echo -e "${RED}NO RULE${NC}"
                missing_rules=$((missing_rules + 1))
            fi
        done

    elif command -v firewall-cmd &>/dev/null && systemctl is-active --quiet firewalld 2>/dev/null; then
        fw_type="firewalld"
        echo -e "  Firewall: ${YELLOW}firewalld (active)${NC}"
        echo ""

        local open_ports=$(firewall-cmd --list-ports 2>/dev/null)
        for port in $required_ports; do
            printf "  Port %-5s: " "$port"
            if echo "$open_ports" | grep -qE "${port}/tcp|${port}/udp"; then
                echo -e "${GREEN}ALLOWED${NC}"
            else
                echo -e "${RED}NO RULE${NC}"
                missing_rules=$((missing_rules + 1))
            fi
        done

    elif iptables -L INPUT -n 2>/dev/null | grep -q "ACCEPT"; then
        fw_type="iptables"
        echo -e "  Firewall: ${YELLOW}iptables${NC}"
        echo ""

        for port in $required_ports; do
            printf "  Port %-5s: " "$port"
            if iptables -L INPUT -n 2>/dev/null | grep -qE "dpt:${port}\b"; then
                echo -e "${GREEN}ALLOWED${NC}"
            else
                echo -e "${RED}NO RULE / CHECK MANUALLY${NC}"
                missing_rules=$((missing_rules + 1))
            fi
        done
    else
        echo -e "  Firewall: ${GREEN}No active firewall detected (all ports open)${NC}"
    fi

    if [ $missing_rules -gt 0 ]; then
        echo ""
        print_warning "$missing_rules firewall rule(s) missing!"
        echo -e "  ${YELLOW}Use option 'F' below to auto-configure firewall${NC}"
    fi

    # --- API connectivity test ---
    echo ""
    echo -e "${WHITE}${BOLD}═══ API connectivity ═══${NC}"
    echo ""

    printf "  Server API (21121):  "
    if curl -sfo /dev/null --connect-timeout 3 "http://127.0.0.1:21121/api/server-info" 2>/dev/null; then
        echo -e "${GREEN}OK${NC}"
    else
        echo -e "${RED}UNREACHABLE${NC}"
    fi

    printf "  Web Console (5000):  "
    if curl -sfo /dev/null --connect-timeout 3 "http://127.0.0.1:5000/health" 2>/dev/null; then
        echo -e "${GREEN}OK${NC}"
    else
        echo -e "${RED}UNREACHABLE${NC}"
    fi

    # --- Diagnostics sub-menu ---
    echo ""
    local _menu_items=(
        $'Configure firewall rules\tAuto-create any missing rules'
        $'Test port connectivity\tProbe ports from outside'
        $'Back\tReturn to the main menu'
    )
    local _menu_returns=( F P 0 )
    menu_choose "Diagnostics Actions" "Optional follow-up checks"
    local sub_choice="$MENU_CHOICE"

    case "$sub_choice" in
        [Ff])
            echo ""
            configure_firewall_rules
            press_enter
            ;;
        [Pp])
            echo ""
            echo -e "${WHITE}${BOLD}═══ External port test ═══${NC}"
            echo ""
            local server_ip=$(get_public_ip)
            print_info "Public IP: $server_ip"
            print_info "Testing external port accessibility..."
            echo ""

            for port in 21115 21116 21117; do
                printf "  Port %s: " "$port"
                if timeout 3 bash -c "echo >/dev/tcp/$server_ip/$port" 2>/dev/null; then
                    echo -e "${GREEN}REACHABLE${NC}"
                else
                    echo -e "${RED}BLOCKED/UNREACHABLE${NC}"
                fi
            done
            press_enter
            ;;
        *)
            return
            ;;
    esac
}

#===============================================================================
# Uninstall Functions
#===============================================================================

do_uninstall() {
    print_header
    echo -e "${RED}${BOLD}══════════ UNINSTALL DOCKER ══════════${NC}"
    echo ""
    
    print_warning "This operation will remove BetterDesk Docker!"
    echo ""
    
    if ! confirm "Are you sure you want to continue?"; then
        return
    fi
    
    if confirm "Create backup before uninstall?"; then
        do_backup_silent
    fi
    
    print_step "Stopping containers..."
    cd "$SCRIPT_DIR"
    $COMPOSE_CMD down -v 2>/dev/null || true
    
    if confirm "Remove Docker images?"; then
        docker rmi betterdesk-server betterdesk-console 2>/dev/null || true
        print_info "Images removed"
    fi
    
    if confirm "Remove data ($DATA_DIR)?"; then
        rm -rf "$DATA_DIR"
        print_info "Removed: $DATA_DIR"
    fi
    
    print_success "BetterDesk Docker has been uninstalled"
    press_enter
}

#===============================================================================
# Migration Functions
#===============================================================================

# Detect existing standard RustDesk Docker installation
detect_existing_rustdesk() {
    EXISTING_FOUND=false
    EXISTING_CONTAINERS=()
    EXISTING_DATA_DIR=""
    EXISTING_COMPOSE_FILE=""
    EXISTING_KEY_FILE=""
    EXISTING_DB_FILE=""
    
    print_step "Scanning for existing RustDesk Docker installations..."
    echo ""
    
    # 1. Search for RustDesk containers (common naming patterns)
    local container_patterns=("hbbs" "hbbr" "rustdesk" "s6")
    local found_containers=()
    
    for pattern in "${container_patterns[@]}"; do
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            # Skip BetterDesk containers
            if [[ "$line" == *"betterdesk"* ]]; then
                continue
            fi
            found_containers+=("$line")
        done < <(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -i "$pattern" || true)
    done
    
    # Deduplicate
    local unique_containers=()
    for c in "${found_containers[@]}"; do
        local is_dup=false
        for u in "${unique_containers[@]}"; do
            if [ "$c" = "$u" ]; then
                is_dup=true
                break
            fi
        done
        if [ "$is_dup" = false ]; then
            unique_containers+=("$c")
        fi
    done
    EXISTING_CONTAINERS=("${unique_containers[@]}")
    
    if [ ${#EXISTING_CONTAINERS[@]} -gt 0 ]; then
        print_info "Found RustDesk containers:"
        for c in "${EXISTING_CONTAINERS[@]}"; do
            local status
            status=$(docker inspect --format '{{.State.Status}}' "$c" 2>/dev/null || echo "unknown")
            echo -e "    ${CYAN}•${NC} $c (${status})"
        done
        echo ""
    fi
    
    # 2. Try to find data directory from container mounts
    for c in "${EXISTING_CONTAINERS[@]}"; do
        local mounts
        mounts=$(docker inspect --format '{{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}' "$c" 2>/dev/null || true)
        
        for mount in $mounts; do
            local src="${mount%%:*}"
            local dst="${mount##*:}"
            
            # Look for RustDesk data mounts (typically /root or /data or /opt/rustdesk)
            if [[ "$dst" == "/root" ]] || [[ "$dst" == "/data" ]] || [[ "$dst" == "/opt/rustdesk" ]]; then
                if [ -d "$src" ]; then
                    # Check for key files
                    if [ -f "$src/id_ed25519" ] || [ -f "$src/id_ed25519.pub" ] || [ -f "$src/db_v2.sqlite3" ]; then
                        EXISTING_DATA_DIR="$src"
                        break 2
                    fi
                fi
            fi
        done
    done
    
    # 3. If no data dir from mounts, search common locations
    if [ -z "$EXISTING_DATA_DIR" ]; then
        local search_paths=(
            "./data"
            "./rustdesk-data"
            "/opt/rustdesk"
            "/opt/rustdesk-data"
            "$HOME/rustdesk"
            "$HOME/data"
        )
        
        for path in "${search_paths[@]}"; do
            if [ -d "$path" ] && [ -f "$path/id_ed25519" ]; then
                EXISTING_DATA_DIR="$path"
                break
            fi
        done
    fi
    
    # 4. Search for existing docker-compose files
    local compose_search_paths=(
        "."
        "$HOME"
        "/opt/rustdesk"
        "/opt"
    )
    
    for base in "${compose_search_paths[@]}"; do
        for fname in "docker-compose.yml" "docker-compose.yaml" "compose.yml" "compose.yaml"; do
            local candidate="$base/$fname"
            if [ -f "$candidate" ] && grep -qi "rustdesk\|hbbs\|hbbr" "$candidate" 2>/dev/null; then
                # Skip BetterDesk's own compose file
                if grep -qi "betterdesk" "$candidate" 2>/dev/null; then
                    continue
                fi
                EXISTING_COMPOSE_FILE="$candidate"
                break 2
            fi
        done
    done
    
    # 5. Verify found data
    if [ -n "$EXISTING_DATA_DIR" ]; then
        [ -f "$EXISTING_DATA_DIR/id_ed25519" ] && EXISTING_KEY_FILE="$EXISTING_DATA_DIR/id_ed25519"
        [ -f "$EXISTING_DATA_DIR/db_v2.sqlite3" ] && EXISTING_DB_FILE="$EXISTING_DATA_DIR/db_v2.sqlite3"
    fi
    
    # Determine if we found anything useful
    if [ ${#EXISTING_CONTAINERS[@]} -gt 0 ] || [ -n "$EXISTING_DATA_DIR" ]; then
        EXISTING_FOUND=true
    fi
}

do_migrate() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ MIGRATE FROM EXISTING RUSTDESK ══════════${NC}"
    echo ""
    echo -e "${CYAN}This wizard will migrate your existing RustDesk Docker installation${NC}"
    echo -e "${CYAN}to BetterDesk Console with enhanced features and web management.${NC}"
    echo ""
    
    # Check Docker
    if ! check_docker; then
        print_error "Docker is not available!"
        press_enter
        return
    fi
    
    if ! check_docker_compose; then
        print_error "Docker Compose is not available!"
        press_enter
        return
    fi
    
    # Detect existing installation
    detect_existing_rustdesk
    
    if [ "$EXISTING_FOUND" = false ]; then
        echo ""
        print_warning "No existing RustDesk Docker installation detected automatically."
        echo ""
        echo "You can specify the data directory manually."
        echo -e "${CYAN}The data directory should contain files like: id_ed25519, id_ed25519.pub, db_v2.sqlite3${NC}"
        echo ""
        
        read -p "Enter path to existing RustDesk data directory (or press Enter to cancel): " manual_path
        
        if [ -z "$manual_path" ]; then
            press_enter
            return
        fi
        
        if [ ! -d "$manual_path" ]; then
            print_error "Directory not found: $manual_path"
            press_enter
            return
        fi
        
        EXISTING_DATA_DIR="$manual_path"
        [ -f "$EXISTING_DATA_DIR/id_ed25519" ] && EXISTING_KEY_FILE="$EXISTING_DATA_DIR/id_ed25519"
        [ -f "$EXISTING_DATA_DIR/db_v2.sqlite3" ] && EXISTING_DB_FILE="$EXISTING_DATA_DIR/db_v2.sqlite3"
    fi
    
    # Show migration summary
    echo ""
    echo -e "${WHITE}${BOLD}═══ Migration Summary ═══${NC}"
    echo ""
    
    if [ ${#EXISTING_CONTAINERS[@]} -gt 0 ]; then
        echo -e "  ${CYAN}Containers found:${NC}"
        for c in "${EXISTING_CONTAINERS[@]}"; do
            echo "    • $c"
        done
    fi
    
    if [ -n "$EXISTING_DATA_DIR" ]; then
        echo -e "  ${CYAN}Data directory:${NC}  $EXISTING_DATA_DIR"
    fi
    
    if [ -n "$EXISTING_COMPOSE_FILE" ]; then
        echo -e "  ${CYAN}Compose file:${NC}    $EXISTING_COMPOSE_FILE"
    fi
    
    echo ""
    echo -e "  ${CYAN}Key files found:${NC}"
    
    local key_found=false
    if [ -n "$EXISTING_KEY_FILE" ]; then
        echo -e "    ${GREEN}✓${NC} id_ed25519 (encryption key)"
        key_found=true
    else
        echo -e "    ${RED}✗${NC} id_ed25519 (not found)"
    fi
    
    if [ -f "$EXISTING_DATA_DIR/id_ed25519.pub" ]; then
        echo -e "    ${GREEN}✓${NC} id_ed25519.pub (public key)"
    else
        echo -e "    ${YELLOW}!${NC} id_ed25519.pub (not found - will be regenerated)"
    fi
    
    if [ -n "$EXISTING_DB_FILE" ]; then
        local peer_count
        peer_count=$(sqlite3 "$EXISTING_DB_FILE" "SELECT COUNT(*) FROM peers;" 2>/dev/null || \
                     sqlite3 "$EXISTING_DB_FILE" "SELECT COUNT(*) FROM peer;" 2>/dev/null || echo "?")
        echo -e "    ${GREEN}✓${NC} db_v2.sqlite3 (${peer_count} devices)"
    else
        echo -e "    ${YELLOW}!${NC} db_v2.sqlite3 (not found - new DB will be created)"
    fi
    
    echo ""
    
    if [ "$key_found" = false ]; then
        print_warning "No encryption key found! Without the key, existing clients"
        print_warning "will need to be reconfigured. Continue anyway?"
        echo ""
    fi
    
    echo -e "${YELLOW}${BOLD}IMPORTANT:${NC} This will:"
    echo "  1. Create a backup of existing data"
    echo "  2. Stop existing RustDesk containers (if found)"
    echo "  3. Copy data to BetterDesk data directory"
    echo "  4. Build and start BetterDesk containers"
    echo "  5. Create a web admin account"
    echo ""
    echo -e "${CYAN}Your existing RustDesk data will NOT be deleted.${NC}"
    echo ""
    
    if ! confirm "Do you want to proceed with the migration?"; then
        press_enter
        return
    fi
    
    echo ""
    
    # === Step 1: Backup existing data ===
    print_step "[1/6] Backing up existing data..."
    
    local migration_backup="$BACKUP_DIR/pre_migration_$(date +%Y%m%d_%H%M%S)"
    mkdir -p "$migration_backup"
    
    if [ -n "$EXISTING_DATA_DIR" ] && [ -d "$EXISTING_DATA_DIR" ]; then
        cp -r "$EXISTING_DATA_DIR"/* "$migration_backup/" 2>/dev/null || true
        print_success "  Backup saved to: $migration_backup"
    fi
    
    if [ -n "$EXISTING_COMPOSE_FILE" ] && [ -f "$EXISTING_COMPOSE_FILE" ]; then
        cp "$EXISTING_COMPOSE_FILE" "$migration_backup/old_docker-compose.yml" 2>/dev/null || true
        print_info "  Old compose file backed up"
    fi
    
    # === Step 2: Stop existing containers ===
    print_step "[2/6] Stopping existing RustDesk containers..."
    
    if [ ${#EXISTING_CONTAINERS[@]} -gt 0 ]; then
        for c in "${EXISTING_CONTAINERS[@]}"; do
            docker stop "$c" 2>/dev/null && print_info "  Stopped: $c" || true
        done
    else
        print_info "  No containers to stop"
    fi
    
    # === Step 3: Prepare BetterDesk data directory ===
    print_step "[3/6] Preparing BetterDesk data directory..."
    
    if [ -z "$DATA_DIR" ]; then
        DATA_DIR="/opt/betterdesk-data"
    fi
    
    # Create directories with proper permissions (handles SELinux)
    create_data_directory "$DATA_DIR" || {
        print_error "Failed to create data directory: $DATA_DIR"
        print_info "If you're on SELinux-enabled system (AlmaLinux, RHEL, CentOS):"
        print_info "  sudo setenforce 0  # Temporarily disable"
        print_info "  # Or: sudo chcon -Rt svirt_sandbox_file_t $DATA_DIR"
        return
    }
    create_data_directory "$BACKUP_DIR" || true
    
    # Copy key files
    if [ -n "$EXISTING_DATA_DIR" ] && [ "$EXISTING_DATA_DIR" != "$DATA_DIR" ]; then
        # Copy encryption keys (critical)
        for keyfile in id_ed25519 id_ed25519.pub; do
            if [ -f "$EXISTING_DATA_DIR/$keyfile" ]; then
                cp "$EXISTING_DATA_DIR/$keyfile" "$DATA_DIR/"
                print_success "  Copied: $keyfile"
            fi
        done
        
        # Copy database
        if [ -f "$EXISTING_DATA_DIR/db_v2.sqlite3" ]; then
            cp "$EXISTING_DATA_DIR/db_v2.sqlite3" "$DATA_DIR/"
            print_success "  Copied: db_v2.sqlite3"
        fi
        
        # Copy any other relevant files (.api_key etc.)
        for extra in .api_key; do
            if [ -f "$EXISTING_DATA_DIR/$extra" ]; then
                cp "$EXISTING_DATA_DIR/$extra" "$DATA_DIR/"
                print_info "  Copied: $extra"
            fi
        done
    elif [ "$EXISTING_DATA_DIR" = "$DATA_DIR" ]; then
        print_info "  Data already in target directory: $DATA_DIR"
    else
        print_warning "  No source data to copy"
    fi
    
    # === Step 4: Create BetterDesk compose file ===
    print_step "[4/6] Creating BetterDesk Docker Compose configuration..."
    
    if [ ! -f "$COMPOSE_FILE" ]; then
        create_compose_file
    else
        print_info "  Compose file already exists: $COMPOSE_FILE"
    fi
    
    # === Step 5: Build and start ===
    print_step "[5/6] Building BetterDesk Docker images..."
    
    build_images
    start_containers
    
    # === Step 6: Create admin user ===
    print_step "[6/6] Setting up BetterDesk web console..."
    
    create_admin_user
    
    # === Migration complete ===
    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                  MIGRATION COMPLETED SUCCESSFULLY               ║${NC}"
    echo -e "${GREEN}╠══════════════════════════════════════════════════════════════════╣${NC}"
    
    local server_ip
    server_ip=$(get_public_ip)
    
    echo -e "${GREEN}║                                                                  ║${NC}"
    echo -e "${GREEN}║  Web Panel:     ${WHITE}http://$server_ip:5000${GREEN}                           ║${NC}"
    echo -e "${GREEN}║  Data Dir:      ${WHITE}$DATA_DIR${GREEN}                              ║${NC}"
    echo -e "${GREEN}║  Backup:        ${WHITE}$migration_backup${GREEN}       ║${NC}"
    echo -e "${GREEN}║                                                                  ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    
    if [ -n "$EXISTING_KEY_FILE" ]; then
        print_success "Encryption key preserved - existing clients will continue to work!"
    else
        print_warning "No key was migrated - existing clients may need reconfiguration."
    fi
    
    echo ""
    print_info "Your old data is preserved in: $migration_backup"
    print_info "Old containers are stopped but not removed."
    echo ""
    echo -e "${CYAN}To remove old containers later, run:${NC}"
    for c in "${EXISTING_CONTAINERS[@]}"; do
        echo "  docker rm $c"
    done
    
    echo ""
    press_enter
}

#===============================================================================
# SQLite to PostgreSQL Migration
#===============================================================================

do_migrate_postgresql() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ SQLite → PostgreSQL MIGRATION ══════════${NC}"
    echo ""
    
    # Check if containers are running
    detect_installation
    
    if [ "$INSTALL_STATUS" = "none" ]; then
        print_error "BetterDesk Docker is not installed!"
        press_enter
        return
    fi
    
    # Check if SQLite database exists
    local sqlite_db="$DATA_DIR/db_v2.sqlite3"
    if [ ! -f "$sqlite_db" ]; then
        print_error "SQLite database not found: $sqlite_db"
        press_enter
        return
    fi
    
    print_info "Found SQLite database: $sqlite_db"
    
    # Get device count
    local device_count
    # Go server uses 'peers' table; legacy Rust uses 'peer'
    device_count=$(docker exec "$CONSOLE_CONTAINER" sqlite3 "$sqlite_db" "SELECT COUNT(*) FROM peers;" 2>/dev/null || \
                   docker exec "$CONSOLE_CONTAINER" sqlite3 "$sqlite_db" "SELECT COUNT(*) FROM peer;" 2>/dev/null || echo "0")
    print_info "Devices in database: $device_count"
    echo ""
    
    if ! confirm "Migrate to PostgreSQL? This will modify docker-compose.yml"; then
        return
    fi
    
    # Get PostgreSQL password
    echo ""
    read -p "PostgreSQL password for 'betterdesk' user [betterdesk123]: " pg_pass
    POSTGRESQL_PASS="${pg_pass:-betterdesk123}"
    
    # Backup current setup
    print_step "Creating backup..."
    do_backup_silent
    
    # Stop containers
    print_step "Stopping containers..."
    stop_containers
    
    # Set database type
    DB_TYPE="postgresql"
    
    # Recreate compose file with PostgreSQL
    create_compose_file
    
    # Build and start with PostgreSQL
    print_step "Starting containers with PostgreSQL..."
    build_images
    start_containers
    
    # Wait for PostgreSQL to be ready
    print_step "Waiting for PostgreSQL to be ready..."
    sleep 10
    
    # Check if migration tool is available
    local migrate_tool=""
    local arch=$(uname -m)
    case "$arch" in
        x86_64) migrate_tool="./betterdesk-server/tools/migrate/migrate-linux-amd64" ;;
        aarch64|arm64) migrate_tool="./betterdesk-server/tools/migrate/migrate-linux-arm64" ;;
    esac
    
    if [ ! -f "$migrate_tool" ]; then
        print_warning "Migration tool not found: $migrate_tool"
        print_info "You can migrate manually using:"
        echo "  $migrate_tool sqlite2pg --sqlite \"$sqlite_db\" --pg \"postgres://$POSTGRESQL_USER:$POSTGRESQL_PASS@localhost:5432/$POSTGRESQL_DB?sslmode=disable\""
        echo ""
        print_info "PostgreSQL container is running. You can connect to it with:"
        echo "  docker exec -it betterdesk-postgres psql -U $POSTGRESQL_USER -d $POSTGRESQL_DB"
        press_enter
        return
    fi
    
    # Run migration
    print_step "Migrating data from SQLite to PostgreSQL..."
    chmod +x "$migrate_tool"
    
    # PostgreSQL is inside Docker, so we need to use host network or port mapping
    # Default docker-compose doesn't expose PostgreSQL port, so we connect via Docker network
    # For migration, we need to temporarily expose PostgreSQL or copy data
    
    # Copy SQLite database to migrate tool location
    cp "$sqlite_db" "/tmp/betterdesk_migrate.sqlite3"
    
    # Since PostgreSQL is inside Docker, we need to connect via localhost:5432 if exposed
    # or use docker exec. Let's use docker exec approach:
    
    print_step "Creating PostgreSQL schema..."
    docker exec betterdesk-postgres psql -U "$POSTGRESQL_USER" -d "$POSTGRESQL_DB" << 'EOSQL'
CREATE TABLE IF NOT EXISTS peers (
    guid TEXT PRIMARY KEY,
    id TEXT UNIQUE NOT NULL,
    uuid TEXT,
    pk BYTEA,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_online TIMESTAMPTZ,
    info TEXT,
    hostname TEXT,
    username TEXT,
    os TEXT,
    version TEXT,
    cpu TEXT,
    memory TEXT,
    is_banned BOOLEAN DEFAULT FALSE,
    ban_reason TEXT,
    banned_at TIMESTAMPTZ,
    banned_until TIMESTAMPTZ,
    deleted BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'viewer',
    totp_secret TEXT,
    totp_enabled BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_login TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS address_books (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    ab_name TEXT NOT NULL,
    ab_data TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    permissions TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_used TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS server_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS peer_tags (
    peer_guid TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (peer_guid, tag)
);

CREATE TABLE IF NOT EXISTS id_history (
    id BIGSERIAL PRIMARY KEY,
    peer_guid TEXT NOT NULL,
    old_id TEXT NOT NULL,
    new_id TEXT NOT NULL,
    changed_at TIMESTAMPTZ DEFAULT NOW(),
    changed_by TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    event_type TEXT NOT NULL,
    actor TEXT,
    target TEXT,
    details TEXT,
    ip_address TEXT
);

CREATE INDEX IF NOT EXISTS idx_peers_id ON peers(id);
CREATE INDEX IF NOT EXISTS idx_peers_last_online ON peers(last_online);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
EOSQL

    print_success "PostgreSQL schema created"
    
    # Export data from SQLite and import to PostgreSQL
    print_step "Migrating peer data..."
    
    # Extract data from SQLite (try 'peers' table first, fall back to 'peer' for legacy Rust)
    docker exec "$CONSOLE_CONTAINER" sqlite3 "/opt/rustdesk/db_v2.sqlite3" -csv \
        "SELECT guid, id, uuid, pk, created_at, last_online, info, hostname, username, os, version, cpu, memory, is_banned, ban_reason, banned_at, banned_until, coalesce(deleted, 0) FROM peers;" \
        > /tmp/peers_export.csv 2>/dev/null || \
    docker exec "$CONSOLE_CONTAINER" sqlite3 "/opt/rustdesk/db_v2.sqlite3" -csv \
        "SELECT guid, id, uuid, pk, created_at, last_online, info, hostname, username, os, version, cpu, memory, is_banned, ban_reason, banned_at, banned_until, coalesce(deleted, 0) FROM peer;" \
        > /tmp/peers_export.csv 2>/dev/null || true
    
    if [ -f /tmp/peers_export.csv ] && [ -s /tmp/peers_export.csv ]; then
        # Copy to PostgreSQL container
        docker cp /tmp/peers_export.csv betterdesk-postgres:/tmp/peers_export.csv
        
        # Import with proper type conversion
        docker exec betterdesk-postgres psql -U "$POSTGRESQL_USER" -d "$POSTGRESQL_DB" << 'EOSQL'
CREATE TEMP TABLE peers_import (
    guid TEXT, id TEXT, uuid TEXT, pk TEXT, created_at TEXT, last_online TEXT,
    info TEXT, hostname TEXT, username TEXT, os TEXT, version TEXT, cpu TEXT, memory TEXT,
    is_banned TEXT, ban_reason TEXT, banned_at TEXT, banned_until TEXT, deleted TEXT
);
\copy peers_import FROM '/tmp/peers_export.csv' WITH (FORMAT csv);
INSERT INTO peers (guid, id, uuid, pk, created_at, last_online, info, hostname, username, os, version, cpu, memory, is_banned, ban_reason, banned_at, banned_until, deleted)
SELECT 
    guid, id, uuid, decode(pk, 'hex'), 
    CASE WHEN created_at != '' THEN created_at::timestamptz ELSE NOW() END,
    CASE WHEN last_online != '' THEN last_online::timestamptz END,
    info, hostname, username, os, version, cpu, memory,
    CASE WHEN is_banned = '1' THEN TRUE ELSE FALSE END,
    ban_reason,
    CASE WHEN banned_at != '' THEN banned_at::timestamptz END,
    CASE WHEN banned_until != '' THEN banned_until::timestamptz END,
    CASE WHEN deleted = '1' THEN TRUE ELSE FALSE END
FROM peers_import
ON CONFLICT (id) DO NOTHING;
DROP TABLE peers_import;
EOSQL
        
        rm -f /tmp/peers_export.csv
        print_success "Peer data migrated"
    else
        print_warning "No peer data to migrate or export failed"
    fi
    
    # Migrate users if they exist
    print_step "Migrating users..."
    docker exec "$CONSOLE_CONTAINER" sqlite3 "/opt/rustdesk/db_v2.sqlite3" -csv \
        "SELECT username, password_hash, role, coalesce(is_active, 1), created_at, last_login FROM users;" \
        > /tmp/users_export.csv 2>/dev/null || true
    
    if [ -f /tmp/users_export.csv ] && [ -s /tmp/users_export.csv ]; then
        docker cp /tmp/users_export.csv betterdesk-postgres:/tmp/users_export.csv
        
        docker exec betterdesk-postgres psql -U "$POSTGRESQL_USER" -d "$POSTGRESQL_DB" << 'EOSQL'
CREATE TEMP TABLE users_import (
    username TEXT, password_hash TEXT, role TEXT, is_active TEXT, created_at TEXT, last_login TEXT
);
\copy users_import FROM '/tmp/users_export.csv' WITH (FORMAT csv);
INSERT INTO users (username, password_hash, role, is_active, created_at, last_login)
SELECT 
    username, password_hash, role,
    CASE WHEN is_active = '1' THEN TRUE ELSE FALSE END,
    CASE WHEN created_at != '' THEN created_at::timestamptz ELSE NOW() END,
    CASE WHEN last_login != '' THEN last_login::timestamptz END
FROM users_import
ON CONFLICT (username) DO NOTHING;
DROP TABLE users_import;
EOSQL
        
        rm -f /tmp/users_export.csv
        print_success "Users migrated"
    fi
    
    # Verify migration
    print_step "Verifying migration..."
    local pg_count
    pg_count=$(docker exec betterdesk-postgres psql -U "$POSTGRESQL_USER" -d "$POSTGRESQL_DB" -t -c "SELECT COUNT(*) FROM peers;" | tr -d ' ')
    
    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║           SQLite → PostgreSQL MIGRATION COMPLETE                 ║${NC}"
    echo -e "${GREEN}╠══════════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${GREEN}║  SQLite devices:     ${WHITE}$device_count${GREEN}                                       ║${NC}"
    echo -e "${GREEN}║  PostgreSQL devices: ${WHITE}$pg_count${GREEN}                                       ║${NC}"
    echo -e "${GREEN}║  Database URL:       ${WHITE}postgres://$POSTGRESQL_USER:***@postgres:5432/$POSTGRESQL_DB${GREEN}  ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    
    print_info "Containers have been reconfigured to use PostgreSQL"
    print_info "SQLite database preserved at: $sqlite_db"
    
    press_enter
}

#===============================================================================
# SSL/TLS Configuration
#===============================================================================

do_configure_ssl() {
    detect_installation
    
    if [ "$INSTALL_STATUS" = "none" ]; then
        print_error "BetterDesk Docker is not installed!"
        print_info "Use 'Fresh Installation' first (option 1)"
        press_enter
        return
    fi
    
    local ssl_dir="$DATA_DIR/ssl"
    local env_file="$DATA_DIR/.env"
    
    local _menu_items=(
        $'Let'"'"'s Encrypt\tACME certificate with auto-renewal'
        $'Custom certificate\tProvide your own cert + key files'
        $'Self-signed certificate\tQuick HTTPS for testing'
        $'Disable SSL\tRevert the panel back to HTTP'
        $'Enterprise TLS\tFull HTTPS: panel + signal + relay'
        $'Back\tReturn to the main menu'
    )
    local _menu_returns=( 1 2 3 4 5 0 )
    menu_choose "SSL Certificate Configuration" "Enables HTTPS for the admin panel"
    local ssl_choice="${MENU_CHOICE:-3}"
    
    case "$ssl_choice" in
        0) return ;;
        1)
            print_warning "Let's Encrypt for Docker requires additional setup."
            print_info "Recommended: Use a reverse proxy (nginx/traefik) with Let's Encrypt."
            print_info "See: https://github.com/UNITRONIX/Rustdesk-FreeConsole/wiki/TLS-SSL"
            press_enter
            return
            ;;
        2)
            # Custom certificate
            echo ""
            read -p "Path to certificate file (PEM): " cert_path
            read -p "Path to private key file (PEM): " key_path
            read -p "Path to CA bundle (optional, press Enter to skip): " ca_path
            
            if [ ! -f "$cert_path" ]; then
                print_error "Certificate file not found: $cert_path"
                press_enter
                return
            fi
            if [ ! -f "$key_path" ]; then
                print_error "Key file not found: $key_path"
                press_enter
                return
            fi
            
            mkdir -p "$ssl_dir"
            cp "$cert_path" "$ssl_dir/betterdesk.crt"
            cp "$key_path" "$ssl_dir/betterdesk.key"
            [ -n "$ca_path" ] && [ -f "$ca_path" ] && cp "$ca_path" "$ssl_dir/ca.crt"
            
            chmod 600 "$ssl_dir/betterdesk.key"
            
            configure_docker_ssl "$ssl_dir" false
            print_success "Custom SSL certificate configured"
            ;;
        3)
            # Self-signed with full SANs
            mkdir -p "$ssl_dir"
            
            echo ""
            read -p "Enter domain name (optional, press Enter to skip): " cert_domain
            
            # Detect IPs
            local server_ip
            server_ip=$(get_public_ip)
            local lan_ip
            lan_ip=$(ip -4 addr show scope global | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1 2>/dev/null || \
                     hostname -I 2>/dev/null | awk '{print $1}' || echo "")
            
            # Build SAN list
            local san_list="IP:$server_ip,IP:127.0.0.1,DNS:localhost"
            [ -n "$lan_ip" ] && [ "$lan_ip" != "$server_ip" ] && san_list="$san_list,IP:$lan_ip"
            [ -n "$cert_domain" ] && san_list="DNS:$cert_domain,$san_list"
            
            local cn="${cert_domain:-$server_ip}"
            
            print_step "Generating self-signed certificate..."
            print_info "SANs: $san_list"
            
            openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
                -keyout "$ssl_dir/betterdesk.key" \
                -out "$ssl_dir/betterdesk.crt" \
                -subj "/CN=$cn/O=BetterDesk/C=PL" \
                -addext "subjectAltName=$san_list" 2>&1 || {
                # Fallback for older openssl
                openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
                    -keyout "$ssl_dir/betterdesk.key" \
                    -out "$ssl_dir/betterdesk.crt" \
                    -subj "/CN=$cn/O=BetterDesk/C=PL" 2>&1
            }
            
            chmod 600 "$ssl_dir/betterdesk.key"
            chmod 644 "$ssl_dir/betterdesk.crt"
            
            configure_docker_ssl "$ssl_dir" false
            
            print_success "Self-signed certificate generated (valid 10 years)"
            print_info "Certificate: $ssl_dir/betterdesk.crt"
            [ -n "$lan_ip" ] && [ "$lan_ip" != "$server_ip" ] && print_info "LAN IP included: $lan_ip"
            print_warning "Browsers will show security warning. Use Let's Encrypt for public servers."
            ;;
        4)
            # Disable SSL
            configure_docker_ssl "" disable
            print_success "SSL disabled. Running in HTTP mode."
            ;;
        5)
            # Enterprise TLS - full HTTPS on ALL channels including API
            print_header
            echo -e "${YELLOW}${BOLD}══════════ ENTERPRISE TLS CONFIGURATION ══════════${NC}"
            echo ""
            print_warning "⚠️  IMPORTANT: Enterprise TLS enables HTTPS on ALL ports including API."
            print_warning "    This requires RustDesk client >= 1.3.x for full compatibility."
            print_warning "    Legacy clients may have connectivity issues."
            echo ""
            
            mkdir -p "$ssl_dir"
            
            read -p "Enter domain name (optional, press Enter to skip): " cert_domain
            
            # Detect IPs
            local server_ip
            server_ip=$(get_public_ip)
            local lan_ip
            lan_ip=$(ip -4 addr show scope global | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1 2>/dev/null || \
                     hostname -I 2>/dev/null | awk '{print $1}' || echo "")
            
            # Build comprehensive SAN list
            local san_list="IP:$server_ip,IP:127.0.0.1,DNS:localhost"
            [ -n "$lan_ip" ] && [ "$lan_ip" != "$server_ip" ] && san_list="$san_list,IP:$lan_ip"
            [ -n "$cert_domain" ] && san_list="DNS:$cert_domain,$san_list"
            
            local cn="${cert_domain:-$server_ip}"
            
            print_step "Generating Enterprise certificate..."
            print_info "SANs: $san_list"
            
            openssl req -x509 -nodes -days 3650 -newkey rsa:4096 \
                -keyout "$ssl_dir/betterdesk.key" \
                -out "$ssl_dir/betterdesk.crt" \
                -subj "/CN=$cn/O=BetterDesk Enterprise/C=PL" \
                -addext "subjectAltName=$san_list" 2>&1 || {
                openssl req -x509 -nodes -days 3650 -newkey rsa:4096 \
                    -keyout "$ssl_dir/betterdesk.key" \
                    -out "$ssl_dir/betterdesk.crt" \
                    -subj "/CN=$cn/O=BetterDesk Enterprise/C=PL" 2>&1
            }
            
            chmod 600 "$ssl_dir/betterdesk.key"
            chmod 644 "$ssl_dir/betterdesk.crt"
            
            configure_docker_ssl "$ssl_dir" enterprise
            
            print_success "Enterprise TLS configured successfully!"
            echo ""
            print_info "Certificate: $ssl_dir/betterdesk.crt"
            print_info "Valid: 10 years (RSA 4096-bit)"
            [ -n "$lan_ip" ] && [ "$lan_ip" != "$server_ip" ] && print_info "LAN IP: $lan_ip"
            echo ""
            print_warning "All connections now use TLS:"
            print_info "  • Panel HTTPS: :5443"
            print_info "  • Signal TLS: :21116"
            print_info "  • Relay TLS: :21117"
            print_info "  • API HTTPS: :21121"
            echo ""
            print_warning "For browsers/clients, you may need to import $ssl_dir/betterdesk.crt as trusted CA"
            ;;
        *)
            print_warning "Invalid option"
            press_enter
            return
            ;;
    esac
    
    echo ""
    if confirm "Restart Docker containers to apply SSL changes?"; then
        stop_containers
        start_containers
        print_success "Docker containers restarted with new SSL configuration"
    fi
    
    press_enter
}

# Helper function to configure SSL in docker-compose
configure_docker_ssl() {
    local ssl_dir="$1"
    local mode="${2:-standard}"  # standard, enterprise, disable
    
    if [ "$mode" = "disable" ]; then
        # Remove SSL configuration from docker-compose
        if [ -f "$COMPOSE_FILE" ]; then
            # Remove TLS flags from server service
            sed -i 's/ -tls-cert [^ ]*//g' "$COMPOSE_FILE"
            sed -i 's/ -tls-key [^ ]*//g' "$COMPOSE_FILE"
            sed -i 's/ -tls-signal//g' "$COMPOSE_FILE"
            sed -i 's/ -tls-relay//g' "$COMPOSE_FILE"
            sed -i 's/ -tls-api//g' "$COMPOSE_FILE"
            
            # Update console environment
            sed -i 's/HTTPS_ENABLED=true/HTTPS_ENABLED=false/' "$COMPOSE_FILE"
            sed -i '/SSL_CERT_PATH/d' "$COMPOSE_FILE"
            sed -i '/SSL_KEY_PATH/d' "$COMPOSE_FILE"
            sed -i '/ALLOW_SELF_SIGNED_CERTS/d' "$COMPOSE_FILE"
            sed -i '/ENTERPRISE_TLS/d' "$COMPOSE_FILE"
        fi
        return
    fi
    
    # For standard and enterprise modes, regenerate compose file with SSL settings
    # Store SSL configuration for compose file generation
    export SSL_ENABLED=true
    export SSL_DIR="$ssl_dir"
    
    if [ "$mode" = "enterprise" ]; then
        export ENTERPRISE_TLS=true
    else
        export ENTERPRISE_TLS=false
    fi
    
    # Regenerate docker-compose.yml with SSL settings
    create_compose_file
}

#===============================================================================
# Main Menu
#===============================================================================

show_menu() {
    print_header
    print_status
    
    echo -e "${WHITE}${BOLD}══════════ MAIN MENU (Docker) ══════════${NC}"
    echo ""
    echo "  1. 🚀 Fresh Installation"
    echo "  2. ⬆️  Update"
    echo "  3. 🔧 Repair"
    echo "  4. ✅ Validation"
    echo "  5. 💾 Backup"
    echo "  6. 🔐 Reset admin password"
    echo "  7. 🔨 Build images"
    echo "  8. 📊 Diagnostics"
    echo "  9. 🗑️  UNINSTALL"
    echo ""
    echo "  C. 🔒 Configure SSL/TLS"
    echo "  M. 🔄 Migrate from existing RustDesk"
    echo "  P. 🐘 Migrate SQLite → PostgreSQL"
    echo "  S. ⚙️  Settings (paths)"
    echo "  0. ❌ Exit"
    echo ""
}

main() {
    # Check root for some operations
    if [ "$EUID" -ne 0 ]; then
        print_warning "Some operations may require root privileges (sudo)"
    fi
    
    # Check docker compose. Diagnostics can still return useful evidence without
    # Compose, but repair actions need it for safe stack restarts.
    if ! check_docker_compose; then
        if [ "$CLI_ACTION" = "diagnose" ]; then
            print_warning "Docker Compose is not available; diagnostics will be partial"
            COMPOSE_CMD="docker compose"
        else
            print_error "Docker Compose is not available!"
            exit 1
        fi
    fi
    
    # Auto-detect paths on startup
    echo -e "${CYAN}Detecting installation...${NC}"
    auto_detect_docker_paths
    echo ""

    if [ "$NONINTERACTIVE" != true ]; then
        sleep 1
    fi

    case "$CLI_ACTION" in
        rescue)
            do_safe_rescue
            exit $?
            ;;
        diagnose)
            print_rescue_diagnostics
            exit $?
            ;;
        repair-permissions)
            repair_docker_permissions
            exit $?
            ;;
    esac
    
    # Action tokens map 1:1 to the classic case dispatch below, so both the
    # arrow-key TUI and the numeric fallback share the exact same handlers.
    local menu_labels=(
        $'Fresh installation\tFull Docker install from scratch'
        $'Update\tUpdate an existing installation'
        $'Repair\tFix common problems'
        $'Validate\tCheck correctness'
        $'Backup\tCreate a backup'
        $'Reset admin password\tReset the console admin'
        $'Build images\tRebuild Docker images'
        $'Diagnostics\tDetailed problem analysis'
        $'Uninstall\tRemove BetterDesk'
        $'Configure SSL/TLS\tEnable HTTPS for the panel'
        $'Migrate from RustDesk\tImport an existing RustDesk deployment'
        $'SQLite -> PostgreSQL\tMigrate the database backend'
        $'Settings (paths)\tConfigure install paths'
        $'Exit\tQuit the manager'
    )
    local menu_actions=( 1 2 3 4 5 6 7 8 9 C M P S 0 )

    while true; do
        local choice=""
        if tui_available; then
            local status_line="Docker Compose manager v${VERSION}"
            [ -n "$DATA_DIR" ] && status_line="$status_line  |  data: ${DATA_DIR}"
            if tui_select "BetterDesk Console Manager (Docker)" "$status_line" "${menu_labels[@]}"; then
                choice="${menu_actions[$TUI_RESULT]}"
            else
                choice="0"
            fi
        else
            show_menu
            read -p "Select option: " choice
        fi

        case $choice in
            1) do_install ;;
            2) do_update ;;
            3) do_repair ;;
            4) do_validate ;;
            5) do_backup ;;
            6) do_reset_password ;;
            7) do_build ;;
            8) do_diagnostics ;;
            9) do_uninstall ;;
            [Cc]) do_configure_ssl ;;
            [Mm]) do_migrate ;;
            [Pp]) do_migrate_postgresql ;;
            [Ss]) configure_docker_paths ;;
            0) 
                echo ""
                print_info "Goodbye!"
                exit 0
                ;;
            *)
                print_warning "Invalid option"
                sleep 1
                ;;
        esac
    done
}

# Run
parse_cli_args "$@"
main "$@"
