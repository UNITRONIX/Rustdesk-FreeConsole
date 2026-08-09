#!/bin/bash
#===============================================================================
#
#   BetterDesk Console Manager v3.5.40
#   All-in-One Interactive Tool for Linux
#
#   Features:
#     - Fresh installation (Node.js web console)
#     - Minimal installation (Go server only, no web console)
#     - Update existing installation  
#     - Repair/fix issues (enhanced with graceful shutdown)
#     - Validate installation
#     - Backup & restore
#     - Reset admin password
#     - Build & deploy server (rebuild Go binary with rollback)
#     - Full diagnostics
#     - SHA256 binary verification
#     - Auto mode (non-interactive)
#     - Enhanced service management with health verification
#     - Port conflict detection
#     - Fixed ban system (device-specific, not IP-based)
#     - RustDesk Client API (login, address book sync)
#     - TOTP Two-Factor Authentication
#     - SSL/TLS certificate configuration
#     - PostgreSQL database support
#     - SQLite to PostgreSQL migration
#     - CDAP (Custom Device API Protocol) support
#
#   Usage: 
#     Interactive: sudo ./betterdesk.sh
#     Auto mode:   sudo ./betterdesk.sh --auto
#     PostgreSQL:  sudo ./betterdesk.sh --auto --postgresql
#
#===============================================================================

set -e

# Version
VERSION="3.5.40"
# Bump when installer control-flow changes must apply mid-session after Update (#219).
BETTERDESK_SH_REVISION="20260725-console-start-306"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Preserve argv before shift — used to re-exec after installer self-update (#219).
BETTERDESK_ORIG_ARGV=("$@")

# Auto mode flag
AUTO_MODE=false
SKIP_VERIFY=false
MINIMAL_MODE=false
PREFERRED_CONSOLE_TYPE="nodejs"  # Always Node.js (Flask removed in v2.3.0)

# Relay server selection mode:
#   auto   - detect public IP (default, best for internet-facing servers)
#   local  - use the server's LAN IP (best for LAN-only deployments)
#   public - force public IP detection
# RELAY_SERVERS env var (or --relay-servers) always overrides this with a fixed value.
RELAY_MODE="${RELAY_MODE:-auto}"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --auto|-a)
            AUTO_MODE=true
            shift
            ;;
        --skip-verify)
            SKIP_VERIFY=true
            shift
            ;;
        --minimal)
            MINIMAL_MODE=true
            shift
            ;;
        --nodejs)
            PREFERRED_CONSOLE_TYPE="nodejs"
            shift
            ;;
        --postgresql|--postgres)
            USE_POSTGRESQL=true
            shift
            ;;
        --relay-mode)
            RELAY_MODE="$2"
            if [ "$RELAY_MODE" != "auto" ] && [ "$RELAY_MODE" != "local" ] && [ "$RELAY_MODE" != "lan" ] && [ "$RELAY_MODE" != "public" ] && [ "$RELAY_MODE" != "wan" ]; then
                echo "ERROR: --relay-mode must be 'auto', 'local' (lan) or 'public' (wan)"
                exit 1
            fi
            shift 2
            ;;
        --relay-servers|--relay)
            RELAY_SERVERS="$2"
            shift 2
            ;;
        --protocol)
            PROTOCOL_MODE="$2"
            if [ "$PROTOCOL_MODE" != "http" ] && [ "$PROTOCOL_MODE" != "https" ]; then
                echo "ERROR: --protocol must be 'http' or 'https'"
                exit 1
            fi
            shift 2
            ;;
        --pg-uri)
            POSTGRESQL_URI="$2"
            USE_POSTGRESQL=true
            shift 2
            ;;
        --flask)
            echo "WARNING: Flask console is deprecated and no longer available in v2.3.0"
            echo "Node.js console will be installed instead."
            PREFERRED_CONSOLE_TYPE="nodejs"
            shift
            ;;
        --help|-h)
            echo "BetterDesk Console Manager v$VERSION"
            echo ""
            echo "Usage: sudo ./betterdesk.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --auto, -a       Run in automatic mode (non-interactive)"
            echo "  --skip-verify    Skip SHA256 verification of binaries"
            echo "  --minimal        Install Go server only (no web console)"
            echo "  --nodejs         Install Node.js web console (default)"
            echo "  --postgresql     Use PostgreSQL instead of SQLite"
            echo "  --pg-uri URI     PostgreSQL connection URI (implies --postgresql)"
            echo "  --protocol MODE  Set protocol mode: 'http' or 'https'"
            echo "  --relay-mode M   Relay IP selection: 'auto' (public, default), 'local' (LAN), 'public'"
            echo "  --relay-servers IP  Force a fixed relay server address (IP or host[:port])"
            echo "  --help, -h       Show this help message"
            echo ""
            echo "Environment variables:"
            echo "  USE_POSTGRESQL=true     Use PostgreSQL"
            echo "  POSTGRESQL_URI=...      PostgreSQL connection URI"
            echo "  POSTGRESQL_USER=...     PostgreSQL username (default: betterdesk)"
            echo "  POSTGRESQL_PASS=...     PostgreSQL password (auto-generated if empty)"
            echo "  POSTGRESQL_DB=...       PostgreSQL database (default: betterdesk)"
            echo "  POSTGRESQL_HOST=...     PostgreSQL host (default: localhost)"
            echo "  POSTGRESQL_PORT=...     PostgreSQL port (default: 5432)"
            echo "  RELAY_MODE=auto|local|public  Relay IP selection mode (default: auto)"
            echo "  RELAY_SERVERS=...       Force a fixed relay server address (overrides RELAY_MODE)"
            echo "  STORE_ADMIN_CREDENTIALS=true  Persist admin password to .admin_credentials (not recommended)"
            echo "  ADMIN_PASSWORD=...      Set custom admin password (default: auto-generated)"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Go server source directory
GO_SERVER_SOURCE="$SCRIPT_DIR/betterdesk-server"

# Minimum Go version required for compilation
GO_MIN_VERSION="1.25"
# Point release downloaded when system Go is missing/outdated (must exist on go.dev/dl).
GO_DOWNLOAD_VERSION="1.26.4"

# Default paths (can be overridden by environment variables)
RUSTDESK_PATH="${RUSTDESK_PATH:-}"
CONSOLE_PATH="${CONSOLE_PATH:-}"
CONSOLE_TYPE="none"  # none, nodejs
BACKUP_DIR="${BACKUP_DIR:-/opt/rustdesk-backups}"

# API (v3): handlers on Go (GO_API_PORT 21114, default/direct). :21121 is Node
# reverse-proxy for backward compatibility only. Panel is management UI (:5000).
GO_API_PORT="${GO_API_PORT:-21114}"
CLIENT_API_PORT="${CLIENT_API_PORT:-21121}"
API_PORT="${API_PORT:-$GO_API_PORT}"
STORE_ADMIN_CREDENTIALS="${STORE_ADMIN_CREDENTIALS:-false}"

# Database configuration
USE_POSTGRESQL="${USE_POSTGRESQL:-false}"  # true = PostgreSQL, false = SQLite
POSTGRESQL_URI="${POSTGRESQL_URI:-}"       # postgres://user:pass@host:5432/dbname
POSTGRESQL_USER="${POSTGRESQL_USER:-betterdesk}"
POSTGRESQL_PASS="${POSTGRESQL_PASS:-}"
POSTGRESQL_DB="${POSTGRESQL_DB:-betterdesk}"
POSTGRESQL_HOST="${POSTGRESQL_HOST:-localhost}"
POSTGRESQL_PORT="${POSTGRESQL_PORT:-5432}"

# Common installation paths to search
COMMON_RUSTDESK_PATHS=(
    "/opt/betterdesk"
    "/opt/rustdesk"
    "/usr/local/rustdesk"
    "/var/lib/rustdesk"
    "/home/rustdesk"
    "$HOME/rustdesk"
)

COMMON_CONSOLE_PATHS=(
    "/opt/BetterDeskConsole"
    "/opt/betterdesk"
    "/var/lib/betterdesk"
    "$HOME/BetterDeskConsole"
)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
WHITE='\033[1;37m'
NC='\033[0m' # No Color
BOLD='\033[1m'
DIM='\033[2m'

# Logging
LOG_FILE="/tmp/betterdesk_$(date +%Y%m%d_%H%M%S).log"

#===============================================================================
# Helper Functions
#===============================================================================

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

print_header() {
    clear
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
    echo "║                  Console Manager v${VERSION}                     ║"
    echo "╚══════════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

print_success() { echo -e "${GREEN}✓${NC} $1"; log "SUCCESS: $1"; }
print_error() { echo -e "${RED}✗${NC} $1"; log "ERROR: $1"; }
print_warning() { echo -e "${YELLOW}!${NC} $1"; log "WARNING: $1"; }
print_info() { echo -e "${BLUE}ℹ${NC} $1"; log "INFO: $1"; }
print_step() { echo -e "${MAGENTA}▶${NC} $1"; log "STEP: $1"; }

press_enter() {
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
# Returns 0 on selection, 1 when TUI is unavailable (caller falls back to text).
TUI_RESULT=""

# Detect whether the modern arrow-key interface can be used.
tui_available() {
    [ "${BETTERDESK_CLASSIC_MENU:-0}" = "1" ] && return 1
    [ -t 0 ] && [ -t 1 ] || return 1
    return 0
}

# Cleanup helper: always restore the cursor when leaving the TUI.
_tui_restore() { printf '\033[?25h' 2>/dev/null; stty echo 2>/dev/null; }

# tui_select "Title" "Subtitle" item1 item2 ...
# Each item may embed a description after a literal $'\t' (tab).
# Navigation: ↑/↓ or k/j to move, Enter/→ to choose, q/Esc/0 to cancel.
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

    printf '\033[?25l'                       # hide cursor
    trap '_tui_restore' INT TERM

    clear
    while true; do
        # Build the whole frame in a single buffer, then emit it with one
        # write. Terminals (notably the VS Code integrated terminal with GPU
        # acceleration) drop individual glyphs when a full-screen TUI is redrawn
        # via many separate printf calls after each keypress. One write avoids it.
        local buf=""
        buf+="\033[H"   # move cursor home instead of clearing (less flicker)
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
            # Manual padding by character count keeps columns aligned reliably.
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
        buf+="\033[J"   # clear anything below the menu

        printf '%b' "$buf"

        # Read a single keypress (with escape-sequence handling)
        IFS= read -rsn1 key 2>/dev/null
        if [[ "$key" == $'\033' ]]; then
            read -rsn2 -t 0.05 rest 2>/dev/null
            key+="$rest"
        fi

        case "$key" in
            $'\033[A'|'k') sel=$(( (sel - 1 + count) % count )) ;;
            $'\033[B'|'j') sel=$(( (sel + 1) % count )) ;;
            ''|$'\033[C') TUI_RESULT="$sel"; _tui_restore; trap - INT TERM; return 0 ;;  # Enter / →
            'q'|'Q'|'0'|$'\033') TUI_RESULT=""; _tui_restore; trap - INT TERM; return 2 ;;
            [1-9])
                # Numeric shortcut jumps straight to that 1-based entry
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
# ui_panel_header "Title" "Subtitle"
# Draws a clean ASCII box header (single buffered write to avoid glyph drops).
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

# ui_section "Title"  — a lightweight section divider for output screens.
ui_section() {
    echo ""
    echo -e "  ${CYAN}${BOLD}== $1 ==${NC}"
    echo ""
}

# menu_choose "Title" "Subtitle"
# Caller must pre-populate two parallel arrays:
#   _menu_items=( "Label\tDescription" ... )   # what the user sees
#   _menu_returns=( "1" "2" ... "0" )          # value returned for each entry
# The chosen value is stored in MENU_CHOICE. On cancel (q/Esc) the LAST entry's
# value is returned (by convention the final item is "Back"/"Exit").
# Uses the arrow-key TUI when available, otherwise a styled numeric menu.
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

    # Styled numeric fallback (no TTY / classic mode)
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

# Detect the server's primary LAN/private IPv4 address.
# Used for LAN-only deployments where the public IP is unreachable by clients.
get_local_ip() {
    local ip
    # Primary: source address used to reach the default gateway
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' | head -1)
    [ -n "$ip" ] && echo "$ip" && return
    # Fallback: first non-loopback global-scope address
    ip=$(ip -4 addr show scope global 2>/dev/null | grep -oP 'inet \K[0-9.]+' | head -1)
    [ -n "$ip" ] && echo "$ip" && return
    # Last resort: hostname resolution
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ -n "$ip" ] && echo "$ip" && return
    echo "127.0.0.1"
}

# Resolve P2P/relay connection strategy env vars for systemd/NSSM (issue #157).
resolve_connection_mode_env() {
    CONNECTION_MODE="${CONNECTION_MODE:-p2p_first}"
    if [ "$AUTO_MODE" = false ] && [ -z "$CONNECTION_MODE_SET" ]; then
        echo ""
        print_info "Connection strategy: P2P hole punch vs relay-only routing."
        echo -e "  ${CYAN}1)${NC} P2P first (recommended) — try direct connection, fall back to relay"
        echo -e "  ${CYAN}2)${NC} Relay only — route all sessions through the relay server"
        echo -ne "  ${CYAN}Select connection mode [1]:${NC} "
        read -r _conn_choice
        case "$_conn_choice" in
            2) CONNECTION_MODE="relay_only" ;;
            *) CONNECTION_MODE="p2p_first" ;;
        esac
        echo ""
    fi

    P2P_FALLBACK_MS="${P2P_FALLBACK_MS:-2000}"
    SAME_NAT_RELAY="${SAME_NAT_RELAY:-Y}"

    case "$CONNECTION_MODE" in
        relay_only)
            P2P_FIRST_ENV=N
            ALWAYS_USE_RELAY_ENV=Y
            ;;
        *)
            P2P_FIRST_ENV=Y
            ALWAYS_USE_RELAY_ENV=N
            ;;
    esac

    CONNECTION_MODE_ENV_BLOCK="Environment=P2P_FIRST=$P2P_FIRST_ENV
Environment=ALWAYS_USE_RELAY=$ALWAYS_USE_RELAY_ENV
Environment=P2P_FALLBACK_MS=$P2P_FALLBACK_MS
Environment=SAME_NAT_RELAY=$SAME_NAT_RELAY"
    print_info "Connection mode: ${CONNECTION_MODE} (P2P_FIRST=$P2P_FIRST_ENV, ALWAYS_USE_RELAY=$ALWAYS_USE_RELAY_ENV)"
}

# Resolve the relay server address according to RELAY_MODE / RELAY_SERVERS.
# Prints the resolved address to stdout; warnings/info go to stderr so the
# captured value (server_ip=$(resolve_relay_ip)) stays clean.
resolve_relay_ip() {
    # Explicit override always wins
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
            # Warn if auto-detection returned a private/loopback address — relay
            # will not work for remote clients unless this is a LAN-only setup.
            if [ "$ip" = "127.0.0.1" ] || [[ "$ip" == 10.* ]] || [[ "$ip" == 192.168.* ]] || [[ "$ip" == 172.1[6-9].* ]] || [[ "$ip" == 172.2[0-9].* ]] || [[ "$ip" == 172.3[0-1].* ]]; then
                echo "WARNING: Auto-detected private/loopback IP: $ip" >&2
                echo "WARNING: Remote (internet) clients will NOT connect via relay with this address." >&2
                echo "         For LAN-only use, this is fine. For internet access, run with:" >&2
                echo "           --relay-servers YOUR.PUBLIC.IP   (or RELAY_SERVERS env var)" >&2
                echo "         To silence this and use the LAN IP explicitly, run with:" >&2
                echo "           --relay-mode local" >&2
            fi
            ;;
    esac
    echo "$ip"
}

sql_escape_literal() {
    # Escape single quotes for SQL string literals: ' -> ''
    local value="$1"
    printf "%s" "${value//\'/\'\'}"
}

