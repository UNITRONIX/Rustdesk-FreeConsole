# Client Setup

This guide covers configuring RustDesk desktop and mobile clients to connect to your BetterDesk server.

---

## Obtaining Server Details

### From the Web Console

1. Log in to **http://your-server:5000**
2. Go to **Settings** → **Server Configuration**
3. You'll see:
   - **Server Address** (e.g., `your-server.com`)
   - **Public Key** (e.g., `OeVuKk5nl...`)
4. Use the **QR Code** button for easy mobile setup
5. Use the **Copy Config** button for clipboard-ready values

### From the CLI

```bash
# Public key
cat /opt/betterdesk/id_ed25519.pub

# Or from the API
curl http://your-server:21114/api/server-config
```

---

## RustDesk Desktop Client

### Manual Configuration

1. Open RustDesk client
2. Click **Settings** (gear icon) → **Network** → **ID/Relay Server**
3. Configure:
   - **ID Server**: `your-server.com`
   - **Relay Server**: `your-server.com`
   - **API Server**: `http://your-server.com:21121`
   - **Key**: paste the public key from the web console

> **Important:** The API Server must point to port **21121** (Node.js Client API), not 21114 (Go server API). The protocol prefix (`http://`) is required.

### Configuration File

Alternatively, edit the RustDesk config file directly:

**Windows:** `%APPDATA%\RustDesk\config\RustDesk.toml`  
**Linux:** `~/.config/rustdesk/RustDesk.toml`  
**macOS:** `~/Library/Preferences/RustDesk/RustDesk.toml`

```toml
rendezvous_server = "your-server.com"
relay-server = "your-server.com"
api-server = "http://your-server.com:21121"
key = "OeVuKk5nl..."
```

---

## Mobile Clients

### Android / iOS

1. Open RustDesk mobile app
2. Tap **Settings** (⚙️) → **ID/Relay Server**
3. Scan the QR code from the web console, or enter manually:
   - **ID Server**: `your-server.com`
   - **Relay Server**: `your-server.com`
   - **API Server**: `http://your-server.com:21121`
   - **Key**: paste the public key

---

## Client Login

RustDesk clients can optionally log in to the server for:
- Address book sync across devices
- Persistent group assignments
- Audit trail of connections

### Login Flow

1. In RustDesk client, click the user icon (top right)
2. Enter username and password (created in the web console)
3. If TOTP 2FA is enabled, enter the 6-digit code
4. After login, address books sync automatically

### Session lifetime

RustDesk client login tokens are **DB-backed** (v3.3.129+):
- Default **7 days** with sliding renewal on activity
- Maximum **30 days**
- Configure under **Settings → Authentication → RustDesk clients** in the web panel

After a server update that changes session handling, users may need to **sign in once** in the RustDesk client.

### User Roles on Client

| Role | Client Behavior |
|------|----------------|
| **Admin** | Full access, can manage via web console |
| **Operator** | Can connect to assigned devices |
| **Viewer** | Read-only access to device list |
| **Pro** | API-only access (no panel login, no client login) |

---

## Mass Deployment

### Configuration via Registry (Windows)

For enterprise deployment, push RustDesk config via Group Policy:

```reg
[HKEY_LOCAL_MACHINE\SOFTWARE\RustDesk]
"rendezvous_server"="your-server.com"
"relay-server"="your-server.com"
"api-server"="http://your-server.com:21121"
"key"="OeVuKk5nl..."
```

### Configuration via MSI Properties

```bash
msiexec /i rustdesk.msi /quiet \
  RENDEZVOUS_SERVER=your-server.com \
  RELAY_SERVER=your-server.com \
  API_SERVER=http://your-server.com:21121 \
  KEY=OeVuKk5nl...
```

### Configuration via betterdesk.sh

The ALL-IN-ONE Linux script can generate pre-configured client packages. Choose option **7** (Build binaries) from the interactive menu.

---

## Testing Connection

### Verify Client Registration

After configuring a client:

1. The client should receive a numeric ID (e.g., `1340238749`)
2. The device appears in the web console **Devices** page
3. Status should show as **Online** (green dot)

### Troubleshooting Client Connection

| Issue | Solution |
|-------|----------|
| Client shows "Connecting..." | Check firewall ports 21116 TCP/UDP, 21117 TCP |
| No ID assigned | Verify ID Server address and public key match |
| "Failed to secure TCP" | Check TLS configuration, ensure key file matches |
| Address book not syncing | Verify API Server is `http://server:21121` (with `http://` prefix) |
| Login fails | Check user exists in web console, verify TOTP if enabled |

### Test with Command Line

```bash
# Test signal port
nc -vz your-server.com 21116

# Test relay port
nc -vz your-server.com 21117

# Test client API
curl http://your-server.com:21121/api/login-options
```

---

## Custom Client Branding

RustDesk supports custom branding. Use the built-in **Client Generator** in the web panel to build pre-configured clients — see [[Client Generator|Client-Generator]].

---

## See also

- [[Installation]] — server setup
- [[TLS / SSL Certificates|TLS-SSL]] — HTTPS for API server URLs
- [[Troubleshooting]] — connection issues
- [[Client Generator|Client-Generator]] — branded client packages
