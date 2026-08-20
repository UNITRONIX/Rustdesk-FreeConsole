# BetterDesk Desktop security model

## Trust assumptions

- The configured server URL and public key are untrusted until validated.
- A remote peer is untrusted until its identity and server-signed key chain are
  verified.
- The web UI is not a security boundary.
- A connection may be interrupted or replayed at any point.

## Required controls

1. Release builds require TLS certificate validation.
2. Transport selection is automatic: HTTPS is preferred for addresses without
   a scheme, while explicitly configured HTTP is reported as plaintext and is
   never reached through a silent HTTPS downgrade.
3. Server public keys are validated before they are stored or used.
4. Protocol frames have hard size limits and reject malformed lengths.
5. Credentials are never written to logs or included in error messages.
6. Secrets use the operating-system credential store where available.
7. Remote file paths are treated as peer data, constrained to an
   operator-approved root, and never passed to a local shell.
8. Privileged settings use an operation allowlist and platform elevation.
9. Tray notifications contain no passwords, tokens or full remote paths.
10. Reconnect uses bounded exponential backoff and does not retry failed
    authentication indefinitely.

## Settings classification

| Class | Examples | Elevation |
|---|---|---|
| User | language, theme, window layout, peer history | No |
| Session | quality, monitor, view-only, clipboard, audio | No; peer policy still applies |
| Machine/security | server key, unattended mode, service, autostart, system proxy, update | Yes |

The application does not run its complete process as administrator. On
Windows, the helper uses UAC. On Linux, the helper uses polkit where
available. If elevation is unavailable, the operation fails closed.

## Clean-room provenance

Protocol interoperability is implemented from the BetterDesk repository's
protocol definitions and tests. RustDesk is treated as an external behavioral
reference only. No RustDesk source, generated binary, UI asset, trademark or
brand resource is included in this directory.