is_valid_pg_identifier() {
    # PostgreSQL unquoted identifier compatible pattern.
    # Keeps installation scripts safe from SQL injection in CREATE/ALTER statements.
    local ident="$1"
    [[ "$ident" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]
}

#===============================================================================
# Service Management Functions (Enhanced v2.1.2)
#===============================================================================

# Wait for a service to fully stop with timeout
wait_for_service_stop() {
    local service_name="$1"
    local timeout="${2:-30}"
    local elapsed=0
    
    while [ $elapsed -lt $timeout ]; do
        if ! systemctl is-active --quiet "$service_name" 2>/dev/null; then
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    
    print_warning "Service $service_name did not stop within ${timeout}s"
    return 1
}

# Kill any stale processes that might be holding files/ports
# Free BetterDesk ports when systemd stop left orphan listeners (#219).
kill_processes_holding_ports() {
    local port pids
    for port in 21116 21117 5000 5443; do
        if ! ss -tlnH 2>/dev/null | grep -q ":${port} "; then
            continue
        fi
        pids=$(lsof -t -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)
        if [ -n "$pids" ]; then
            print_warning "Port ${port} still in use (pids: $pids) — terminating (#219)"
            for pid in $pids; do
                kill -TERM "$pid" 2>/dev/null || true
            done
            sleep 1
            pids=$(lsof -t -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)
            if [ -n "$pids" ]; then
                for pid in $pids; do
                    kill -9 "$pid" 2>/dev/null || true
                done
            fi
        elif command -v fuser &>/dev/null; then
            fuser -k "${port}/tcp" 2>/dev/null || true
        fi
    done
    sleep 1
}

kill_stale_processes() {
    local process_name="$1"

    # Find and kill any remaining processes
    local pids=$(pgrep -f "$process_name" 2>/dev/null || true)
    
    if [ -n "$pids" ]; then
        print_warning "Found stale $process_name processes: $pids"
        
        # Try graceful termination first
        for pid in $pids; do
            kill -TERM "$pid" 2>/dev/null || true
        done
        sleep 2
        
        # Force kill if still running
        pids=$(pgrep -f "$process_name" 2>/dev/null || true)
        if [ -n "$pids" ]; then
            for pid in $pids; do
                kill -9 "$pid" 2>/dev/null || true
            done
            sleep 1
        fi
        
        print_info "Cleaned up stale $process_name processes"
    fi
}

# Check if a port is available
check_port_available() {
    local port="$1"
    local service_name="${2:-unknown}"
    
    if ss -tlnp 2>/dev/null | grep -q ":${port} " || \
       netstat -tlnp 2>/dev/null | grep -q ":${port} "; then
        local process=$(ss -tlnp 2>/dev/null | grep ":${port} " | awk '{print $NF}' || \
                       netstat -tlnp 2>/dev/null | grep ":${port} " | awk '{print $NF}')
        print_error "Port $port is already in use by: $process"
        return 1
    fi
    return 0
}

# Verify that a service is healthy (running and listening on expected port)
_tcp_port_is_listening() {
    local port="$1"
    # Match :PORT followed by whitespace or end — covers ss/netstat layouts
    # like "0.0.0.0:80", "*:80", "[::]:80" (#219).
    ss -tlnH 2>/dev/null | grep -qE ":${port}([[:space:]]|$)" || \
        ss -tln 2>/dev/null | grep -qE ":${port}([[:space:]]|$)" || \
        netstat -tln 2>/dev/null | grep -qE ":${port}([[:space:]]|$)"
}

# Hint when .env requests a privileged panel port but Node bound a fallback (#219).
_hint_panel_privileged_port_mismatch() {
    local expected_port="$1"
    local https_enabled
    https_enabled=$(read_effective_console_setting HTTPS_ENABLED false)

    if [ "$(echo "$https_enabled" | tr '[:upper:]' '[:lower:]')" != "true" ]; then
        return 0
    fi

    if [ "$expected_port" = "443" ] && _tcp_port_is_listening 5443; then
        print_info "  Panel is listening on :5443 instead of configured :443"
        print_info "  → Run Repair → Repair permissions (adds CAP_NET_BIND_SERVICE), then restart betterdesk-console"
        print_info "  → Or set HTTPS_PORT=5443 and use a reverse proxy on :443 (docs/setup/REVERSE_PROXY.md)"
        return 0
    fi

    if [ "$expected_port" = "80" ] && _tcp_port_is_listening 5000; then
        print_info "  HTTP redirect is on :5000 instead of configured :80 — set PORT=80 and run Repair → Repair permissions"
    fi
}

verify_service_health() {
    local service_name="$1"
    local expected_port="$2"
    local timeout="${3:-10}"
    local elapsed=0
    
    # First check if service is active
    if ! systemctl is-active --quiet "$service_name" 2>/dev/null; then
        print_error "Service $service_name is not running"
        show_service_logs "$service_name" 20
        return 1
    fi
    
    # If port specified, wait for it to be bound
    if [ -n "$expected_port" ]; then
        while [ $elapsed -lt $timeout ]; do
            if _tcp_port_is_listening "$expected_port"; then
                return 0
            fi
            sleep 1
            elapsed=$((elapsed + 1))
        done
        
        print_error "Service $service_name is running but not listening on port $expected_port"
        if [ "$service_name" = "betterdesk-console" ]; then
            _hint_panel_privileged_port_mismatch "$expected_port"
        fi
        show_service_logs "$service_name" 20
        return 1
    fi
    
    return 0
}

# Show recent service logs for debugging
show_service_logs() {
    local service_name="$1"
    local lines="${2:-30}"
    
    echo ""
    echo -e "${YELLOW}═══ Recent logs for $service_name ═══${NC}"
    journalctl -u "$service_name" -n "$lines" --no-pager 2>/dev/null || \
        print_warning "Could not retrieve logs for $service_name"
    echo -e "${YELLOW}═══════════════════════════════════════${NC}"
    echo ""
}

# Gracefully stop all BetterDesk services with proper cleanup
graceful_stop_services() {
    print_step "Stopping services gracefully..."
    
    # New Go services (primary)
    local services=("betterdesk-console" "betterdesk-server")
    # Legacy services (for migration)
    local legacy_services=("betterdesk" "rustdesksignal" "rustdeskrelay" "betterdesk-api" "betterdesk-go")
    
    # Stop current services
    for service in "${services[@]}"; do
        if systemctl is-active --quiet "$service" 2>/dev/null; then
            print_info "Stopping $service..."
            systemctl stop "$service" 2>/dev/null || true
        fi
    done
    
    # Stop legacy services if they exist
    for service in "${legacy_services[@]}"; do
        if systemctl is-active --quiet "$service" 2>/dev/null; then
            print_info "Stopping legacy $service..."
            systemctl stop "$service" 2>/dev/null || true
        fi
    done
    
    # Wait for services to stop
    for service in "${services[@]}" "${legacy_services[@]}"; do
        wait_for_service_stop "$service" 15
    done
    
    # Kill any stale processes (Go and legacy Rust)
    kill_stale_processes "betterdesk-server"
    kill_stale_processes "hbbs"
    kill_stale_processes "hbbr"
    kill_processes_holding_ports
    
    print_success "All services stopped"
}

# Read console setting with systemd Environment= overriding .env (matches runtime order).
# Prefer .env over unit Environment= — matches systemd EnvironmentFile= precedence
# (EnvironmentFile overrides Environment=). Stale Environment=PORT=5000 must not
# win over .env PORT=80 when probing redirect / panel ports (#219).
read_effective_console_setting() {
    local key="$1"
    local default="${2:-}"
    local svc_file="/etc/systemd/system/betterdesk-console.service"
    local env_file="${CONSOLE_PATH}/.env"
    local val=""

    if [ -f "$env_file" ]; then
        val=$(grep -m1 "^${key}=" "$env_file" 2>/dev/null | cut -d= -f2- | tr -d '[:space:]')
    fi
    if [ -z "$val" ] && [ -f "$svc_file" ]; then
        val=$(grep -E "^Environment=${key}=" "$svc_file" 2>/dev/null | tail -1 | sed "s/^Environment=${key}=//")
    fi
    if [ -z "$val" ]; then
        val="$default"
    fi
    echo "$val"
}

# Keep betterdesk-console.service Environment=PORT/HTTPS_PORT aligned with .env (#219).
_sync_console_panel_ports_to_systemd() {
    local svc_file="/etc/systemd/system/betterdesk-console.service"
    local env_file="${CONSOLE_PATH}/.env"
    local http_port https_port changed=0

    [ -f "$svc_file" ] || return 1

    http_port=$(grep -m1 '^PORT=' "$env_file" 2>/dev/null | cut -d= -f2- | tr -d '[:space:]')
    https_port=$(grep -m1 '^HTTPS_PORT=' "$env_file" 2>/dev/null | cut -d= -f2- | tr -d '[:space:]')
    [ -n "$http_port" ] || http_port="5000"
    [ -n "$https_port" ] || https_port="5443"

    if ! grep -qE "^Environment=PORT=${http_port}$" "$svc_file" 2>/dev/null; then
        _upsert_systemd_env "$svc_file" PORT "$http_port"
        changed=1
    fi
    if [ "$(read_effective_console_setting HTTPS_ENABLED false | tr '[:upper:]' '[:lower:]')" = "true" ]; then
        if ! grep -qE "^Environment=HTTPS_PORT=${https_port}$" "$svc_file" 2>/dev/null; then
            _upsert_systemd_env "$svc_file" HTTPS_PORT "$https_port"
            changed=1
        fi
    fi

    if [ "$changed" -eq 1 ]; then
        systemctl daemon-reload 2>/dev/null || true
        return 0
    fi
    return 1
}

_upsert_env_line() {
    local file="$1" key="$2" value="$3"
    [ -f "$file" ] || touch "$file"
    if grep -q "^${key}=" "$file" 2>/dev/null; then
        sed -i "s|^${key}=.*|${key}=${value}|" "$file"
    else
        echo "${key}=${value}" >> "$file"
    fi
}

_remove_env_line() {
    local file="$1" key="$2"
    [ -f "$file" ] && sed -i "/^${key}=/d" "$file"
}

_upsert_systemd_env() {
    local file="$1" key="$2" value="$3"
    [ -f "$file" ] || return 0
    if grep -q "Environment=${key}=" "$file" 2>/dev/null; then
        sed -i "s|Environment=${key}=.*|Environment=${key}=${value}|" "$file"
    else
        sed -i "/^\[Service\]/a Environment=${key}=${value}" "$file"
    fi
}

_remove_systemd_env() {
    local file="$1" key="$2"
    [ -f "$file" ] && sed -i "/Environment=${key}=/d" "$file"
}

# Infer RUSTDESK_API_TLS / ALLOW_SELF_SIGNED_CERTS from certificate path (LE vs self-signed).
infer_tls_mode_from_cert() {
    local cert_path="$1"
    local resolved
    resolved=$(readlink -f "$cert_path" 2>/dev/null || echo "$cert_path")
    if [[ "$resolved" == *"/etc/letsencrypt/"* ]]; then
        INFERRED_RUSTDESK_API_TLS="true"
        INFERRED_ALLOW_SELF_SIGNED="false"
    else
        INFERRED_RUSTDESK_API_TLS="false"
        INFERRED_ALLOW_SELF_SIGNED="true"
    fi
}

# Resolve Let's Encrypt live/ dir from .env, paths, symlinks, LE_CERT_DOMAIN, or cert SAN (#219).
resolve_le_cert_live_dir() {
    local env_file="${1:-${CONSOLE_PATH}/.env}"
    local cert_hint="${2:-$RUSTDESK_PATH/ssl/betterdesk.crt}"
    local ssl_key_env ssl_cert_env le_live_dir le_domain dns_name

    le_live_dir=$(grep -m1 '^LE_CERT_LIVE_DIR=' "$env_file" 2>/dev/null | cut -d= -f2- || true)
    ssl_cert_env=$(grep -m1 '^SSL_CERT_PATH=' "$env_file" 2>/dev/null | cut -d= -f2- || true)
    ssl_key_env=$(grep -m1 '^SSL_KEY_PATH=' "$env_file" 2>/dev/null | cut -d= -f2- || true)

    if [ -z "$le_live_dir" ] && [[ "$ssl_cert_env" == *"/etc/letsencrypt/"* ]]; then
        le_live_dir=$(dirname "$(readlink -f "$ssl_cert_env" 2>/dev/null || echo "$ssl_cert_env")")
    fi
    if [ -z "$le_live_dir" ] && [[ "$ssl_key_env" == *"/etc/letsencrypt/"* ]]; then
        le_live_dir=$(dirname "$(readlink -f "$ssl_key_env" 2>/dev/null || echo "$ssl_key_env")")
    fi
    if [ -z "$le_live_dir" ] && [ -L "$cert_hint" ]; then
        le_live_dir=$(dirname "$(readlink -f "$cert_hint" 2>/dev/null || echo "")")
    fi
    if [ -z "$le_live_dir" ]; then
        le_domain=$(grep -m1 '^LE_CERT_DOMAIN=' "$env_file" 2>/dev/null | cut -d= -f2- || true)
        if [ -n "$le_domain" ] && [ -d "/etc/letsencrypt/live/$le_domain" ]; then
            le_live_dir="/etc/letsencrypt/live/$le_domain"
        fi
    fi
    if [ -z "$le_live_dir" ] && [ -f "$cert_hint" ] && command -v openssl &>/dev/null; then
        dns_name=$(openssl x509 -in "$cert_hint" -noout -ext subjectAltName 2>/dev/null | \
            grep -oE 'DNS:[^, ]+' | head -1 | cut -d: -f2- || true)
        if [ -n "$dns_name" ] && [ -d "/etc/letsencrypt/live/$dns_name" ]; then
            le_live_dir="/etc/letsencrypt/live/$dns_name"
        fi
    fi
    echo "$le_live_dir"
}

# Copy a TLS file to dest as a real file (not a symlink).
# - If dest is already the same real file as src (self-signed generated in place),
#   do nothing — deleting dest would remove src and break cp (#325, discussion #322).
# - If dest is a symlink that resolves to src (LE live dir), remove the symlink
#   and copy content so the console user can read it (#219).
_safe_cp_tls_file() {
    local src="$1"
    local dest="$2"
    local src_real dest_real tmp

    [ -f "$src" ] || return 1
    src_real=$(readlink -f "$src" 2>/dev/null || echo "$src")
    if [ -e "$dest" ]; then
        dest_real=$(readlink -f "$dest" 2>/dev/null || echo "$dest")
        if [ "$src_real" = "$dest_real" ]; then
            if [ -L "$dest" ]; then
                # Symlink to src → replace with a real copy (#219)
                rm -f "$dest"
            else
                # Already a real file at dest (self-signed path) — no copy needed (#325)
                return 0
            fi
        fi
    fi
    tmp="${dest}.betterdesk.$$.tmp"
    cp -L "$src" "$tmp" || return 1
    mv -f "$tmp" "$dest" || { rm -f "$tmp"; return 1; }
    return 0
}

# Ensure Go signal/relay/API ports are not overridden by shared .env (#219).
ensure_go_server_signal_ports() {
    local go_svc_file="/etc/systemd/system/betterdesk-server.service"
    local changed=0
    local go_api_port="${GO_API_PORT:-21114}"

    [ -f "$go_svc_file" ] || return 1

    if ! grep -q '^Environment=SIGNAL_PORT=21116' "$go_svc_file" 2>/dev/null; then
        _upsert_systemd_env "$go_svc_file" SIGNAL_PORT 21116
        changed=1
    fi
    if ! grep -q '^Environment=RELAY_PORT=21117' "$go_svc_file" 2>/dev/null; then
        _upsert_systemd_env "$go_svc_file" RELAY_PORT 21117
        changed=1
    fi
    if ! grep -q "^Environment=GO_API_PORT=${go_api_port}" "$go_svc_file" 2>/dev/null; then
        _upsert_systemd_env "$go_svc_file" GO_API_PORT "$go_api_port"
        changed=1
    fi
    if [ -f "$go_svc_file" ] && grep -qE '\-api-port[[:space:]]+21121\b' "$go_svc_file" 2>/dev/null; then
        print_info "Migrating Go -api-port 21121 → ${go_api_port} (handlers on Go; clients stay on :${CLIENT_API_PORT:-21121} proxy)"
        sed -i "s/-api-port 21121/-api-port ${go_api_port}/" "$go_svc_file"
        changed=1
    fi
    if [ "$changed" -eq 1 ]; then
        systemctl daemon-reload 2>/dev/null || true
        print_info "Go server uses SIGNAL_PORT=21116, GO_API_PORT=${go_api_port} (panel PORT/API_PORT in .env are console-only)"
    fi
    [ "$changed" -eq 1 ]
}

# Copy TLS material into $RUSTDESK_PATH/ssl/ as real files (not symlinks) so the
# betterdesk console user can read them. LE live dirs are root-only (#219).
deploy_ssl_material_to_rustdesk_dir() {
    local cert_src="$1"
    local key_src="$2"
    local le_live_dir="${3:-}"
    local ssl_dir="$RUSTDESK_PATH/ssl"
    local svc_user="betterdesk"
    local env_file="${CONSOLE_PATH}/.env"

    if [ ! -f "$cert_src" ] || [ ! -f "$key_src" ]; then
        print_error "Certificate or key source not found: cert=$cert_src key=$key_src"
        return 1
    fi

    mkdir -p "$ssl_dir"
    if ! _safe_cp_tls_file "$cert_src" "$ssl_dir/betterdesk.crt"; then
        print_error "Failed to deploy certificate to $ssl_dir/betterdesk.crt"
        return 1
    fi
    if ! _safe_cp_tls_file "$key_src" "$ssl_dir/betterdesk.key"; then
        print_error "Failed to deploy private key to $ssl_dir/betterdesk.key"
        return 1
    fi

    if id "$svc_user" &>/dev/null; then
        chown root:"$svc_user" "$ssl_dir/betterdesk.crt" "$ssl_dir/betterdesk.key" 2>/dev/null || true
    fi
    chmod 640 "$ssl_dir/betterdesk.crt" "$ssl_dir/betterdesk.key" 2>/dev/null || true

    if [ -n "$le_live_dir" ]; then
        _upsert_env_line "$env_file" LE_CERT_LIVE_DIR "$le_live_dir"
        _upsert_env_line "$env_file" LE_CERT_DOMAIN "$(basename "$le_live_dir")"
        install_le_certbot_renew_hook
    fi

    return 0
}

# certbot deploy hook: re-copy renewed LE certs then restart BetterDesk services.
install_le_certbot_renew_hook() {
    local hook_dir="/etc/letsencrypt/renewal-hooks/deploy"
    local hook="$hook_dir/betterdesk-reload.sh"
    local conf="$hook_dir/betterdesk-reload.conf"
    mkdir -p "$hook_dir"

    cat > "$conf" <<EOF
RUSTDESK_PATH=${RUSTDESK_PATH}
CONSOLE_PATH=${CONSOLE_PATH}
EOF
    chmod 640 "$conf"

    cat > "$hook" <<'HOOK'
#!/bin/bash
set -euo pipefail
CONF="/etc/letsencrypt/renewal-hooks/deploy/betterdesk-reload.conf"
[ -f "$CONF" ] && . "$CONF"
RUSTDESK_PATH="${RUSTDESK_PATH:-/opt/rustdesk}"
CONSOLE_PATH="${CONSOLE_PATH:-/opt/betterdesk}"
ENV_FILE="$CONSOLE_PATH/.env"
SSL_DIR="$RUSTDESK_PATH/ssl"
SVC_USER="betterdesk"

le_live_dir=""
if [ -f "$ENV_FILE" ]; then
    le_live_dir=$(grep -m1 '^LE_CERT_LIVE_DIR=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
fi
if [ -z "$le_live_dir" ] || [ ! -d "$le_live_dir" ]; then
    echo "betterdesk-reload: LE_CERT_LIVE_DIR missing or invalid — skipping cert copy" >&2
    systemctl restart betterdesk-server betterdesk-console 2>/dev/null || true
    exit 0
fi

mkdir -p "$SSL_DIR"
for pair in "fullchain.pem:betterdesk.crt" "privkey.pem:betterdesk.key"; do
    src_name="${pair%%:*}"
    dest_name="${pair##*:}"
    src="$le_live_dir/$src_name"
    dest="$SSL_DIR/$dest_name"
    src_real=$(readlink -f "$src" 2>/dev/null || echo "$src")
    if [ -e "$dest" ]; then
        dest_real=$(readlink -f "$dest" 2>/dev/null || echo "$dest")
        [ "$src_real" = "$dest_real" ] && rm -f "$dest"
    fi
    tmp="${dest}.betterdesk.$$.tmp"
    cp -L "$src" "$tmp"
    mv -f "$tmp" "$dest"
done
if id "$SVC_USER" &>/dev/null; then
    chown root:"$SVC_USER" "$SSL_DIR/betterdesk.crt" "$SSL_DIR/betterdesk.key"
fi
chmod 640 "$SSL_DIR/betterdesk.crt" "$SSL_DIR/betterdesk.key"
systemctl restart betterdesk-server betterdesk-console 2>/dev/null || true
HOOK
    chmod +x "$hook"
}

# Repair installs that symlinked LE certs into ssl/ (console user cannot read privkey).
maybe_repair_le_ssl_symlinks() {
    local ssl_dir="$RUSTDESK_PATH/ssl"
    local crt="$ssl_dir/betterdesk.crt"
    local key="$ssl_dir/betterdesk.key"
    local env_file="${CONSOLE_PATH}/.env"
    local needs_redeploy="no"
    local ssl_key_env ssl_cert_env
    local console_user="betterdesk"

    for f in "$crt" "$key"; do
        if [ -L "$f" ]; then
            local target
            target=$(readlink -f "$f" 2>/dev/null || readlink "$f" 2>/dev/null || echo "")
            if [[ "$target" == *"/etc/letsencrypt/"* ]]; then
                needs_redeploy="yes"
            fi
        fi
    done

    ssl_key_env=$(grep -m1 '^SSL_KEY_PATH=' "$env_file" 2>/dev/null | cut -d= -f2- || true)
    ssl_cert_env=$(grep -m1 '^SSL_CERT_PATH=' "$env_file" 2>/dev/null | cut -d= -f2- || true)
    if [[ "$ssl_key_env" == *"/etc/letsencrypt/"* ]] || [[ "$ssl_cert_env" == *"/etc/letsencrypt/"* ]]; then
        needs_redeploy="yes"
    fi
    if id "$console_user" &>/dev/null && [ -e "$key" ] \
        && ! runuser -u "$console_user" -- test -r "$key" 2>/dev/null; then
        needs_redeploy="yes"
    fi

    if [ "$needs_redeploy" != "yes" ]; then
        return 2
    fi

    local le_live_dir
    le_live_dir=$(resolve_le_cert_live_dir "$env_file" "$crt")

    if [ -z "$le_live_dir" ] || [ ! -f "$le_live_dir/fullchain.pem" ] || [ ! -f "$le_live_dir/privkey.pem" ]; then
        print_warning "LE certificate symlinks detected but live dir not found — manual repair may be needed"
        return 1
    fi

    print_info "Repairing LE certificate symlinks → copied files for console user (#219)"
    if ! deploy_ssl_material_to_rustdesk_dir "$le_live_dir/fullchain.pem" "$le_live_dir/privkey.pem" "$le_live_dir"; then
        print_error "LE redeploy failed for $le_live_dir — remove symlinks under $ssl_dir and retry"
        return 1
    fi
    _sync_deployed_ssl_paths_to_env
    return 0
}

# When HTTPS uses standard port 443, align HTTP redirect listener to :80 (#219).
_ensure_standard_https_redirect_ports() {
    local env_file="${CONSOLE_PATH}/.env"
    local svc_file="/etc/systemd/system/betterdesk-console.service"
    local https_port http_port https_enabled changed=0
    local svc_port svc_https

    https_enabled=$(read_effective_console_setting HTTPS_ENABLED false)
    if [ "$(echo "$https_enabled" | tr '[:upper:]' '[:lower:]')" != "true" ]; then
        return 1
    fi

    https_port=$(read_effective_console_setting HTTPS_PORT 5443)
    [ "$https_port" = "443" ] || return 1

    http_port=$(read_effective_console_setting PORT 5000)
    if [ "$http_port" != "80" ]; then
        _upsert_env_line "$env_file" PORT 80
        _upsert_env_line "$env_file" HTTP_REDIRECT_HTTPS true
        changed=1
    fi
    if [ -f "$svc_file" ]; then
        svc_port=$(grep -E '^Environment=PORT=' "$svc_file" 2>/dev/null | tail -1 | sed 's/^Environment=PORT=//')
        svc_https=$(grep -E '^Environment=HTTPS_PORT=' "$svc_file" 2>/dev/null | tail -1 | sed 's/^Environment=HTTPS_PORT=//')
        if [ "$svc_port" != "80" ] || [ "$svc_https" != "443" ]; then
            _upsert_systemd_env "$svc_file" HTTPS_PORT 443
            _upsert_systemd_env "$svc_file" PORT 80
            _upsert_systemd_env "$svc_file" HTTP_REDIRECT_HTTPS true
            systemctl daemon-reload 2>/dev/null || true
            changed=1
        fi
    fi
    if [ "$changed" -eq 1 ]; then
        ensure_betterdesk_console_user >/dev/null
        print_info "Standard HTTPS ports synced: HTTPS :443, HTTP redirect :80 (#219)"
        return 0
    fi
    return 1
}

# Repair HTTPS stuck state: Go signal port isolation + LE material redeploy (#219).
repair_https_stuck_state() {
    local quiet="${1:-}"
    local changed=0

    repair_console_service_user_line "betterdesk"

    if ensure_go_server_signal_ports; then
        changed=1
    fi

    local https_enabled
    https_enabled=$(read_effective_console_setting HTTPS_ENABLED false)
    if [ "$(echo "$https_enabled" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
        local le_rc=2
        maybe_repair_le_ssl_symlinks || le_rc=$?
        if [ "$le_rc" -eq 0 ]; then
            changed=1
        elif [ "$le_rc" -ne 2 ] && ensure_console_tls_material_readable; then
            changed=1
        fi
        _sync_deployed_ssl_paths_to_env 2>/dev/null || true
        if _ensure_standard_https_redirect_ports; then
            changed=1
        fi
        if _sync_console_panel_ports_to_systemd; then
            changed=1
        fi
    fi

    if [ "$changed" -eq 1 ] && [ "$quiet" != "yes" ]; then
        print_info "HTTPS/TLS configuration repaired (#219)"
    fi
    return 0
}

# Ensure copied TLS files under $RUSTDESK_PATH/ssl/ are referenced in .env + systemd.
_sync_deployed_ssl_paths_to_env() {
    local ssl_dir="$RUSTDESK_PATH/ssl"
    local env_file="${CONSOLE_PATH}/.env"
    local svc_file="/etc/systemd/system/betterdesk-console.service"

    _upsert_env_line "$env_file" SSL_CERT_PATH "$ssl_dir/betterdesk.crt"
    _upsert_env_line "$env_file" SSL_KEY_PATH "$ssl_dir/betterdesk.key"
    if [ -f "$svc_file" ]; then
        _upsert_systemd_env "$svc_file" SSL_CERT_PATH "$ssl_dir/betterdesk.crt"
        _upsert_systemd_env "$svc_file" SSL_KEY_PATH "$ssl_dir/betterdesk.key"
        systemctl daemon-reload 2>/dev/null || true
    fi
}

# When HTTPS is enabled, ensure the console user can read the TLS private key (#219).
# Re-copies from LE_CERT_LIVE_DIR when symlinks, unreadable keys, or /etc/letsencrypt paths remain.
ensure_console_tls_material_readable() {
    local https_enabled console_user="betterdesk"
    local env_file="${CONSOLE_PATH}/.env"
    local ssl_dir="$RUSTDESK_PATH/ssl"
    local ssl_key_path ssl_cert_path

    https_enabled=$(read_effective_console_setting HTTPS_ENABLED false)
    if [ "$(echo "$https_enabled" | tr '[:upper:]' '[:lower:]')" != "true" ]; then
        return 0
    fi

    maybe_repair_le_ssl_symlinks 2>/dev/null || true

    ssl_key_path=$(read_effective_console_setting SSL_KEY_PATH "")
    ssl_cert_path=$(read_effective_console_setting SSL_CERT_PATH "")
    if [ -z "$ssl_key_path" ]; then
        ssl_key_path="$ssl_dir/betterdesk.key"
    fi

    if id "$console_user" &>/dev/null && [ -e "$ssl_key_path" ]; then
        if runuser -u "$console_user" -- test -r "$ssl_key_path" 2>/dev/null; then
            return 0
        fi
    fi

    local le_live_dir
    le_live_dir=$(resolve_le_cert_live_dir "$env_file" "$ssl_key_path")
    if [ -z "$le_live_dir" ] && [ -n "$ssl_cert_path" ]; then
        le_live_dir=$(resolve_le_cert_live_dir "$env_file" "$ssl_cert_path")
    fi

    if [ -n "$le_live_dir" ] && [ -f "$le_live_dir/fullchain.pem" ] && [ -f "$le_live_dir/privkey.pem" ]; then
        print_info "Re-deploying Let's Encrypt certificate for console user (#219)"
        if deploy_ssl_material_to_rustdesk_dir "$le_live_dir/fullchain.pem" "$le_live_dir/privkey.pem" "$le_live_dir"; then
            _sync_deployed_ssl_paths_to_env
            if id "$console_user" &>/dev/null && runuser -u "$console_user" -- test -r "$ssl_dir/betterdesk.key" 2>/dev/null; then
                return 0
            fi
        fi
    fi

    print_warning "HTTPS is enabled but console user cannot read TLS key (${ssl_key_path:-$ssl_dir/betterdesk.key})"
    print_info "  Check: runuser -u betterdesk -- test -r ${ssl_key_path:-$ssl_dir/betterdesk.key}"
    print_info "  Logs:  journalctl -u betterdesk-console -n 30 --no-pager"
    return 1
}

# Wait for an HTTP(S) endpoint to return a usable status code (post-restart boot delay).
_wait_for_http_code() {
    local url="$1"
    local max_wait="${2:-15}"
    local use_insecure="${3:-}"
    local elapsed=0
    local code="000"
    local curl_args=(-s -o /dev/null -w '%{http_code}' --max-time 4)

    if [ "$use_insecure" = "yes" ]; then
        curl_args=(-k "${curl_args[@]}")
    fi

    while [ "$elapsed" -lt "$max_wait" ]; do
        code=$(curl "${curl_args[@]}" "$url" 2>/dev/null || echo "000")
        if [[ "$code" =~ ^(200|301|302|304|401|403|405)$ ]]; then
            echo "$code"
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    echo "$code"
    return 1
}

# Sync .env + betterdesk-console.service for HTTP or HTTPS panel mode (#219).
apply_console_protocol_mode() {
    local mode="$1"
    local cert_crt="${2:-}"
    local cert_key="${3:-}"
    local api_tls="${4:-false}"
    local allow_self_signed="${5:-true}"
    local env_file="${CONSOLE_PATH}/.env"
    local svc_file="/etc/systemd/system/betterdesk-console.service"
    local go_port="${GO_API_PORT:-21114}"

    if [ "$mode" = "http" ]; then
        _upsert_env_line "$env_file" HTTPS_ENABLED false
        _upsert_env_line "$env_file" RUSTDESK_API_TLS false
        _upsert_env_line "$env_file" ALLOW_SELF_SIGNED_CERTS false
        _upsert_env_line "$env_file" HTTP_REDIRECT_HTTPS false
        _upsert_env_line "$env_file" TRUST_PROXY false
        _upsert_env_line "$env_file" HBBS_API_URL "http://localhost:${go_port}/api"
        _upsert_env_line "$env_file" BETTERDESK_API_URL "http://localhost:${go_port}/api"
        _remove_env_line "$env_file" NODE_EXTRA_CA_CERTS
        _remove_env_line "$env_file" ENTERPRISE_TLS

        if [ -f "$svc_file" ]; then
            _upsert_systemd_env "$svc_file" HTTPS_ENABLED false
            _upsert_systemd_env "$svc_file" RUSTDESK_API_TLS false
            _upsert_systemd_env "$svc_file" ALLOW_SELF_SIGNED_CERTS false
            _upsert_systemd_env "$svc_file" HTTP_REDIRECT_HTTPS false
            _upsert_systemd_env "$svc_file" TRUST_PROXY false
            sed -i "s|Environment=HBBS_API_URL=https://localhost|Environment=HBBS_API_URL=http://localhost|" "$svc_file"
            sed -i "s|Environment=BETTERDESK_API_URL=https://localhost|Environment=BETTERDESK_API_URL=http://localhost|" "$svc_file"
            _remove_systemd_env "$svc_file" NODE_EXTRA_CA_CERTS
            _remove_systemd_env "$svc_file" ENTERPRISE_TLS
        fi
        sync_go_server_trust_proxy no
    elif [ "$mode" = "https" ]; then
        _upsert_env_line "$env_file" HTTPS_ENABLED true
        _upsert_env_line "$env_file" SSL_CERT_PATH "$cert_crt"
        _upsert_env_line "$env_file" SSL_KEY_PATH "$cert_key"
        _upsert_env_line "$env_file" TRUST_PROXY false
        if ! grep -q '^HTTPS_PORT=' "$env_file" 2>/dev/null; then
            _upsert_env_line "$env_file" HTTPS_PORT 5443
        fi
        _upsert_env_line "$env_file" HTTP_REDIRECT_HTTPS true
        _upsert_env_line "$env_file" RUSTDESK_API_TLS "$api_tls"
        _upsert_env_line "$env_file" ALLOW_SELF_SIGNED_CERTS "$allow_self_signed"
        _upsert_env_line "$env_file" HBBS_API_URL "http://localhost:${go_port}/api"
        _upsert_env_line "$env_file" BETTERDESK_API_URL "http://localhost:${go_port}/api"
        if [ "$allow_self_signed" = "true" ]; then
            _upsert_env_line "$env_file" NODE_EXTRA_CA_CERTS "$cert_crt"
        else
            _remove_env_line "$env_file" NODE_EXTRA_CA_CERTS
        fi

        if [ -f "$svc_file" ]; then
            _upsert_systemd_env "$svc_file" HTTPS_ENABLED true
            _upsert_systemd_env "$svc_file" SSL_CERT_PATH "$cert_crt"
            _upsert_systemd_env "$svc_file" SSL_KEY_PATH "$cert_key"
            _upsert_systemd_env "$svc_file" HTTP_REDIRECT_HTTPS true
            _upsert_systemd_env "$svc_file" RUSTDESK_API_TLS "$api_tls"
            _upsert_systemd_env "$svc_file" ALLOW_SELF_SIGNED_CERTS "$allow_self_signed"
            _upsert_systemd_env "$svc_file" TRUST_PROXY false
            sed -i "s|Environment=HBBS_API_URL=https://localhost|Environment=HBBS_API_URL=http://localhost|" "$svc_file"
            sed -i "s|Environment=BETTERDESK_API_URL=https://localhost|Environment=BETTERDESK_API_URL=http://localhost|" "$svc_file"
            if [ "$allow_self_signed" = "true" ]; then
                _upsert_systemd_env "$svc_file" NODE_EXTRA_CA_CERTS "$cert_crt"
            else
                _remove_systemd_env "$svc_file" NODE_EXTRA_CA_CERTS
            fi
        fi
        sync_go_server_trust_proxy no
    else
        print_error "apply_console_protocol_mode: unknown mode '$mode'"
        return 1
    fi

    systemctl daemon-reload 2>/dev/null || true
}

# Enable signal/relay TLS on betterdesk-server using deployed panel cert (#219).
sync_go_server_signal_relay_tls() {
    local ssl_dir="${1:-$RUSTDESK_PATH/ssl}"
    local go_svc_file="/etc/systemd/system/betterdesk-server.service"

    [ -f "$go_svc_file" ] || return 0
    sed -i 's/ -tls-cert [^ ]*//g' "$go_svc_file"
    sed -i 's/ -tls-key [^ ]*//g' "$go_svc_file"
    sed -i 's/ -tls-signal//g' "$go_svc_file"
    sed -i 's/ -tls-relay//g' "$go_svc_file"
    sed -i 's/ -tls-api//g' "$go_svc_file"
    sed -i 's/ -force-https//g' "$go_svc_file"
    sed -i "s|\(ExecStart=.*betterdesk-server[^$]*\)|\1 -tls-cert $ssl_dir/betterdesk.crt -tls-key $ssl_dir/betterdesk.key -tls-signal -tls-relay|" "$go_svc_file"
    systemctl daemon-reload 2>/dev/null || true
}

# Remove signal/relay TLS from betterdesk-server (#219).
clear_go_server_signal_relay_tls() {
    local go_svc_file="/etc/systemd/system/betterdesk-server.service"

    [ -f "$go_svc_file" ] || return 0
    sed -i 's/ -tls-cert [^ ]*//g' "$go_svc_file"
    sed -i 's/ -tls-key [^ ]*//g' "$go_svc_file"
    sed -i 's/ -tls-signal//g' "$go_svc_file"
    sed -i 's/ -tls-relay//g' "$go_svc_file"
    sed -i 's/ -tls-api//g' "$go_svc_file"
    sed -i 's/ -force-https//g' "$go_svc_file"
    systemctl daemon-reload 2>/dev/null || true
}

# Enable or disable Go server reverse-proxy trust (#267 / #276).
# Optional 2nd arg: TRUSTED_PROXIES CIDR list. Omitted → loopback default.
# Empty string → enable TRUST_PROXY but do not write TRUSTED_PROXIES (remote proxy).
sync_go_server_trust_proxy() {
    local enable="${1:-yes}"
    local trusted_cidrs
    if [ "$#" -ge 2 ]; then
        trusted_cidrs="$2"
    else
        trusted_cidrs="127.0.0.1/32,::1/128"
    fi
    local go_svc_file="/etc/systemd/system/betterdesk-server.service"

    [ -f "$go_svc_file" ] || return 0
    if [ "$enable" = "yes" ]; then
        _upsert_systemd_env "$go_svc_file" TRUST_PROXY Y
        if [ -n "$trusted_cidrs" ]; then
            _upsert_systemd_env "$go_svc_file" TRUSTED_PROXIES "$trusted_cidrs"
        fi
        if ! grep -q '\-trust-proxy' "$go_svc_file" 2>/dev/null; then
            sed -i 's|\(ExecStart=.*betterdesk-server[^$]*\)|\1 -trust-proxy|' "$go_svc_file"
        fi
    else
        _remove_systemd_env "$go_svc_file" TRUST_PROXY
        _remove_systemd_env "$go_svc_file" TRUSTED_PROXIES
        sed -i 's/ -trust-proxy//g' "$go_svc_file"
    fi
    systemctl daemon-reload 2>/dev/null || true
}

# Console + Go settings for TLS termination at an external reverse proxy (#267).
apply_console_reverse_proxy_mode() {
    local panel_host="${1:-}"
    local server_id="${2:-}"
    local ws_origins="${3:-}"
    local panel_bind="${4:-127.0.0.1}"
    local env_file="${CONSOLE_PATH}/.env"
    local svc_file="/etc/systemd/system/betterdesk-console.service"
    local go_port="${GO_API_PORT:-21114}"

    apply_console_protocol_mode http
    clear_go_server_signal_relay_tls

    _upsert_env_line "$env_file" HOST "$panel_bind"
    _upsert_env_line "$env_file" TRUST_PROXY Y
    # Same-host proxy: loopback. Remote proxy (HOST=0.0.0.0): operator must set the proxy CIDR.
    local trusted_cidrs="127.0.0.1/32,::1/128"
    if [ "$panel_bind" = "0.0.0.0" ]; then
        trusted_cidrs=""
    fi
    if [ -n "$trusted_cidrs" ]; then
        _upsert_env_line "$env_file" TRUSTED_PROXIES "$trusted_cidrs"
    fi
    _upsert_env_line "$env_file" HTTP_REDIRECT_HTTPS false
    _upsert_env_line "$env_file" HBBS_API_URL "http://localhost:${go_port}/api"
    _upsert_env_line "$env_file" BETTERDESK_API_URL "http://localhost:${go_port}/api"

    if [ -n "$panel_host" ]; then
        _upsert_env_line "$env_file" PANEL_PUBLIC_HOST "$panel_host"
        _upsert_env_line "$env_file" PANEL_PUBLIC_URL "https://${panel_host}"
    fi
    if [ -n "$server_id" ]; then
        _upsert_env_line "$env_file" PUBLIC_SERVER_ID "$server_id"
    elif [ -n "$panel_host" ]; then
        _upsert_env_line "$env_file" PUBLIC_SERVER_ID "$panel_host"
    fi
    if [ -n "$ws_origins" ]; then
        _upsert_env_line "$env_file" WS_ALLOWED_ORIGINS "$ws_origins"
    elif [ -n "$panel_host" ]; then
        _upsert_env_line "$env_file" WS_ALLOWED_ORIGINS "https://${panel_host}"
    fi

    if [ -f "$svc_file" ]; then
        _upsert_systemd_env "$svc_file" HOST "$panel_bind"
        _upsert_systemd_env "$svc_file" TRUST_PROXY Y
        _upsert_systemd_env "$svc_file" HTTPS_ENABLED false
        _upsert_systemd_env "$svc_file" HTTP_REDIRECT_HTTPS false
        _upsert_systemd_env "$svc_file" RUSTDESK_API_TLS false
    fi

    sync_go_server_trust_proxy yes "$trusted_cidrs"
    systemctl daemon-reload 2>/dev/null || true
}

# Write Caddy/Nginx snippets and verify script under $RUSTDESK_PATH/reverse-proxy/ (#267).
generate_reverse_proxy_config() {
    local panel_host="${1:-}"
    local proxy_type="${2:-caddy}"
    local route_wss="${3:-yes}"
    local server_id="${4:-}"
    local panel_bind="${5:-}"
    local upstream_addr="${6:-}"

    if [ -z "$panel_host" ]; then
        read -p "Public panel hostname (e.g., console.example.com): " panel_host
        if [ -z "$panel_host" ]; then
            print_error "Hostname is required for reverse-proxy snippets"
            return 1
        fi
    fi

    if [ -z "$panel_bind" ]; then
        if confirm "Is the reverse proxy on THIS server (same host as BetterDesk)?"; then
            panel_bind="127.0.0.1"
            upstream_addr="127.0.0.1"
        else
            panel_bind="0.0.0.0"
            upstream_addr=$(ip route get 1 2>/dev/null | awk '{print $7; exit}')
            [ -z "$upstream_addr" ] && upstream_addr=$(hostname -I 2>/dev/null | awk '{print $1}')
            echo ""
            read -p "BetterDesk LAN IP for proxy upstream [${upstream_addr}]: " _custom_up
            [ -n "$_custom_up" ] && upstream_addr="$_custom_up"
            if [ -z "$upstream_addr" ]; then
                print_error "LAN IP required when the proxy runs on another host"
                return 1
            fi
            print_warning "Panel will listen on 0.0.0.0:5000 — restrict firewall to your proxy host"
        fi
    fi
    [ -z "$upstream_addr" ] && upstream_addr="$panel_bind"
    if [ "$panel_bind" = "0.0.0.0" ] && [ "$upstream_addr" = "0.0.0.0" ]; then
        upstream_addr=$(ip route get 1 2>/dev/null | awk '{print $7; exit}')
    fi

    if [ -z "$proxy_type" ] || [ "$proxy_type" = "prompt" ]; then
        echo ""
        echo "  1) Caddy"
        echo "  2) Nginx"
        read -p "Proxy type [1]: " _proxy_pick
        case "${_proxy_pick:-1}" in
            2) proxy_type="nginx" ;;
            *) proxy_type="caddy" ;;
        esac
    fi

    if [ -z "$route_wss" ] || [ "$route_wss" = "prompt" ]; then
        if confirm "Route RustDesk WSS paths (/ws/id, /ws/relay) on the same hostname?"; then
            route_wss="yes"
        else
            route_wss="no"
        fi
    fi

    if [ -z "$server_id" ]; then
        if confirm "Use a different hostname for RustDesk ID/relay clients than the panel?"; then
            read -p "RustDesk ID server hostname (e.g., desk.example.com): " server_id
        fi
    fi
    [ -z "$server_id" ] && server_id="$panel_host"

    local out_dir="$RUSTDESK_PATH/reverse-proxy"
    mkdir -p "$out_dir"

    local ws_origins="https://${panel_host}"
    [ "$panel_host" != "$server_id" ] && ws_origins="${ws_origins},https://${server_id}"

    cat > "$out_dir/betterdesk.env.snippet" << EOF
# BetterDesk reverse-proxy mode (#267) — merge into $CONSOLE_PATH/.env
HOST=${panel_bind}
HTTPS_ENABLED=false
HTTP_REDIRECT_HTTPS=false
TRUST_PROXY=Y
TRUSTED_PROXIES=127.0.0.1/32,::1/128
PORT=5000
PANEL_PUBLIC_HOST=${panel_host}
PANEL_PUBLIC_URL=https://${panel_host}
PUBLIC_SERVER_ID=${server_id}
WS_ALLOWED_ORIGINS=${ws_origins}
EOF

    if [ "$proxy_type" = "nginx" ]; then
        cat > "$out_dir/nginx.betterdesk.conf.snippet" << EOF
# BetterDesk reverse-proxy snippet (#267) — merge into your nginx site config.
# TLS certificates: use certbot --nginx or your existing cert setup.

map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name ${panel_host};

    client_max_body_size 100M;
EOF
        if [ "$route_wss" = "yes" ]; then
            cat >> "$out_dir/nginx.betterdesk.conf.snippet" << EOF

    location = /ws/id {
        proxy_pass http://${upstream_addr}:21118;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }

    location = /ws/relay {
        proxy_pass http://${upstream_addr}:21119;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
EOF
        fi
        cat >> "$out_dir/nginx.betterdesk.conf.snippet" << EOF

    location ~ ^/ws/ {
        proxy_pass http://${upstream_addr}:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_socket_keepalive on;
    }

    location / {
        proxy_pass http://${upstream_addr}:5000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 86400s;
    }
}
EOF
        print_success "Nginx snippet: $out_dir/nginx.betterdesk.conf.snippet"
    else
        cat > "$out_dir/caddy.Caddyfile.snippet" << EOF
# BetterDesk reverse-proxy snippet (#267) — merge into /etc/caddy/Caddyfile
# Caddy obtains TLS automatically when this block is active.

${panel_host} {
EOF
        if [ "$route_wss" = "yes" ]; then
            cat >> "$out_dir/caddy.Caddyfile.snippet" << EOF
    handle /ws/id {
        reverse_proxy ${upstream_addr}:21118
    }
    handle /ws/relay {
        reverse_proxy ${upstream_addr}:21119
    }
EOF
        fi
        cat >> "$out_dir/caddy.Caddyfile.snippet" << EOF
    reverse_proxy ${upstream_addr}:5000

    encode gzip zstd
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
    }
}
EOF
        if [ "$panel_host" != "$server_id" ]; then
            cat >> "$out_dir/caddy.Caddyfile.snippet" << EOF

# Optional second site when ID/relay clients use a different hostname:
# ${server_id} {
#     handle /ws/id { reverse_proxy ${upstream_addr}:21118 }
#     handle /ws/relay { reverse_proxy ${upstream_addr}:21119 }
# }
EOF
        fi
        print_success "Caddy snippet: $out_dir/caddy.Caddyfile.snippet"
    fi

    cat > "$out_dir/firewall-notes.txt" << EOF
BetterDesk reverse-proxy firewall (#267)

Through your reverse proxy (HTTPS :443):
  - Panel + console WebSockets -> http://${upstream_addr}:5000
$( [ "$route_wss" = "yes" ] && echo "  - RustDesk WSS /ws/id -> ${upstream_addr}:21118, /ws/relay -> ${upstream_addr}:21119" )
$( [ "$panel_bind" = "0.0.0.0" ] && echo "  - Panel bind: 0.0.0.0:5000 (remote proxy) — restrict :5000 to proxy IP in firewall" )

Must reach this host directly (not HTTP reverse-proxied):
  - 21116/tcp + 21116/udp  Signal
  - 21117/tcp              Relay
  - 21121/tcp              Client API (unless proxied separately)

Example (ufw):
  sudo ufw allow 443/tcp
  sudo ufw allow 21116/tcp
  sudo ufw allow 21116/udp
  sudo ufw allow 21117/tcp
  sudo ufw allow 21121/tcp
EOF

    cat > "$out_dir/verify.sh" << 'VERIFYEOF'
#!/usr/bin/env bash
# BetterDesk reverse-proxy verification (#267)
set -euo pipefail
PANEL_HOST="${1:-}"
if [ -z "$PANEL_HOST" ]; then
    echo "Usage: $0 <public-hostname>"
    exit 1
fi
echo "=== Local panel (HTTP) ==="
curl -sI "http://127.0.0.1:5000/" | head -5 || true
echo ""
echo "=== Public panel (HTTPS via proxy) ==="
curl -sI "https://${PANEL_HOST}/" | head -5 || true
echo ""
echo "=== Console WebSocket upgrade ==="
curl -i -N --max-time 8 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "https://${PANEL_HOST}/ws/bd-signal" 2>/dev/null | head -8 || true
VERIFYEOF
    chmod +x "$out_dir/verify.sh"
    # Inject hostname into verify script usage (already passed as arg)

    echo ""
    print_info "Reverse-proxy files written to: $out_dir"
    print_info "  betterdesk.env.snippet"
    [ "$proxy_type" = "nginx" ] && print_info "  nginx.betterdesk.conf.snippet" || print_info "  caddy.Caddyfile.snippet"
    print_info "  verify.sh $panel_host"
    print_info "  firewall-notes.txt"
    print_info "Documentation: docs/setup/REVERSE_PROXY.md"
    echo ""
    print_warning "Configure your proxy, then open https://${panel_host}/ (not :5443)"
    if [ "$panel_host" != "$server_id" ]; then
        print_info "RustDesk clients: ID server ${server_id} (set PUBLIC_SERVER_ID in .env)"
    fi

    REVERSE_PROXY_GENERATED_HOST="$panel_host"
    REVERSE_PROXY_GENERATED_SERVER_ID="$server_id"
    REVERSE_PROXY_GENERATED_WS_ORIGINS="$ws_origins"
    REVERSE_PROXY_PANEL_BIND="$panel_bind"
    REVERSE_PROXY_UPSTREAM_ADDR="$upstream_addr"
}

# Interactive reverse-proxy wizard: apply BetterDesk settings + emit proxy snippets (#267).
do_configure_reverse_proxy() {
    local panel_host server_id ws_origins panel_bind

    echo ""
    print_step "Configuring BetterDesk for external reverse proxy (TLS at Caddy/Nginx)..."
    print_info "Your proxy terminates TLS on :443; BetterDesk panel stays plain HTTP"
    echo ""

    read -p "Public panel hostname (e.g., console.example.com): " panel_host
    if [ -z "$panel_host" ]; then
        print_error "Hostname is required"
        return 1
    fi

    if ! generate_reverse_proxy_config "$panel_host" "prompt" "prompt" ""; then
        return 1
    fi

    server_id="${REVERSE_PROXY_GENERATED_SERVER_ID:-$panel_host}"
    ws_origins="${REVERSE_PROXY_GENERATED_WS_ORIGINS:-https://${panel_host}}"
    panel_bind="${REVERSE_PROXY_PANEL_BIND:-127.0.0.1}"

    apply_console_reverse_proxy_mode "$panel_host" "$server_id" "$ws_origins" "$panel_bind"

    print_success "BetterDesk configured for external reverse proxy"
    echo ""
    if [ "$panel_bind" = "0.0.0.0" ]; then
        print_info "  Panel (bind):   http://0.0.0.0:$(resolve_panel_http_port) (remote proxy host)"
        print_info "  Proxy upstream: http://${REVERSE_PROXY_UPSTREAM_ADDR:-<lan-ip>}:$(resolve_panel_http_port)"
    else
        print_info "  Panel (local):  http://127.0.0.1:$(resolve_panel_http_port)"
    fi
    print_info "  Panel (public): https://${panel_host}/"
    print_info "  TRUST_PROXY:    Y (console + Go server)"
    if [ "$panel_bind" = "0.0.0.0" ]; then
        print_info "  TRUSTED_PROXIES: set to your reverse-proxy IP/CIDR in .env (required for Go WSS)"
    else
        print_info "  TRUSTED_PROXIES: 127.0.0.1/32,::1/128 (same-host)"
    fi
    print_info "  Signal/Relay:   TCP :21116 / :21117 (direct — not HTTP-proxied)"
    echo ""
    print_info "Copy proxy snippet from $RUSTDESK_PATH/reverse-proxy/ into Caddy/Nginx, then reload the proxy."
}

# HTTP redirect listener port (always PORT, default 5000).
resolve_panel_http_port() {
    read_effective_console_setting PORT 5000
}

# HTTPS panel listen port (HTTPS_PORT, default 5443 — never conflated with PORT).
resolve_panel_https_port() {
    read_effective_console_setting HTTPS_PORT 5443
}

# Primary panel port for health checks: HTTPS_PORT when HTTPS enabled, else PORT.
resolve_panel_health_port() {
    local https_enabled
    https_enabled=$(read_effective_console_setting HTTPS_ENABLED false)
    if [ "$(echo "$https_enabled" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
        resolve_panel_https_port
    else
        resolve_panel_http_port
    fi
}

# Offer native HTTPS on standard port 443 after enabling TLS (#219 follow-up).
maybe_offer_standard_https_port() {
    local env_file="${CONSOLE_PATH}/.env"
    local svc_file="/etc/systemd/system/betterdesk-console.service"
    local current_https_port

    current_https_port=$(read_effective_console_setting HTTPS_PORT 5443)
    [ "$current_https_port" = "443" ] && return 0

    echo ""
    print_info "Panel HTTPS defaults to port 5443 (avoids conflicts with nginx/certbot on :443)."
    if confirm "Use standard HTTPS port 443 (https://your-domain without :5443)?"; then
        _upsert_env_line "$env_file" HTTPS_PORT 443
        _upsert_env_line "$env_file" PORT 80
        _upsert_env_line "$env_file" HTTP_REDIRECT_HTTPS true
        if [ -f "$svc_file" ]; then
            _upsert_systemd_env "$svc_file" HTTPS_PORT 443
            _upsert_systemd_env "$svc_file" PORT 80
            _upsert_systemd_env "$svc_file" HTTP_REDIRECT_HTTPS true
            systemctl daemon-reload 2>/dev/null || true
        fi
        ensure_betterdesk_console_user >/dev/null
        print_success "Standard ports configured: HTTPS :443, HTTP redirect :80"
        print_info "Ensure nothing else listens on :443/:80; open firewall: ufw allow 443/tcp (and 80/tcp if redirecting)"
    fi
}

# True when Client API (:21121) should be probed over HTTPS (RUSTDESK_API_TLS + cert present).
client_api_should_use_tls() {
    local mode cert_path key_path
    mode=$(read_effective_console_setting RUSTDESK_API_TLS auto)
    mode=$(echo "$mode" | tr '[:upper:]' '[:lower:]')
    if [ "$mode" = "false" ] || [ "$mode" = "0" ] || [ "$mode" = "off" ] || [ "$mode" = "http" ]; then
        return 1
    fi
    cert_path=$(read_effective_console_setting SSL_CERT_PATH "")
    key_path=$(read_effective_console_setting SSL_KEY_PATH "")
    if [ -z "$cert_path" ] || [ ! -f "$cert_path" ] || [ -z "$key_path" ] || [ ! -f "$key_path" ]; then
        return 1
    fi
    if [ "$mode" = "true" ] || [ "$mode" = "1" ] || [ "$mode" = "on" ] || [ "$mode" = "https" ]; then
        return 0
    fi
    # auto — certs present
    return 0
}

# True when an existing panel auth store is present (update must not show credential banner).
has_existing_panel_auth() {
    if [ -f "$CONSOLE_PATH/data/auth.db" ]; then
        return 0
    fi
    if [ "${USE_POSTGRESQL:-false}" = "true" ]; then
        return 0
    fi
    if [ -f "$CONSOLE_PATH/.env" ] && grep -q '^DATABASE_URL=' "$CONSOLE_PATH/.env" 2>/dev/null; then
        return 0
    fi
    return 1
}

# On update: reset failed state and sync console service user permissions before start.
prepare_console_after_update() {
    if [ ! -f "$CONSOLE_PATH/server.js" ]; then
        return 0
    fi
    systemctl reset-failed betterdesk-console 2>/dev/null || true
    repair_console_service_user_line "betterdesk" || true
    repair_https_stuck_state yes || true
    if [ -f "$CONSOLE_PATH/scripts/linux-ensure-console-user.js" ] && command -v node &>/dev/null; then
        if [ "$(id -u)" -eq 0 ]; then
            node "$CONSOLE_PATH/scripts/linux-ensure-console-user.js" || print_warning "Console permission sync reported issues"
        elif command -v sudo &>/dev/null && sudo -n true 2>/dev/null; then
            sudo -n node "$CONSOLE_PATH/scripts/linux-ensure-console-user.js" || print_warning "Console permission sync reported issues"
        else
            print_warning "Console permission sync skipped (run as root: sudo node $CONSOLE_PATH/scripts/linux-ensure-console-user.js)"
        fi
    fi
    repair_console_service_user_line "betterdesk" || true
    ensure_console_tls_material_readable 2>/dev/null || true
    return 0
}

maybe_create_admin_user_on_update() {
    if has_existing_panel_auth; then
        print_info "Existing installation — admin accounts preserved"
        return 0
    fi
    create_admin_user
}

# Start / restart betterdesk-console and verify panel health (#306).
# Always attempts start even when earlier helper steps failed (set -e safe).
start_betterdesk_console_verified() {
    local panel_port console_state
    panel_port=$(resolve_panel_health_port)

    print_info "Starting betterdesk-console (Node.js)..."
    systemctl reset-failed betterdesk-console 2>/dev/null || true
    if systemctl is-active --quiet betterdesk-console 2>/dev/null; then
        systemctl restart betterdesk-console || true
    else
        # Prefer start when inactive (post graceful_stop); fall back to restart.
        systemctl start betterdesk-console 2>/dev/null || systemctl restart betterdesk-console || true
    fi
    sleep 2

    if ! verify_service_health "betterdesk-console" "$panel_port" 10; then
        print_warning "Web console may not be running correctly"
        console_state=$(systemctl show betterdesk-console --property=ActiveState --value 2>/dev/null || echo "unknown")
        print_error "betterdesk-console ActiveState=${console_state} (expected: active)"
        print_info "  Possible causes: npm modules, TLS key permissions, port ${panel_port} conflict"
        print_info "Run: journalctl -u betterdesk-console -n 50 --no-pager"
        print_info "Then: sudo systemctl start betterdesk-console"
        return 1
    fi

    print_success "betterdesk-console started and healthy (port ${panel_port})"
    return 0
}

# Start services with health verification
start_services_with_verification() {
    print_step "Starting services with health verification..."
    
    local has_errors=false
    local console_ok=true
    
    # Check ports before starting
    if ! check_port_available "21116" "signal"; then
        print_error "Port 21116 (ID server) is not available"
        has_errors=true
    fi
    
    if ! check_port_available "21117" "relay"; then
        print_error "Port 21117 (relay) is not available"
        has_errors=true
    fi
    
    if [ "$has_errors" = true ]; then
        print_error "Cannot start services - ports are in use"
        print_info "Try: sudo lsof -i :21116 and sudo lsof -i :21117 to find conflicts"
        return 1
    fi
    
    # Enable services
    systemctl enable betterdesk-server betterdesk-console 2>/dev/null || true
    
    # Start Go server (signal + relay + API in one binary)
    print_info "Starting betterdesk-server (Go)..."
    systemctl start betterdesk-server
    sleep 3
    
    if ! verify_service_health "betterdesk-server" "21116" 10; then
        print_error "Failed to start betterdesk-server"
        print_info "Service state: $(systemctl show betterdesk-server --property=ActiveState --value 2>/dev/null)"
        print_info "Run: journalctl -u betterdesk-server -n 50 --no-pager"
        # Still try to bring console up — operator may recover Go separately (#306)
        prepare_console_after_update || true
        start_betterdesk_console_verified || true
        return 1
    fi
    print_success "betterdesk-server started and healthy"
    
    # Inject shared API key into Go server database for Node.js ↔ Go communication.
    # Must not abort under set -e (sqlite3 busy/locked after Go start was leaving Console down — #306).
    local api_key_file="$RUSTDESK_PATH/.api_key"
    if [ -f "$api_key_file" ]; then
        local api_key
        api_key=$(cat "$api_key_file" 2>/dev/null || true)
        local api_key_sql=""
        if [ -n "$api_key" ]; then
            api_key_sql=$(sql_escape_literal "$api_key")
        fi
        local go_db="$RUSTDESK_PATH/db_v2.sqlite3"
        if [ -n "$api_key_sql" ] && [ -f "$go_db" ] && command -v sqlite3 &>/dev/null; then
            if sqlite3 "$go_db" "INSERT OR REPLACE INTO server_config (key, value) VALUES ('api_key', '$api_key_sql');" 2>/dev/null; then
                print_info "API key synced to Go server database"
            else
                print_warning "API key sync to Go DB skipped (sqlite3 failed — Console start continues)"
            fi
        fi
    fi
    
    # Verify relay port is also listening
    if ! verify_service_health "betterdesk-server" "21117" 5; then
        print_warning "Relay port 21117 may not be ready yet"
    fi

    # Re-sync permissions after Go server may have created root-owned DB/WAL files (#206)
    # Never abort start path under set -e (#306)
    prepare_console_after_update || print_warning "Console prep after update reported issues (continuing)"

    if ! start_betterdesk_console_verified; then
        console_ok=false
    fi

    if [ "$console_ok" = true ]; then
        print_success "All services started and verified"
        return 0
    fi

    print_error "Server is running but web console failed to start"
    print_info "Run: journalctl -u betterdesk-console -n 50 --no-pager"
    print_info "Then: sudo systemctl start betterdesk-console"
    return 1
}

#===============================================================================
# Detection Functions
#===============================================================================

detect_installation() {
    INSTALL_STATUS="none"
    HBBS_RUNNING=false
    HBBR_RUNNING=false
    CONSOLE_RUNNING=false
    BINARIES_OK=false
    DATABASE_OK=false
    CONSOLE_TYPE="none"
    
    # Check paths
    if [ -d "$RUSTDESK_PATH" ]; then
        INSTALL_STATUS="partial"
        
        # Check Go server binary (primary) or legacy Rust binaries
        if [ -f "$RUSTDESK_PATH/betterdesk-server" ]; then
            BINARIES_OK=true
            SERVER_TYPE="go"
        elif [ -f "$RUSTDESK_PATH/hbbs" ] || [ -f "$RUSTDESK_PATH/hbbs-v8-api" ]; then
            BINARIES_OK=true
            SERVER_TYPE="rust"
            print_warning "Legacy Rust binaries detected. Consider upgrading to Go server."
        fi
        
        # Check database (SQLite file or PostgreSQL connection)
        local detected_db_type="sqlite"
        if [ -f "$CONSOLE_PATH/.env" ]; then
            detected_db_type=$(grep -m1 '^DB_TYPE=' "$CONSOLE_PATH/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
            detected_db_type="${detected_db_type:-sqlite}"
        fi

        if [ "$detected_db_type" = "postgres" ]; then
            # PostgreSQL: check via systemd service config or .env
            local pg_uri
            pg_uri=$(grep -m1 '^DATABASE_URL=' "$CONSOLE_PATH/.env" 2>/dev/null | cut -d= -f2-)
            if [ -n "$pg_uri" ]; then
                if PGCONNECT_TIMEOUT=3 psql "$pg_uri" -c "SELECT 1" &>/dev/null 2>&1; then
                    DATABASE_OK=true
                fi
            fi
        else
            # SQLite: check file exists
            if [ -f "$DB_PATH" ]; then
                DATABASE_OK=true
            fi
        fi
    fi
    
    # Detect console type
    if [ -d "$CONSOLE_PATH" ]; then
        if [ -f "$CONSOLE_PATH/server.js" ] || [ -f "$CONSOLE_PATH/package.json" ]; then
            CONSOLE_TYPE="nodejs"
        elif [ -f "$CONSOLE_PATH/app.py" ]; then
            CONSOLE_TYPE="nodejs"  # Flask detected, will be migrated to Node.js
            print_warning "Legacy Flask console detected. It will be migrated to Node.js on update."
        fi
        
        if [ "$CONSOLE_TYPE" != "none" ] && [ "$BINARIES_OK" = true ] && [ "$DATABASE_OK" = true ]; then
            INSTALL_STATUS="complete"
        fi
    fi
    
    # Check services (Go server or legacy Rust)
    if systemctl is-active --quiet betterdesk-server 2>/dev/null; then
        HBBS_RUNNING=true
        HBBR_RUNNING=true  # Go server handles both
    elif systemctl is-active --quiet rustdesksignal 2>/dev/null || \
         systemctl is-active --quiet hbbs 2>/dev/null; then
        HBBS_RUNNING=true
    fi
    
    if ! [ "$HBBR_RUNNING" = true ]; then
        if systemctl is-active --quiet rustdeskrelay 2>/dev/null || \
           systemctl is-active --quiet hbbr 2>/dev/null; then
            HBBR_RUNNING=true
        fi
    fi
    
    if systemctl is-active --quiet betterdesk-console 2>/dev/null || \
       systemctl is-active --quiet betterdesk 2>/dev/null; then
        CONSOLE_RUNNING=true
    fi
}

# Preserve database configuration from existing .env file
# This MUST be called before install_nodejs_console() during UPDATE/REPAIR
# to prevent switching from PostgreSQL to SQLite
preserve_database_config() {
    if [ -f "$CONSOLE_PATH/.env" ]; then
        local existing_db_type existing_db_url
        existing_db_type=$(grep -m1 '^DB_TYPE=' "$CONSOLE_PATH/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
        existing_db_url=$(grep -m1 '^DATABASE_URL=' "$CONSOLE_PATH/.env" 2>/dev/null | cut -d= -f2-)
        
        if [ "$existing_db_type" = "postgres" ] && [ -n "$existing_db_url" ]; then
            USE_POSTGRESQL="true"
            POSTGRESQL_URI="$existing_db_url"
            print_info "Preserving PostgreSQL configuration from existing .env"
        elif [ "$existing_db_type" = "sqlite" ]; then
            USE_POSTGRESQL="false"
            POSTGRESQL_URI=""
            print_info "Preserving SQLite configuration from existing .env"
        fi
    fi
}

# Write or merge console .env from web-nodejs/.env.example (issue #158).
# Usage: merge_console_env true   — fresh install (full template)
#        merge_console_env false  — update (append missing keys only)
merge_console_env() {
    local fresh_install="${1:-false}"
    local merge_script=""
    local subst_script=""
    local ssl_dir="$RUSTDESK_PATH/ssl"
    local db_type="sqlite"
    local database_url=""
    local admin_password="${ADMIN_PASSWORD:-}"
    local session_secret=""
    local subst_file="/tmp/betterdesk-env-subst-$$.json"
    local go_port="${GO_API_PORT:-21114}"
    local client_port="${CLIENT_API_PORT:-21121}"

    if [ -f "$CONSOLE_PATH/scripts/merge-env.js" ]; then
        merge_script="$CONSOLE_PATH/scripts/merge-env.js"
        subst_script="$CONSOLE_PATH/scripts/write-installer-env-subst.js"
    elif [ -f "$SCRIPT_DIR/web-nodejs/scripts/merge-env.js" ]; then
        merge_script="$SCRIPT_DIR/web-nodejs/scripts/merge-env.js"
        subst_script="$SCRIPT_DIR/web-nodejs/scripts/write-installer-env-subst.js"
    else
        print_error "merge-env.js not found — cannot configure .env"
        return 1
    fi

    if [ "$USE_POSTGRESQL" = "true" ] && [ -n "$POSTGRESQL_URI" ]; then
        db_type="postgres"
        database_url="$POSTGRESQL_URI"
    fi

    if [ "$fresh_install" = "true" ]; then
        if [ -z "$admin_password" ]; then
            admin_password=$(openssl rand -hex 16)
        fi
        session_secret=$(openssl rand -hex 32)
    else
        if [ -f "$CONSOLE_PATH/.env" ]; then
            session_secret=$(grep -m1 '^SESSION_SECRET=' "$CONSOLE_PATH/.env" 2>/dev/null | cut -d= -f2-)
            if [ -z "$admin_password" ]; then
                admin_password=$(grep -m1 '^DEFAULT_ADMIN_PASSWORD=' "$CONSOLE_PATH/.env" 2>/dev/null | cut -d= -f2-)
            fi
        fi
        if [ -z "$session_secret" ]; then
            session_secret=$(openssl rand -hex 32)
        fi
    fi

    local fresh_flag=""
    [ "$fresh_install" = "true" ] && fresh_flag="--fresh"

    export BD_SUBST_RUSTDESK_DIR="$RUSTDESK_PATH"
    export BD_SUBST_PUB_KEY_PATH="$RUSTDESK_PATH/id_ed25519.pub"
    export BD_SUBST_API_KEY_PATH="$RUSTDESK_PATH/.api_key"
    export BD_SUBST_DB_TYPE="$db_type"
    export BD_SUBST_DB_PATH="$RUSTDESK_PATH/db_v2.sqlite3"
    export BD_SUBST_DATABASE_URL="$database_url"
    export BD_SUBST_DATA_DIR="$CONSOLE_PATH/data"
    export BD_SUBST_GO_API_PORT="$go_port"
    export BD_SUBST_HBBS_API_URL="http://localhost:${go_port}/api"
    export BD_SUBST_BETTERDESK_API_URL="http://localhost:${go_port}/api"
    export BD_SUBST_API_PORT="$client_port"
    export BD_SUBST_DEFAULT_ADMIN_PASSWORD="$admin_password"
    export BD_SUBST_SESSION_SECRET="$session_secret"
    export BD_SUBST_SSL_CERT_PATH="$ssl_dir/betterdesk.crt"
    export BD_SUBST_SSL_KEY_PATH="$ssl_dir/betterdesk.key"

    if [ -f "$subst_script" ]; then
        node "$subst_script" "$subst_file" 2>/dev/null || true
    fi

    local merge_ok=false
    local merge_output=""
    local had_subst_file=false
    if [ -f "$subst_file" ]; then
        had_subst_file=true
        merge_output=$(node "$merge_script" --target "$CONSOLE_PATH/.env" $fresh_flag --subst-file "$subst_file" 2>&1) || true
        if echo "$merge_output" | grep -q '"success":true'; then
            merge_ok=true
        fi
        rm -f "$subst_file"
    fi

    if [ "$merge_ok" != true ]; then
        print_error "Failed to write .env via merge-env.js"
        if [ -n "$merge_output" ]; then
            print_info "$merge_output"
        elif [ "$had_subst_file" != true ]; then
            print_info "Substitution file was not created (check write-installer-env-subst.js)"
        fi
        return 1
    fi

    chmod 600 "$CONSOLE_PATH/.env" 2>/dev/null || true
    if [ "$fresh_install" = "true" ]; then
        print_info "Created .env configuration file (fresh install)"
    else
        print_info "Merged new .env keys (existing settings preserved)"
    fi
    return 0
}

detect_architecture() {
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64) ARCH_NAME="x86_64" ;;
        aarch64|arm64) ARCH_NAME="aarch64" ;;
        armv7l) ARCH_NAME="armv7" ;;
        *) ARCH_NAME="unknown" ;;
    esac
}

detect_os() {
    if [ -f /etc/os-release ]; then
        OS_NAME=$(grep -m1 '^NAME=' /etc/os-release | cut -d= -f2- | sed 's/^"//; s/"$//' || echo "Unknown")
        OS_VERSION=$(grep -m1 '^VERSION_ID=' /etc/os-release | cut -d= -f2- | sed 's/^"//; s/"$//' || echo "")
    else
        OS_NAME="Unknown"
        OS_VERSION=""
    fi
}

# Auto-detect RustDesk installation path
auto_detect_paths() {
    local found=false
    
    # If RUSTDESK_PATH is already set (via env var), validate it
    if [ -n "$RUSTDESK_PATH" ]; then
        if [ -d "$RUSTDESK_PATH" ] && { [ -f "$RUSTDESK_PATH/betterdesk-server" ] || [ -f "$RUSTDESK_PATH/hbbs" ] || [ -f "$RUSTDESK_PATH/hbbs-v8-api" ]; }; then
            print_info "Using configured RustDesk path: $RUSTDESK_PATH"
            found=true
        else
            print_warning "Configured RUSTDESK_PATH ($RUSTDESK_PATH) is invalid"
            RUSTDESK_PATH=""
        fi
    fi
    
    # Auto-detect if not found
    if [ -z "$RUSTDESK_PATH" ]; then
        for path in "${COMMON_RUSTDESK_PATHS[@]}"; do
            if [ -d "$path" ] && { [ -f "$path/betterdesk-server" ] || [ -f "$path/hbbs" ] || [ -f "$path/hbbs-v8-api" ]; }; then
                RUSTDESK_PATH="$path"
                print_success "Detected RustDesk installation: $RUSTDESK_PATH"
                found=true
                break
            fi
        done
    fi
    
    # If still not found, use default for new installations
    if [ -z "$RUSTDESK_PATH" ]; then
        RUSTDESK_PATH="/opt/betterdesk"
        print_info "No installation detected. Default path: $RUSTDESK_PATH"
    fi
    
    # Auto-detect Console path and type
    CONSOLE_TYPE="none"
    
    if [ -n "$CONSOLE_PATH" ]; then
        # Check for Node.js console first
        if [ -d "$CONSOLE_PATH" ] && { [ -f "$CONSOLE_PATH/server.js" ] || [ -f "$CONSOLE_PATH/package.json" ]; }; then
            CONSOLE_TYPE="nodejs"
            print_info "Using configured Node.js Console path: $CONSOLE_PATH"
        elif [ -d "$CONSOLE_PATH" ] && [ -f "$CONSOLE_PATH/app.py" ]; then
            CONSOLE_TYPE="nodejs"  # Legacy Flask, will be migrated
            print_warning "Legacy Flask console detected at $CONSOLE_PATH — will be migrated to Node.js"
        else
            print_warning "Configured CONSOLE_PATH ($CONSOLE_PATH) is invalid"
            CONSOLE_PATH=""
        fi
    fi
    
    if [ -z "$CONSOLE_PATH" ]; then
        for path in "${COMMON_CONSOLE_PATHS[@]}"; do
            # Check for Node.js console first
            if [ -d "$path" ] && { [ -f "$path/server.js" ] || [ -f "$path/package.json" ]; }; then
                CONSOLE_PATH="$path"
                CONSOLE_TYPE="nodejs"
                print_success "Detected Node.js Console: $CONSOLE_PATH"
                break
            fi
            # Check for legacy Flask console (will be migrated)
            if [ -d "$path" ] && [ -f "$path/app.py" ]; then
                CONSOLE_PATH="$path"
                CONSOLE_TYPE="nodejs"
                print_warning "Legacy Flask console detected at $CONSOLE_PATH — will be migrated to Node.js"
                break
            fi
        done
    fi
    
    # Default Console path if not found
    if [ -z "$CONSOLE_PATH" ]; then
        CONSOLE_PATH="/opt/BetterDeskConsole"
    fi
    
    # Update DB_PATH based on detected RUSTDESK_PATH
    DB_PATH="$RUSTDESK_PATH/db_v2.sqlite3"
    
    return 0
}

# Interactive path configuration
configure_paths() {
    local _menu_items=(
        $'Auto-detect paths\tScan common install locations'
        $'Set server path\tManually set the RustDesk server path'
        $'Set console path\tManually set the web console path'
        $'Reset to defaults\t/opt/betterdesk + /opt/BetterDeskConsole'
        $'Back\tReturn to the main menu'
    )
    local _menu_returns=( 1 2 3 4 0 )
    local subtitle="server: ${RUSTDESK_PATH:-unset} | console: ${CONSOLE_PATH:-unset}"
    menu_choose "Path Configuration" "$subtitle"
    local choice="$MENU_CHOICE"

    case $choice in
        1)
            RUSTDESK_PATH=""
            CONSOLE_PATH=""
            auto_detect_paths
            press_enter
            configure_paths
            ;;
        2)
            echo ""
            echo -n "Enter RustDesk server path (e.g., /opt/rustdesk): "
            read -r new_path
            if [ -n "$new_path" ]; then
                if [ -d "$new_path" ]; then
                    RUSTDESK_PATH="$new_path"
                    DB_PATH="$RUSTDESK_PATH/db_v2.sqlite3"
                    print_success "RustDesk path set to: $RUSTDESK_PATH"
                else
                    print_warning "Directory does not exist: $new_path"
                    if confirm "Create this directory?"; then
                        mkdir -p "$new_path"
                        RUSTDESK_PATH="$new_path"
                        DB_PATH="$RUSTDESK_PATH/db_v2.sqlite3"
                        print_success "Created and set RustDesk path: $RUSTDESK_PATH"
                    fi
                fi
            fi
            press_enter
            configure_paths
            ;;
        3)
            echo ""
            echo -n "Enter Console path (e.g., /opt/BetterDeskConsole): "
            read -r new_path
            if [ -n "$new_path" ]; then
                if [ -d "$new_path" ]; then
                    CONSOLE_PATH="$new_path"
                    print_success "Console path set to: $CONSOLE_PATH"
                else
                    print_warning "Directory does not exist: $new_path"
                    if confirm "Create this directory?"; then
                        mkdir -p "$new_path"
                        CONSOLE_PATH="$new_path"
                        print_success "Created and set Console path: $CONSOLE_PATH"
                    fi
                fi
            fi
            press_enter
            configure_paths
            ;;
        4)
            RUSTDESK_PATH="/opt/betterdesk"
            CONSOLE_PATH="/opt/BetterDeskConsole"
            DB_PATH="$RUSTDESK_PATH/db_v2.sqlite3"
            print_success "Paths reset to defaults"
            press_enter
            configure_paths
            ;;
        0|"")
            return
            ;;
        *)
            print_error "Invalid option"
            press_enter
            configure_paths
            ;;
    esac
}

