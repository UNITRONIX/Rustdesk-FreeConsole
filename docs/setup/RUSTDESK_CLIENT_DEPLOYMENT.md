# RustDesk Client Deployment (Windows / Intune / PSADT)

Guide for mass-deploying the **stock RustDesk MSI** against a BetterDesk server. For custom branded installers, see the **Client Generator** in the web console.

## Quick local test (do this before Intune)

1. Install RustDesk on a test VM (same MSI you plan to push).
2. Open the BetterDesk web console → **Dashboard** → **RustDesk Client Configuration**.
3. Set **Client server address** to the IP or DNS your clients will use (public IP if the panel is opened on `localhost`).
4. In RustDesk: **menu (≡) → Network → ID/Relay Server** (unlock as admin) and enter:
   - **ID Server** — value from the dashboard
   - **Relay Server** — same (or leave empty)
   - **API Server** — `http://<server>:21114` for HTTP-only setups (no TLS yet)
   - **Key** — contents of `id_ed25519.pub`
5. Confirm the device appears under **Devices** in the console.
6. From an **elevated** PowerShell on the same VM, test scripted config:

```powershell
& "${env:ProgramFiles}\RustDesk\rustdesk.exe" --config '<deploy-string-from-dashboard>'
```

Use **Copy deploy string** on the dashboard, or **Intune / PSADT script** for a full snippet.

> **Tip:** After a successful manual setup, RustDesk **Settings → Network → Export Server Config** produces the same string used by `--config`.

## Three configuration formats

| Method | Format | Use case |
|--------|--------|----------|
| Manual UI | Four fields in Network settings | First test, one-off machines |
| QR / deep link | `rustdesk://config/<standard-base64-json>` | Mobile / scan from dashboard QR |
| CLI / Import | `reverse(base64(json))` without `=` padding | Intune, PSADT, GPO, RMM scripts |

All three use the same JSON payload:

```json
{
  "host": "203.0.113.10",
  "relay": "203.0.113.10",
  "api": "http://203.0.113.10:21114",
  "key": "<contents-of-id_ed25519.pub>"
}
```

### CLI deploy string algorithm

1. Build compact JSON (as above).
2. Base64-encode the JSON string.
3. Remove trailing `=` padding.
4. **Reverse** the base64 string character-by-character.

PowerShell example:

```powershell
$ServerHost = '203.0.113.10'
$PublicKey = '<from id_ed25519.pub>'
$json = @{
    host = $ServerHost
    relay = $ServerHost
    api = "http://${ServerHost}:21114"
    key = $PublicKey
} | ConvertTo-Json -Compress
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)).TrimEnd('=')
$CfgString = -join ($b64[-1..-($b64.Length)] -join '')
& "${env:ProgramFiles}\RustDesk\rustdesk.exe" --config $CfgString
```

> **Do not** pass raw JSON to `--config` — RustDesk expects the reversed base64 string.

## HTTP server without TLS

For lab or early production with a public IP and no certificates:

- **API Server** must be **`http://<ip>:21114`** (not `https://`).
- Open outbound **TCP 21114–21117** and **UDP 21116** from clients to the server.
- Set `PANEL_PUBLIC_HOST=<public-ip-or-dns>` in the console `.env` if operators open the panel via localhost or an internal name — the dashboard will then show the correct client address.

## Intune / Robopack / PSADT 4.x

Typical flow when the MSI is deployed by Robopack + PSADT:

1. MSI installs RustDesk silently (your existing package).
2. **Post-install script** (elevated) applies server settings:

```powershell
$RustDesk = Join-Path $env:ProgramFiles 'RustDesk\rustdesk.exe'
# $CfgString from dashboard "Copy deploy string" or generated inline (see above)
Start-Process -FilePath $RustDesk -ArgumentList @('--config', $CfgString) -Wait -NoNewWindow

# Optional permanent password for unattended access:
# Start-Process -FilePath $RustDesk -ArgumentList @('--password', 'YourSecurePassword') -Wait -NoNewWindow
```

3. Hook this into PSADT **after** `Execute-Process` / MSI success in `Deploy-Application.ps1` (or your Robopack post-install phase).

A ready-to-customize template lives at [`scripts/deploy/rustdesk-apply-config.ps1.example`](../../scripts/deploy/rustdesk-apply-config.ps1.example).

### Detection rule (Intune Win32)

Common options:

- File exists: `%ProgramFiles%\RustDesk\rustdesk.exe`
- Registry uninstall key for RustDesk (product display name)

Combine with a custom detection script that verifies network settings if required.

## Optional client settings

| Setting | Stock MSI + script | Custom RustDesk build |
|---------|-------------------|------------------------|
| ID / Relay / API / Key | `--config` | Embedded in installer |
| Permanent password | `--password` (admin) | `--password` or generator |
| Disable settings UI | Not available | Custom client generator |
| Silent user login | Not supported | Users log in manually |

BetterDesk **Pro features** (address book sync, device list, audit) activate after each user **logs in** in the RustDesk client with their BetterDesk account — server config alone is not enough.

## Troubleshooting

| Symptom | Check |
|---------|--------|
| `--config` appears to do nothing | Use reversed base64 string, not JSON; run elevated |
| Wrong server in dashboard | Set **Client server address** or `PANEL_PUBLIC_HOST` in `.env` |
| Device not in console | Firewall 21114–21117, UDP 21116; API URL is `http://` if no TLS |
| Client login fails | API Server = Go `:21114`, not web panel `:5000` |
| "Settings are disabled" on `--password` | Custom client locked settings — use an unlocked stock MSI |

## Related docs

- [README — RustDesk Client Configuration](../../README.md#-rustdesk-client-configuration)
- [RustDesk client deployment (upstream)](https://rustdesk.com/docs/en/self-host/client-deployment/)
- [RustDesk MSI parameters](https://rustdesk.com/docs/en/client/windows/msi/)
