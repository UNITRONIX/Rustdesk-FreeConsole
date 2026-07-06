# check=skip=SecretsUsedInArgOrEnv
# BetterDesk — Single Container Image
# =====================================
# Combines Go server (signal + relay + API) and Node.js web console
# into a single container using supervisord as process manager.
#
# Build:  docker build -t betterdesk:local .
# Run:    docker compose up -d
#
# Ports:
#   21121 - HTTP API (Go server: RustDesk client API + REST)
#   21115 - NAT type test
#   21116 - Signal TCP/UDP
#   21117 - Relay TCP
#   21118 - WebSocket Signal
#   21119 - WebSocket Relay
#   5000  - Web Console (Node.js admin panel)

# ============= Stage 1: Build Go server =============
FROM golang:1.25-alpine AS go-builder

# Retry apk in case of transient DNS failures (common on AlmaLinux/CentOS Docker)
RUN apk add --no-cache git || { sleep 2 && apk add --no-cache git; }

WORKDIR /src
COPY betterdesk-server/go.mod betterdesk-server/go.sum ./
RUN go mod download

COPY betterdesk-server/ .

ARG BETTERDESK_PRODUCT_VERSION=dev

RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w -X main.Version=${BETTERDESK_PRODUCT_VERSION}" \
    -tags "netgo osusergo" \
    -o /betterdesk-server .

# ============= Stage 2: Build Node.js console =============
FROM node:20-alpine AS node-builder

WORKDIR /app

# Build dependencies for native modules (better-sqlite3, bcrypt)
# Note: sqlite-dev is NOT needed — better-sqlite3 bundles its own SQLite
RUN apk add --no-cache python3 make g++ || { sleep 2 && apk add --no-cache python3 make g++; }

COPY web-nodejs/package.json web-nodejs/package-lock.json* ./
RUN npm install --production

# ============= Stage 3: Production runtime =============
# Note: supervisord requires root to manage child processes with user= directive.
# Both betterdesk-server and betterdesk-console run as non-root 'betterdesk' user
# via supervisord configuration (user=betterdesk).
FROM node:20-alpine

LABEL maintainer="UNITRONIX"
LABEL description="BetterDesk — All-in-One (Go Server + Node.js Console)"
LABEL version="3.3.121"

# Install runtime packages (retry for transient DNS failures)
RUN apk add --no-cache \
    ca-certificates \
    curl \
    sqlite \
    tini \
    supervisor \
    && mkdir -p /var/log/supervisor \
    || { sleep 2 && apk add --no-cache \
    ca-certificates \
    curl \
    sqlite \
    tini \
    supervisor \
    && mkdir -p /var/log/supervisor; }

# Create betterdesk user and directories
RUN addgroup -g 10001 -S betterdesk && \
    adduser -u 10001 -S -G betterdesk betterdesk && \
    mkdir -p /opt/rustdesk /app/data /var/log/betterdesk && \
    chown -R betterdesk:betterdesk /opt/rustdesk /app/data /var/log/betterdesk

# ---- Go server binary ----
COPY --from=go-builder /betterdesk-server /usr/local/bin/betterdesk-server
RUN chmod +x /usr/local/bin/betterdesk-server

# ---- Node.js console ----
WORKDIR /app
# IMPORTANT: Copy app code FIRST, then overlay compiled node_modules.
# This prevents local node_modules (if any) from overwriting the
# properly compiled Alpine/musl native modules from the builder.
COPY web-nodejs/ .
COPY --from=node-builder /app/node_modules ./node_modules/

ARG BETTERDESK_COMMIT_SHA=unknown
ARG BETTERDESK_IMAGE_VERSION=unknown
ENV BETTERDESK_IMAGE_SHA=${BETTERDESK_COMMIT_SHA}
ENV BETTERDESK_IMAGE_VERSION=${BETTERDESK_IMAGE_VERSION}
ENV BETTERDESK_UPDATE_MODE=image
RUN printf '%s\n' "${BETTERDESK_COMMIT_SHA}" > /app/.image-commit

# ---- Supervisord config ----
COPY docker/supervisord.conf /etc/supervisor/conf.d/betterdesk.conf

# ---- Entrypoint ----
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/wait-panel-auth-db.sh /app/docker/wait-panel-auth-db.sh
COPY docker/show-admin-credentials.sh /usr/local/bin/betterdesk-show-admin-credentials
RUN chmod +x /entrypoint.sh /app/docker/wait-panel-auth-db.sh /usr/local/bin/betterdesk-show-admin-credentials

# Environment variables (defaults)
ENV NODE_ENV=production
ENV PORT=5000
ENV SIGNAL_PORT=21116
ENV SIGNAL_RATE_LIMIT_PER_IP=20
ENV HOST=0.0.0.0
ENV API_HOST=0.0.0.0
ENV DATA_DIR=/app/data
ENV RUSTDESK_PATH=/opt/rustdesk
ENV DB_PATH=/opt/rustdesk/db_v2.sqlite3
ENV PUB_KEY_PATH=/opt/rustdesk/id_ed25519.pub
ENV API_KEY_PATH=/opt/rustdesk/.api_key
ENV SERVER_BACKEND=betterdesk
# API consolidated onto the Go server (21121); console proxies to it and does
# not run its own client API listener.
ENV API_ENABLED=false
ENV HBBS_API_URL=http://127.0.0.1:21121/api
ENV BETTERDESK_API_URL=http://127.0.0.1:21121/api
ENV DOCKER=true
ENV ENCRYPTED_ONLY=1\nENV RELAY_SERVERS=

# Expose all ports
EXPOSE 5000 21115 21116/tcp 21116/udp 21117 21118 21119 21121

# Health check: both Go server API and Node.js console must be healthy
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -sf http://localhost:21121/api/health && curl -sf http://localhost:5000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/entrypoint.sh"]