print_status() {
    detect_installation
    detect_architecture
    detect_os
    
    echo ""
    echo -e "${WHITE}${BOLD}═══ System Status ═══${NC}"
    echo ""
    echo -e "  System:       ${CYAN}$OS_NAME $OS_VERSION${NC}"
    echo -e "  Architecture: ${CYAN}$ARCH_NAME${NC}"
    echo ""
    
    echo -e "${WHITE}${BOLD}═══ Configured Paths ═══${NC}"
    echo ""
    echo -e "  RustDesk:     ${CYAN}$RUSTDESK_PATH${NC}"
    echo -e "  Console:      ${CYAN}$CONSOLE_PATH${NC}"
    
    # Show database type and path/URI
    local diag_db_type="sqlite"
    if [ -f "$CONSOLE_PATH/.env" ]; then
        diag_db_type=$(grep -m1 '^DB_TYPE=' "$CONSOLE_PATH/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
        diag_db_type="${diag_db_type:-sqlite}"
    fi
    if [ "$diag_db_type" = "postgres" ]; then
        local diag_pg_uri
        diag_pg_uri=$(grep -m1 '^DATABASE_URL=' "$CONSOLE_PATH/.env" 2>/dev/null | cut -d= -f2-)
        # Mask password in URI for display
        local diag_pg_display
        diag_pg_display=$(echo "$diag_pg_uri" | sed 's|://[^:]*:[^@]*@|://***:***@|')
        echo -e "  Database:     ${CYAN}PostgreSQL${NC} ($diag_pg_display)"
    else
        echo -e "  Database:     ${CYAN}SQLite${NC} ($DB_PATH)"
    fi
    echo ""
    
    echo -e "${WHITE}${BOLD}═══ Installation Status ═══${NC}"
    echo ""
    
    # Installation status
    case "$INSTALL_STATUS" in
        "complete")
            echo -e "  Status:       ${GREEN}✓ Installed${NC}"
            ;;
        "partial")
            echo -e "  Status:       ${YELLOW}! Partial installation${NC}"
            ;;
        "none")
            echo -e "  Status:       ${RED}✗ Not installed${NC}"
            ;;
    esac
    
    # Components
    if [ "$BINARIES_OK" = true ]; then
        echo -e "  Binaries:      ${GREEN}✓ OK${NC}"
    else
        echo -e "  Binaries:      ${RED}✗ Not found${NC}"
    fi
    
    if [ "$DATABASE_OK" = true ]; then
        echo -e "  Database:  ${GREEN}✓ OK${NC}"
    else
        echo -e "  Database:  ${RED}✗ Not found${NC}"
    fi
    
    if [ -d "$CONSOLE_PATH" ]; then
        case "$CONSOLE_TYPE" in
            nodejs) echo -e "  Web Console:  ${GREEN}✓ OK${NC} (Node.js)" ;;
            *) echo -e "  Web Console:  ${GREEN}✓ OK${NC}" ;;
        esac
    else
        echo -e "  Web Console:  ${RED}✗ Not found${NC}"
    fi
    
    echo ""
    echo -e "${WHITE}${BOLD}═══ Services Status ═══${NC}"
    echo ""
    
    # Check if using Go server (single binary) or legacy Rust (two binaries)
    if [ "${SERVER_TYPE:-}" = "go" ] || systemctl is-active --quiet betterdesk-server 2>/dev/null; then
        local go_state
        go_state=$(systemctl show betterdesk-server --property=ActiveState --value 2>/dev/null || echo "unknown")
        case "$go_state" in
            active)
                echo -e "  BetterDesk Server (Go): ${GREEN}● Active${NC} (Signal + Relay + API)"
                ;;
            failed)
                echo -e "  BetterDesk Server (Go): ${RED}✗ Failed${NC} (check: journalctl -u betterdesk-server -n 30)"
                ;;
            activating)
                echo -e "  BetterDesk Server (Go): ${YELLOW}◌ Starting...${NC}"
                ;;
            *)
                echo -e "  BetterDesk Server (Go): ${RED}○ Inactive${NC} ($go_state)"
                ;;
        esac
    else
        # Legacy Rust servers
        if [ "$HBBS_RUNNING" = true ]; then
            echo -e "  HBBS (Signal): ${GREEN}● Active${NC} ${YELLOW}(Legacy Rust)${NC}"
        else
            echo -e "  HBBS (Signal): ${RED}○ Inactive${NC}"
        fi
        
        if [ "$HBBR_RUNNING" = true ]; then
            echo -e "  HBBR (Relay):  ${GREEN}● Active${NC} ${YELLOW}(Legacy Rust)${NC}"
        else
            echo -e "  HBBR (Relay):  ${RED}○ Inactive${NC}"
        fi
    fi
    
    # Console status with state details
    local console_state
    console_state=$(systemctl show betterdesk-console --property=ActiveState --value 2>/dev/null || echo "unknown")
    case "$console_state" in
        active)
            echo -e "  Web Console:   ${GREEN}● Active${NC}"
            ;;
        failed)
            echo -e "  Web Console:   ${RED}✗ Failed${NC} (check: journalctl -u betterdesk-console -n 30)"
            ;;
        activating)
            echo -e "  Web Console:   ${YELLOW}◌ Starting...${NC}"
            ;;
        *)
            if [ "$CONSOLE_RUNNING" = true ]; then
                echo -e "  Web Console:   ${GREEN}● Active${NC}"
            else
                echo -e "  Web Console:   ${RED}○ Inactive${NC} ($console_state)"
            fi
            ;;
    esac
    
    echo ""
}

#===============================================================================
# Go Installation and Compilation
#===============================================================================

# Extract numeric semver component (handles "1.25+", "26rc1", etc.).
_go_version_part() {
    local ver="$1" field="${2:-1}"
    local part
    part=$(echo "$ver" | cut -d'.' -f"$field" | grep -oE '^[0-9]+' | head -1)
    echo "${part:-0}"
}

check_go_installed() {
    if command -v go &> /dev/null; then
        local go_version
        go_version=$(go version | awk '{print $3}' | sed 's/go//')
        local go_major=$(_go_version_part "$go_version" 1)
        local go_minor=$(_go_version_part "$go_version" 2)
        local go_patch=$(_go_version_part "$go_version" 3)
        local min_major=$(_go_version_part "$GO_MIN_VERSION" 1)
        local min_minor=$(_go_version_part "$GO_MIN_VERSION" 2)

        # Security hardening: reject vulnerable Go 1.26.0 stdlib.
        if [ "$go_major" -eq 1 ] && [ "$go_minor" -eq 26 ] && [ "$go_patch" -eq 0 ]; then
            print_warning "Detected vulnerable Go version $go_version (known stdlib CVEs)."
            return 1
        fi
        
        if [ "$go_major" -gt "$min_major" ] || ([ "$go_major" -eq "$min_major" ] && [ "$go_minor" -ge "$min_minor" ]); then
            return 0
        fi
    fi
    return 1
}

install_golang() {
    print_step "Installing Go $GO_MIN_VERSION+..."
    
    # Ensure architecture is detected
    if [ -z "$ARCH_NAME" ]; then
        detect_architecture
    fi
    
    if check_go_installed; then
        local go_version=$(go version | awk '{print $3}' | sed 's/go//')
        print_info "Go $go_version is already installed"
        return 0
    fi
    
    local go_version="$GO_DOWNLOAD_VERSION"
    local go_arch=""
    
    case "$ARCH_NAME" in
        x86_64) go_arch="amd64" ;;
        aarch64) go_arch="arm64" ;;
        armv7*) go_arch="armv6l" ;;
        *) print_error "Unsupported architecture: $ARCH_NAME"; return 1 ;;
    esac
    
    local go_tarball="go${go_version}.linux-${go_arch}.tar.gz"
    local go_url="https://go.dev/dl/$go_tarball"
    
    print_info "Downloading Go $go_version for $go_arch..."
    
    cd /tmp
    if command -v wget &> /dev/null; then
        wget -q --show-progress "$go_url" -O "$go_tarball" || wget "$go_url" -O "$go_tarball"
    elif command -v curl &> /dev/null; then
        curl -fSL --progress-bar "$go_url" -o "$go_tarball"
    else
        print_error "Neither wget nor curl available"
        return 1
    fi
    
    print_info "Installing Go to /usr/local/go..."
    rm -rf /usr/local/go
    tar -C /usr/local -xzf "$go_tarball"
    rm "$go_tarball"
    
    # Add to PATH for current session
    export PATH=$PATH:/usr/local/go/bin
    
    # Add to system-wide PATH
    if [ ! -f /etc/profile.d/go.sh ]; then
        echo 'export PATH=$PATH:/usr/local/go/bin' > /etc/profile.d/go.sh
        chmod +x /etc/profile.d/go.sh
    fi
    
    if check_go_installed; then
        print_success "Go $go_version installed successfully"
        return 0
    else
        print_error "Go installation failed"
        return 1
    fi
}

compile_go_server() {
    print_step "Compiling BetterDesk Go server..."
    
    if [ ! -d "$GO_SERVER_SOURCE" ]; then
        print_error "Go server source not found: $GO_SERVER_SOURCE"
        return 1
    fi
    
    # Ensure Go is available
    export PATH=$PATH:/usr/local/go/bin
    
    if ! check_go_installed; then
        if ! install_golang; then
            print_error "Go is required for compilation"
            return 1
        fi
    fi
    
    cd "$GO_SERVER_SOURCE"
    
    # Clean previous builds
    rm -f betterdesk-server betterdesk-server-linux-*
    
    # Build
    print_info "Building BetterDesk server for $ARCH_NAME..."
    local output_name="betterdesk-server"
    
    # Download dependencies
    print_info "Downloading Go modules..."
    go mod download
    
    # Build with optimizations
    CGO_ENABLED=0 go build -ldflags="-s -w -X main.Version=${VERSION}" -o "$output_name" .
    
    if [ -f "$output_name" ]; then
        chmod +x "$output_name"
        local size=$(du -h "$output_name" | cut -f1)
        print_success "Compiled: $output_name ($size)"
        return 0
    else
        print_error "Compilation failed"
        return 1
    fi
}

#===============================================================================
# Binary Verification Functions
#===============================================================================

verify_go_binary() {
    local binary_path="$1"
    
    if [ -z "$binary_path" ]; then
        binary_path="$GO_SERVER_SOURCE/betterdesk-server"
    fi
    
    if [ ! -f "$binary_path" ]; then
        # Check installed location
        binary_path="$RUSTDESK_PATH/betterdesk-server"
    fi
    
    if [ ! -f "$binary_path" ]; then
        return 1
    fi
    
    # Verify it's executable
    if [ -x "$binary_path" ]; then
        return 0
    fi
    
    return 1
}

verify_binaries() {
    print_step "Verifying BetterDesk server..."
    
    if [ "$SKIP_VERIFY" = true ]; then
        print_warning "Verification skipped (--skip-verify)"
        return 0
    fi
    
    # Check for precompiled binary
    local found=false
    
    if [ -f "$GO_SERVER_SOURCE/betterdesk-server" ]; then
        if verify_go_binary "$GO_SERVER_SOURCE/betterdesk-server"; then
            local size=$(du -h "$GO_SERVER_SOURCE/betterdesk-server" | cut -f1)
            print_success "Found compiled binary in source directory ($size)"
            found=true
        fi
    fi
    
    if [ -f "$RUSTDESK_PATH/betterdesk-server" ]; then
        if verify_go_binary "$RUSTDESK_PATH/betterdesk-server"; then
            local size=$(du -h "$RUSTDESK_PATH/betterdesk-server" | cut -f1)
            print_success "Found installed binary ($size)"
            found=true
        fi
    fi
    
    if [ "$found" = false ]; then
        print_warning "No BetterDesk server binary found"
        print_info "Binary will be compiled during installation"
    fi
    
    return 0
}

#===============================================================================
# Installation Functions
#===============================================================================

install_dependencies() {
    print_step "Installing dependencies..."
    
    if command -v apt-get &> /dev/null; then
        apt-get update -qq
        apt-get install -y -qq python3 python3-pip python3-venv sqlite3 curl wget openssl build-essential
    elif command -v dnf &> /dev/null; then
        dnf install -y -q python3 python3-pip sqlite curl wget openssl gcc gcc-c++ make
    elif command -v yum &> /dev/null; then
        yum install -y -q python3 python3-pip sqlite curl wget openssl gcc gcc-c++ make
    elif command -v pacman &> /dev/null; then
        pacman -Sy --noconfirm python python-pip sqlite curl wget openssl base-devel
    else
        print_warning "Unknown package manager. Make sure Python 3 and SQLite are installed."
    fi
    
    print_success "Dependencies installed"
}

#===============================================================================
# PostgreSQL Installation Functions
#===============================================================================

install_postgresql() {
    print_step "Installing PostgreSQL..."
    
    if command -v psql &> /dev/null; then
        local pg_version=$(psql --version | grep -oP '\d+' | head -1)
        print_success "PostgreSQL $pg_version already installed"
        return 0
    fi
    
    if command -v apt-get &> /dev/null; then
        apt-get update -qq
        apt-get install -y -qq postgresql postgresql-contrib
    elif command -v dnf &> /dev/null; then
        dnf install -y -q postgresql-server postgresql
        postgresql-setup --initdb 2>/dev/null || true
    elif command -v yum &> /dev/null; then
        yum install -y -q postgresql-server postgresql
        postgresql-setup initdb 2>/dev/null || true
    elif command -v pacman &> /dev/null; then
        pacman -Sy --noconfirm postgresql
        su - postgres -c "initdb -D /var/lib/postgres/data" 2>/dev/null || true
    else
        print_error "Cannot install PostgreSQL automatically."
        print_info "Please install PostgreSQL manually and run the script again."
        return 1
    fi
    
    # Start PostgreSQL service
    systemctl start postgresql 2>/dev/null || service postgresql start 2>/dev/null || true
    systemctl enable postgresql 2>/dev/null || true
    
    # Verify installation
    if command -v psql &> /dev/null; then
        print_success "PostgreSQL installed and started"
        return 0
    else
        print_error "PostgreSQL installation failed!"
        return 1
    fi
}

setup_postgresql_database() {
    print_step "Setting up PostgreSQL database for BetterDesk..."

    if ! is_valid_pg_identifier "$POSTGRESQL_USER"; then
        print_error "Invalid PostgreSQL username: $POSTGRESQL_USER"
        print_info "Allowed pattern: ^[A-Za-z_][A-Za-z0-9_]{0,62}$"
        return 1
    fi
    if ! is_valid_pg_identifier "$POSTGRESQL_DB"; then
        print_error "Invalid PostgreSQL database name: $POSTGRESQL_DB"
        print_info "Allowed pattern: ^[A-Za-z_][A-Za-z0-9_]{0,62}$"
        return 1
    fi
    
    # Generate password if not set
    if [ -z "$POSTGRESQL_PASS" ]; then
        # SECURITY (audit fix M-05, 2026-04-10): use hex (4 bits/char, no
        # alphabet shrinking) instead of base64+tr+truncate which lost a few
        # entropy bits per character.
        POSTGRESQL_PASS=$(openssl rand -hex 16)
        print_info "Generated PostgreSQL password"
    fi
    
    # Check if PostgreSQL is running
    if ! systemctl is-active --quiet postgresql 2>/dev/null; then
        systemctl start postgresql 2>/dev/null || service postgresql start 2>/dev/null
        sleep 2
    fi
    
    # Create user and database
    local pg_pass_sql
    pg_pass_sql=$(sql_escape_literal "$POSTGRESQL_PASS")

    print_step "Creating PostgreSQL user '$POSTGRESQL_USER'..."
    sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE USER \"$POSTGRESQL_USER\" WITH PASSWORD '$pg_pass_sql' CREATEDB;" 2>/dev/null || {
        print_warning "User might already exist, trying to update password..."
        sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER USER \"$POSTGRESQL_USER\" WITH PASSWORD '$pg_pass_sql';" 2>/dev/null || true
    }
    
    print_step "Creating PostgreSQL database '$POSTGRESQL_DB'..."
    sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$POSTGRESQL_DB\" OWNER \"$POSTGRESQL_USER\";" 2>/dev/null || {
        print_warning "Database might already exist"
    }
    
    # Build connection URI
    POSTGRESQL_URI="postgres://$POSTGRESQL_USER:$POSTGRESQL_PASS@$POSTGRESQL_HOST:$POSTGRESQL_PORT/$POSTGRESQL_DB?sslmode=disable"
    
    # Test connection
    print_step "Testing PostgreSQL connection..."
    if PGPASSWORD="$POSTGRESQL_PASS" psql -U "$POSTGRESQL_USER" -h "$POSTGRESQL_HOST" -p "$POSTGRESQL_PORT" -d "$POSTGRESQL_DB" -c "SELECT 1;" &>/dev/null; then
        print_success "PostgreSQL connection successful!"
        print_info "Connection URI: postgres://$POSTGRESQL_USER:****@$POSTGRESQL_HOST:$POSTGRESQL_PORT/$POSTGRESQL_DB"
    else
        print_error "PostgreSQL connection failed!"
        print_info "Check PostgreSQL pg_hba.conf for local connections"
        return 1
    fi
    
    return 0
}

