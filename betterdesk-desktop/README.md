# BetterDesk Desktop

Independent BetterDesk operator client for Windows and Linux.

The project is intentionally separate from `rdclient-desktop`. It does not
load the web console as its runtime UI and does not depend on RustDesk source
code or binaries. RustDesk-compatible interoperability is implemented from
the protocol specifications maintained in this repository:

- `../betterdesk-server/protos/rendezvous.proto`
- `../betterdesk-server/protos/message.proto`
- `../docs/cdap/PROTOCOL.md`

## Current implementation

The first implementation slice provides:

- a Rust core crate with bounded frame parsing/encoding;
- BetterDesk/RustDesk-compatible protobuf generation;
- strict server URL and public-key validation;
- automatic HTTPS/HTTP API probing without a compatibility toggle;
- deploy-string parsing compatible with BetterDesk's RustDesk deployment
  format;
- CDAP authentication, registration, heartbeat and media event models;
- durable device ID, rotating session password and Ed25519 identity storage;
- RustDesk-compatible registration, input, clipboard, audio and file messages;
- bounded Windows primary-screen capture, mouse/keyboard injection and
  operator-approved file-transfer roots;
- a safe settings policy separating user settings from administrator-only
  machine settings;
- a Flutter desktop shell with quick connect, durable peer history, local
  identity, UAC-gated settings, desktop-session canvas and tray state;
- a release build orchestrator for Windows and Linux packages.

The protocol/session modules are deliberately layered so that media, input,
clipboard, and file-transfer implementations can be added without coupling
the UI to the wire protocol.

## Development

Requirements:

- Rust stable;
- Flutter stable with Windows and Linux desktop support;
- `protoc`;
- Windows: WebView2 and WiX 4 for MSI packaging;
- Linux: GTK/WebKitGTK development packages, `dpkg-deb`, `rpmbuild`,
  `appimagetool` and `tar`.

From this directory:

```text
python build.py check
python build.py test
python build.py build --target windows-x64
python build.py build --target linux-x64
```

For a Flutter-only development run:

```text
cd flutter
flutter pub get
flutter run -d windows
```

## Configuration

The client can be configured without the panel Generator:

1. enter a BetterDesk/RustDesk-compatible server configuration in the setup
   screen;
2. import a deploy string or QR payload;
3. set `BETTERDESK_SERVER_URL` before first launch; or
4. pass `--server-url` and `--server-key` on the command line.

The application never disables TLS verification in release builds. HTTPS is
preferred automatically when no scheme is entered; explicit HTTP is supported
for RustDesk-compatible deployments and is clearly reported as plaintext.

## Background and elevation model

Closing the main window sends the client to the system tray. The process can
be terminated explicitly from the tray menu. Autostart is opt-in.

Theme, language, window layout and local peer history are per-user settings.
Machine-wide endpoints, server keys, unattended access, system proxy,
autostart/service installation and updates are administrator-controlled.
Connection fields remain hidden until a successful UAC/polkit authorization.
The full UI is never run elevated; privileged operations use a narrowly scoped
platform helper.

## Licensing and provenance

BetterDesk Desktop is an original BetterDesk component. It uses the project
license and only declares third-party dependencies with compatible licenses.
Protocol interoperability does not include copying RustDesk implementation
code, UI assets, branding or proprietary material.