choose_database_type() {
    if [ "$AUTO_MODE" = true ]; then
        # In auto mode, use environment variable or default to SQLite
        if [ "$USE_POSTGRESQL" = "true" ]; then
            print_info "Auto mode: Using PostgreSQL"
            return 0
        else
            print_info "Auto mode: Using SQLite (default)"
            USE_POSTGRESQL="false"
            return 0
        fi
    fi
    
    echo ""
    local _menu_items=(
        $'SQLite (default)\tSingle-file DB, zero setup, good for <=100 devices'
        $'PostgreSQL (production)\tPooled SQL DB, multi-server / >100 devices / HA'
    )
    local _menu_returns=( 1 2 )
    menu_choose "Select Database Type" "SQLite is recommended for most installs"
    local db_choice="${MENU_CHOICE:-1}"
    
    case $db_choice in
        2)
            USE_POSTGRESQL="true"
            print_info "Selected: PostgreSQL"
            
            # Ask for PostgreSQL details or use defaults
            echo ""
            read -p "PostgreSQL host [$POSTGRESQL_HOST]: " pg_host
            POSTGRESQL_HOST="${pg_host:-$POSTGRESQL_HOST}"
            
            read -p "PostgreSQL port [$POSTGRESQL_PORT]: " pg_port
            POSTGRESQL_PORT="${pg_port:-$POSTGRESQL_PORT}"
            
            read -p "PostgreSQL database [$POSTGRESQL_DB]: " pg_db
            POSTGRESQL_DB="${pg_db:-$POSTGRESQL_DB}"
            
            read -p "PostgreSQL user [$POSTGRESQL_USER]: " pg_user
            POSTGRESQL_USER="${pg_user:-$POSTGRESQL_USER}"
            
            read -sp "PostgreSQL password (leave empty to generate): " pg_pass
            echo ""
            POSTGRESQL_PASS="${pg_pass:-}"
            ;;
        *)
            USE_POSTGRESQL="false"
            print_info "Selected: SQLite"
            ;;
    esac
}

migrate_sqlite_to_postgresql() {
    print_step "Migrating existing SQLite data to PostgreSQL..."
    
    local sqlite_db="$RUSTDESK_PATH/db_v2.sqlite3"
    
    if [ ! -f "$sqlite_db" ]; then
        print_info "No existing SQLite database found, skipping migration"
        return 0
    fi
    
    # Find migration binary
    local migrate_bin=""
    if [ -f "$SCRIPT_DIR/betterdesk-server/tools/migrate/migrate-linux-amd64" ]; then
        migrate_bin="$SCRIPT_DIR/betterdesk-server/tools/migrate/migrate-linux-amd64"
    elif [ -f "$SCRIPT_DIR/tools/migrate/migrate-linux-amd64" ]; then
        migrate_bin="$SCRIPT_DIR/tools/migrate/migrate-linux-amd64"
    elif [ -f "/opt/betterdesk-go/migrate" ]; then
        migrate_bin="/opt/betterdesk-go/migrate"
    fi
    
    # Try to compile migration tool from source if not found or outdated
    if [ -z "$migrate_bin" ] && command -v go &>/dev/null; then
        local migrate_src="$SCRIPT_DIR/betterdesk-server/tools/migrate"
        if [ -d "$migrate_src" ]; then
            print_info "Compiling migration tool from source..."
            if (cd "$SCRIPT_DIR/betterdesk-server" && go build -o "tools/migrate/migrate-linux-amd64" ./tools/migrate/) 2>&1; then
                migrate_bin="$migrate_src/migrate-linux-amd64"
                print_success "Migration tool compiled successfully"
            else
                print_warning "Failed to compile migration tool"
            fi
        fi
    fi
    
    if [ -z "$migrate_bin" ]; then
        print_warning "Migration binary not found, skipping automatic migration"
        print_info "You can migrate manually using: M -> 3 (SQLite → PostgreSQL)"
        return 0
    fi
    
    chmod +x "$migrate_bin"
    
    # Verify binary supports -mode flag (in case of outdated binary)
    if ! "$migrate_bin" -mode backup -src /dev/null 2>&1 | grep -qv "flag provided but not defined"; then
        if "$migrate_bin" -mode backup -src /dev/null 2>&1 | grep -q "flag provided but not defined"; then
            print_warning "Migration binary is outdated (missing -mode flag)"
            print_info "Rebuild with: cd betterdesk-server && go build -o tools/migrate/migrate-linux-amd64 ./tools/migrate/"
            return 0
        fi
    fi
    
    # Check if SQLite has data
    local peer_count
    peer_count=$(sqlite3 "$sqlite_db" "SELECT COUNT(*) FROM peer;" 2>/dev/null || echo "0")
    
    if [ "$peer_count" -gt 0 ]; then
        print_info "Found $peer_count devices in SQLite database"
        
        if [ "$AUTO_MODE" = true ] || confirm "Migrate existing data to PostgreSQL?"; then
            print_step "Creating backup before migration..."
            "$migrate_bin" -mode backup -src "$sqlite_db" 2>&1 || true
            
            print_step "Running SQLite → PostgreSQL migration (nodejs2go mode)..."
            if "$migrate_bin" -mode nodejs2go -src "$sqlite_db" -dst "$POSTGRESQL_URI" 2>&1; then
                print_success "Migration completed! $peer_count devices migrated."
            else
                print_warning "Migration had issues, check output above"
            fi
        fi
    else
        print_info "SQLite database is empty, no migration needed"
    fi
}

#===============================================================================
# Node.js Installation Functions
#===============================================================================

install_nodejs() {
    print_step "Checking Node.js installation..."
    
    # Check if Node.js is already installed and version is sufficient
    if command -v node &> /dev/null; then
        local node_version=$(node --version | sed 's/v//' | cut -d'.' -f1)
        if [ "$node_version" -ge 22 ]; then
            print_success "Node.js v$(node --version) already installed"
            return 0
        else
            print_warning "Node.js version $node_version is too old (need 22+). Upgrading..."
        fi
    fi
    
    print_step "Installing Node.js 24 LTS..."

    # Detect OS and install Node.js. The NodeSource setup script is downloaded
    # to a temp file and validated before execution (H5 audit fix): we do NOT
    # pipe `curl | bash` blindly. Optional pinning: set $NODESOURCE_SHA256 to
    # require an exact SHA-256 match before running the installer.
    _fetch_and_run_nodesource() {
        local url="$1"
        local tmp
        tmp=$(mktemp --suffix=.sh) || { print_error "mktemp failed"; return 1; }
        trap "rm -f '$tmp'" RETURN

        if ! curl -fsSL --max-time 60 --proto '=https' --tlsv1.2 -o "$tmp" "$url"; then
            print_error "Failed to download NodeSource setup script from $url"
            return 1
        fi

        # Size sanity check: NodeSource setup script is ~15-40 KB. Reject anything
        # outside [1 KB, 500 KB] (catches HTML error pages and tampered payloads).
        local size
        size=$(stat -c%s "$tmp" 2>/dev/null || wc -c <"$tmp")
        if [ "${size:-0}" -lt 1024 ] || [ "${size:-0}" -gt 512000 ]; then
            print_error "Downloaded NodeSource script has unexpected size (${size} bytes). Aborting."
            return 1
        fi

        # Header sanity check: must be a bash/sh script.
        local first_line
        first_line=$(head -n 1 "$tmp")
        case "$first_line" in
            "#!/bin/bash"*|"#!/usr/bin/env bash"*|"#!/bin/sh"*|"#!/usr/bin/env sh"*) ;;
            *)
                print_error "Downloaded NodeSource script has unexpected shebang: '$first_line'"
                return 1
                ;;
        esac

        # Optional pinned SHA-256 verification.
        local actual_sha
        if command -v sha256sum &> /dev/null; then
            actual_sha=$(sha256sum "$tmp" | awk '{print $1}')
        elif command -v shasum &> /dev/null; then
            actual_sha=$(shasum -a 256 "$tmp" | awk '{print $1}')
        fi
        if [ -n "$actual_sha" ]; then
            print_info "NodeSource setup script SHA-256: $actual_sha"
            if [ -n "${NODESOURCE_SHA256:-}" ] && [ "$actual_sha" != "$NODESOURCE_SHA256" ]; then
                print_error "NodeSource SHA-256 mismatch (expected $NODESOURCE_SHA256, got $actual_sha)"
                return 1
            fi
        fi

        bash "$tmp"
    }

    # Detect OS and install Node.js
    if command -v apt-get &> /dev/null; then
        # Debian/Ubuntu - use NodeSource
        _fetch_and_run_nodesource "https://deb.nodesource.com/setup_24.x" || return 1
        apt-get install -y -qq nodejs
    elif command -v dnf &> /dev/null; then
        # Fedora/RHEL 8+
        _fetch_and_run_nodesource "https://rpm.nodesource.com/setup_24.x" || return 1
        dnf install -y -q nodejs
    elif command -v yum &> /dev/null; then
        # RHEL/CentOS 7
        _fetch_and_run_nodesource "https://rpm.nodesource.com/setup_24.x" || return 1
        yum install -y -q nodejs
    elif command -v pacman &> /dev/null; then
        # Arch Linux
        pacman -Sy --noconfirm nodejs npm
    elif command -v apk &> /dev/null; then
        # Alpine Linux
        apk add --no-cache nodejs npm
    else
        print_error "Cannot install Node.js automatically. Please install Node.js 22+ manually."
        return 1
    fi
    
    # Verify installation
    if command -v node &> /dev/null; then
        print_success "Node.js $(node --version) installed"
        print_info "npm $(npm --version)"
        return 0
    else
        print_error "Node.js installation failed!"
        return 1
    fi
}

install_nodejs_console() {
    print_step "Installing Node.js Web Console..."
    
    # Install Node.js if not present
    if ! install_nodejs; then
        print_error "Cannot proceed without Node.js"
        return 1
    fi
    
    mkdir -p "$CONSOLE_PATH"
    
    # Check for web-nodejs folder first, then web folder
    local source_folder=""
    if [ -d "$SCRIPT_DIR/web-nodejs" ]; then
        source_folder="$SCRIPT_DIR/web-nodejs"
        print_info "Found Node.js console in web-nodejs/"
    elif [ -d "$SCRIPT_DIR/web" ] && [ -f "$SCRIPT_DIR/web/server.js" ]; then
        source_folder="$SCRIPT_DIR/web"
        print_info "Found Node.js console in web/"
    else
        print_error "Node.js web console not found!"
        print_info "Expected: $SCRIPT_DIR/web-nodejs/ or $SCRIPT_DIR/web/server.js"
        return 1
    fi
    
    # Copy web files (glob * skips dotfiles — .env.example is required by merge-env.js, #166)
    cp -r "$source_folder/"* "$CONSOLE_PATH/"
    if [ -f "$source_folder/.env.example" ]; then
        cp -a "$source_folder/.env.example" "$CONSOLE_PATH/.env.example"
    fi
    if [ -f "$SCRIPT_DIR/VERSION" ]; then
        cp -a "$SCRIPT_DIR/VERSION" "$CONSOLE_PATH/VERSION" 2>/dev/null || true
    fi
    
    # Install npm dependencies
    print_step "Installing npm dependencies..."
    cd "$CONSOLE_PATH"
    
    # Install npm dependencies with proper error handling
    local npm_log="/tmp/betterdesk_npm_install.log"
    if ! npm install --production > "$npm_log" 2>&1; then
        print_error "npm install failed! Check log:"
        tail -20 "$npm_log"
        print_info "Full log: $npm_log"
        return 1
    fi
    rm -f "$npm_log"
    echo ""

    # Best-effort install of node-pty for Server Management terminal (BETA).
    # node-pty is an optional dependency: if the native build fails the
    # console falls back to plain pipe spawn (no PTY).
    print_step "Installing optional node-pty (Server Management terminal — BETA)..."
    if npm install --no-audit --no-fund --no-save node-pty >>"$npm_log" 2>&1; then
        print_success "node-pty installed (real PTY available)"
    else
        print_warn "node-pty install failed — Server Management terminal will use pipe fallback"
    fi
    rm -f "$npm_log"

    # Server Management Terminal sudo hint (BETA — manual step, NOT automated):
    #   echo 'betterdesk-console ALL=(ALL) NOPASSWD: /usr/bin/systemctl, /usr/bin/journalctl' \
    #       | sudo tee /etc/sudoers.d/betterdesk-console
    # The installer never modifies sudoers; admins opt in manually.
    echo ""
    
    # Create data directory for databases
    mkdir -p "$CONSOLE_PATH/data"
    
    # Fresh install only when no existing panel state (issue #158 — never reset passwords on update).
    local is_fresh=false
    if [ ! -f "$CONSOLE_PATH/.env" ] && [ ! -f "$CONSOLE_PATH/data/auth.db" ]; then
        is_fresh=true
    fi

    if [ "$is_fresh" = true ]; then
        if [ -f "$CONSOLE_PATH/data/auth.db" ]; then
            print_info "Removing old auth database (fresh install)..."
            rm -f "$CONSOLE_PATH/data/auth.db" "$CONSOLE_PATH/data/auth.db-wal" "$CONSOLE_PATH/data/auth.db-shm"
        fi
        if [ -z "$ADMIN_PASSWORD" ]; then
            ADMIN_PASSWORD=$(openssl rand -hex 16)
        elif [ -n "$ADMIN_PASSWORD" ]; then
            print_info "Using custom admin password from ADMIN_PASSWORD env var"
        fi
        touch "$CONSOLE_PATH/data/.force_password_update"
    else
        print_info "Update mode: preserving auth database and panel passwords"
        ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
    fi

    if ! merge_console_env "$is_fresh"; then
        return 1
    fi

    local nodejs_admin_password="${ADMIN_PASSWORD:-}"
    if [ -z "$nodejs_admin_password" ] && [ -f "$CONSOLE_PATH/.env" ]; then
        nodejs_admin_password=$(grep -m1 '^DEFAULT_ADMIN_PASSWORD=' "$CONSOLE_PATH/.env" 2>/dev/null | cut -d= -f2-)
    fi

    # Persist credentials only when explicitly requested (fresh install).
    if [ "$STORE_ADMIN_CREDENTIALS" = "true" ] && [ "$is_fresh" = true ] && [ -n "$nodejs_admin_password" ]; then
        cat > "$CONSOLE_PATH/data/.admin_credentials" << CREDEOF
Admin Username: admin
Admin Password: $nodejs_admin_password
Generated by: BetterDesk installer
Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)
CREDEOF
        chmod 600 "$CONSOLE_PATH/data/.admin_credentials"
    fi
    
    # Set permissions
    chown -R root:root "$CONSOLE_PATH"
    chmod -R 755 "$CONSOLE_PATH"
    chmod 600 "$CONSOLE_PATH/.env" 2>/dev/null || true
    
    CONSOLE_TYPE="nodejs"
    print_success "Node.js Web Console installed"
}

install_binaries() {
    local force_recompile="${1:-false}"
    
    print_step "Installing BetterDesk Go Server..."
    
    # Ensure architecture is detected
    if [ -z "$ARCH_NAME" ]; then
        detect_architecture
    fi
    
    # Safety: stop services before copying (prevents "Text file busy")
    if systemctl is-active --quiet betterdesk-server 2>/dev/null; then
        print_info "Stopping running services before binary installation..."
        graceful_stop_services
    fi
    
    mkdir -p "$RUSTDESK_PATH"
    
    local go_binary="$GO_SERVER_SOURCE/betterdesk-server"
    local need_compile=false
    
    if [ ! -f "$go_binary" ]; then
        need_compile=true
        print_info "Pre-compiled binary not found, compiling from source..."
    elif [ "$force_recompile" = "true" ]; then
        # During UPDATE: check if any .go source file is newer than the binary
        local newest_source
        newest_source=$(find "$GO_SERVER_SOURCE" -name '*.go' -newer "$go_binary" 2>/dev/null | head -1)
        if [ -n "$newest_source" ]; then
            need_compile=true
            print_info "Source code updated since last build, recompiling..."
        else
            print_info "Binary is up-to-date with source code"
        fi
    fi
    
    if [ "$need_compile" = true ]; then
        # Ensure Go is installed
        if ! check_go_installed; then
            print_info "Installing Go toolchain..."
            if ! install_golang; then
                print_error "Failed to install Go toolchain"
                return 1
            fi
        fi
        
        # Compile the Go server
        if ! compile_go_server; then
            print_error "Failed to compile Go server"
            return 1
        fi
    else
        print_info "Using existing Go server binary"
    fi
    
    # Verify binary before installation
    if ! verify_binaries; then
        print_error "Aborting installation due to verification failure"
        return 1
    fi
    
    # Copy binary
    cp "$go_binary" "$RUSTDESK_PATH/betterdesk-server"
    chmod +x "$RUSTDESK_PATH/betterdesk-server"
    
    print_success "BetterDesk Go Server v$VERSION installed"
    print_info "Single binary replaces both hbbs (signal) and hbbr (relay)"
}

# Flask console removed in v2.3.0 - archived to archive/web-flask/

install_console() {
    # Always install Node.js console (Flask removed in v2.3.0)
    local console_choice="nodejs"
    
    print_info "Installing Node.js web console..."
    
    # Check for existing Flask console and migrate
    if [ -d "$CONSOLE_PATH" ]; then
        if [ -f "$CONSOLE_PATH/app.py" ] && ! [ -f "$CONSOLE_PATH/server.js" ]; then
            print_warning "Legacy Flask console detected at $CONSOLE_PATH"
            if [ "$AUTO_MODE" = false ]; then
                if confirm "Migrate from Flask to Node.js?"; then
                    migrate_console "flask" "nodejs"
                else
                    print_info "Flask is deprecated. Installing Node.js alongside..."
                fi
            else
                print_info "Auto mode: Migrating from Flask to Node.js"
                migrate_console "flask" "nodejs"
            fi
        fi
    fi
    
    install_nodejs_console
}

migrate_console() {
    local from_type="$1"
    local to_type="$2"
    
    print_step "Migrating from $from_type to $to_type..."
    
    # Backup existing console
    local backup_path="$BACKUP_DIR/console_${from_type}_$(date +%Y%m%d_%H%M%S)"
    mkdir -p "$backup_path"
    
    # Backup user database (auth.db) if exists
    if [ -f "$CONSOLE_PATH/data/auth.db" ]; then
        cp "$CONSOLE_PATH/data/auth.db" "$backup_path/"
        print_info "Backed up user database"
    fi
    
    # Backup .env if exists
    if [ -f "$CONSOLE_PATH/.env" ]; then
        cp "$CONSOLE_PATH/.env" "$backup_path/"
    fi
    
    # Stop old console service
    systemctl stop betterdesk 2>/dev/null || true
    
    # Remove old console files but preserve data
    rm -rf "$CONSOLE_PATH/venv" 2>/dev/null || true
    rm -rf "$CONSOLE_PATH/node_modules" 2>/dev/null || true
    rm -f "$CONSOLE_PATH/app.py" "$CONSOLE_PATH/server.js" 2>/dev/null || true
    
    print_success "Old $from_type console backed up to $backup_path"
}

generate_ssl_certificates() {
    print_step "Generating self-signed TLS certificates..."
    
    local ssl_dir="$RUSTDESK_PATH/ssl"
    
    # Skip if certificates already exist
    if [ -f "$ssl_dir/betterdesk.crt" ] && [ -f "$ssl_dir/betterdesk.key" ]; then
        print_info "TLS certificates already exist at $ssl_dir"
        print_info "Skipping certificate generation (use SSL config menu to regenerate)"
        return 0
    fi
    
    # Ensure openssl is available
    if ! command -v openssl &>/dev/null; then
        print_warning "openssl not found - skipping TLS certificate generation"
        print_info "Install openssl and use SSL config menu (option C) to generate later"
        return 1
    fi
    
    mkdir -p "$ssl_dir"
    
    # Detect server IPs for SAN (Subject Alternative Name)
    local server_ip
    server_ip=$(get_public_ip)
    
    # Detect LAN IP (first non-loopback IPv4)
    local lan_ip
    lan_ip=$(ip -4 addr show scope global | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1 2>/dev/null || \
             hostname -I 2>/dev/null | awk '{print $1}' || echo "")
    
    # Build SAN list
    local san_list="IP:$server_ip,IP:127.0.0.1,DNS:localhost"
    
    # Add LAN IP if different from public IP
    if [ -n "$lan_ip" ] && [ "$lan_ip" != "$server_ip" ] && [ "$lan_ip" != "127.0.0.1" ]; then
        san_list="$san_list,IP:$lan_ip"
    fi
    
    # Add custom domain if provided via environment variable
    if [ -n "${SSL_DOMAIN:-}" ]; then
        san_list="DNS:$SSL_DOMAIN,$san_list"
        print_info "Adding domain to certificate: $SSL_DOMAIN"
    fi
    
    # Determine CN (Common Name) — prefer domain, fallback to public IP
    local cn="${SSL_DOMAIN:-$server_ip}"
    
    # Generate certificate with SAN extension (valid for 10 years for self-signed)
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
        -keyout "$ssl_dir/betterdesk.key" \
        -out "$ssl_dir/betterdesk.crt" \
        -subj "/CN=$cn/O=BetterDesk/C=PL" \
        -addext "subjectAltName=$san_list" \
        2>&1 || {
        print_warning "Certificate generation failed (openssl too old for -addext?)"
        # Fallback without SAN for older openssl
        openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
            -keyout "$ssl_dir/betterdesk.key" \
            -out "$ssl_dir/betterdesk.crt" \
            -subj "/CN=$cn/O=BetterDesk/C=PL" \
            2>&1 || {
            print_error "Failed to generate self-signed certificate"
            return 1
        }
    }
    
    # Deploy with console-user-readable permissions (#219)
    if ! deploy_ssl_material_to_rustdesk_dir "$ssl_dir/betterdesk.crt" "$ssl_dir/betterdesk.key"; then
        print_error "Failed to set permissions on self-signed certificate"
        return 1
    fi
    
    # Also symlink to console SSL directory for Node.js
    if [ -d "$CONSOLE_PATH" ]; then
        local console_ssl="$CONSOLE_PATH/ssl"
        mkdir -p "$console_ssl"
        ln -sf "$ssl_dir/betterdesk.crt" "$console_ssl/betterdesk.crt" 2>/dev/null || \
            cp -f "$ssl_dir/betterdesk.crt" "$console_ssl/betterdesk.crt"
        ln -sf "$ssl_dir/betterdesk.key" "$console_ssl/betterdesk.key" 2>/dev/null || \
            cp -f "$ssl_dir/betterdesk.key" "$console_ssl/betterdesk.key"
        
        # Enable HTTPS in .env so Node.js console (port 5000 + 21121) uses TLS
        local env_file="$CONSOLE_PATH/.env"
        if [ -f "$env_file" ]; then
            sed -i "s|^HTTPS_ENABLED=.*|HTTPS_ENABLED=true|" "$env_file"
            sed -i "s|^SSL_CERT_PATH=.*|SSL_CERT_PATH=$ssl_dir/betterdesk.crt|" "$env_file"
            sed -i "s|^SSL_KEY_PATH=.*|SSL_KEY_PATH=$ssl_dir/betterdesk.key|" "$env_file"
            # Note: Do NOT change internal Go API URLs to https:// here.
            # API TLS breaks RustDesk clients; Node.js only needs the CA for its own HTTPS endpoints.
            if grep -q '^NODE_EXTRA_CA_CERTS=' "$env_file" 2>/dev/null; then
                sed -i "s|^NODE_EXTRA_CA_CERTS=.*|NODE_EXTRA_CA_CERTS=$ssl_dir/betterdesk.crt|" "$env_file"
            else
                echo "NODE_EXTRA_CA_CERTS=$ssl_dir/betterdesk.crt" >> "$env_file"
            fi
            
            # Enterprise TLS compatibility: Go API must remain HTTP because
            # RustDesk desktop clients use plain HTTP on signal_port-2.
            if [ "${ENTERPRISE_TLS:-false}" = "true" ]; then
                if grep -q '^ALLOW_SELF_SIGNED_CERTS=' "$env_file" 2>/dev/null; then
                    sed -i "s|^ALLOW_SELF_SIGNED_CERTS=.*|ALLOW_SELF_SIGNED_CERTS=true|" "$env_file"
                else
                    echo "ALLOW_SELF_SIGNED_CERTS=true" >> "$env_file"
                fi
                sed -i "s|^HBBS_API_URL=https://localhost|HBBS_API_URL=http://localhost|" "$env_file"
                sed -i "s|^BETTERDESK_API_URL=https://localhost|BETTERDESK_API_URL=http://localhost|" "$env_file"
                print_info "Enterprise TLS: Go API stays HTTP for RustDesk client compatibility"
            fi
        fi
    fi
    
    print_success "Self-signed TLS certificate generated (valid 10 years)"
    print_info "Certificate: $ssl_dir/betterdesk.crt"
    print_info "Private key: $ssl_dir/betterdesk.key"
    print_info "SANs: $san_list"
    [ -n "$lan_ip" ] && [ "$lan_ip" != "$server_ip" ] && print_info "LAN IP included: $lan_ip"
    return 0
}

# Go :21114 + Node :21121 proxy (keeps legacy RustDesk client API URLs working).
ensure_api_compat_proxy_layout() {
    local go_port="${GO_API_PORT:-21114}"
    local client_port="${CLIENT_API_PORT:-21121}"
    API_PORT="$go_port"
    local go_svc="/etc/systemd/system/betterdesk-server.service"

    if [ -f "$go_svc" ] && grep -qE '\-api-port[[:space:]]+21121\b' "$go_svc" 2>/dev/null; then
        print_info "Migrating Go -api-port 21121 → $go_port (handlers on Go; clients stay on :$client_port proxy)"
        sed -i "s/-api-port 21121/-api-port ${go_port}/" "$go_svc"
    fi

    if [ -z "$CONSOLE_PATH" ] || [ ! -f "$CONSOLE_PATH/.env" ]; then
        return 0
    fi

    local env_file="$CONSOLE_PATH/.env"
    local env_go_port
    env_go_port=$(grep -oP '^HBBS_API_URL=https?://[^:/]+:\K[0-9]+' "$env_file" 2>/dev/null | head -1)
    if [ "$env_go_port" = "21121" ]; then
        print_info "Pointing panel API URLs to Go :$go_port (was :21121)"
        sed -i "s|://localhost:21121/api|://localhost:${go_port}/api|g" "$env_file"
        sed -i "s|://127.0.0.1:21121/api|://127.0.0.1:${go_port}/api|g" "$env_file"
    fi

    sed -i 's/^API_ENABLED=.*/API_ENABLED=true/' "$env_file" 2>/dev/null || echo "API_ENABLED=true" >> "$env_file"
    sed -i "s/^API_PORT=.*/API_PORT=$client_port/" "$env_file" 2>/dev/null || echo "API_PORT=$client_port" >> "$env_file"
    sed -i 's/^RUSTDESK_API_PROXY=.*/RUSTDESK_API_PROXY=true/' "$env_file" 2>/dev/null || echo "RUSTDESK_API_PROXY=true" >> "$env_file"
    if grep -q '^GO_API_PORT=' "$env_file" 2>/dev/null; then
        sed -i "s/^GO_API_PORT=.*/GO_API_PORT=$go_port/" "$env_file"
    else
        echo "GO_API_PORT=$go_port" >> "$env_file"
    fi
    sed -i "s|^HBBS_API_URL=.*|HBBS_API_URL=http://localhost:${go_port}/api|" "$env_file"
    sed -i "s|^BETTERDESK_API_URL=.*|BETTERDESK_API_URL=http://localhost:${go_port}/api|" "$env_file"
}

# Safe in-place patch of systemd units (TLS API flags, HTTP URLs) without recreating units.
patch_service_definitions() {
    local changed=0
    local svc console_svc
    for svc in /etc/systemd/system/betterdesk-server.service; do
        [ -f "$svc" ] || continue
        local content new_content backup
        content=$(cat "$svc")
        new_content=$(printf '%s' "$content" \
            | sed -E 's/[[:space:]]-tls-api(=[^[:space:]]*)?//g' \
            | sed -E 's/[[:space:]]-tls-api-port(=[^[:space:]]*)?//g' \
            | sed 's|Environment=HBBS_API_URL=https://localhost|Environment=HBBS_API_URL=http://localhost|g' \
            | sed 's|Environment=BETTERDESK_API_URL=https://localhost|Environment=BETTERDESK_API_URL=http://localhost|g')
        if [ "$new_content" != "$content" ]; then
            backup="${svc}.bak.$(date +%Y%m%d%H%M%S)"
            cp "$svc" "$backup" 2>/dev/null || true
            printf '%s' "$new_content" > "$svc"
            print_info "Patched $(basename "$svc") (removed incompatible TLS API flags)"
            changed=1
        fi
    done

    console_svc="/etc/systemd/system/betterdesk-console.service"
    if [ -f "$console_svc" ]; then
        local console_user
        console_user=$(ensure_betterdesk_console_user)
        repair_console_service_user_line "$console_user"
        local content new_content backup
        content=$(cat "$console_svc")
        new_content=$(printf '%s' "$content" \
            | sed 's|Environment=HBBS_API_URL=https://localhost|Environment=HBBS_API_URL=http://localhost|g' \
            | sed 's|Environment=BETTERDESK_API_URL=https://localhost|Environment=BETTERDESK_API_URL=http://localhost|g')
        if [ "$console_user" != "root" ] && grep -q '^User=root' <<< "$new_content"; then
            new_content=$(printf '%s' "$new_content" | sed "s/^User=root/User=$console_user/")
            print_info "Patched betterdesk-console.service (User=$console_user)"
            changed=1
        fi
        local node_path
        node_path=$(command -v node 2>/dev/null || echo "/usr/bin/node")
        if ! grep -q '^ExecStartPre=.*linux-ensure-console-user' <<< "$new_content"; then
            new_content=$(printf '%s' "$new_content" | sed "s|^ExecStart=|ExecStartPre=+${node_path} ${CONSOLE_PATH}/scripts/linux-ensure-console-user.js\nExecStart=|")
            print_info "Patched betterdesk-console.service (ExecStartPre permission sync)"
            changed=1
        fi
        if [ "$new_content" != "$content" ]; then
            backup="${console_svc}.bak.$(date +%Y%m%d%H%M%S)"
            cp "$console_svc" "$backup" 2>/dev/null || true
            printf '%s' "$new_content" > "$console_svc"
            [ "$console_user" = "root" ] || print_info "Patched betterdesk-console.service (Go API URLs stay HTTP)"
            changed=1
        fi
    fi

    if [ "$changed" -eq 1 ]; then
        systemctl daemon-reload 2>/dev/null || true
        print_success "Service definitions patched (custom ExecStart preserved)"
    fi

    ensure_go_server_signal_ports 2>/dev/null || true
}

# During UPDATE: create missing units; patch existing ones safely (issue #158).
# Optional: UPDATE_REFRESH_SERVICES=true or second arg "recreate" → full setup_services.
maybe_update_services() {
    local mode="${1:-default}"
    local need_setup=false
    if [ ! -f /etc/systemd/system/betterdesk-server.service ]; then
        need_setup=true
    fi
    if [ -f "$CONSOLE_PATH/server.js" ] && [ ! -f /etc/systemd/system/betterdesk-console.service ]; then
        need_setup=true
    fi
    if [ "$need_setup" = true ]; then
        print_info "Service units missing — creating systemd services..."
        setup_services
        return
    fi

    patch_service_definitions
    repair_https_stuck_state yes

    if [ "$mode" = "recreate" ] || [ "${UPDATE_REFRESH_SERVICES:-false}" = true ]; then
        print_info "Recreating systemd service units from template..."
        setup_services
        return
    fi

    print_info "Service units present — patched in place (Repair → Repair services for full recreate)"
}

# Repair corrupted User= lines in betterdesk-console.service (#219).
# Command substitution must never capture repair warnings on stdout.
repair_console_service_user_line() {
    local want_user="${1:-betterdesk}"
    local svc_file="/etc/systemd/system/betterdesk-console.service"
    local user_count valid_count

    [ -f "$svc_file" ] || return 0

    user_count=$(grep -c '^User=' "$svc_file" 2>/dev/null || echo 0)
    valid_count=$(grep -cE "^User=(root|betterdesk)$" "$svc_file" 2>/dev/null || echo 0)

    if [ "$user_count" -eq 1 ] && [ "$valid_count" -eq 1 ]; then
        return 0
    fi

    print_warning "Repairing invalid User= in betterdesk-console.service (#219)"
    sed -i '/^User=/d' "$svc_file"
    sed -i "/^\[Service\]/a User=${want_user}" "$svc_file"
    systemctl daemon-reload 2>/dev/null || true
}

# Internal: permissions + optional LE repair (may print to stderr only).
_sync_betterdesk_console_user_permissions() {
    local svc_user="betterdesk"

    if ! id "$svc_user" &>/dev/null; then
        useradd -r -s /usr/sbin/nologin -d /var/lib/betterdesk -c "BetterDesk web console" "$svc_user" 2>/dev/null \
            || print_warning "Could not create system user '$svc_user' — console will stay on root"
    fi
    if ! id "$svc_user" &>/dev/null; then
        return 1
    fi

    mkdir -p /var/lib/betterdesk "$CONSOLE_PATH/data" "$RUSTDESK_PATH" "$RUSTDESK_PATH/ssl"
    chown -R "$svc_user:$svc_user" "$CONSOLE_PATH" 2>/dev/null || true
    chown root:"$svc_user" "$RUSTDESK_PATH" 2>/dev/null || true
    chmod 2775 "$RUSTDESK_PATH" 2>/dev/null || true
    if [ -d "$RUSTDESK_PATH/ssl" ]; then
        chown root:"$svc_user" "$RUSTDESK_PATH/ssl" 2>/dev/null || true
        chmod 2750 "$RUSTDESK_PATH/ssl" 2>/dev/null || true
    fi
    if [ -f "$RUSTDESK_PATH/.api_key" ]; then
        chown root:"$svc_user" "$RUSTDESK_PATH/.api_key" 2>/dev/null || true
        chmod 640 "$RUSTDESK_PATH/.api_key" 2>/dev/null || true
    fi
    for f in id_ed25519.pub db_v2.sqlite3 db_v2.sqlite3-wal db_v2.sqlite3-shm; do
        if [ -e "$RUSTDESK_PATH/$f" ]; then
            chown root:"$svc_user" "$RUSTDESK_PATH/$f" 2>/dev/null || true
            chmod g+rw "$RUSTDESK_PATH/$f" 2>/dev/null || true
        fi
    done
    for f in ssl/betterdesk.crt ssl/betterdesk.key; do
        if [ -e "$RUSTDESK_PATH/$f" ]; then
            chown root:"$svc_user" "$RUSTDESK_PATH/$f" 2>/dev/null || true
            chmod 640 "$RUSTDESK_PATH/$f" 2>/dev/null || true
        fi
    done
    { maybe_repair_le_ssl_symlinks || true; } >&2
    return 0
}

# Create a dedicated unprivileged user for the web console (audit H-7).
# stdout must contain ONLY the username (used in command substitution).
ensure_betterdesk_console_user() {
    if ! _sync_betterdesk_console_user_permissions; then
        echo "root"
        return
    fi
    echo "betterdesk"
}

setup_services() {
    print_step "Configuring systemd services..."

    ensure_api_compat_proxy_layout
    
    # SAFETY NET: Re-read database config from .env if shell vars are empty.
    # This prevents PostgreSQL → SQLite regression during UPDATE/REPAIR
    # if preserve_database_config() was not called or vars were lost.
    if [ "$USE_POSTGRESQL" != "true" ] && [ -f "$CONSOLE_PATH/.env" ]; then
        local _env_db_type
        _env_db_type=$(grep -m1 '^DB_TYPE=' "$CONSOLE_PATH/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
        if [ "$_env_db_type" = "postgres" ]; then
            POSTGRESQL_URI=$(grep -m1 '^DATABASE_URL=' "$CONSOLE_PATH/.env" 2>/dev/null | cut -d= -f2-)
            if [ -n "$POSTGRESQL_URI" ]; then
                USE_POSTGRESQL="true"
                print_info "Recovered PostgreSQL config from existing .env"
            fi
        fi
    fi
    
    # Get relay server IP according to RELAY_MODE / RELAY_SERVERS
    # (auto = public IP, local = LAN IP, public = forced public, RELAY_SERVERS = fixed)
    # Interactive relay mode selection (skipped in auto mode or when explicitly set)
    if [ "$AUTO_MODE" = false ] && [ -z "$RELAY_SERVERS" ] && [ "${RELAY_MODE:-auto}" = "auto" ]; then
        local _local_ip _public_ip
        _local_ip=$(get_local_ip)
        echo ""
        print_info "Relay server address controls how clients connect for remote sessions."
        echo -e "  ${CYAN}1)${NC} Internet / public  ${DIM}(auto-detect public IP — default)${NC}"
        echo -e "  ${CYAN}2)${NC} LAN only           ${DIM}(use this server's local IP: $_local_ip)${NC}"
        echo -e "  ${CYAN}3)${NC} Custom address     ${DIM}(enter a specific IP or host)${NC}"
        echo -ne "  ${CYAN}Select relay mode [1]:${NC} "
        read -r _relay_choice
        case "$_relay_choice" in
            2) RELAY_MODE="local" ;;
            3)
                echo -ne "  ${CYAN}Enter relay address (IP or host[:port]):${NC} "
                read -r RELAY_SERVERS
                ;;
            *) RELAY_MODE="auto" ;;
        esac
        echo ""
    fi

    local server_ip
    server_ip=$(resolve_relay_ip)

    resolve_connection_mode_env

    print_info "Relay server IP: $server_ip (mode: ${RELAY_SERVERS:+fixed}${RELAY_SERVERS:-$RELAY_MODE})"
    print_info "API Port: $API_PORT"

    local signal_rate_limit="${SIGNAL_RATE_LIMIT_PER_IP:-20}"
    if ! [[ "$signal_rate_limit" =~ ^[0-9]+$ ]]; then
        print_warning "Invalid SIGNAL_RATE_LIMIT_PER_IP='$signal_rate_limit'; using 20"
        signal_rate_limit="20"
    fi
    print_info "Signal registration rate limit: $signal_rate_limit/min (0 = disabled)"
    
    # Build database configuration
    local db_arg=""
    if [ "$USE_POSTGRESQL" = "true" ] && [ -n "$POSTGRESQL_URI" ]; then
        db_arg="-db \"$POSTGRESQL_URI\""
        print_info "Database: PostgreSQL"
    else
        db_arg="-db \"$RUSTDESK_PATH/db_v2.sqlite3\""
        print_info "Database: SQLite"
    fi
    
    # Build TLS arguments if certificates exist
    local tls_arg=""
    local ssl_dir="$RUSTDESK_PATH/ssl"
    local tls_is_selfsigned=false
    if [ -f "$ssl_dir/betterdesk.crt" ] && [ -f "$ssl_dir/betterdesk.key" ]; then
        # Check if certificate is self-signed (issuer == subject after stripping prefix)
        local cert_issuer cert_subject
        cert_issuer=$(openssl x509 -in "$ssl_dir/betterdesk.crt" -noout -issuer 2>/dev/null | sed 's/^issuer[= ]*//' || echo "")
        cert_subject=$(openssl x509 -in "$ssl_dir/betterdesk.crt" -noout -subject 2>/dev/null | sed 's/^subject[= ]*//' || echo "")
        if [ -n "$cert_issuer" ] && [ "$cert_issuer" = "$cert_subject" ]; then
            tls_is_selfsigned=true
        elif echo "$cert_subject" | grep -qi "BetterDesk"; then
            tls_is_selfsigned=true
        fi
        
        # Enable TLS on signal/relay for client encryption.
        # API port (21121) MUST stay HTTP — RustDesk desktop clients send plain HTTP
        # to the configured API server URL and do not support HTTPS for API endpoints
        # (heartbeat, sysinfo, login, ab). Enabling -tls-api breaks all clients.
        tls_arg="-tls-cert $ssl_dir/betterdesk.crt -tls-key $ssl_dir/betterdesk.key -tls-signal -tls-relay"
        
        if [ "$tls_is_selfsigned" = false ]; then
            print_info "TLS: Enabled for signal/relay (proper certificate found, API stays HTTP)"
        else
            print_info "TLS: Enabled for signal/relay (self-signed cert, API stays HTTP)"
        fi
    else
        print_info "TLS: Disabled (no certificate found)"
    fi
    
    # BetterDesk Go Server (single binary replacing hbbs+hbbr)
    # Generate shared API key for Node.js ↔ Go server communication (preserve existing)
    local api_key
    if [ -f "$RUSTDESK_PATH/.api_key" ] && [ -s "$RUSTDESK_PATH/.api_key" ]; then
        api_key=$(cat "$RUSTDESK_PATH/.api_key" | tr -d '\n')
        print_info "Using existing API key for console-server communication"
    else
        api_key=$(openssl rand -hex 32)
        echo "$api_key" > "$RUSTDESK_PATH/.api_key"
        chmod 600 "$RUSTDESK_PATH/.api_key"
        print_info "Generated API key for console-server communication"
    fi
    
    # Read admin password from install step (for syncing Go server admin)
    # Escape $ → $$ and % → %% for systemd (ExecStart interprets $VAR
    # as env var substitution and %n/%u/etc. as specifiers)
    local init_admin_arg=""
    if [ -n "$ADMIN_PASSWORD" ]; then
        local escaped_admin_pass
        escaped_admin_pass=$(printf '%s' "$ADMIN_PASSWORD" | sed 's/\$/\$\$/g; s/%/%%/g')
        init_admin_arg="-init-admin-pass $escaped_admin_pass"
    fi
    
    # Escape $ and % in database URL for systemd (PostgreSQL passwords can contain $ and %)
    local systemd_db_arg="$db_arg"
    systemd_db_arg=$(printf '%s' "$systemd_db_arg" | sed 's/\$/\$\$/g; s/%/%%/g')
    
    cat > /etc/systemd/system/betterdesk-server.service << EOF
[Unit]
Description=BetterDesk Go Server v$VERSION (Signal + Relay + API)
Documentation=https://github.com/UNITRONIX/Rustdesk-FreeConsole
After=network.target postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=$RUSTDESK_PATH
EnvironmentFile=-$CONSOLE_PATH/.env
Environment=AUTH_DB_PATH=$CONSOLE_PATH/data/auth.db
Environment=MESH_ENABLED=Y
Environment=SIGNAL_PORT=21116
Environment=RELAY_PORT=21117
Environment=GO_API_PORT=${GO_API_PORT:-21114}
$CONNECTION_MODE_ENV_BLOCK
ExecStart=$RUSTDESK_PATH/betterdesk-server -mode all -relay-servers $server_ip $systemd_db_arg -key-file $RUSTDESK_PATH/id_ed25519 -api-port $API_PORT -signal-rate-limit-per-ip $signal_rate_limit $init_admin_arg $tls_arg
Restart=always
RestartSec=5
LimitNOFILE=1000000

[Install]
WantedBy=multi-user.target
EOF

    print_success "Created betterdesk-server.service (Go)"
    
    # Remove legacy Rust services if they exist
    if [ -f /etc/systemd/system/rustdesksignal.service ]; then
        systemctl stop rustdesksignal 2>/dev/null || true
        systemctl disable rustdesksignal 2>/dev/null || true
        rm -f /etc/systemd/system/rustdesksignal.service
        print_info "Removed legacy rustdesksignal.service"
    fi
    
    if [ -f /etc/systemd/system/rustdeskrelay.service ]; then
        systemctl stop rustdeskrelay 2>/dev/null || true
        systemctl disable rustdeskrelay 2>/dev/null || true
        rm -f /etc/systemd/system/rustdeskrelay.service
        print_info "Removed legacy rustdeskrelay.service"
    fi
    
    # Remove legacy Flask betterdesk-api.service (deprecated in v2.3.0)
    if [ -f /etc/systemd/system/betterdesk-api.service ]; then
        systemctl stop betterdesk-api 2>/dev/null || true
        systemctl disable betterdesk-api 2>/dev/null || true
        rm -f /etc/systemd/system/betterdesk-api.service
        print_info "Removed legacy betterdesk-api.service (Flask)"
    fi
    
    # Remove stale betterdesk-go.service (manual installs, wrong credentials)
    if [ -f /etc/systemd/system/betterdesk-go.service ]; then
        systemctl stop betterdesk-go 2>/dev/null || true
        systemctl disable betterdesk-go 2>/dev/null || true
        rm -f /etc/systemd/system/betterdesk-go.service
        print_info "Removed stale betterdesk-go.service"
    fi

    # Console service (Web Interface) - Node.js only
    if [ "$CONSOLE_TYPE" = "nodejs" ]; then
        # Build database environment variables
        # Escape $ → $$ for systemd Environment= directives
        local db_env=""
        if [ "$USE_POSTGRESQL" = "true" ] && [ -n "$POSTGRESQL_URI" ]; then
            local escaped_pg_uri
            escaped_pg_uri=$(printf '%s' "$POSTGRESQL_URI" | sed 's/\$/\$\$/g')
            db_env="Environment=DB_TYPE=postgres
Environment=DATABASE_URL=$escaped_pg_uri"
        else
            db_env="Environment=DB_TYPE=sqlite
Environment=DB_PATH=$RUSTDESK_PATH/db_v2.sqlite3"
        fi
        
        # API port always stays HTTP (RustDesk clients require plain HTTP)
        local api_scheme="http"
        local tls_env=""
        if [ -n "$tls_arg" ]; then
                # Enable HTTPS on Node.js console (admin panel port 5443). The
                # RustDesk Client API port 21121 has its own TLS switch because
                # stock clients cannot trust self-signed certs here.
                local rustdesk_api_tls="auto"
                [ "$tls_is_selfsigned" = true ] && rustdesk_api_tls="false"
            tls_env="Environment=HTTPS_ENABLED=true
Environment=SSL_CERT_PATH=$ssl_dir/betterdesk.crt
        Environment=SSL_KEY_PATH=$ssl_dir/betterdesk.key
        Environment=RUSTDESK_API_TLS=$rustdesk_api_tls"
        fi
        
        # Detect node binary path dynamically (NodeSource, nvm, system, etc.)
        local node_path
        node_path=$(command -v node 2>/dev/null || which node 2>/dev/null || echo "/usr/bin/node")
        if [ ! -x "$node_path" ]; then
            print_warning "Node.js binary not found at $node_path — service may fail to start"
        fi

        # Preserve panel listen ports from .env (do not reset :80/:443 → :5000/:5443 on recreate) (#219).
        local console_http_port=5000
        local console_https_port=""
        local console_https_port_env=""
        if [ -f "$CONSOLE_PATH/.env" ]; then
            console_http_port=$(grep -m1 '^PORT=' "$CONSOLE_PATH/.env" 2>/dev/null | cut -d= -f2- | tr -d '[:space:]')
            [ -n "$console_http_port" ] || console_http_port=5000
            console_https_port=$(grep -m1 '^HTTPS_PORT=' "$CONSOLE_PATH/.env" 2>/dev/null | cut -d= -f2- | tr -d '[:space:]')
        fi
        if [ -n "$tls_env" ] || grep -qiE '^HTTPS_ENABLED=true' "$CONSOLE_PATH/.env" 2>/dev/null; then
            [ -n "$console_https_port" ] || console_https_port=5443
            console_https_port_env="Environment=HTTPS_PORT=${console_https_port}"
        fi

        local console_user
        console_user=$(ensure_betterdesk_console_user)
        print_info "Web console service user: $console_user"
        
        cat > /etc/systemd/system/betterdesk-console.service << EOF
[Unit]
Description=BetterDesk Web Console (Node.js)
Documentation=https://github.com/UNITRONIX/Rustdesk-FreeConsole
After=network.target betterdesk-server.service postgresql.service

[Service]
Type=simple
User=$console_user
WorkingDirectory=$CONSOLE_PATH
EnvironmentFile=-$CONSOLE_PATH/.env
ExecStartPre=+$node_path $CONSOLE_PATH/scripts/linux-ensure-console-user.js
ExecStart=$node_path server.js
StandardOutput=journal
StandardError=journal
SyslogIdentifier=betterdesk-console
Environment=NODE_ENV=production
Environment=RUSTDESK_DIR=$RUSTDESK_PATH
Environment=KEYS_PATH=$RUSTDESK_PATH
Environment=DATA_DIR=$CONSOLE_PATH/data
$db_env
Environment=HBBS_API_URL=$api_scheme://localhost:${GO_API_PORT:-21114}/api
Environment=BETTERDESK_API_URL=$api_scheme://localhost:${GO_API_PORT:-21114}/api
Environment=SERVER_BACKEND=betterdesk
Environment=API_ENABLED=true
Environment=API_PORT=${CLIENT_API_PORT:-21121}
Environment=RUSTDESK_API_PROXY=true
Environment=GO_API_PORT=${GO_API_PORT:-21114}
Environment=API_HOST=0.0.0.0
Environment=PORT=${console_http_port}
${console_https_port_env}
Environment=HOST=0.0.0.0
$tls_env
$([ "$tls_is_selfsigned" = true ] && echo "Environment=NODE_EXTRA_CA_CERTS=$ssl_dir/betterdesk.crt" || true)
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
        print_success "Created betterdesk-console.service (Node.js)"
        repair_console_service_user_line "$console_user"
        
        # Remove legacy betterdesk.service if exists
        if [ -f /etc/systemd/system/betterdesk.service ]; then
            systemctl stop betterdesk 2>/dev/null || true
            systemctl disable betterdesk 2>/dev/null || true
            rm -f /etc/systemd/system/betterdesk.service
            print_info "Removed legacy betterdesk.service"
        fi
    fi

    systemctl daemon-reload
    
    print_success "Systemd services configured"
    print_info "Services: betterdesk-server, betterdesk-console"
}

run_migrations() {
    print_step "Running database migrations..."
    
    if [ -d "$SCRIPT_DIR/migrations" ]; then
        cd "$SCRIPT_DIR/migrations"
        
        # Export auto mode flag for migration scripts
        if [ "$AUTO_MODE" = true ]; then
            export BETTERDESK_AUTO=1
        fi
        
        for migration in v*.py; do
            if [ -f "$migration" ]; then
                print_info "Migration: $migration"
                # Pass database path as argument
                python3 "$migration" "$DB_PATH" 2>&1 || {
                    print_warning "Migration $migration returned non-zero exit code (may already be applied)"
                }
            fi
        done
        
        unset BETTERDESK_AUTO
    fi
    
    print_success "Migrations completed"
}

create_admin_user() {
    print_step "Creating admin user..."
    
    # Node.js console only (Flask removed in v2.3.0)
    if [ ! -f "$CONSOLE_PATH/server.js" ]; then
        print_warning "No Node.js console detected, skipping admin creation"
        return
    fi
    
    # Node.js console - admin is created automatically on startup.
    # Prefer in-memory password from installer, then .env fallback.
    local admin_password="${ADMIN_PASSWORD:-}"
    if [ -z "$admin_password" ] && [ -f "$CONSOLE_PATH/.env" ]; then
        admin_password=$(grep -E '^DEFAULT_ADMIN_PASSWORD=' "$CONSOLE_PATH/.env" | head -1 | cut -d= -f2-)
    fi

    if [ -n "$admin_password" ]; then
        echo ""
        echo -e "${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
        echo -e "${GREEN}║            PANEL LOGIN CREDENTIALS                    ║${NC}"
        echo -e "${GREEN}╠════════════════════════════════════════════════════════╣${NC}"
        echo -e "${GREEN}║  Login:    ${WHITE}admin${GREEN}                                     ║${NC}"
        echo -e "${GREEN}║  Password: ${WHITE}${admin_password}${GREEN}                         ║${NC}"
        echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}"
        echo ""

        if [ "$STORE_ADMIN_CREDENTIALS" = "true" ]; then
            cat > "$RUSTDESK_PATH/.admin_credentials" << CREDEOF
Admin Username: admin
Admin Password: $admin_password
Generated by: BetterDesk installer
Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)
CREDEOF
            chmod 600 "$RUSTDESK_PATH/.admin_credentials"
            print_info "Credentials saved in: $RUSTDESK_PATH/.admin_credentials"
        else
            print_warning "Credentials are not persisted by default (security hardening)."
            print_info "Set STORE_ADMIN_CREDENTIALS=true to restore legacy behavior."
        fi
    else
        print_warning "No admin password available for display"
        print_info "Use option 6 (Password reset) if needed"
    fi
}

start_services() {
    # Use enhanced start function with health verification
    start_services_with_verification
}

#===============================================================================
# BetterDesk Minimal Installation (Go server only, no web console)
#===============================================================================

do_install_minimal() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ MINIMAL INSTALLATION (Server Only) ══════════${NC}"
    echo ""
    
    print_info "BetterDesk Minimal installs the Go server binary only."
    print_info "No web console, no Node.js, no npm dependencies."
    print_info "Manage via REST API on port ${GO_API_PORT:-21114} or TCP admin console."
    echo ""
    
    detect_installation
    
    if [ "$INSTALL_STATUS" = "complete" ]; then
        print_warning "BetterDesk is already installed!"
        if [ "$AUTO_MODE" = false ]; then
            if ! confirm "Do you want to reinstall in Minimal mode?"; then
                return
            fi
        fi
        do_backup_silent
    fi
    
    # Choose database type (SQLite or PostgreSQL)
    choose_database_type
    
    # Stop services if running
    graceful_stop_services
    
    # Minimal: no Node.js dependencies needed
    print_step "Checking system dependencies..."
    command -v curl >/dev/null 2>&1 || apt-get install -y curl
    
    # Install and configure PostgreSQL if selected
    if [ "$USE_POSTGRESQL" = "true" ]; then
        install_postgresql || { print_error "PostgreSQL installation failed"; return 1; }
        setup_postgresql_database || { print_error "PostgreSQL setup failed"; return 1; }
    fi
    
    detect_architecture
    install_binaries || { print_error "Binary installation failed"; return 1; }
    
    # Skip console installation entirely
    print_info "Skipping web console (Minimal mode)"
    
    # Generate self-signed TLS certificates (default for fresh installs)
    generate_ssl_certificates
    
    # Migrate existing SQLite data to PostgreSQL if applicable
    if [ "$USE_POSTGRESQL" = "true" ]; then
        migrate_sqlite_to_postgresql
    fi
    
    # Setup only the Go server service (no console service)
    setup_services_minimal
    
    # Configure firewall rules (signal + relay + API only, no console ports)
    print_step "Configuring firewall rules..."
    if command -v ufw >/dev/null 2>&1; then
        ufw allow "${GO_API_PORT:-21114}/tcp" comment "BetterDesk Go API (default)" 2>/dev/null || true
        ufw allow 21115/tcp comment "BetterDesk NAT" 2>/dev/null || true
        ufw allow 21116/tcp comment "BetterDesk Signal TCP" 2>/dev/null || true
        ufw allow 21116/udp comment "BetterDesk Signal UDP" 2>/dev/null || true
        ufw allow 21117/tcp comment "BetterDesk Relay" 2>/dev/null || true
        ufw allow 21118/tcp comment "BetterDesk WS Signal" 2>/dev/null || true
        ufw allow 21119/tcp comment "BetterDesk WS Relay" 2>/dev/null || true
    fi
    
    # Start server
    print_step "Starting BetterDesk server..."
    systemctl daemon-reload
    systemctl start betterdesk-server.service 2>/dev/null || true
    systemctl enable betterdesk-server.service 2>/dev/null || true
    
    sleep 3
    
    # Verify
    if systemctl is-active --quiet betterdesk-server.service; then
        print_success "BetterDesk server is running"
    else
        print_error "BetterDesk server failed to start"
        journalctl -u betterdesk-server.service --no-pager -n 20
        return 1
    fi
    
    echo ""
    print_success "===== BETTERDESK MINIMAL INSTALLATION COMPLETE ====="
    echo ""
    
    local SERVER_IP
    SERVER_IP=$(get_public_ip)
    
    echo -e "${GREEN}Server: ${SERVER_IP}${NC}"
    echo -e "${GREEN}Go API: http://${SERVER_IP}:${GO_API_PORT:-21114}${NC}"
    echo ""
    echo -e "${YELLOW}Ports: ${GO_API_PORT:-21114} (Go API), ${CLIENT_API_PORT:-21121} (compat proxy, full install), 21115-21117 (Signal/Relay)${NC}"
    echo -e "${YELLOW}No web console installed. Use REST API or TCP admin for management.${NC}"
    echo ""
    
    press_enter
}

setup_services_minimal() {
    print_step "Setting up BetterDesk server service (Minimal mode)..."
    
    local GO_BINARY_PATH="$INSTALL_DIR/betterdesk-server"
    local KEY_DIR="$INSTALL_DIR"
    local DB_DIR="$INSTALL_DIR"
    
    # Build server arguments
    local SERVER_ARGS="-key $KEY_DIR"
    SERVER_ARGS="$SERVER_ARGS -db $DB_DIR"
    
    # Add relay servers argument
    local SERVER_IP
    SERVER_IP=$(resolve_relay_ip)
    if [ -n "$SERVER_IP" ]; then
        SERVER_ARGS="$SERVER_ARGS -relay-servers $SERVER_IP"
    fi
    resolve_connection_mode_env

    local signal_rate_limit="${SIGNAL_RATE_LIMIT_PER_IP:-20}"
    if ! [[ "$signal_rate_limit" =~ ^[0-9]+$ ]]; then
        print_warning "Invalid SIGNAL_RATE_LIMIT_PER_IP='$signal_rate_limit'; using 20"
        signal_rate_limit="20"
    fi
    SERVER_ARGS="$SERVER_ARGS -signal-rate-limit-per-ip $signal_rate_limit"
    
    # Database configuration for Go server
    # Escape $ -> $$ for systemd (PostgreSQL passwords can contain $)
    local GO_ENV=""
    if [ "$USE_POSTGRESQL" = "true" ] && [ -n "$POSTGRESQL_URI" ]; then
        local escaped_pg_uri
        escaped_pg_uri=$(printf '%s' "$POSTGRESQL_URI" | sed 's/\$/\$\$/g')
        GO_ENV="Environment=\"DB_URL=$escaped_pg_uri\""
    fi
    
    # TLS configuration — look for certificates in standard ssl/ directory
    local SSL_DIR="$INSTALL_DIR/ssl"
    local TLS_CERT_PATH="$SSL_DIR/betterdesk.crt"
    local TLS_KEY_PATH="$SSL_DIR/betterdesk.key"
    
    # Also check legacy paths for backwards compatibility
    if [ ! -f "$TLS_CERT_PATH" ] && [ -f "$INSTALL_DIR/cert.pem" ]; then
        TLS_CERT_PATH="$INSTALL_DIR/cert.pem"
        TLS_KEY_PATH="$INSTALL_DIR/key.pem"
    fi
    
    if [ -f "$TLS_CERT_PATH" ] && [ -f "$TLS_KEY_PATH" ]; then
        SERVER_ARGS="$SERVER_ARGS -tls-cert $TLS_CERT_PATH -tls-key $TLS_KEY_PATH -tls-signal -tls-relay"
        
        # Enterprise TLS still keeps the Go API HTTP for RustDesk client
        # compatibility. Only signal/relay receive TLS flags here.
        if [ "${ENTERPRISE_TLS:-false}" = "true" ]; then
            print_info "Enterprise TLS enabled: API port ${API_PORT:-21121} stays HTTP"
        fi
    fi
    
    # Remove old services (cleanup)
    for old_svc in rustdesksignal rustdeskrelay betterdesk-api betterdesk-go betterdesk-console; do
        if systemctl is-active --quiet "$old_svc.service" 2>/dev/null; then
            systemctl stop "$old_svc.service" 2>/dev/null || true
        fi
        if [ -f "/etc/systemd/system/$old_svc.service" ]; then
            systemctl disable "$old_svc.service" 2>/dev/null || true
            rm -f "/etc/systemd/system/$old_svc.service"
        fi
    done
    
    cat > /etc/systemd/system/betterdesk-server.service <<EOF
[Unit]
Description=BetterDesk Server (Minimal)
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
$( [ -n "$CONSOLE_PATH" ] && [ -f "$CONSOLE_PATH/.env" ] && echo "EnvironmentFile=-$CONSOLE_PATH/.env" )
ExecStart=$GO_BINARY_PATH $SERVER_ARGS
Restart=always
RestartSec=5
$GO_ENV
Environment=MESH_ENABLED=Y
$CONNECTION_MODE_ENV_BLOCK

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$INSTALL_DIR $DB_DIR
ProtectHome=true
PrivateTmp=true

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=betterdesk-server

[Install]
WantedBy=multi-user.target
EOF
    
    systemctl daemon-reload
    print_success "BetterDesk server service created (Minimal mode)"
}

do_install() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ FRESH INSTALLATION ══════════${NC}"
    echo ""
    
    detect_installation
    
    if [ "$INSTALL_STATUS" = "complete" ]; then
        print_warning "BetterDesk is already installed!"
        if [ "$AUTO_MODE" = false ]; then
            if ! confirm "Do you want to reinstall?"; then
                return
            fi
        fi
        do_backup_silent
    fi
    
    echo ""
    print_info "Starting BetterDesk Console v$VERSION installation..."
    echo ""
    
    # Choose database type (SQLite or PostgreSQL)
    choose_database_type
    
    # Stop services if running (prevents "Text file busy" error)
    graceful_stop_services
    
    install_dependencies
    
    # Install and configure PostgreSQL if selected
    if [ "$USE_POSTGRESQL" = "true" ]; then
        install_postgresql || { print_error "PostgreSQL installation failed"; return 1; }
        setup_postgresql_database || { print_error "PostgreSQL setup failed"; return 1; }
    fi
    
    detect_architecture
    install_binaries || { print_error "Binary installation failed"; return 1; }
    install_console
    
    # Generate self-signed TLS certificates (default for fresh installs)
    generate_ssl_certificates
    
    # Migrate existing SQLite data to PostgreSQL if applicable
    if [ "$USE_POSTGRESQL" = "true" ]; then
        migrate_sqlite_to_postgresql
    fi
    
    setup_services
    run_migrations
    create_admin_user
    
    # Configure firewall rules
    print_step "Configuring firewall rules..."
    configure_firewall_rules
    
    start_services
    
    # Post-install verification: confirm services are actually running
    local install_ok=true
    sleep 2
    
    local go_state
    go_state=$(systemctl show betterdesk-server --property=ActiveState --value 2>/dev/null || echo "unknown")
    if [ "$go_state" != "active" ]; then
        print_error "betterdesk-server is $go_state (expected: active)"
        print_info "Debug: journalctl -u betterdesk-server -n 30 --no-pager"
        install_ok=false
    fi
    
    local console_state
    console_state=$(systemctl show betterdesk-console --property=ActiveState --value 2>/dev/null || echo "unknown")
    if [ "$console_state" != "active" ]; then
        print_warning "betterdesk-console is $console_state (expected: active)"
        print_info "Debug: journalctl -u betterdesk-console -n 30 --no-pager"
        install_ok=false
    fi
    
    echo ""
    if [ "$install_ok" = true ]; then
        print_success "Installation completed successfully!"
    else
        print_warning "Installation finished but some services are not running."
        print_info "Run option 8 (Diagnostics) to investigate."
    fi
    echo ""
    
    local server_ip
    server_ip=$(get_public_ip)
    local public_key=""
    if [ -f "$RUSTDESK_PATH/id_ed25519.pub" ]; then
        public_key=$(cat "$RUSTDESK_PATH/id_ed25519.pub")
    fi
    
    local db_type_info="SQLite"
    if [ "$USE_POSTGRESQL" = "true" ]; then
        db_type_info="PostgreSQL"
    fi
    
    local tls_status="Disabled"
    if [ -f "$RUSTDESK_PATH/ssl/betterdesk.crt" ] && [ -f "$RUSTDESK_PATH/ssl/betterdesk.key" ]; then
        tls_status="Self-signed (auto-generated)"
    fi
    
    echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║              INSTALLATION INFO                             ║${NC}"
    echo -e "${CYAN}╠════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${CYAN}║  Panel Web:     ${WHITE}http://$server_ip:5000${CYAN}                        ║${NC}"
    echo -e "${CYAN}║  API Port:      ${WHITE}$API_PORT${CYAN}                                     ║${NC}"
    echo -e "${CYAN}║  Server ID:     ${WHITE}$server_ip${CYAN}                                    ║${NC}"
    echo -e "${CYAN}║  Database:      ${WHITE}$db_type_info${CYAN}                                 ║${NC}"
    echo -e "${CYAN}║  TLS:           ${WHITE}$tls_status${CYAN}                                   ║${NC}"
    echo -e "${CYAN}║  Key:           ${WHITE}${public_key:0:20}...${CYAN}                          ║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
    
    # Offer TLS configuration for fresh installs
    if [ "$install_ok" = true ] && [ "$AUTO_MODE" = false ]; then
        echo ""
        print_info "Production TLS options:"
        print_info "  • External reverse proxy (Caddy/Nginx on :443) — recommended when a proxy already handles certificates"
        print_info "  • Enterprise TLS (Option 5 in SSL menu) — BetterDesk-native HTTPS on panel + signal/relay"
        echo ""
        if confirm "Will TLS terminate at an external reverse proxy (Caddy/Nginx)?"; then
            do_configure_reverse_proxy || true
        elif confirm "Would you like to configure HTTPS Enterprise now? (Option 5 in SSL menu)"; then
            do_configure_ssl
        fi
    fi
    
    if [ "$AUTO_MODE" = false ]; then
        press_enter
    fi
}

#===============================================================================
# Update Functions
#===============================================================================

# GitHub repository configuration for online updates
UPDATE_GITHUB_OWNER="${UPDATE_GITHUB_OWNER:-Chesster1981}"
UPDATE_GITHUB_REPO="${UPDATE_GITHUB_REPO:-BetterDesk}"
UPDATE_GITHUB_BRANCH="${UPDATE_GITHUB_BRANCH:-main}"
UPDATE_CLONE_DIR="/tmp/betterdesk-update-$$"

read_update_github_branch_from_env() {
    local env_file="${CONSOLE_PATH:-}/.env"
    if [ -n "$CONSOLE_PATH" ] && [ -f "$env_file" ]; then
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
    local env_file="${CONSOLE_PATH:-}/.env"
    if [ -z "$CONSOLE_PATH" ]; then
        print_error "Console path unknown — cannot save update channel"
        return 1
    fi
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
    return 0
}

switch_update_channel() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ UPDATE CHANNEL ══════════${NC}"
    echo ""
    detect_installation
    if [ "$INSTALL_STATUS" = "none" ]; then
        print_error "BetterDesk is not installed!"
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
    menu_choose "Update Channel" "Stable is recommended for production servers"
    case "${MENU_CHOICE:-main}" in
        0) return ;;
        main)
            write_update_github_branch_to_env "main"
            ;;
        dev)
            print_warning "Development channel may include unstable changes."
            write_update_github_branch_to_env "dev"
            ;;
        *)
            write_update_github_branch_to_env "main"
            ;;
    esac
    print_info "Run 'Check for updates' in the console or use Online GitHub update to apply."
    press_enter
}

run_terminal_project_update() {
    local cli_path="$CONSOLE_PATH/scripts/update-cli.js"
    local node_bin=""
    node_bin=$(command -v node 2>/dev/null || true)

    if [ -z "$node_bin" ] || [ ! -f "$cli_path" ]; then
        return 2
    fi

    print_step "Running commit-aware project updater..."
    print_info "Updater CLI: $cli_path"

    local args=()
    if [ "${AUTO_MODE:-false}" = "true" ]; then
        args+=("--yes")
    fi

    "$node_bin" "$cli_path" "${args[@]}"
    return $?
}

# Pull latest project from GitHub and apply update to local installation.
# This is the primary update path — it fetches the full repo, rebuilds
# the Go server, and reinstalls the Node.js console from fresh source.
# All local state (databases, keys, .env, auth.db) is preserved.
update_from_github() {
    local clone_dir="$UPDATE_CLONE_DIR"
    local server_build_failed=0

    read_update_github_branch_from_env

    # Clean up any leftover clone from a previous failed run
    rm -rf "$clone_dir"

    # ---- Step 1: Clone or download latest code ----
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
        # Fallback: download tarball via curl
        local tarball_url="https://github.com/${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO}/archive/refs/heads/${UPDATE_GITHUB_BRANCH}.tar.gz"
        local tarball_path="/tmp/betterdesk-update-$$.tar.gz"
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

    # Validate downloaded source
    if [ ! -f "$clone_dir/betterdesk-server/go.mod" ] || [ ! -f "$clone_dir/web-nodejs/server.js" ]; then
        print_error "Downloaded source is incomplete or invalid"
        rm -rf "$clone_dir"
        return 1
    fi

    # Read remote version
    local remote_version=""
    if [ -f "$clone_dir/VERSION" ]; then
        remote_version=$(cat "$clone_dir/VERSION" | tr -d '[:space:]')
    fi
    if [ -n "$remote_version" ]; then
        print_info "Remote version: $remote_version"
    fi

    # ---- Step 2: Update Go server source & compile ----
    print_step "Updating Go server source..."
    if [ -d "$GO_SERVER_SOURCE" ]; then
        # Backup existing source (lightweight — just rename)
        mv "$GO_SERVER_SOURCE" "${GO_SERVER_SOURCE}.pre-update.$$" 2>/dev/null || true
    fi
    # Copy the *contents* into a guaranteed-existing destination. Copying the
    # directory itself would nest the new tree inside an existing
    # $GO_SERVER_SOURCE if the rename above failed (e.g. a locked/busy file),
    # leaving the old inconsistent source in place and breaking `go build`
    # with "undefined" errors (issue #158).
    mkdir -p "$GO_SERVER_SOURCE"
    cp -rf "$clone_dir/betterdesk-server/." "$GO_SERVER_SOURCE/"

    # Restore any local data/ directory that existed in the old source dir
    if [ -d "${GO_SERVER_SOURCE}.pre-update.$$/data" ]; then
        cp -rn "${GO_SERVER_SOURCE}.pre-update.$$/data" "$GO_SERVER_SOURCE/" 2>/dev/null || true
    fi
    rm -rf "${GO_SERVER_SOURCE}.pre-update.$$"
    print_success "Go server source updated"

    # Compile Go server
    print_step "Building Go server..."
    if ! check_go_installed; then
        print_info "Installing Go toolchain..."
        if ! install_golang; then
            print_warning "Go toolchain not available — server binary not updated"
            print_info "Install Go manually from https://go.dev/dl/ and re-run update"
            # Non-critical: source files were updated, binary can be built later
        fi
    fi

    if check_go_installed; then
        if compile_go_server; then
            print_success "Go server compiled successfully"
            # Deploy binary to installation path
            if [ -f "$GO_SERVER_SOURCE/betterdesk-server" ]; then
                # Backup existing binary
                if [ -f "$RUSTDESK_PATH/betterdesk-server" ]; then
                    cp "$RUSTDESK_PATH/betterdesk-server" \
                       "$RUSTDESK_PATH/betterdesk-server.bak.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
                fi
                kill_stale_processes "betterdesk-server"
                kill_processes_holding_ports
                cp "$GO_SERVER_SOURCE/betterdesk-server" "$RUSTDESK_PATH/betterdesk-server"
                chmod +x "$RUSTDESK_PATH/betterdesk-server"
                print_success "Go server binary deployed to $RUSTDESK_PATH"
            fi
        else
            print_warning "Go server compilation failed — keeping existing binary"
            print_info "Use the panel Rebuild server binary button or option 7 (Build & deploy server)"
            server_build_failed=1
        fi
    fi

    # ---- Step 3: Update Node.js console files ----
    print_step "Updating Node.js web console..."

    # Preserve critical local state files before overwriting
    local state_files=(".env" "data" "node_modules")
    local preserved_dir="/tmp/betterdesk-console-state-$$"
    mkdir -p "$preserved_dir"

    for item in "${state_files[@]}"; do
        if [ -e "$CONSOLE_PATH/$item" ]; then
            cp -a "$CONSOLE_PATH/$item" "$preserved_dir/$item" 2>/dev/null || true
        fi
    done

    # Copy new console files (overwrite code, but not state)
    # Use rsync if available for selective copy, otherwise cp
    if command -v rsync &>/dev/null; then
        rsync -a --delete \
            --exclude='data/' \
            --exclude='node_modules/' \
            --exclude='.env' \
            --exclude='.env.local' \
            --exclude='*.sqlite3' \
            --exclude='*.sqlite3-wal' \
            --exclude='*.sqlite3-shm' \
            --exclude='*.db' \
            --exclude='*.db-wal' \
            --exclude='*.db-shm' \
            --exclude='.session_secret' \
            --exclude='.update_sha' \
            --exclude='.api_key' \
            --exclude='.admin_credentials' \
            --exclude='.force_password_update' \
            "$clone_dir/web-nodejs/" "$CONSOLE_PATH/"
    else
        # cp fallback: copy everything then restore state (glob * skips dotfiles — #166)
        cp -r "$clone_dir/web-nodejs/"* "$CONSOLE_PATH/"
        if [ -f "$clone_dir/web-nodejs/.env.example" ]; then
            cp -a "$clone_dir/web-nodejs/.env.example" "$CONSOLE_PATH/.env.example"
        fi
        # Restore preserved state files
        for item in "${state_files[@]}"; do
            if [ -e "$preserved_dir/$item" ]; then
                if [ -d "$preserved_dir/$item" ]; then
                    # For directories (data/, node_modules/), don't delete the new
                    # copy — just ensure old files are restored
                    cp -a "$preserved_dir/$item/"* "$CONSOLE_PATH/$item/" 2>/dev/null || true
                else
                    cp -a "$preserved_dir/$item" "$CONSOLE_PATH/$item" 2>/dev/null || true
                fi
            fi
        done
    fi
    rm -rf "$preserved_dir"
    print_success "Console files updated"

    # Install npm dependencies if package.json changed
    print_step "Installing npm dependencies..."
    cd "$CONSOLE_PATH"
    local npm_log="/tmp/betterdesk_npm_install.log"
    if npm install --production --no-audit --no-fund > "$npm_log" 2>&1; then
        print_success "npm dependencies installed"
    else
        print_warning "npm install had issues (non-critical):"
        tail -5 "$npm_log"
    fi
    rm -f "$npm_log"

    # Stage Go support-agent source for the Generator build worker
    print_step "Staging support-agent source for Generator builds..."
    if stage_support_agent_source "$clone_dir"; then
        mkdir -p "$CONSOLE_PATH/data"
        printf '{"reason":"betterdesk.sh update","at":"%s"}\n' \
            "$(date -Iseconds 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)" \
            > "$CONSOLE_PATH/data/.agent_rebuild_pending"
        print_info "Generator bundles will rebuild after console restart"
    else
        print_warning "Support-agent source staging skipped"
    fi

    # Merge any new .env keys from .env.example (preserve operator settings — issue #158)
    print_step "Merging new .env configuration keys..."
    merge_console_env false || print_warning ".env merge skipped (merge-env.js unavailable)"

    # ---- Step 4: Update installer scripts ----
    print_step "Updating installer scripts..."
    local scripts_updated=0
    for script_file in betterdesk.sh betterdesk.ps1 betterdesk-docker.sh \
                       docker-compose.yml docker-compose.single.yml docker-compose.quick.yml \
                       docker-compose.quick.single.yml docker-compose.quick.single.macvlan.yml \
                       Dockerfile Dockerfile.server Dockerfile.console VERSION; do
        if [ -f "$clone_dir/$script_file" ]; then
            cp "$clone_dir/$script_file" "$SCRIPT_DIR/$script_file" 2>/dev/null || true
            if [[ "$script_file" == *.sh ]]; then
                chmod +x "$SCRIPT_DIR/$script_file" 2>/dev/null || true
            fi
            scripts_updated=$((scripts_updated + 1))
        fi
    done
    print_success "$scripts_updated installer files updated"

    # ---- Step 5: Update SHA tracking for in-app updater ----
    if command -v git &>/dev/null && [ -d "$clone_dir/.git" ]; then
        local remote_sha
        remote_sha=$(git -C "$clone_dir" rev-parse HEAD 2>/dev/null)
        if [ -n "$remote_sha" ]; then
            mkdir -p "$CONSOLE_PATH/data"
            echo "$remote_sha" > "$CONSOLE_PATH/data/.update_sha"
            echo "$remote_sha" > "$CONSOLE_PATH/data/.agent_source_sha"
            rm -f "$CONSOLE_PATH/data/.last_update_result.json"
            print_info "SHA tracking updated: ${remote_sha:0:7}"
        fi
    fi

    # ---- Step 6: Update VERSION file in project root ----
    if [ -f "$clone_dir/VERSION" ] && [ -n "$remote_version" ]; then
        cp "$clone_dir/VERSION" "$SCRIPT_DIR/VERSION" 2>/dev/null || true
        cp "$clone_dir/VERSION" "$CONSOLE_PATH/VERSION" 2>/dev/null || true
    fi

    # Cleanup
    rm -rf "$clone_dir"

    print_success "All project files updated from GitHub"
    if [ "$server_build_failed" -eq 1 ]; then
        print_error "Go server binary was not rebuilt — update incomplete for server component"
        return 1
    fi
    return 0
}

# After update replaces betterdesk.sh on disk, re-exec so Repair / Protocol Toggle
# use the new functions (bash keeps the old script in memory otherwise) (#219).
reexec_installer_after_update() {
    if [ "${AUTO_MODE:-false}" = "true" ]; then
        return 0
    fi
    if [ "${BETTERDESK_REEXECED:-}" = "1" ]; then
        return 0
    fi
    local self="${SCRIPT_DIR}/betterdesk.sh"
    if [ ! -f "$self" ]; then
        self="${BASH_SOURCE[0]}"
    fi
    print_info "Reloading installer so the next menu action uses the updated betterdesk.sh (#219)"
    press_enter
    exec env BETTERDESK_REEXECED=1 bash "$self" "${BETTERDESK_ORIG_ARGV[@]}"
}

# If Update already wrote a newer betterdesk.sh, re-exec before Repair/Toggle (#219).
maybe_reexec_if_installer_on_disk_is_newer() {
    if [ "${AUTO_MODE:-false}" = "true" ]; then
        return 0
    fi
    if [ "${BETTERDESK_REEXECED:-}" = "1" ]; then
        return 0
    fi
    local self="${SCRIPT_DIR}/betterdesk.sh"
    [ -f "$self" ] || return 0
    local disk_rev
    disk_rev=$(grep -m1 '^BETTERDESK_SH_REVISION=' "$self" 2>/dev/null | cut -d= -f2- | tr -d "\"'[:space:]")
    if [ -z "$disk_rev" ] || [ "$disk_rev" = "${BETTERDESK_SH_REVISION:-}" ]; then
        return 0
    fi
    print_info "Installer on disk is newer (revision $disk_rev) — reloading before this action (#219)"
    exec env BETTERDESK_REEXECED=1 bash "$self" "${BETTERDESK_ORIG_ARGV[@]}"
}

do_update() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ UPDATE ══════════${NC}"
    echo ""
    
    detect_installation
    
    if [ "$INSTALL_STATUS" = "none" ]; then
        print_error "BetterDesk is not installed!"
        print_info "Use 'FRESH INSTALLATION' option"
        press_enter
        return
    fi
    
    # Detect Rust → Go upgrade (major architecture change)
    if [ "${SERVER_TYPE:-}" = "rust" ]; then
        print_warning "Legacy Rust server (hbbs/hbbr) detected!"
        print_warning "Upgrading from Rust to Go server requires a FRESH INSTALLATION."
        print_info "The Go server is a single binary replacing both hbbs and hbbr."
        print_info "Your data (keys, database) will be preserved during migration."
        echo ""
        if [ "${AUTO_MODE:-false}" = "true" ]; then
            print_info "Auto mode: Redirecting to fresh installation for Rust → Go migration"
            do_install
            return
        else
            read -rp "Proceed with fresh installation (recommended)? [Y/n] " answer
            if [ "${answer,,}" != "n" ]; then
                do_install
                return
            else
                print_warning "Continuing with update — legacy Rust binaries will NOT be replaced with Go server."
            fi
        fi
    fi
    
    # CRITICAL: Preserve database configuration before reinstalling console
    # This prevents PostgreSQL → SQLite switch during updates
    preserve_database_config

    # ---- Update method selection ----
    read_update_github_branch_from_env
    print_info "GitHub update branch: $UPDATE_GITHUB_BRANCH"

    if [ "${AUTO_MODE:-false}" = "true" ]; then
        print_info "Auto mode: using GitHub pull update"
    else
        local _menu_items=(
            $'Online update from GitHub\tDownload latest code, rebuild server, update console'
            $'In-app updater\tBuilt-in Node.js commit-aware updater'
            $'Local update\tCopy files from this script\'s directory'
            $'Switch update channel\tChoose stable (main) or development (dev) branch'
            $'Back\tReturn to the main menu'
        )
        local _menu_returns=( 1 2 3 4 0 )
        menu_choose "Update Method" "Online GitHub update is recommended"
        update_method="${MENU_CHOICE:-1}"

        case "$update_method" in
            0)
                return
                ;;
            4)
                switch_update_channel
                return
                ;;
            2)
                if run_terminal_project_update; then
                    print_success "Online project update completed"
                    reexec_installer_after_update
                    return
                else
                    update_rc=$?
                    if [ "$update_rc" -ne 2 ]; then
                        print_error "In-app update failed (exit code: $update_rc)"
                    else
                        print_error "In-app updater not available (Node.js or CLI script missing)"
                    fi
                    press_enter
                    return
                fi
                ;;
            3)
                # Legacy local update path
                print_info "Using local files from: $SCRIPT_DIR"
                print_info "Creating backup before update..."
                do_backup_silent
                graceful_stop_services
                detect_architecture
                install_binaries true
                install_console
                run_migrations
                maybe_update_services
                prepare_console_after_update
                maybe_create_admin_user_on_update
                if ! start_services_with_verification; then
                    print_error "Local update applied but services did not start correctly"
                    press_enter
                    return 1
                fi
                print_success "Local update completed!"
                reexec_installer_after_update
                return
                ;;
            1|*)
                # Fall through to GitHub update below
                ;;
        esac
    fi

    # ---- GitHub Pull Update ----
    print_info "Creating backup before update..."
    do_backup_silent

    # Stop services gracefully before updating files
    graceful_stop_services

    if ! update_from_github; then
        print_error "GitHub update failed"
        print_info "Attempting to restart services with existing files..."
        if ! start_services_with_verification; then
            print_error "Could not restart services after failed update"
        fi
        press_enter
        return 1
    fi

    # Run database migrations (adds missing columns etc.)
    run_migrations

    local svc_mode="default"
    if [ "${AUTO_MODE:-false}" != true ]; then
        echo ""
        read -rp "Recreate systemd service units from installer template? [y/N] " _recreate_svc
        if [ "${_recreate_svc,,}" = "y" ] || [ "${_recreate_svc,,}" = "yes" ]; then
            svc_mode="recreate"
        fi
    fi
    
    # Patch existing units or create missing; optional full recreate (issue #158)
    maybe_update_services "$svc_mode"

    prepare_console_after_update || print_warning "Console prep after update reported issues"
    maybe_create_admin_user_on_update

    # Start services with verification (#306 — do not claim success if Console is down)
    if ! start_services_with_verification; then
        print_error "Update files applied but services did not start correctly"
        print_info "Fix Console with: sudo systemctl start betterdesk-console"
        print_info "Logs: journalctl -u betterdesk-console -n 50 --no-pager"
        press_enter
        return 1
    fi
    
    print_success "Update completed!"
    if [ -n "${remote_version:-}" ]; then
        print_info "BetterDesk is now at version $remote_version"
    fi
    reexec_installer_after_update
}

#===============================================================================
# Repair Functions
#===============================================================================

do_repair() {
    maybe_reexec_if_installer_on_disk_is_newer
    print_header
    echo -e "${WHITE}${BOLD}══════════ REPAIR INSTALLATION ══════════${NC}"
    echo ""
    
    detect_installation
    
    # CRITICAL: Preserve database configuration before any repair operation
    # This prevents PostgreSQL → SQLite switch when regenerating service files
    preserve_database_config
    
    print_status
    
    local _menu_items=(
        $'Repair binaries\tReplace the server binary with BetterDesk Go'
        $'Repair database\tAdd missing columns / run migrations'
        $'Repair services\tRegenerate systemd service units'
        $'Repair permissions\tFix file ownership and permissions'
        $'Repair HTTPS / TLS\tFix LE certs, signal port :5000 conflict (#219)'
        $'Full repair\tRun all repair steps above'
        $'Back\tReturn to the main menu'
    )
    local _menu_returns=( 1 2 3 4 5 6 0 )
    menu_choose "Repair Installation" "Choose what to repair"
    local repair_choice="$MENU_CHOICE"
    
    case $repair_choice in
        1) repair_binaries ;;
        2) repair_database ;;
        3) repair_services ;;
        4) repair_permissions ;;
        5) repair_https_tls ;;
        6) 
            repair_binaries
            repair_database
            repair_services
            repair_permissions
            repair_https_tls
            print_success "Full repair completed!"
            ;;
        0) return ;;
    esac
    
    press_enter
}

repair_binaries() {
    print_step "Repairing BetterDesk Go Server..."
    
    detect_architecture
    
    local go_binary="$GO_SERVER_SOURCE/betterdesk-server"
    
    # Check if Go binary exists, or compile it
    if [ ! -f "$go_binary" ]; then
        print_info "Go server binary not found, checking if we can compile..."
        
        if ! check_go_installed; then
            print_info "Installing Go toolchain..."
            if ! install_golang; then
                print_error "Failed to install Go toolchain"
                return 1
            fi
        fi
        
        if ! compile_go_server; then
            print_error "Failed to compile Go server"
            return 1
        fi
    fi
    
    # Create backup before repair
    if [ -f "$RUSTDESK_PATH/betterdesk-server" ]; then
        cp "$RUSTDESK_PATH/betterdesk-server" "$RUSTDESK_PATH/betterdesk-server.backup.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
    fi
    
    # Gracefully stop all services
    graceful_stop_services
    
    # Extra safety: wait and verify files are not in use
    sleep 2
    
    # Check if binary is still locked (Text file busy prevention)
    if lsof "$RUSTDESK_PATH/betterdesk-server" 2>/dev/null | grep -q .; then
        print_error "betterdesk-server binary is still in use!"
        kill_stale_processes "betterdesk-server"
        sleep 2
    fi
    
    # Now install binary
    if ! install_binaries; then
        print_error "Failed to install binary"
        return 1
    fi
    
    # Start services with health verification
    if ! start_services_with_verification; then
        print_error "Services failed to start after binary repair"
        print_info "Check logs above for details"
        return 1
    fi
    
    print_success "Go server binary repaired and services verified!"
}

repair_database() {
    print_step "Repair database..."
    
    if [ ! -f "$DB_PATH" ]; then
        print_warning "Database does not exist, creating new one..."
        touch "$DB_PATH"
    fi
    
    # Add missing columns
    python3 << EOF
import sqlite3

conn = sqlite3.connect('$DB_PATH')
cursor = conn.cursor()

# Ensure peer table has required columns
columns_to_add = [
    ('status', 'INTEGER DEFAULT 0'),
    ('last_online', 'TEXT'),
    ('is_deleted', 'INTEGER DEFAULT 0'),
    ('deleted_at', 'TEXT'),
    ('updated_at', 'TEXT'),
    ('note', 'TEXT'),
    ('previous_ids', 'TEXT'),
    ('id_changed_at', 'TEXT'),
]

cursor.execute("PRAGMA table_info(peer)")
existing_columns = [col[1] for col in cursor.fetchall()]

for col_name, col_def in columns_to_add:
    if col_name not in existing_columns:
        try:
            cursor.execute(f"ALTER TABLE peer ADD COLUMN {col_name} {col_def}")
            print(f"  Added column: {col_name}")
        except Exception as e:
            pass

conn.commit()
conn.close()
print("Database repaired")
EOF

    print_success "Database repaired"
}

repair_services() {
    print_step "Repairing systemd services..."
    
    # Stop services gracefully first
    graceful_stop_services
    
    # Backup existing service files
    for svc in betterdesk-server betterdesk-console rustdesksignal rustdeskrelay betterdesk; do
        if [ -f "/etc/systemd/system/${svc}.service" ]; then
            cp "/etc/systemd/system/${svc}.service" "/etc/systemd/system/${svc}.service.backup.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
        fi
    done
    
    # Verify Go server binary exists
    if [ ! -f "$RUSTDESK_PATH/betterdesk-server" ]; then
        print_error "betterdesk-server binary not found at $RUSTDESK_PATH/betterdesk-server"
        print_info "Run 'Repair binaries' first"
        return 1
    fi
    
    # Regenerate service files
    setup_services
    
    # Start services with health verification
    if ! start_services_with_verification; then
        print_error "Services failed to start after repair"
        print_info "Restoring backup service files..."
        
        for svc in betterdesk-server betterdesk-console; do
            backup_file=$(ls -t /etc/systemd/system/${svc}.service.backup.* 2>/dev/null | head -1)
            if [ -n "$backup_file" ]; then
                cp "$backup_file" "/etc/systemd/system/${svc}.service"
            fi
        done
        systemctl daemon-reload
        
        return 1
    fi
    
    print_success "Services repaired and verified!"
}

repair_permissions() {
    print_step "Repairing permissions..."

    if [ -f "$CONSOLE_PATH/server.js" ]; then
        local console_user
        console_user=$(ensure_betterdesk_console_user)
        print_info "Console tree owner: $console_user"
        if [ -f "$CONSOLE_PATH/scripts/linux-ensure-console-user.js" ] && command -v node &>/dev/null; then
            if [ "$(id -u)" -eq 0 ]; then
                node "$CONSOLE_PATH/scripts/linux-ensure-console-user.js" || print_warning "Console permission script reported issues"
            elif command -v sudo &>/dev/null && sudo -n true 2>/dev/null; then
                sudo -n node "$CONSOLE_PATH/scripts/linux-ensure-console-user.js" || print_warning "Console permission script reported issues"
            else
                print_warning "Console permission sync skipped (run as root: sudo node $CONSOLE_PATH/scripts/linux-ensure-console-user.js)"
            fi
        fi
        repair_https_stuck_state yes
        ensure_console_tls_material_readable 2>/dev/null || true
    fi

    chmod +x "$RUSTDESK_PATH/betterdesk-server" 2>/dev/null || true

    if systemctl is-enabled --quiet betterdesk-console 2>/dev/null; then
        systemctl restart betterdesk-console 2>/dev/null || true
        sleep 2
        if systemctl is-active --quiet betterdesk-console 2>/dev/null; then
            print_success "Permissions repaired — console is running"
        else
            print_warning "Permissions synced but console still inactive — check: journalctl -u betterdesk-console -n 40 --no-pager"
        fi
    else
        print_success "Permissions repaired"
    fi
}

repair_https_tls() {
    print_step "Repairing HTTPS / TLS configuration (#219)..."

    repair_https_stuck_state

    if confirm "Restart BetterDesk services now?"; then
        systemctl restart betterdesk-server betterdesk-console 2>/dev/null || true
        verify_service_health "betterdesk-server" "21116" 15 >/dev/null 2>&1 || true
        verify_service_health "betterdesk-console" "$(resolve_panel_health_port)" 15 >/dev/null 2>&1 || true
        print_success "BetterDesk services restarted"
        run_protocol_tests
    else
        print_info "Repair saved. Restart later: systemctl restart betterdesk-server betterdesk-console"
    fi
}

#===============================================================================
# Validation Functions
#===============================================================================

do_validate() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ INSTALLATION VALIDATION ══════════${NC}"
    echo ""
    
    local errors=0
    local warnings=0
    
    detect_installation
    detect_architecture
    
    echo -e "${WHITE}Checking components...${NC}"
    echo ""
    
    # Check directories
    echo -n "  RustDesk directory ($RUSTDESK_PATH): "
    if [ -d "$RUSTDESK_PATH" ]; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${RED}✗ Not found${NC}"
        errors=$((errors + 1))
    fi
    
    echo -n "  Console directory ($CONSOLE_PATH): "
    if [ -d "$CONSOLE_PATH" ]; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${RED}✗ Not found${NC}"
        errors=$((errors + 1))
    fi
    
    # Check Go server binary
    echo -n "  BetterDesk Server (Go): "
    if [ -x "$RUSTDESK_PATH/betterdesk-server" ]; then
        echo -e "${GREEN}✓ Single binary (signal + relay + API)${NC}"
    elif [ -x "$RUSTDESK_PATH/hbbs" ] && [ -x "$RUSTDESK_PATH/hbbr" ]; then
        echo -e "${YELLOW}! Legacy Rust binaries (consider upgrading to Go)${NC}"
        warnings=$((warnings + 1))
    else
        echo -e "${RED}✗ Not found or missing permissions${NC}"
        errors=$((errors + 1))
    fi
    
    # Check database
    echo -n "  Database: "
    local validate_db_type="sqlite"
    if [ -f "$CONSOLE_PATH/.env" ]; then
        validate_db_type=$(grep -m1 '^DB_TYPE=' "$CONSOLE_PATH/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
        validate_db_type="${validate_db_type:-sqlite}"
    fi

    if [ "$validate_db_type" = "postgres" ]; then
        local pg_uri
        pg_uri=$(grep -m1 '^DATABASE_URL=' "$CONSOLE_PATH/.env" 2>/dev/null | cut -d= -f2-)
        if [ -n "$pg_uri" ] && PGCONNECT_TIMEOUT=3 psql "$pg_uri" -c "SELECT 1" &>/dev/null 2>&1; then
            echo -e "${GREEN}✓ PostgreSQL${NC}"
            # Check tables in PostgreSQL
            echo -n "    - Table peers: "
            if PGCONNECT_TIMEOUT=3 psql "$pg_uri" -c "SELECT 1 FROM peers LIMIT 1" &>/dev/null 2>&1; then
                echo -e "${GREEN}✓${NC}"
            else
                echo -e "${YELLOW}! Empty or not found (will be created on first start)${NC}"
                warnings=$((warnings + 1))
            fi
            echo -n "    - Table users: "
            if PGCONNECT_TIMEOUT=3 psql "$pg_uri" -c "SELECT 1 FROM users LIMIT 1" &>/dev/null 2>&1; then
                echo -e "${GREEN}✓${NC}"
            else
                echo -e "${YELLOW}! Empty or not found (will be created on first start)${NC}"
                warnings=$((warnings + 1))
            fi
        else
            echo -e "${RED}✗ PostgreSQL connection failed${NC}"
            errors=$((errors + 1))
        fi
    elif [ -f "$DB_PATH" ]; then
        echo -e "${GREEN}✓ SQLite${NC}"
        
        # Check tables (Go uses 'peers', legacy uses 'peer')
        echo -n "    - Table peers: "
        if sqlite3 "$DB_PATH" "SELECT 1 FROM peers LIMIT 1" 2>/dev/null; then
            echo -e "${GREEN}✓${NC}"
        elif sqlite3 "$DB_PATH" "SELECT 1 FROM peer LIMIT 1" 2>/dev/null; then
            echo -e "${YELLOW}! Legacy schema (peer)${NC}"
            warnings=$((warnings + 1))
        else
            echo -e "${YELLOW}! Empty or not found (will be created on first start)${NC}"
            warnings=$((warnings + 1))
        fi
        
        echo -n "    - Table users: "
        if sqlite3 "$DB_PATH" "SELECT 1 FROM users LIMIT 1" 2>/dev/null; then
            echo -e "${GREEN}✓${NC}"
        else
            echo -e "${YELLOW}! Empty or not found (will be created on first start)${NC}"
            warnings=$((warnings + 1))
        fi
    else
        # Check if Go server is running — it creates the DB on start
        if systemctl is-active --quiet betterdesk-server 2>/dev/null; then
            echo -e "${YELLOW}! SQLite file not yet created (server running, will create on first connection)${NC}"
            warnings=$((warnings + 1))
        else
            echo -e "${RED}✗ Not found (will be created when server starts)${NC}"
            errors=$((errors + 1))
        fi
    fi
    
    # Check keys
    echo -n "  Ed25519 key: "
    if [ -f "$RUSTDESK_PATH/id_ed25519.pub" ] || [ -f "$RUSTDESK_PATH/id_ed25519" ]; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${YELLOW}! Will be generated on first start${NC}"
        warnings=$((warnings + 1))
    fi
    
    # Check services
    echo ""
    echo -e "${WHITE}Checking services...${NC}"
    echo ""
    
    # Check Go server service first
    echo -n "  betterdesk-server (Go): "
    if systemctl is-active --quiet betterdesk-server 2>/dev/null; then
        echo -e "${GREEN}● Active (signal + relay + API)${NC}"
    elif systemctl is-enabled --quiet betterdesk-server 2>/dev/null; then
        echo -e "${YELLOW}○ Enabled but inactive${NC}"
        warnings=$((warnings + 1))
    elif systemctl list-unit-files betterdesk-server.service &>/dev/null 2>&1; then
        echo -e "${RED}○ Disabled${NC}"
        errors=$((errors + 1))
    else
        # Check legacy Rust services
        echo -e "${CYAN}Not installed${NC}"
        
        for service in rustdesksignal rustdeskrelay; do
            echo -n "  $service (Legacy Rust): "
            if systemctl is-active --quiet "$service" 2>/dev/null; then
                echo -e "${GREEN}● Active${NC}"
            elif systemctl is-enabled --quiet "$service" 2>/dev/null; then
                echo -e "${YELLOW}○ Enabled but inactive${NC}"
                warnings=$((warnings + 1))
            else
                echo -e "${RED}○ Disabled${NC}"
                errors=$((errors + 1))
            fi
        done
    fi
    
    echo -n "  betterdesk-console (Node.js): "
    if systemctl is-active --quiet betterdesk-console 2>/dev/null; then
        echo -e "${GREEN}● Active${NC}"
    elif systemctl is-active --quiet betterdesk 2>/dev/null; then
        echo -e "${GREEN}● Active (legacy name)${NC}"
    elif systemctl is-enabled --quiet betterdesk-console 2>/dev/null; then
        echo -e "${YELLOW}○ Enabled but inactive${NC}"
        warnings=$((warnings + 1))
    else
        echo -e "${RED}○ Disabled${NC}"
        errors=$((errors + 1))
    fi
    
    # Check ports
    echo ""
    echo -e "${WHITE}Checking ports...${NC}"
    echo ""
    
    for port in "${GO_API_PORT:-21114}" "${CLIENT_API_PORT:-21121}" 21115 21116 21117 5000; do
        echo -n "  Port $port: "
        if ss -tlnp 2>/dev/null | grep -q ":$port " || netstat -tlnp 2>/dev/null | grep -q ":$port "; then
            local pname=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'users:\(\("\K[^"]+' 2>/dev/null | head -1)
            echo -e "${GREEN}● Listening${NC}${pname:+ ($pname)}"
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
        echo -e "${CYAN}Use 'REPAIR INSTALLATION' option to fix problems${NC}"
    fi
    
    press_enter
}

#===============================================================================
# Backup Functions
#===============================================================================

do_backup() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ BACKUP ══════════${NC}"
    echo ""
    
    do_backup_silent
    
    print_success "Backup completed!"
    press_enter
}

do_backup_silent() {
    local backup_name="betterdesk_backup_$(date +%Y%m%d_%H%M%S)"
    local backup_path="$BACKUP_DIR/$backup_name"
    
    mkdir -p "$backup_path"
    
    print_step "Creating backup: $backup_name"
    
    # Backup database
    if [ -f "$DB_PATH" ]; then
        cp "$DB_PATH" "$backup_path/"
        print_info "  - Database"
    fi
    
    # Backup keys
    if [ -f "$RUSTDESK_PATH/id_ed25519" ]; then
        cp "$RUSTDESK_PATH/id_ed25519"* "$backup_path/"
        print_info "  - Keys"
    fi
    
    # Backup API key
    if [ -f "$RUSTDESK_PATH/.api_key" ]; then
        cp "$RUSTDESK_PATH/.api_key" "$backup_path/"
        print_info "  - API key"
    fi
    
    # Backup credentials
    if [ -f "$RUSTDESK_PATH/.admin_credentials" ]; then
        cp "$RUSTDESK_PATH/.admin_credentials" "$backup_path/"
        print_info "  - Login credentials"
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
    print_header
    echo -e "${WHITE}${BOLD}══════════ ADMIN PASSWORD RESET ══════════${NC}"
    echo ""
    
    # Refresh detection
    auto_detect_paths
    
    if [ "$CONSOLE_TYPE" = "none" ]; then
        print_error "No console installation detected!"
        press_enter
        return
    fi
    
    echo -e "Detected console type: ${CYAN}${CONSOLE_TYPE}${NC}"
    echo ""
    
    local _menu_items=(
        $'Generate random password\tCreate a strong random admin password'
        $'Set custom password\tType a new password (min. 8 characters)'
        $'Back\tReturn to the main menu'
    )
    local _menu_returns=( 1 2 0 )
    menu_choose "Admin Password Reset" "Console type: ${CONSOLE_TYPE}"
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
    
    local success=false
    
    if [ "$CONSOLE_TYPE" = "nodejs" ]; then
        # --- Hotfix: detect broken Go-first auth flow (commit 188991d) ---
        # If authService.js contains the broken Go-first authenticate() function,
        # auto-download the fixed version. Without this, NO password will work.
        local auth_service="$CONSOLE_PATH/services/authService.js"
        if [ -f "$auth_service" ] && grep -q 'checkGoServerHealth.*authenticateViaGo' "$auth_service" 2>/dev/null; then
            # Check if authenticate() delegates to Go first (broken pattern)
            if grep -q 'const health = await checkGoServerHealth' "$auth_service" 2>/dev/null; then
                print_warning "Detected broken authentication flow (Go-first delegation bug)"
                print_info "Downloading fixed authService.js from GitHub..."
                local fixed_url="https://raw.githubusercontent.com/UNITRONIX/BetterDesk/main/web-nodejs/services/authService.js"
                if curl -fsSL "$fixed_url" -o "$auth_service.tmp" 2>/dev/null; then
                    # Verify the fix was downloaded correctly (check for local-first pattern)
                    if grep -q 'Step 1: Check local database FIRST' "$auth_service.tmp" 2>/dev/null; then
                        mv "$auth_service.tmp" "$auth_service"
                        print_success "Fixed authentication flow (restored local-first login)"
                    else
                        rm -f "$auth_service.tmp"
                        print_warning "Downloaded file does not contain expected fix — skipped"
                    fi
                else
                    rm -f "$auth_service.tmp" 2>/dev/null
                    print_warning "Could not download fix (no internet?) — password reset will proceed but login may still fail"
                    print_info "Manual fix: curl -sL '$fixed_url' -o '$auth_service'"
                fi
            fi
        fi

        # Detect database type from console .env
        local db_type="sqlite"
        if [ -f "$CONSOLE_PATH/.env" ]; then
            local env_db_type
            env_db_type=$(grep -E '^DB_TYPE=' "$CONSOLE_PATH/.env" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')
            if [ "$env_db_type" = "postgres" ] || [ "$env_db_type" = "postgresql" ]; then
                db_type="postgres"
            fi
        fi
        
        print_info "Database type: $db_type"
        
        # Use Node.js reset-password script (supports both SQLite and PostgreSQL)
        local reset_script="$CONSOLE_PATH/scripts/reset-password.js"
        if [ -f "$reset_script" ] && command -v node &> /dev/null; then
            print_info "Using reset-password.js script..."
            pushd "$CONSOLE_PATH" > /dev/null
            # The script reads .env for DB_TYPE and DATABASE_URL automatically
            DATA_DIR="$CONSOLE_PATH/data" node "$reset_script" "$new_password" admin
            if [ $? -eq 0 ]; then
                success=true
            fi
            popd > /dev/null
        fi
        
        # Fallback: direct database update
        if [ "$success" = "false" ]; then
            if [ "$db_type" = "postgres" ]; then
                # PostgreSQL mode — use psql or Python with psycopg2
                local pg_url
                pg_url=$(grep -E '^DATABASE_URL=' "$CONSOLE_PATH/.env" 2>/dev/null | head -1 | cut -d= -f2-)
                
                if [ -n "$pg_url" ] && command -v python3 &> /dev/null; then
                    print_info "Using Python to update PostgreSQL..."
                    PG_URL="$pg_url" RESET_ADMIN_PASSWORD="$new_password" python3 << 'PYEOF'
import bcrypt
import os
try:
    import psycopg2
except ImportError:
    import subprocess, sys
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'psycopg2-binary', '-q'])
    import psycopg2

pg_url = os.environ.get('PG_URL', '')
new_password = os.environ.get('RESET_ADMIN_PASSWORD', '')
password_hash = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt(12)).decode()

conn = psycopg2.connect(pg_url)
cursor = conn.cursor()

# Create table if missing
cursor.execute('''CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'admin',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_login TIMESTAMPTZ
)''')

cursor.execute("UPDATE users SET password_hash = %s WHERE username = 'admin'", (password_hash,))

if cursor.rowcount == 0:
    cursor.execute("INSERT INTO users (username, password_hash, role) VALUES ('admin', %s, 'admin')", (password_hash,))

conn.commit()
conn.close()
print("Password updated successfully (PostgreSQL)")
PYEOF
                    if [ $? -eq 0 ]; then
                        success=true
                    fi
                fi
            else
                # SQLite mode — update auth.db directly
                local auth_db_path="$CONSOLE_PATH/data/auth.db"
                if [ ! -f "$auth_db_path" ]; then
                    auth_db_path="$RUSTDESK_PATH/auth.db"
                fi
                print_info "Auth database: $auth_db_path"
                
                AUTH_DB_PATH="$auth_db_path" RESET_ADMIN_PASSWORD="$new_password" python3 << 'PYEOF'
import sqlite3
import bcrypt
import os

auth_db_path = os.environ.get('AUTH_DB_PATH', '')

# Create parent directory if needed
os.makedirs(os.path.dirname(auth_db_path), exist_ok=True)

conn = sqlite3.connect(auth_db_path)
cursor = conn.cursor()

# Ensure table exists (for fresh installations)
cursor.execute('''CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'admin',
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT
)''')

new_password = os.environ.get('RESET_ADMIN_PASSWORD', '')
password_hash = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt(12)).decode()

cursor.execute("UPDATE users SET password_hash = ? WHERE username = 'admin'", (password_hash,))

if cursor.rowcount == 0:
    cursor.execute('''INSERT INTO users (username, password_hash, role)
                      VALUES ('admin', ?, 'admin')''', (password_hash,))

conn.commit()
conn.close()
print("Password updated successfully")
PYEOF
                if [ $? -eq 0 ]; then
                    success=true
                fi
            fi
        fi
    fi

    echo ""
    if [ "$success" = "true" ]; then
        # Update DEFAULT_ADMIN_PASSWORD in .env so ensureDefaultAdmin() does not
        # overwrite the new hash on next Node.js restart
        if [ -f "$CONSOLE_PATH/.env" ]; then
            if grep -q '^DEFAULT_ADMIN_PASSWORD=' "$CONSOLE_PATH/.env" 2>/dev/null; then
                # Use awk to safely handle passwords with special chars (|, &, $, etc.)
                awk -v pw="$new_password" '/^DEFAULT_ADMIN_PASSWORD=/{print "DEFAULT_ADMIN_PASSWORD=" pw; next}{print}' "$CONSOLE_PATH/.env" > "$CONSOLE_PATH/.env.tmp" && mv "$CONSOLE_PATH/.env.tmp" "$CONSOLE_PATH/.env"
            fi
        fi
        
        # Restart console so it picks up the new .env value
        if systemctl is-active betterdesk-console &>/dev/null; then
            print_info "Restarting betterdesk-console..."
            systemctl restart betterdesk-console 2>/dev/null || true
            sleep 2
        fi
        
        echo -e "${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
        echo -e "${GREEN}║              NEW LOGIN CREDENTIALS                       ║${NC}"
        echo -e "${GREEN}╠════════════════════════════════════════════════════════╣${NC}"
        echo -e "${GREEN}║  Login:    ${WHITE}admin${GREEN}                                     ║${NC}"
        echo -e "${GREEN}║  Password: ${WHITE}${new_password}${GREEN}                         ║${NC}"
        echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}"
        
        # Persist credentials only when explicitly requested.
        if [ "$STORE_ADMIN_CREDENTIALS" = "true" ]; then
            cat > "$RUSTDESK_PATH/.admin_credentials" << CREDEOF
Admin Username: admin
Admin Password: $new_password
Generated by: BetterDesk password reset
Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)
CREDEOF
            chmod 600 "$RUSTDESK_PATH/.admin_credentials"
        fi
    else
        print_error "Failed to reset password!"
        print_info "Make sure Python with bcrypt is installed, or Node.js for Node.js console"
    fi
    
    press_enter
}

#===============================================================================
# Build Functions
#===============================================================================

# Stage Go support-agent sources where the Node.js build worker expects them.
# Called after console updates and toolchain install so Generator builds work
# without a full git checkout on the production host.
stage_support_agent_source() {
    local repo_root="${1:-$SCRIPT_DIR}"
    local console_path="${CONSOLE_PATH:-/opt/BetterDeskConsole}"
    local base="$console_path/agent-source"
    local build_user="${SUDO_USER:-${BUILD_USER:-unitronix}}"

    local support_src="$repo_root/betterdesk-support-agent"
    local agent_lib_src="$repo_root/betterdesk-agent"
    local server_lib_src="$repo_root/betterdesk-server"
    local support_dst="$base/betterdesk-support-agent"
    local agent_lib_dst="$base/betterdesk-agent"
    local server_lib_dst="$base/betterdesk-server"

    if [ ! -f "$support_src/build.sh" ]; then
        print_warning "Support agent source not found: $support_src (Generator builds will fail)"
        return 1
    fi

    mkdir -p "$base"
    local staged=0
    for pair in "$support_src:$support_dst" "$agent_lib_src:$agent_lib_dst" "$server_lib_src:$server_lib_dst"; do
        local src="${pair%%:*}"
        local dst="${pair#*:}"
        if [ ! -d "$src" ]; then
            print_warning "Missing agent source tree: $src"
            continue
        fi
        if command -v rsync &>/dev/null; then
            rsync -a --delete \
                --exclude '.git/' \
                --exclude 'dist/' \
                --exclude 'data/' \
                "$src/" "$dst/"
        else
            rm -rf "$dst"
            mkdir -p "$dst"
            cp -a "$src/." "$dst/"
        fi
        staged=$((staged + 1))
    done

    if [ "$staged" -eq 0 ]; then
        print_error "No support-agent sources staged"
        return 1
    fi

    chown -R "$build_user:$build_user" "$base" 2>/dev/null || true
    print_success "Go support-agent source staged at $base"
    return 0
}

# Install the toolchain used by the Node.js console worker to compile branded
# agent installers (cargo + rustup + tauri-cli + cargo-xwin + nsis + rpm +
# appimagetool + mingw-w64). Runs the standalone script shipped alongside the
# installer; idempotent. Requires ~3 GB download + 5 GB free disk.
do_install_build_toolchain() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ AGENT BUILD TOOLCHAIN ══════════${NC}"
    echo ""
    echo "  Installs: Rust stable, cargo-tauri 2.x, cargo-xwin,"
    echo "            mingw-w64 (Windows cross-compile), NSIS,"
    echo "            rpm-build, appimagetool, pnpm, WebKit dev libs."
    echo ""
    echo "  Disk:  ~3 GB download, ~5 GB after install,"
    echo "         plus cargo build cache (/var/cache/betterdesk-build)."
    echo ""
    echo "  This is REQUIRED for the 'Generator Agenta' feature."
    echo "  Skip if you do not generate branded agent installers."
    echo ""

    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local toolchain_script="$script_dir/scripts/install-build-toolchain.sh"

    if [ ! -f "$toolchain_script" ]; then
        print_error "Toolchain installer not found: $toolchain_script"
        print_info "Pull the latest repository and try again."
        press_enter
        return 1
    fi

    if [ "$AUTO_MODE" != true ]; then
        read -p "Proceed with toolchain install? [y/N]: " confirm
        confirm="${confirm:-N}"
        if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
            print_info "Cancelled."
            press_enter
            return 0
        fi
    fi

    local extra_args=()
    [ "$AUTO_MODE" = true ] && extra_args+=(--unattended)

    BUILD_USER="${SUDO_USER:-${BUILD_USER:-unitronix}}" \
        bash "$toolchain_script" "${extra_args[@]}"

    local rc=$?
    if [ $rc -eq 0 ]; then
        stage_support_agent_source "$script_dir" || true
        print_success "Build toolchain installed."
        print_info "Restart the console service to pick up new PATH:"
        print_info "  sudo systemctl restart betterdesk-console"
    else
        print_error "Toolchain installer exited with code $rc"
    fi
    press_enter
    return $rc
}

do_build() {
    local _menu_items=(
        $'Rebuild & deploy server\tCompile, stop, replace and restart the Go server'
        $'Compile server only\tBuild the Go binary without deploying it'
        $'Build legacy Rust binaries\tArchived hbbs/hbbr (advanced)'
        $'Back\tReturn to the main menu'
    )
    local _menu_returns=( 1 2 3 0 )
    menu_choose "Build & Deploy" "Rebuild and deploy the BetterDesk Go server"
    local build_choice="${MENU_CHOICE:-1}"

    case $build_choice in
        1) do_rebuild_go_server ;;
        2) do_compile_go_only ;;
        3) do_build_legacy_rust ;;
        0) return ;;
        *) print_warning "Invalid option"; sleep 1 ;;
    esac
}

# Rebuild & deploy Go server: compile → backup → stop → replace → start → verify
do_rebuild_go_server() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ REBUILD & DEPLOY GO SERVER ══════════${NC}"
    echo ""

    detect_installation

    if [ "$INSTALL_STATUS" = "none" ]; then
        print_warning "BetterDesk is not installed. Binary will be compiled but not deployed."
        if ! confirm "Continue with compilation only?"; then
            press_enter
            return
        fi
        do_compile_go_only
        return
    fi

    # Step 1: Compile
    print_step "[1/5] Compiling Go server from source..."
    detect_architecture

    if ! compile_go_server; then
        print_error "Compilation failed — aborting. Current installation is untouched."
        press_enter
        return
    fi

    local new_binary="$GO_SERVER_SOURCE/betterdesk-server"
    if [ ! -f "$new_binary" ]; then
        print_error "Compiled binary not found at $new_binary"
        press_enter
        return
    fi

    # Step 2: Backup current binary
    print_step "[2/5] Backing up current binary..."
    local installed_binary="$RUSTDESK_PATH/betterdesk-server"
    local ts
    ts=$(date +%Y%m%d_%H%M%S)
    if [ -f "$installed_binary" ]; then
        cp "$installed_binary" "${installed_binary}.backup.${ts}"
        print_info "Backup: ${installed_binary}.backup.${ts}"
    else
        print_info "No existing binary to backup"
    fi

    # Step 3: Stop services
    print_step "[3/5] Stopping services..."
    graceful_stop_services

    # Step 4: Replace binary
    print_step "[4/5] Deploying new binary..."
    mkdir -p "$RUSTDESK_PATH"
    cp "$new_binary" "$installed_binary"
    chmod +x "$installed_binary"
    local size
    size=$(du -h "$installed_binary" | cut -f1)
    print_success "Deployed: $installed_binary ($size)"

    # Step 5: Start services and verify
    print_step "[5/5] Starting services..."
    start_services_with_verification

    if systemctl is-active --quiet betterdesk-server 2>/dev/null; then
        echo ""
        print_success "Go server rebuilt and deployed successfully!"
        echo ""
        echo -e "${WHITE}Recent logs:${NC}"
        journalctl -u betterdesk-server -n 5 --no-pager 2>/dev/null || true
    else
        print_error "Service failed to start after rebuild!"
        echo ""
        echo -e "${YELLOW}Rolling back to previous binary...${NC}"
        if [ -f "${installed_binary}.backup.${ts}" ]; then
            cp "${installed_binary}.backup.${ts}" "$installed_binary"
            chmod +x "$installed_binary"
            systemctl start betterdesk-server 2>/dev/null || true
            sleep 2
            if systemctl is-active --quiet betterdesk-server 2>/dev/null; then
                print_success "Rollback successful — previous binary restored"
            else
                print_error "Rollback also failed. Check: journalctl -u betterdesk-server -n 50"
            fi
        else
            print_error "No backup to rollback to. Check: journalctl -u betterdesk-server -n 50"
        fi
    fi

    press_enter
}

# Compile Go server only (no deployment)
do_compile_go_only() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ COMPILE GO SERVER ══════════${NC}"
    echo ""

    detect_architecture

    if ! compile_go_server; then
        print_error "Compilation failed"
        press_enter
        return
    fi

    local new_binary="$GO_SERVER_SOURCE/betterdesk-server"
    local size
    size=$(du -h "$new_binary" | cut -f1)
    print_success "Binary compiled: $new_binary ($size)"
    print_info "Use option 7 → 1 to deploy it, or copy manually."

    press_enter
}

# Legacy Rust build (archived — hbbs/hbbr)
do_build_legacy_rust() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ BUILD LEGACY RUST BINARIES ══════════${NC}"
    echo ""
    print_warning "Legacy Rust binaries (hbbs/hbbr) are archived."
    print_info "The Go server is the current architecture."
    echo ""
    if ! confirm "Continue with legacy Rust build anyway?"; then
        return
    fi

    # Check Rust
    if ! command -v cargo &> /dev/null; then
        print_warning "Rust is not installed!"
        echo ""
        if confirm "Do you want to install Rust?"; then
            curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
            source "$HOME/.cargo/env"
        else
            press_enter
            return
        fi
    fi

    print_info "Rust: $(cargo --version)"
    echo ""

    local build_dir="/tmp/betterdesk_build_$$"
    mkdir -p "$build_dir"
    cd "$build_dir"

    print_step "Downloading RustDesk Server sources..."
    git clone --depth 1 --branch 1.1.14 https://github.com/rustdesk/rustdesk-server.git
    cd rustdesk-server
    git submodule update --init --recursive

    print_step "Applying BetterDesk modifications..."

    # Copy modified sources
    if [ -d "$SCRIPT_DIR/hbbs-patch-v2/src" ]; then
        cp "$SCRIPT_DIR/hbbs-patch-v2/src/main.rs" src/ 2>/dev/null || true
        cp "$SCRIPT_DIR/hbbs-patch-v2/src/http_api.rs" src/ 2>/dev/null || true
        cp "$SCRIPT_DIR/hbbs-patch-v2/src/database.rs" src/ 2>/dev/null || true
        cp "$SCRIPT_DIR/hbbs-patch-v2/src/peer.rs" src/ 2>/dev/null || true
        cp "$SCRIPT_DIR/hbbs-patch-v2/src/rendezvous_server.rs" src/ 2>/dev/null || true
    else
        print_error "Modified sources not found in hbbs-patch-v2/src/"
        press_enter
        return
    fi

    print_step "Compiling (may take several minutes)..."
    cargo build --release

    # Copy results
    print_step "Copying binaries..."
    detect_architecture
    mkdir -p "$SCRIPT_DIR/hbbs-patch-v2"

    cp target/release/hbbs "$SCRIPT_DIR/hbbs-patch-v2/hbbs-linux-$ARCH_NAME"
    cp target/release/hbbr "$SCRIPT_DIR/hbbs-patch-v2/hbbr-linux-$ARCH_NAME"

    # Cleanup
    cd /
    rm -rf "$build_dir"

    print_success "Legacy Rust compilation completed!"
    print_info "Binaries saved in: $SCRIPT_DIR/hbbs-patch-v2/"

    press_enter
}

#===============================================================================
# Firewall Configuration
#===============================================================================

configure_firewall_rules() {
    local required_ports="${GO_API_PORT:-21114} ${CLIENT_API_PORT:-21121} 21115 21116 21117 21118 21119 5000 5443"
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
        
        # Try to persist iptables rules
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
    echo -e "${WHITE}${BOLD}══════════ DIAGNOSTICS ══════════${NC}"
    echo ""
    
    print_status
    
    echo ""
    echo -e "${WHITE}${BOLD}═══ Service logs (last 10 lines) ═══${NC}"
    echo ""
    
    # Check for Go server first, then legacy Rust services
    if systemctl list-unit-files betterdesk-server.service &>/dev/null 2>&1; then
        echo -e "${CYAN}--- betterdesk-server (Go) ---${NC}"
        journalctl -u betterdesk-server -n 10 --no-pager 2>/dev/null || echo "No logs found"
    else
        echo -e "${CYAN}--- rustdesksignal (Legacy Rust) ---${NC}"
        journalctl -u rustdesksignal -n 10 --no-pager 2>/dev/null || echo "No logs found"
        
        echo ""
        echo -e "${CYAN}--- rustdeskrelay (Legacy Rust) ---${NC}"
        journalctl -u rustdeskrelay -n 10 --no-pager 2>/dev/null || echo "No logs found"
    fi
    
    echo ""
    echo -e "${CYAN}--- betterdesk-console (Node.js) ---${NC}"
    journalctl -u betterdesk-console -n 10 --no-pager 2>/dev/null || \
        journalctl -u betterdesk -n 10 --no-pager 2>/dev/null || echo "No logs found"
    
    echo ""
    echo -e "${WHITE}${BOLD}═══ Database statistics ═══${NC}"
    echo ""
    
    # Determine the active database type the SAME way the rest of the script does:
    # read DB_TYPE from the console .env first (source of truth), and only fall back
    # to SQLite file detection. This prevents a stale db_v2.sqlite3 left over from a
    # previous install from masking an active PostgreSQL backend.
    local diag_db_type="sqlite"
    local diag_pg_uri=""
    if [ -f "$CONSOLE_PATH/.env" ]; then
        diag_db_type=$(grep -m1 '^DB_TYPE=' "$CONSOLE_PATH/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
        diag_db_type="${diag_db_type:-sqlite}"
        diag_pg_uri=$(grep -m1 '^DATABASE_URL=' "$CONSOLE_PATH/.env" 2>/dev/null | cut -d= -f2-)
    fi
    # The Go server may also carry the DSN in its systemd unit (-db postgres://...)
    if [ "$diag_db_type" != "postgres" ] && [ -f /etc/systemd/system/betterdesk-server.service ]; then
        local svc_db
        svc_db=$(grep -oP '\-db\s+"?\K(postgres|postgresql)://[^" ]+' /etc/systemd/system/betterdesk-server.service 2>/dev/null | head -1)
        if [ -n "$svc_db" ]; then
            diag_db_type="postgres"
            diag_pg_uri="${diag_pg_uri:-$svc_db}"
        fi
    fi
    
    if [ "$diag_db_type" = "postgres" ] && [ -n "$diag_pg_uri" ]; then
        # Mask password for display
        local diag_pg_display
        diag_pg_display=$(echo "$diag_pg_uri" | sed 's|://[^:]*:[^@]*@|://***:***@|')
        echo -e "  Database type:     ${CYAN}PostgreSQL${NC}"
        echo -e "  Connection:        ${DIM}$diag_pg_display${NC}"
        if command -v psql &>/dev/null; then
            if PGCONNECT_TIMEOUT=3 psql "$diag_pg_uri" -tAc "SELECT 1" &>/dev/null; then
                local device_count online_count user_count
                device_count=$(PGCONNECT_TIMEOUT=3 psql "$diag_pg_uri" -tAc "SELECT COUNT(*) FROM peers WHERE soft_deleted = FALSE" 2>/dev/null || echo "0")
                online_count=$(PGCONNECT_TIMEOUT=3 psql "$diag_pg_uri" -tAc "SELECT COUNT(*) FROM peers WHERE soft_deleted = FALSE AND status = 'ONLINE'" 2>/dev/null || echo "0")
                user_count=$(PGCONNECT_TIMEOUT=3 psql "$diag_pg_uri" -tAc "SELECT COUNT(*) FROM users" 2>/dev/null || echo "0")
                echo -e "  Status:            ${GREEN}Connected${NC}"
                echo "  Devices:           ${device_count:-0}"
                echo "  Online:            ${online_count:-0}"
                echo "  Users:             ${user_count:-0}"
            else
                echo -e "  Status:            ${RED}Connection failed${NC}"
                echo -e "  ${YELLOW}Tip: verify the PostgreSQL service and DATABASE_URL credentials${NC}"
            fi
        else
            echo -e "  ${YELLOW}Install the 'psql' client to see live database statistics${NC}"
        fi
    elif [ -f "$DB_PATH" ]; then
        local device_count online_count user_count
        device_count=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM peers WHERE soft_deleted = 0" 2>/dev/null || \
                            sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM peers WHERE is_deleted = 0" 2>/dev/null || \
                            sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM peer WHERE is_deleted = 0" 2>/dev/null || echo "0")
        online_count=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM peers WHERE soft_deleted = 0 AND status = 'ONLINE'" 2>/dev/null || \
                            sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM peers WHERE status = 1 AND is_deleted = 0" 2>/dev/null || \
                            sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM peer WHERE status = 1 AND is_deleted = 0" 2>/dev/null || echo "0")
        user_count=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM users" 2>/dev/null || echo "0")
        
        echo -e "  Database type:     ${CYAN}SQLite${NC}"
        echo -e "  File:              ${DIM}$DB_PATH${NC}"
        echo "  Devices:           $device_count"
        echo "  Online:            $online_count"
        echo "  Users:             $user_count"
    else
        echo -e "  Database type:     ${CYAN}SQLite${NC} (configured)"
        echo -e "  ${YELLOW}SQLite database file not found: $DB_PATH${NC}"
        echo -e "  ${DIM}This is normal before the first device registers.${NC}"
    fi
    
    # --- Port diagnostics ---
    echo ""
    echo -e "${WHITE}${BOLD}═══ Port diagnostics ═══${NC}"
    echo ""
    
    local port_issues=0
    local port_defs=(
        "${GO_API_PORT:-21114}:TCP:betterdesk-serv|betterdesk-server|hbbs:Go HTTP API (handlers)"
        "${CLIENT_API_PORT:-21121}:TCP:node|MainThread:Client API compat proxy → Go"
        "21115:TCP:betterdesk-serv|betterdesk-server|hbbs:NAT Test"
        "21116:TCP:betterdesk-serv|betterdesk-server|hbbs:ID Server (TCP)"
        "21116:UDP:betterdesk-serv|betterdesk-server|hbbs:ID Server (UDP)"
        "21117:TCP:betterdesk-serv|betterdesk-server|hbbr:Relay Server"
        "5000:TCP:node|MainThread:Web Console"
    )
    
    for entry in "${port_defs[@]}"; do
        IFS=':' read -r port proto expected desc <<< "$entry"
        
        local listening=false
        local proc_info=""
        
        if [ "$proto" = "TCP" ]; then
            proc_info=$(ss -tlnp 2>/dev/null | grep ":${port} " | head -1)
            [ -z "$proc_info" ] && proc_info=$(netstat -tlnp 2>/dev/null | grep ":${port} " | head -1)
        else
            proc_info=$(ss -ulnp 2>/dev/null | grep ":${port} " | head -1)
            [ -z "$proc_info" ] && proc_info=$(netstat -ulnp 2>/dev/null | grep ":${port} " | head -1)
        fi
        
        if [ -n "$proc_info" ]; then
            listening=true
            local process_name=$(echo "$proc_info" | grep -oP 'users:\(\("\K[^"]+' 2>/dev/null || \
                                echo "$proc_info" | awk '{print $NF}')
        fi
        
        printf "  Port %s/%s (%-18s): " "$port" "$proto" "$desc"
        
        if $listening; then
            if [ -n "$process_name" ] && echo "$process_name" | grep -qiE "$expected"; then
                echo -e "${GREEN}OK - $process_name${NC}"
            elif [ -n "$process_name" ]; then
                echo -e "${RED}CONFLICT - used by $process_name${NC}"
                port_issues=$((port_issues + 1))
            else
                echo -e "${GREEN}LISTENING${NC}"
            fi
        else
            echo -e "${YELLOW}NOT LISTENING${NC}"
        fi
    done
    
    if [ $port_issues -gt 0 ]; then
        echo ""
        print_warning "$port_issues port conflict(s) detected!"
        echo -e "  ${YELLOW}Tip: Stop conflicting processes or change ports in configuration${NC}"
    fi
    
    # --- Firewall diagnostics ---
    echo ""
    echo -e "${WHITE}${BOLD}═══ Firewall status ═══${NC}"
    echo ""
    
    local fw_type="none"
    local missing_rules=0
    local required_ports="${GO_API_PORT:-21114} ${CLIENT_API_PORT:-21121} 21115 21116 21117 5000"
    
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
    
    local api_port="${GO_API_PORT:-21114}"
    
    # Detect if Go server API uses TLS (only if explicit --tls-api in service args)
    local api_use_tls=false
    local api_scheme="http"
    if systemctl cat betterdesk-server.service 2>/dev/null | grep -qE '\-tls-api'; then
        api_use_tls=true
        api_scheme="https"
    fi
    
    printf "  Go Server API (%s %s):  " "$api_scheme" "$api_port"
    if [ "$api_use_tls" = true ]; then
        if curl -skfo /dev/null --connect-timeout 3 "https://127.0.0.1:${api_port}/api/health" 2>/dev/null; then
            echo -e "${GREEN}OK (HTTPS)${NC}"
        else
            # Fallback: try HTTP in case TLS is only on signal/relay
            if curl -sfo /dev/null --connect-timeout 3 "http://127.0.0.1:${api_port}/api/health" 2>/dev/null; then
                echo -e "${GREEN}OK (HTTP)${NC}"
                echo -e "  ${YELLOW}⚠ Note: Go server has TLS cert but API responds on HTTP${NC}"
            else
                echo -e "${RED}UNREACHABLE${NC}"
                echo -e "  ${YELLOW}Tip: Check betterdesk-server logs: journalctl -u betterdesk-server -n 20${NC}"
            fi
        fi
    else
        if curl -sfo /dev/null --connect-timeout 3 "http://127.0.0.1:${api_port}/api/health" 2>/dev/null; then
            echo -e "${GREEN}OK${NC}"
        else
            echo -e "${RED}UNREACHABLE${NC}"
        fi
    fi
    
    printf "  Web Console (5000):    "
    if curl -sfo /dev/null --connect-timeout 3 "http://127.0.0.1:5000/health" 2>/dev/null; then
        echo -e "${GREEN}OK${NC}"
    else
        echo -e "${RED}UNREACHABLE${NC}"
    fi
    
    # --- TLS mismatch detection ---
    if [ "$api_use_tls" = true ]; then
        local console_api_url=""
        # Check what URL the console is configured to use
        if [ -f /etc/systemd/system/betterdesk-console.service ]; then
            console_api_url=$(grep 'BETTERDESK_API_URL=' /etc/systemd/system/betterdesk-console.service 2>/dev/null | tail -1 | sed 's/.*BETTERDESK_API_URL=//')
        fi
        if [ -z "$console_api_url" ] && [ -f "$CONSOLE_PATH/.env" ]; then
            console_api_url=$(grep -m1 '^BETTERDESK_API_URL=' "$CONSOLE_PATH/.env" 2>/dev/null | cut -d= -f2-)
        fi
        
        if [ -n "$console_api_url" ] && echo "$console_api_url" | grep -q '^http://'; then
            echo ""
            print_warning "TLS MISMATCH DETECTED!"
            echo -e "  ${YELLOW}Go server has TLS enabled but console is configured with HTTP:${NC}"
            echo -e "  ${YELLOW}  Console URL: $console_api_url${NC}"
            echo -e "  ${YELLOW}  Expected:    https://localhost:$api_port/api${NC}"
            echo -e "  ${YELLOW}  Fix: Re-run installation (option 1) or update .env and systemd service${NC}"
        fi
    fi
    
    # --- Diagnostics sub-menu ---
    echo ""
    local _menu_items=(
        $'Configure firewall rules\tAuto-create any missing firewall rules'
        $'Test external ports\tCheck port connectivity from outside'
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
    echo -e "${RED}${BOLD}══════════ UNINSTALL ══════════${NC}"
    echo ""
    
    print_warning "This operation will remove BetterDesk Console!"
    echo ""
    
    if ! confirm "Are you sure you want to continue?"; then
        return
    fi
    
    if confirm "Create backup before uninstall?"; then
        do_backup_silent
    fi
    
    print_step "Stopping services..."
    # Stop Go server (primary)
    systemctl stop betterdesk-server betterdesk-console 2>/dev/null || true
    systemctl disable betterdesk-server betterdesk-console 2>/dev/null || true
    # Stop legacy Rust services if they exist
    systemctl stop rustdesksignal rustdeskrelay betterdesk betterdesk-api betterdesk-go 2>/dev/null || true
    systemctl disable rustdesksignal rustdeskrelay betterdesk betterdesk-api betterdesk-go 2>/dev/null || true
    
    print_step "Removing service files..."
    # Remove Go services
    rm -f /etc/systemd/system/betterdesk-server.service
    rm -f /etc/systemd/system/betterdesk-console.service
    # Remove legacy services
    rm -f /etc/systemd/system/rustdesksignal.service
    rm -f /etc/systemd/system/rustdeskrelay.service
    rm -f /etc/systemd/system/betterdesk.service
    rm -f /etc/systemd/system/betterdesk-api.service
    rm -f /etc/systemd/system/betterdesk-go.service
    systemctl daemon-reload
    
    if confirm "Remove installation files ($RUSTDESK_PATH)?"; then
        rm -rf "$RUSTDESK_PATH"
        print_info "Removed: $RUSTDESK_PATH"
    fi
    
    if confirm "Remove Web Console ($CONSOLE_PATH)?"; then
        rm -rf "$CONSOLE_PATH"
        print_info "Removed: $CONSOLE_PATH"
    fi
    
    print_success "BetterDesk has been uninstalled"
    press_enter
}

#===============================================================================
# SSL Certificate Configuration
#===============================================================================

do_configure_ssl() {
    maybe_reexec_if_installer_on_disk_is_newer
    print_header
    echo -e "${WHITE}${BOLD}══════════ SSL CERTIFICATE CONFIGURATION ══════════${NC}"
    echo ""

    if [ ! -f "$CONSOLE_PATH/.env" ]; then
        print_error "Node.js console .env not found at $CONSOLE_PATH/.env"
        print_info "Please install BetterDesk first (option 1)"
        press_enter
        return
    fi

    local ssl_dir="$RUSTDESK_PATH/ssl"
    local env_file="$CONSOLE_PATH/.env"
    local svc_file="/etc/systemd/system/betterdesk-console.service"
    local ssl_tls_active="no"

    local _menu_items=(
        $'Let\'s Encrypt\tAutomatic cert (needs domain name + port 80)'
        $'Custom certificate\tProvide your own cert + key files'
        $'Self-signed certificate\tLAN / testing only'
        $'Disable SSL\tRevert the console to plain HTTP'
        $'Enterprise TLS\tPanel + signal + relay TLS (API stays HTTP)'
        $'External reverse proxy\tTLS at Caddy/Nginx — panel HTTP on localhost'
    )
    local _menu_returns=( 1 2 3 4 5 6 )
    menu_choose "SSL Certificate Configuration" "HTTPS for the panel, or TLS at an external reverse proxy"
    local ssl_choice="$MENU_CHOICE"

    case "${ssl_choice:-1}" in
        1)
            echo ""
            read -p "Enter your domain name (e.g., betterdesk.example.com): " domain
            if [ -z "$domain" ]; then
                print_error "Domain name required for Let's Encrypt"
                press_enter
                return
            fi

            if ! command -v certbot &> /dev/null; then
                print_step "Installing certbot..."
                if command -v apt-get &> /dev/null; then apt-get install -y certbot
                elif command -v dnf &> /dev/null; then dnf install -y certbot
                elif command -v yum &> /dev/null; then yum install -y certbot
                elif command -v pacman &> /dev/null; then pacman -Sy --noconfirm certbot
                else
                    print_error "Could not install certbot. Please install it manually."
                    press_enter
                    return
                fi
            fi

            print_step "Requesting certificate for $domain..."
            print_info "Port 80 must be accessible from the internet"

            certbot certonly --standalone --preferred-challenges http \
                -d "$domain" --non-interactive --agree-tos \
                --email "admin@$domain" 2>&1 || {
                    print_error "Certificate request failed. Make sure port 80 is open and the domain points to this server."
                    press_enter
                    return
                }

            local le_live_dir="/etc/letsencrypt/live/$domain"
            if ! deploy_ssl_material_to_rustdesk_dir \
                "$le_live_dir/fullchain.pem" "$le_live_dir/privkey.pem" "$le_live_dir"; then
                print_error "Failed to deploy Let's Encrypt certificate for console user"
                press_enter
                return
            fi

            apply_console_protocol_mode https "$ssl_dir/betterdesk.crt" "$ssl_dir/betterdesk.key" true false
            ssl_tls_active="yes"

            if ! crontab -l 2>/dev/null | grep -q "certbot renew"; then
                (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet") | crontab -
                print_info "Auto-renewal cron job added (daily at 3:00 AM)"
            fi

            print_success "Let's Encrypt certificate configured for $domain"
            print_info "Open the panel at https://${domain}:$(resolve_panel_https_port) (IP access will show certificate errors)"
            ;;
        2)
            echo ""
            read -p "Path to certificate file (PEM): " cert_path
            read -p "Path to private key file (PEM): " key_path
            read -p "Path to CA bundle (optional, press Enter to skip): " ca_path

            if [ ! -f "$cert_path" ] || [ ! -f "$key_path" ]; then
                print_error "Certificate or key file not found."
                press_enter
                return
            fi
            if ! openssl x509 -in "$cert_path" -noout 2>/dev/null; then
                print_error "The provided certificate is not a valid X.509 file."
                press_enter
                return
            fi

            local deploy_crt="$cert_path" merged_crt=""
            if [ -n "$ca_path" ] && [ -f "$ca_path" ]; then
                merged_crt=$(mktemp)
                cat "$cert_path" "$ca_path" > "$merged_crt"
                deploy_crt="$merged_crt"
            fi
            if ! deploy_ssl_material_to_rustdesk_dir "$deploy_crt" "$key_path"; then
                [ -n "$merged_crt" ] && rm -f "$merged_crt"
                print_error "Failed to deploy custom certificate for console user"
                press_enter
                return
            fi
            [ -n "$merged_crt" ] && rm -f "$merged_crt"

            infer_tls_mode_from_cert "$ssl_dir/betterdesk.crt"
            apply_console_protocol_mode https "$ssl_dir/betterdesk.crt" "$ssl_dir/betterdesk.key" \
                "$INFERRED_RUSTDESK_API_TLS" "$INFERRED_ALLOW_SELF_SIGNED"
            if [ -n "$ca_path" ] && [ -f "$ca_path" ]; then
                _upsert_env_line "$env_file" SSL_CA_PATH "$ca_path"
            fi
            ssl_tls_active="yes"
            print_success "Custom SSL certificate configured"
            ;;
        3)
            mkdir -p "$ssl_dir"
            echo ""
            read -p "Enter domain name (optional, press Enter to skip): " cert_domain

            local server_ip lan_ip san_list cn
            server_ip=$(get_public_ip)
            lan_ip=$(ip -4 addr show scope global | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1 2>/dev/null || \
                     hostname -I 2>/dev/null | awk '{print $1}' || echo "")
            san_list="IP:$server_ip,IP:127.0.0.1,DNS:localhost"
            [ -n "$lan_ip" ] && [ "$lan_ip" != "$server_ip" ] && san_list="$san_list,IP:$lan_ip"
            [ -n "$cert_domain" ] && san_list="DNS:$cert_domain,$san_list"
            cn="${cert_domain:-$server_ip}"

            print_step "Generating self-signed certificate..."
            print_info "SANs: $san_list"
            openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
                -keyout "$ssl_dir/betterdesk.key" \
                -out "$ssl_dir/betterdesk.crt" \
                -subj "/CN=$cn/O=BetterDesk/C=PL" \
                -addext "subjectAltName=$san_list" 2>/dev/null || \
            openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
                -keyout "$ssl_dir/betterdesk.key" \
                -out "$ssl_dir/betterdesk.crt" \
                -subj "/CN=$cn/O=BetterDesk/C=PL" 2>/dev/null

            if ! deploy_ssl_material_to_rustdesk_dir "$ssl_dir/betterdesk.crt" "$ssl_dir/betterdesk.key"; then
                print_error "Failed to set permissions on self-signed certificate"
                press_enter
                return
            fi

            apply_console_protocol_mode https "$ssl_dir/betterdesk.crt" "$ssl_dir/betterdesk.key" false true
            ssl_tls_active="yes"
            print_success "Self-signed certificate generated (valid 10 years)"
            print_info "Certificate: $ssl_dir/betterdesk.crt"
            [ -n "$lan_ip" ] && [ "$lan_ip" != "$server_ip" ] && print_info "LAN IP included: $lan_ip"
            print_warning "Browsers will show security warning. Use Let's Encrypt for public servers."
            ;;
        4)
            apply_console_protocol_mode http
            clear_go_server_signal_relay_tls
            print_success "SSL disabled. Running in HTTP mode."
            print_info "If your browser still redirects to HTTPS, clear site cache or HSTS (chrome://net-internals/#hsts)"
            ;;
        5)
            print_header "Enterprise TLS Configuration"
            echo ""
            print_warning "IMPORTANT: Go API port ${GO_API_PORT:-21114} stays HTTP for RustDesk client compatibility."
            echo ""

            mkdir -p "$ssl_dir"
            read -p "Enter domain name (optional, press Enter to skip): " cert_domain

            local server_ip lan_ip san_list cn
            server_ip=$(get_public_ip)
            lan_ip=$(ip -4 addr show scope global | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1 2>/dev/null || \
                     hostname -I 2>/dev/null | awk '{print $1}' || echo "")
            san_list="IP:$server_ip,IP:127.0.0.1,DNS:localhost"
            [ -n "$lan_ip" ] && [ "$lan_ip" != "$server_ip" ] && san_list="$san_list,IP:$lan_ip"
            [ -n "$cert_domain" ] && san_list="DNS:$cert_domain,$san_list"
            cn="${cert_domain:-$server_ip}"

            print_step "Generating Enterprise certificate..."
            print_info "SANs: $san_list"
            openssl req -x509 -nodes -days 3650 -newkey rsa:4096 \
                -keyout "$ssl_dir/betterdesk.key" \
                -out "$ssl_dir/betterdesk.crt" \
                -subj "/CN=$cn/O=BetterDesk Enterprise/C=PL" \
                -addext "subjectAltName=$san_list" 2>/dev/null || \
            openssl req -x509 -nodes -days 3650 -newkey rsa:4096 \
                -keyout "$ssl_dir/betterdesk.key" \
                -out "$ssl_dir/betterdesk.crt" \
                -subj "/CN=$cn/O=BetterDesk Enterprise/C=PL" 2>/dev/null

            if ! deploy_ssl_material_to_rustdesk_dir "$ssl_dir/betterdesk.crt" "$ssl_dir/betterdesk.key"; then
                print_error "Failed to set permissions on Enterprise certificate"
                press_enter
                return
            fi

            apply_console_protocol_mode https "$ssl_dir/betterdesk.crt" "$ssl_dir/betterdesk.key" true true
            _upsert_env_line "$env_file" ENTERPRISE_TLS true
            if [ -f "$svc_file" ]; then
                _upsert_systemd_env "$svc_file" ENTERPRISE_TLS true
            fi
            ssl_tls_active="yes"

            print_success "Enterprise TLS configured successfully!"
            echo ""
            print_info "Certificate: $ssl_dir/betterdesk.crt"
            print_info "Private key: $ssl_dir/betterdesk.key"
            [ -n "$lan_ip" ] && [ "$lan_ip" != "$server_ip" ] && print_info "LAN IP: $lan_ip"
            echo ""
            print_info "  Panel HTTPS: :$(resolve_panel_https_port)"
            print_info "  Signal TLS:  :21116"
            print_info "  Relay TLS:   :21117"
            print_info "  Go API HTTP: :${GO_API_PORT:-21114} (RustDesk client compatibility)"
            ;;
        6)
            do_configure_reverse_proxy || true
            ;;
        *)
            print_warning "Invalid option"
            press_enter
            return
            ;;
    esac

    if [ "$ssl_tls_active" = "yes" ]; then
        sync_go_server_signal_relay_tls "$ssl_dir"
        ensure_betterdesk_console_user >/dev/null
        print_info "Signal/relay TLS enabled; Go API stays HTTP (RustDesk client compatibility)"
        maybe_offer_standard_https_port
    fi

    echo ""
    if confirm "Restart BetterDesk to apply changes?"; then
        repair_https_stuck_state yes
        ensure_console_tls_material_readable 2>/dev/null || true
        systemctl restart betterdesk-server betterdesk-console 2>/dev/null || true
        print_success "BetterDesk services restarted"
        verify_service_health "betterdesk-server" "21116" 15 >/dev/null 2>&1 || true
        verify_service_health "betterdesk-console" "$(resolve_panel_health_port)" 15 >/dev/null 2>&1 || true
        run_protocol_tests
    fi

    press_enter
}

#===============================================================================
# Protocol verification test-suite
#===============================================================================
# Runs a series of non-destructive connectivity / certificate checks after an
# HTTP <-> HTTPS switch so the operator gets immediate, trustworthy feedback.
# Honours the project invariant: the Go API (:21121) must remain HTTP for RustDesk clients.
run_protocol_tests() {
    local go_svc_file="/etc/systemd/system/betterdesk-server.service"
    local ssl_dir="$RUSTDESK_PATH/ssl"
    local pass=0 fail=0 warn=0

    echo ""
    echo -e "${WHITE}${BOLD}═══ Post-configuration tests ═══${NC}"
    echo ""

    _test_ok()   { echo -e "  ${GREEN}✓${NC} $1"; pass=$((pass+1)); }
    _test_fail() { echo -e "  ${RED}✗${NC} $1"; fail=$((fail+1)); }
    _test_warn() { echo -e "  ${YELLOW}!${NC} $1"; warn=$((warn+1)); }

    # ── 1. Services running ──
    if systemctl is-active --quiet betterdesk-server 2>/dev/null; then
        _test_ok "Go server service is active"
    else
        _test_fail "Go server service is NOT active (journalctl -u betterdesk-server)"
        if journalctl -u betterdesk-server --no-pager -n 40 2>/dev/null | grep -q 'listen tcp :5000'; then
            echo -e "      ${DIM}Hint: Go tried signal on :5000 — panel PORT in .env leaked; run Repair → Repair HTTPS/TLS (#219)${NC}"
        fi
    fi
    if systemctl is-active --quiet betterdesk-console 2>/dev/null; then
        _test_ok "Web console service is active"
    else
        _test_fail "Web console service is NOT active (journalctl -u betterdesk-console)"
    fi

    # ── 1b. Wait for Go signal port (post-restart boot delay) ──
    if systemctl is-active --quiet betterdesk-server 2>/dev/null; then
        if verify_service_health "betterdesk-server" "21116" 15 >/dev/null 2>&1; then
            _test_ok "Go server listening on signal port :21116"
        elif journalctl -u betterdesk-server --no-pager -n 40 2>/dev/null | grep -q 'listen tcp :5000'; then
            _test_fail "Go server tried signal on :5000 (conflicts with panel redirect) — Repair → Repair HTTPS/TLS (#219)"
        else
            _test_fail "Go server not listening on :21116 yet (journalctl -u betterdesk-server)"
        fi
    fi

    # ── 2. Effective runtime configuration (systemd overrides .env) ──
    local https_enabled http_port https_port http_redirect api_tls_mode
    https_enabled=$(read_effective_console_setting HTTPS_ENABLED false)
    http_port=$(resolve_panel_http_port)
    https_port=$(resolve_panel_https_port)
    http_redirect=$(read_effective_console_setting HTTP_REDIRECT_HTTPS true)
    api_tls_mode=$(read_effective_console_setting RUSTDESK_API_TLS auto)

    local panel_scheme="http" panel_port
    if [ "$(echo "$https_enabled" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
        panel_scheme="https"
        panel_port="$https_port"
    else
        panel_port="$http_port"
    fi

    # ── 2c. External reverse-proxy mode (TRUST_PROXY + plain HTTP panel) ──
    local trust_proxy_val host_bind
    trust_proxy_val=$(read_effective_console_setting TRUST_PROXY false)
    host_bind=$(read_effective_console_setting HOST "127.0.0.1")
    local _trust_on="no"
    case "$(echo "$trust_proxy_val" | tr '[:upper:]' '[:lower:]')" in
        y|yes|1|true|on) _trust_on="yes" ;;
    esac
    if [ "$(echo "$https_enabled" | tr '[:upper:]' '[:lower:]')" != "true" ] && [ "$_trust_on" = "yes" ]; then
        if [ "$host_bind" = "127.0.0.1" ] || [ "$host_bind" = "localhost" ]; then
            _test_ok "Reverse-proxy mode: panel bound to localhost ($host_bind)"
        elif [ "$host_bind" = "0.0.0.0" ]; then
            _test_ok "Reverse-proxy mode: panel bound to all interfaces (remote proxy host)"
        else
            _test_warn "TRUST_PROXY enabled with HOST=$host_bind (use 127.0.0.1 same-host or 0.0.0.0 remote proxy)"
        fi
        if [ -f "$go_svc_file" ] && grep -qE 'Environment=TRUST_PROXY=Y|-trust-proxy' "$go_svc_file" 2>/dev/null; then
            _test_ok "Go server trusts reverse-proxy headers (TRUST_PROXY / -trust-proxy)"
            if grep -qE 'Environment=TRUSTED_PROXIES=.+' "$go_svc_file" 2>/dev/null || \
               grep -qE '^TRUSTED_PROXIES=.+' "${CONSOLE_PATH}/.env" 2>/dev/null; then
                _test_ok "TRUSTED_PROXIES allowlist configured (#276)"
            else
                _test_warn "TRUSTED_PROXIES empty — Go ignores X-Forwarded-* until set (e.g. 127.0.0.1/32)"
            fi
        else
            _test_fail "Go server TRUST_PROXY not enabled — API rate limits may use proxy IP only"
        fi
        local rp_dir="$RUSTDESK_PATH/reverse-proxy"
        if [ -d "$rp_dir" ] && { [ -f "$rp_dir/caddy.Caddyfile.snippet" ] || [ -f "$rp_dir/nginx.betterdesk.conf.snippet" ]; }; then
            _test_ok "Reverse-proxy snippets in $rp_dir/"
        else
            _test_warn "No snippets in $rp_dir/ — re-run SSL menu → External reverse proxy"
        fi
    fi

    # ── 2b. TLS key readable by console user (HTTPS only) ──
    if [ "$(echo "$https_enabled" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
        local ssl_key_path console_user="betterdesk"
        ssl_key_path=$(read_effective_console_setting SSL_KEY_PATH "")
        if id "$console_user" &>/dev/null && [ -n "$ssl_key_path" ] && [ -e "$ssl_key_path" ]; then
            if runuser -u "$console_user" -- test -r "$ssl_key_path" 2>/dev/null; then
                _test_ok "TLS private key readable by console user ($console_user)"
            else
                _test_fail "Console user $console_user cannot read TLS key ($ssl_key_path) — HTTPS panel will fall back to HTTP (journalctl -u betterdesk-console)"
            fi
        fi
    fi

    # ── 3. Panel reachability on the correct scheme/port ──
    if systemctl is-active --quiet betterdesk-console 2>/dev/null; then
        verify_service_health "betterdesk-console" "$panel_port" 15 >/dev/null 2>&1 || true
    fi
    local panel_code panel_insecure="no"
    [ "$panel_scheme" = "https" ] && panel_insecure="yes"
    panel_code=$(_wait_for_http_code "${panel_scheme}://127.0.0.1:${panel_port}/" 15 "$panel_insecure" || true)
    if [[ "$panel_code" =~ ^(200|301|302|304|401|403)$ ]]; then
        _test_ok "Web panel reachable: ${panel_scheme}://<server>:${panel_port} (HTTP $panel_code)"
    else
        local alt_panel_port=""
        if [ "$panel_scheme" = "https" ] && [ "$panel_port" = "443" ] && _tcp_port_is_listening 5443; then
            alt_panel_port="5443"
            panel_code=$(_wait_for_http_code "https://127.0.0.1:5443/" 5 "$panel_insecure" || true)
            if [[ "$panel_code" =~ ^(200|301|302|304|401|403)$ ]]; then
                _test_fail "Web panel NOT reachable on https://127.0.0.1:443 (panel bound :5443 instead — run Repair → Repair permissions for CAP_NET_BIND_SERVICE)"
            else
                _test_fail "Web panel NOT reachable on ${panel_scheme}://127.0.0.1:${panel_port} (got $panel_code)"
            fi
        else
            _test_fail "Web panel NOT reachable on ${panel_scheme}://127.0.0.1:${panel_port} (got $panel_code)"
        fi
        if systemctl is-active --quiet betterdesk-console 2>/dev/null && [ "$panel_scheme" = "https" ]; then
            if journalctl -u betterdesk-console --no-pager -n 80 2>/dev/null | grep -qi 'Falling back to HTTP'; then
                echo -e "      ${DIM}Hint: console logged HTTPS fallback — check TLS key permissions (runuser -u betterdesk test -r key)${NC}"
            elif [ -n "$alt_panel_port" ]; then
                echo -e "      ${DIM}Hint: configured HTTPS_PORT=443 but Node bound :5443 — Repair → Repair permissions, then restart (#219)${NC}"
            fi
        fi
    fi

    # ── 3b. HTTP→HTTPS redirect (only when HTTPS + redirect enabled) ──
    if [ "$(echo "$https_enabled" | tr '[:upper:]' '[:lower:]')" = "true" ] \
        && [ "$(echo "$http_redirect" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
        local redirect_hdr _r_elapsed=0 redirect_probe_port="$http_port"
        # Standard HTTPS on :443 always redirects from :80 — never probe stale :5000 (#219).
        if [ "$https_port" = "443" ]; then
            redirect_probe_port="80"
        fi
        redirect_hdr=""
        while [ "$_r_elapsed" -lt 10 ]; do
            redirect_hdr=$(curl -sI --max-time 4 "http://127.0.0.1:${redirect_probe_port}/" 2>/dev/null | grep -i '^location:' | head -1)
            if [ "$https_port" = "443" ]; then
                if echo "$redirect_hdr" | grep -qi 'https://' \
                    && { ! echo "$redirect_hdr" | grep -qiE ':[0-9]+' || echo "$redirect_hdr" | grep -qi ':443'; }; then
                    break
                fi
            elif echo "$redirect_hdr" | grep -qi ":${https_port}"; then
                break
            fi
            sleep 1
            _r_elapsed=$((_r_elapsed + 1))
        done
        if [ "$https_port" = "443" ]; then
            if echo "$redirect_hdr" | grep -qi 'https://' \
                && { ! echo "$redirect_hdr" | grep -qiE ':[0-9]+' || echo "$redirect_hdr" | grep -qi ':443'; }; then
                _test_ok "HTTP redirect active: :${redirect_probe_port} → HTTPS :${https_port}"
            else
                _test_fail "HTTP redirect missing or wrong target on :${redirect_probe_port} (got: ${redirect_hdr:-none})"
                if [ "$redirect_probe_port" = "80" ]; then
                    echo -e "      ${DIM}Hint: set PORT=80 in .env, run Repair → Repair HTTPS/TLS, ensure CAP_NET_BIND_SERVICE (#219)${NC}"
                fi
            fi
        elif echo "$redirect_hdr" | grep -qi ":${https_port}"; then
            _test_ok "HTTP redirect active: :${http_port} → HTTPS :${https_port}"
        else
            _test_fail "HTTP redirect missing or wrong target on :${http_port} (got: ${redirect_hdr:-none})"
        fi
    fi

    # ── 4. Go API (RustDesk client + REST) on GO_API_PORT (default 21114) ──
    local go_api_port="${GO_API_PORT:-21114}"
    local client_api_port="${CLIENT_API_PORT:-21121}"
    local api_code _api_elapsed=0
    while [ "$_api_elapsed" -lt 15 ]; do
        api_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 \
            "http://127.0.0.1:${go_api_port}/api/server/stats" 2>/dev/null || echo "000")
        if [[ "$api_code" =~ ^(200|401|403|404)$ ]]; then
            break
        fi
        sleep 1
        _api_elapsed=$((_api_elapsed + 1))
    done
    if [[ "$api_code" =~ ^(200|401|403|404)$ ]]; then
        _test_ok "Go API responding over HTTP on :${go_api_port} (HTTP $api_code)"
    else
        _test_fail "Go API not responding over HTTP on :${go_api_port} (got $api_code)"
        if ! ss -tlnH 2>/dev/null | grep -q ":${go_api_port} "; then
            if ss -tlnpH 2>/dev/null | grep ":${client_api_port} " | grep -qiE 'betterdesk-server|betterdesk-serv'; then
                echo -e "      ${DIM}Hint: Go API bound to :${client_api_port} — API_PORT from .env leaked; run Repair → Repair HTTPS/TLS or update (#219)${NC}"
            fi
        fi
    fi

    # ── 4b. Client API compat proxy (:21121) — scheme matches RUSTDESK_API_TLS ──
    local client_api_scheme="http" client_api_code client_insecure="no"
    if client_api_should_use_tls; then
        client_api_scheme="https"
        client_insecure="yes"
    fi
    client_api_code=$(_wait_for_http_code \
        "${client_api_scheme}://127.0.0.1:${CLIENT_API_PORT:-21121}/api/login-options" 15 "$client_insecure" || true)
    if [[ "$client_api_code" =~ ^(200|401|403|404|405)$ ]]; then
        _test_ok "Client API compat proxy on :${CLIENT_API_PORT:-21121} (${client_api_scheme^^} $client_api_code)"
    else
        _test_fail "Client API proxy not responding on :${CLIENT_API_PORT:-21121} (${client_api_scheme}, got $client_api_code) — check API_ENABLED / RUSTDESK_API_TLS"
    fi

    # Critical invariant: Go API must never be HTTPS-only
    if [ -f "$go_svc_file" ] && grep -Eq '\-tls-api|\-force-https' "$go_svc_file" 2>/dev/null; then
        _test_warn "Go service carries -tls-api/-force-https — RustDesk clients require plain HTTP on :${GO_API_PORT:-21114}"
    fi

    # ── 5. Signal / Relay listeners ──
    local p
    for p in 21116 21117; do
        if ss -tlnH 2>/dev/null | grep -q ":${p} "; then
            _test_ok "Listener present on TCP :${p}"
        else
            _test_warn "No TCP listener detected on :${p} (UDP-only signal is normal for :21116)"
        fi
    done

    # ── 6. Certificate validation (HTTPS / TLS modes) ──
    local tls_active="no"
    [ -f "$go_svc_file" ] && grep -q '\-tls-signal' "$go_svc_file" 2>/dev/null && tls_active="yes"
    if [ "$(echo "$https_enabled" | tr '[:upper:]' '[:lower:]')" = "true" ] || [ "$tls_active" = "yes" ]; then
        if [ -f "$ssl_dir/betterdesk.crt" ]; then
            if openssl x509 -in "$ssl_dir/betterdesk.crt" -noout 2>/dev/null; then
                local not_after days_left
                not_after=$(openssl x509 -in "$ssl_dir/betterdesk.crt" -noout -enddate 2>/dev/null | cut -d= -f2)
                if [ -n "$not_after" ]; then
                    local exp_epoch now_epoch
                    exp_epoch=$(date -d "$not_after" +%s 2>/dev/null || echo 0)
                    now_epoch=$(date +%s)
                    if [ "$exp_epoch" -gt "$now_epoch" ]; then
                        days_left=$(( (exp_epoch - now_epoch) / 86400 ))
                        if [ "$days_left" -lt 14 ]; then
                            _test_warn "Certificate valid but expires in ${days_left} days ($not_after)"
                        else
                            _test_ok "Certificate valid for ${days_left} more days (until $not_after)"
                        fi
                    else
                        _test_fail "Certificate has EXPIRED ($not_after)"
                    fi
                fi
                local san
                san=$(openssl x509 -in "$ssl_dir/betterdesk.crt" -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr -d ' ')
                [ -n "$san" ] && echo -e "      ${DIM}SAN: ${san}${NC}"
            else
                _test_fail "Certificate file is not a valid X.509 certificate"
            fi
        else
            _test_fail "HTTPS/TLS enabled but no certificate found at $ssl_dir/betterdesk.crt"
        fi

        if [ "$tls_active" = "yes" ]; then
            if echo | timeout 5 openssl s_client -connect "127.0.0.1:21116" 2>/dev/null | grep -q 'BEGIN CERTIFICATE'; then
                _test_ok "TLS handshake succeeded on signal :21116"
            else
                _test_warn "Could not complete TLS handshake on :21116 (dual-mode listener may still accept plain TCP)"
            fi
        fi
    fi

    echo ""
    local go_signal_port relay_port
    go_signal_port=$(grep -m1 '^Environment=SIGNAL_PORT=' "$go_svc_file" 2>/dev/null | cut -d= -f2- || echo "21116")
    relay_port=$(grep -m1 '^Environment=RELAY_PORT=' "$go_svc_file" 2>/dev/null | cut -d= -f2- || echo "21117")
    echo -e "  ${DIM}Effective config: HTTPS_ENABLED=${https_enabled} panel=${panel_scheme}:${panel_port} redirect=${http_redirect} client_api_tls=${api_tls_mode} go_signal=${go_signal_port} go_relay=${relay_port}${NC}"
    echo ""
    echo -e "  ${GREEN}${pass} passed${NC}   ${YELLOW}${warn} warnings${NC}   ${RED}${fail} failed${NC}"
    if [ "$fail" -gt 0 ]; then
        echo -e "  ${YELLOW}Some checks failed — review the messages above and the service logs.${NC}"
    else
        echo -e "  ${GREEN}Configuration verified successfully.${NC}"
        if [ "$(echo "$https_enabled" | tr '[:upper:]' '[:lower:]')" = "true" ] && [ "$https_port" = "5443" ]; then
            echo ""
            echo -e "  ${DIM}Tip: for https://your-domain without :5443, set HTTPS_PORT=443 in .env and run Repair → Repair permissions, or re-run Protocol Toggle / SSL config and choose standard port 443. See docs/setup/HTTPS_SETUP.md${NC}"
        elif [ "$(echo "$https_enabled" | tr '[:upper:]' '[:lower:]')" != "true" ] && [ "$_trust_on" = "yes" ]; then
            echo ""
            echo -e "  ${DIM}Tip: configure Caddy/Nginx using $RUSTDESK_PATH/reverse-proxy/ snippets, then open https://your-domain/ (not :5443). See docs/setup/REVERSE_PROXY.md${NC}"
        fi
    fi
    echo ""

    unset -f _test_ok _test_fail _test_warn 2>/dev/null || true
}

#===============================================================================
# HTTP/HTTPS Protocol Toggle
#===============================================================================

do_toggle_protocol() {
    maybe_reexec_if_installer_on_disk_is_newer
    print_header
    echo -e "${WHITE}${BOLD}══════════ PROTOCOL TOGGLE (HTTP / HTTPS) ══════════${NC}"
    echo ""

    local env_file="$CONSOLE_PATH/.env"
    local svc_file="/etc/systemd/system/betterdesk-console.service"
    local go_svc_file="/etc/systemd/system/betterdesk-server.service"
    local ssl_dir="$RUSTDESK_PATH/ssl"

    # Detect current mode (effective runtime: systemd overrides .env)
    local current_mode="HTTP"
    if [ "$(read_effective_console_setting HTTPS_ENABLED false | tr '[:upper:]' '[:lower:]')" = "true" ]; then
        current_mode="HTTPS"
    fi

    local tls_signal="no"
    local tls_relay="no"
    if [ -f "$go_svc_file" ]; then
        grep -q '\-tls-signal' "$go_svc_file" 2>/dev/null && tls_signal="yes"
        grep -q '\-tls-relay' "$go_svc_file" 2>/dev/null && tls_relay="yes"
    fi

    local _menu_items=(
        $'Switch to HTTP\tEverything plain — LAN / testing'
        $'Switch to HTTPS\tPanel HTTPS + signal/relay TLS'
        $'External reverse proxy\tTLS at Caddy/Nginx — panel HTTP on localhost'
        $'Back\tReturn to the main menu'
    )
    local _menu_returns=( 1 2 3 0 )
    menu_choose "Protocol Toggle (HTTP / HTTPS / reverse proxy)" "Current: ${current_mode} | signal TLS: ${tls_signal} | relay TLS: ${tls_relay}"
    local proto_choice="$MENU_CHOICE"

    case "${proto_choice:-0}" in
        1)
            # ── Switch to HTTP ──
            echo ""
            print_step "Switching to HTTP mode..."

            apply_console_protocol_mode http
            clear_go_server_signal_relay_tls

            print_success "Switched to HTTP mode"
            echo ""
            print_info "  Panel:         HTTP :$(resolve_panel_http_port)"
            print_info "  Signal:        TCP  :21116"
            print_info "  Relay:         TCP  :21117"
            print_info "  Go API:        HTTP :${GO_API_PORT:-21114}"
            print_info "  Client API:    HTTP :${CLIENT_API_PORT:-21121}"
            echo ""
            print_warning "SSL certificates were NOT deleted (use option C > 4 to remove)"
            print_info "If your browser still redirects to HTTPS, clear site cache or HSTS (chrome://net-internals/#hsts)"
            ;;
        2)
            # ── Switch to HTTPS ──
            echo ""
            local have_cert="no"
            [ -f "$ssl_dir/betterdesk.crt" ] && [ -f "$ssl_dir/betterdesk.key" ] && have_cert="yes"
            local _keep_desc="No existing certificate found"
            [ "$have_cert" = "yes" ] && _keep_desc="Reuse $ssl_dir/betterdesk.crt"
            local _menu_items=(
                $'Keep existing certificate\t'"$_keep_desc"
                $'Self-signed certificate\tGenerate one for LAN / testing'
                $'Let\'s Encrypt certificate\tPublic domain, port 80 must be free'
                $'Custom certificate\tPaste your own cert + key file paths'
                $'Cancel\tDo not change the protocol'
            )
            local _menu_returns=( 1 2 3 4 0 )
            menu_choose "HTTPS Certificate Source" "Choose the certificate to use for TLS"
            local cert_choice="$MENU_CHOICE"

            case "${cert_choice:-2}" in
                1)
                    if [ "$have_cert" != "yes" ]; then
                        print_error "No existing certificate found — choose another option."
                        press_enter
                        return
                    fi
                    maybe_repair_le_ssl_symlinks 2>/dev/null || true
                    print_info "Using existing certificate at $ssl_dir/betterdesk.crt"
                    ;;
                2)
                    mkdir -p "$ssl_dir"
                    local server_ip lan_ip san_list
                    server_ip=$(get_public_ip 2>/dev/null || echo "127.0.0.1")
                    lan_ip=$(ip route get 1 2>/dev/null | awk '{print $7; exit}')
                    san_list="IP:$server_ip,IP:127.0.0.1,DNS:localhost"
                    [ -n "$lan_ip" ] && [ "$lan_ip" != "$server_ip" ] && san_list="$san_list,IP:$lan_ip"
                    read -p "Optional DNS domain for the certificate (blank to skip): " ss_domain
                    [ -n "$ss_domain" ] && san_list="$san_list,DNS:$ss_domain"
                    print_step "Generating self-signed certificate..."
                    openssl req -x509 -nodes -days 3650 -newkey rsa:4096 \
                        -keyout "$ssl_dir/betterdesk.key" \
                        -out "$ssl_dir/betterdesk.crt" \
                        -subj "/CN=${ss_domain:-$server_ip}/O=BetterDesk/C=PL" \
                        -addext "subjectAltName=$san_list" 2>/dev/null || \
                    openssl req -x509 -nodes -days 3650 -newkey rsa:4096 \
                        -keyout "$ssl_dir/betterdesk.key" \
                        -out "$ssl_dir/betterdesk.crt" \
                        -subj "/CN=${ss_domain:-$server_ip}/O=BetterDesk/C=PL" 2>/dev/null
                    if ! deploy_ssl_material_to_rustdesk_dir "$ssl_dir/betterdesk.crt" "$ssl_dir/betterdesk.key"; then
                        print_error "Failed to set permissions on self-signed certificate"
                        press_enter
                        return
                    fi
                    print_success "Self-signed certificate generated"
                    ;;
                3)
                    if ! command -v certbot &>/dev/null; then
                        print_step "Installing certbot..."
                        if command -v dnf &>/dev/null; then dnf install -y certbot &>/dev/null
                        elif command -v apt-get &>/dev/null; then apt-get install -y certbot &>/dev/null
                        elif command -v yum &>/dev/null; then yum install -y certbot &>/dev/null; fi
                    fi
                    if ! command -v certbot &>/dev/null; then
                        print_error "certbot could not be installed automatically."
                        press_enter
                        return
                    fi
                    read -p "Public domain (e.g. desk.example.com): " le_domain
                    read -p "Admin email (for renewal notices): " le_email
                    if [ -z "$le_domain" ]; then
                        print_error "A domain is required for Let's Encrypt."
                        press_enter
                        return
                    fi
                    print_step "Requesting certificate for $le_domain (standalone, needs port 80)..."
                    if certbot certonly --standalone --non-interactive --agree-tos \
                        ${le_email:+--email "$le_email"} ${le_email:+} \
                        $([ -z "$le_email" ] && echo "--register-unsafely-without-email") \
                        -d "$le_domain"; then
                        local le_live_dir="/etc/letsencrypt/live/$le_domain"
                        if ! deploy_ssl_material_to_rustdesk_dir \
                            "$le_live_dir/fullchain.pem" "$le_live_dir/privkey.pem" "$le_live_dir"; then
                            print_error "Failed to deploy Let's Encrypt certificate for console user"
                            press_enter
                            return
                        fi
                        print_success "Let's Encrypt certificate installed for $le_domain"
                        print_info "Open the panel at https://${le_domain}:$(resolve_panel_https_port) (IP access will show certificate errors)"
                    else
                        print_error "certbot failed — check that DNS points here and port 80 is free."
                        press_enter
                        return
                    fi
                    ;;
                4)
                    read -p "Path to certificate (.crt/.pem, fullchain): " custom_crt
                    read -p "Path to private key (.key): " custom_key
                    read -p "Path to CA chain (optional, blank to skip): " custom_ca
                    if [ ! -f "$custom_crt" ] || [ ! -f "$custom_key" ]; then
                        print_error "Certificate or key file not found."
                        press_enter
                        return
                    fi
                    if ! openssl x509 -in "$custom_crt" -noout 2>/dev/null; then
                        print_error "The provided certificate is not a valid X.509 file."
                        press_enter
                        return
                    fi
                    local deploy_crt="$custom_crt" merged_crt=""
                    if [ -n "$custom_ca" ] && [ -f "$custom_ca" ]; then
                        merged_crt=$(mktemp)
                        cat "$custom_crt" "$custom_ca" > "$merged_crt"
                        deploy_crt="$merged_crt"
                    fi
                    if ! deploy_ssl_material_to_rustdesk_dir "$deploy_crt" "$custom_key"; then
                        [ -n "$merged_crt" ] && rm -f "$merged_crt"
                        print_error "Failed to deploy custom certificate for console user"
                        press_enter
                        return
                    fi
                    [ -n "$merged_crt" ] && rm -f "$merged_crt"
                    print_success "Custom certificate installed"
                    ;;
                0|*)
                    print_info "Cancelled — no changes made."
                    press_enter
                    return
                    ;;
            esac

            local api_tls="false" allow_self_signed="true"
            case "${cert_choice:-2}" in
                1)
                    infer_tls_mode_from_cert "$ssl_dir/betterdesk.crt"
                    api_tls="$INFERRED_RUSTDESK_API_TLS"
                    allow_self_signed="$INFERRED_ALLOW_SELF_SIGNED"
                    ;;
                2)
                    api_tls="false"
                    allow_self_signed="true"
                    ;;
                3)
                    api_tls="true"
                    allow_self_signed="false"
                    ;;
                4)
                    infer_tls_mode_from_cert "$ssl_dir/betterdesk.crt"
                    api_tls="$INFERRED_RUSTDESK_API_TLS"
                    allow_self_signed="$INFERRED_ALLOW_SELF_SIGNED"
                    ;;
            esac

            print_step "Switching to HTTPS mode..."

            apply_console_protocol_mode https "$ssl_dir/betterdesk.crt" "$ssl_dir/betterdesk.key" "$api_tls" "$allow_self_signed"

            sync_go_server_signal_relay_tls "$ssl_dir"
            ensure_betterdesk_console_user >/dev/null

            print_success "Switched to HTTPS mode"
            echo ""
            print_info "  Panel:         HTTPS :$(resolve_panel_https_port)"
            print_info "  Redirect:      HTTP :$(resolve_panel_http_port) → HTTPS :$(resolve_panel_https_port)"
            print_info "  Signal:        TLS   :21116"
            print_info "  Relay:         TLS   :21117"
            print_info "  Go API:        HTTP  :${GO_API_PORT:-21114} (RustDesk client + REST)"
            if [ "$api_tls" = "true" ]; then
                print_info "  Client API:    HTTPS :${CLIENT_API_PORT:-21121}"
            else
                print_info "  Client API:    HTTP  :${CLIENT_API_PORT:-21121}"
            fi
            maybe_offer_standard_https_port
            ;;
        3)
            do_configure_reverse_proxy || true
            ;;
        0|4|*)
            return
            ;;
    esac

    echo ""
    if confirm "Restart BetterDesk services now?"; then
        repair_https_stuck_state yes
        ensure_console_tls_material_readable 2>/dev/null || true
        systemctl restart betterdesk-server betterdesk-console 2>/dev/null || true
        verify_service_health "betterdesk-server" "21116" 15 >/dev/null 2>&1 || true
        verify_service_health "betterdesk-console" "$(resolve_panel_health_port)" 15 >/dev/null 2>&1 || true
        print_success "BetterDesk services restarted"
        run_protocol_tests
    else
        print_info "Changes saved. Restart later with: systemctl restart betterdesk-server betterdesk-console"
    fi

    press_enter
}

#===============================================================================
# Database Migration Functions
#===============================================================================

do_migrate_database() {
    print_header
    echo -e "${WHITE}${BOLD}══════════ DATABASE MIGRATION ══════════${NC}"
    echo ""

    # Locate migration binary
    local migrate_bin=""
    local arch=$(uname -m)
    local search_paths=(
        "$SCRIPT_DIR/betterdesk-server/tools/migrate/migrate-linux-amd64"
        "$SCRIPT_DIR/tools/migrate/migrate-linux-amd64"
        "$RUSTDESK_PATH/migrate"
        "/usr/local/bin/betterdesk-migrate"
    )

    for p in "${search_paths[@]}"; do
        if [ -f "$p" ] && [ -x "$p" ]; then
            migrate_bin="$p"
            break
        fi
    done

    if [ -z "$migrate_bin" ]; then
        # Try to find non-executable and make it executable
        for p in "${search_paths[@]}"; do
            if [ -f "$p" ]; then
                chmod +x "$p"
                migrate_bin="$p"
                break
            fi
        done
    fi

    if [ -z "$migrate_bin" ]; then
        print_error "Migration binary not found!"
        print_info "Expected at: $SCRIPT_DIR/betterdesk-server/tools/migrate/migrate-linux-amd64"
        print_info "Build it with: cd betterdesk-server && go build -o tools/migrate/migrate-linux-amd64 ./tools/migrate/"
        press_enter
        return
    fi

    print_info "Migration binary: $migrate_bin"
    echo ""
    local _menu_items=(
        $'Rust -> Go\tMigrate legacy Rust hbbs database to the Go server'
        $'Node.js -> Go\tMigrate the Node.js web console DB to the Go server'
        $'SQLite -> PostgreSQL\tMigrate BetterDesk Go SQLite to PostgreSQL'
        $'PostgreSQL -> SQLite\tMigrate PostgreSQL back to SQLite'
        $'Backup\tCreate a timestamped SQLite database backup'
        $'Back\tReturn to the main menu'
    )
    local _menu_returns=( 1 2 3 4 5 0 )
    menu_choose "Database Migration" "Migrate databases between BetterDesk components"
    local mig_choice="$MENU_CHOICE"

    case $mig_choice in
        1)
            # Rust → Go
            echo ""
            local default_src="$RUSTDESK_PATH/db_v2.sqlite3"
            read -p "Source Rust database [$default_src]: " src_db
            src_db="${src_db:-$default_src}"

            if [ ! -f "$src_db" ]; then
                print_error "Source database not found: $src_db"
                press_enter
                return
            fi

            read -p "Destination (SQLite path or postgres:// URI) [new file next to source]: " dst_db

            print_step "Creating backup before migration..."
            "$migrate_bin" -mode backup -src "$src_db" 2>&1 || true

            print_step "Running Rust → Go migration..."
            if [ -n "$dst_db" ]; then
                "$migrate_bin" -mode rust2go -src "$src_db" -dst "$dst_db" 2>&1
            else
                "$migrate_bin" -mode rust2go -src "$src_db" 2>&1
            fi

            if [ $? -eq 0 ]; then
                print_success "Rust → Go migration completed successfully!"
            else
                print_error "Migration failed. Check the output above for details."
            fi
            ;;
        2)
            # Node.js → Go
            echo ""
            local default_src="$RUSTDESK_PATH/db_v2.sqlite3"
            local default_auth="$CONSOLE_PATH/data/auth.db"

            read -p "Source Node.js peer database [$default_src]: " src_db
            src_db="${src_db:-$default_src}"

            if [ ! -f "$src_db" ]; then
                print_error "Source peer database not found: $src_db"
                press_enter
                return
            fi

            read -p "Node.js auth database [$default_auth]: " auth_db
            auth_db="${auth_db:-$default_auth}"

            read -p "Destination (SQLite path or postgres:// URI) [new file next to source]: " dst_db

            print_step "Creating backup before migration..."
            "$migrate_bin" -mode backup -src "$src_db" 2>&1 || true
            if [ -f "$auth_db" ]; then
                "$migrate_bin" -mode backup -src "$auth_db" 2>&1 || true
            fi

            print_step "Running Node.js → Go migration..."
            # SECURITY (audit fix M-04, 2026-04-10): use a bash array + direct exec
            # instead of cmd-string + eval to avoid shell injection if any input
            # contains spaces / metacharacters.
            local args=("-mode" "nodejs2go" "-src" "$src_db")
            if [ -f "$auth_db" ]; then
                args+=("-node-auth" "$auth_db")
            fi
            if [ -n "$dst_db" ]; then
                args+=("-dst" "$dst_db")
            fi
            "$migrate_bin" "${args[@]}" 2>&1

            if [ $? -eq 0 ]; then
                print_success "Node.js → Go migration completed successfully!"
            else
                print_error "Migration failed. Check the output above for details."
            fi
            ;;
        3)
            # SQLite → PostgreSQL
            echo ""
            local default_src="$RUSTDESK_PATH/db_v2.sqlite3"
            read -p "Source SQLite database [$default_src]: " src_db
            src_db="${src_db:-$default_src}"

            if [ ! -f "$src_db" ]; then
                print_error "Source database not found: $src_db"
                press_enter
                return
            fi

            read -p "PostgreSQL connection URI (postgres://user:pass@host:5432/dbname): " pg_uri
            if [ -z "$pg_uri" ]; then
                print_error "PostgreSQL URI is required"
                press_enter
                return
            fi

            print_step "Creating backup before migration..."
            "$migrate_bin" -mode backup -src "$src_db" 2>&1 || true

            print_step "Running SQLite → PostgreSQL migration..."
            "$migrate_bin" -mode sqlite2pg -src "$src_db" -dst "$pg_uri" 2>&1

            if [ $? -eq 0 ]; then
                print_success "SQLite → PostgreSQL migration completed successfully!"
                print_info "Update your BetterDesk Go server config: DB_URL=$pg_uri"
            else
                print_error "Migration failed. Check the output above for details."
            fi
            ;;
        4)
            # PostgreSQL → SQLite
            echo ""
            read -p "PostgreSQL connection URI (postgres://user:pass@host:5432/dbname): " pg_uri
            if [ -z "$pg_uri" ]; then
                print_error "PostgreSQL URI is required"
                press_enter
                return
            fi

            local default_dst="$RUSTDESK_PATH/db_v2.sqlite3"
            read -p "Destination SQLite file [$default_dst]: " dst_db
            dst_db="${dst_db:-$default_dst}"

            if [ -f "$dst_db" ]; then
                print_warning "Destination file exists: $dst_db"
                if ! confirm "Overwrite (backup will be created first)?"; then
                    press_enter
                    return
                fi
                "$migrate_bin" -mode backup -src "$dst_db" 2>&1 || true
            fi

            print_step "Running PostgreSQL → SQLite migration..."
            "$migrate_bin" -mode pg2sqlite -src "$pg_uri" -dst "$dst_db" 2>&1

            if [ $? -eq 0 ]; then
                print_success "PostgreSQL → SQLite migration completed successfully!"
            else
                print_error "Migration failed. Check the output above for details."
            fi
            ;;
        5)
            # Backup
            echo ""
            local default_src="$RUSTDESK_PATH/db_v2.sqlite3"
            read -p "SQLite database to backup [$default_src]: " src_db
            src_db="${src_db:-$default_src}"

            if [ ! -f "$src_db" ]; then
                print_error "Database not found: $src_db"
                press_enter
                return
            fi

            print_step "Creating backup..."
            "$migrate_bin" -mode backup -src "$src_db" 2>&1

            if [ $? -eq 0 ]; then
                print_success "Backup created successfully!"
            else
                print_error "Backup failed."
            fi
            ;;
        0)
            return
            ;;
        *)
            print_warning "Invalid option"
            ;;
    esac

    press_enter
}

#===============================================================================
# Main Menu
#===============================================================================

show_menu() {
    print_header
    print_status
    
    echo -e "${WHITE}${BOLD}══════════ MAIN MENU ══════════${NC}"
    echo ""
    echo "  1. 🚀 FRESH INSTALLATION"
    echo "  2. ⬆️  UPDATE"
    echo "  3. 🔧 REPAIR INSTALLATION"
    echo "  4. ✅ INSTALLATION VALIDATION"
    echo "  5. 💾 Backup"
    echo "  6. 🔐 Reset admin password"
    echo "  7. 🔨 Build & deploy server"
    echo "  8. 📊 DIAGNOSTICS"
    echo "  9. 🗑️  UNINSTALL"
    echo ""
    echo "  L. 📦 MINIMAL INSTALLATION (server only)"
    echo "  C. 🔒 Configure SSL certificates"
    echo "  T. 🔄 Toggle HTTP/HTTPS mode"
    echo "  M. 🔄 Database migration"
    echo "  B. 🧰 Build toolchain"
    echo "  S. ⚙️  Settings (paths)"
    echo "  0. ❌ Exit"
    echo ""
    echo -e "  ${DIM}Tip: this menu also supports arrow-key navigation (set BETTERDESK_CLASSIC_MENU=1 to force this list).${NC}"
    echo ""
}

main() {
    # Check root
    if [ "$EUID" -ne 0 ]; then
        echo -e "${RED}This script requires root privileges!${NC}"
        echo "Run: sudo $0"
        exit 1
    fi
    
    # Auto-detect paths on startup
    echo -e "${CYAN}Detecting installation...${NC}"
    auto_detect_paths
    echo ""
    sleep 1
    
    # Auto mode - run installation directly
    if [ "$AUTO_MODE" = true ]; then
        print_info "Running in AUTO mode..."
        if [ "$MINIMAL_MODE" = true ]; then
            do_install_minimal
        else
            do_install
        fi
        exit $?
    fi

    # Action tokens map 1:1 to the classic case dispatch below, so both the
    # arrow-key TUI and the numeric fallback share the exact same handlers.
    local menu_labels=(
        $'Fresh installation\tFull install from scratch'
        $'Update\tUpdate an existing installation'
        $'Repair installation\tFix common problems'
        $'Validate installation\tCheck correctness'
        $'Backup\tCreate a backup'
        $'Reset admin password\tReset the console admin'
        $'Build & deploy server\tCompile and deploy the Go server'
        $'Diagnostics\tDetailed problem analysis'
        $'Uninstall\tRemove BetterDesk'
        $'Minimal installation\tServer only'
        $'Configure SSL certificates\tLet'"'"'s Encrypt / custom / self-signed'
        $'Toggle HTTP/HTTPS\tSwitch protocol + run tests'
        $'Database migration\tMigrate between backends'
        $'Build toolchain\tInstall compilers'
        $'Settings (paths)\tConfigure install paths'
        $'Exit\tQuit the manager'
    )
    local menu_actions=( 1 2 3 4 5 6 7 8 9 L C T M B S 0 )

    while true; do
        local choice=""
        if tui_available; then
            detect_installation 2>/dev/null
            local status_line="Install: ${INSTALL_STATUS:-unknown}"
            [ "$HBBS_RUNNING" = true ] && status_line="$status_line  |  server: running" || status_line="$status_line  |  server: stopped"
            [ "$CONSOLE_RUNNING" = true ] && status_line="$status_line  |  console: running" || status_line="$status_line  |  console: stopped"
            if tui_select "BetterDesk Console Manager v${VERSION}" "$status_line" "${menu_labels[@]}"; then
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
            [Ll]) do_install_minimal ;;
            [Cc]) do_configure_ssl ;;
            [Tt]) do_toggle_protocol ;;
            [Mm]) do_migrate_database ;;
            [Bb]) do_install_build_toolchain ;;
            [Ss]) configure_paths ;;
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
main "$@"
