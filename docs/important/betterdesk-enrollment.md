# BetterDesk Enrollment

- Signal-mode Managed enrollment must create `pending_device_<peerID>` in `server_config` and deny registration until operator approval; Locked mode must deny without creating pending requests.
- Outbound session initiation (`PunchHoleRequest` / `RequestRelay`) requires an authorized initiator (#302 / #327):
  - All modes: initiator must be a live registered peer in the signal peer map (anonymous rendezvous is refused), **or** authorized via a BetterDesk client login token on the punch/relay message, **or** via TCP `RegisterPk` that binds the peer IP for `FindByIP` (viewer-only when the OS service is stopped).
  - Managed / locked: initiator must also exist as an approved peer in the DB (`GetPeer`); `pending_device_<id>` alone is never enough (also rejected if that pending key still exists).
  - **Panel Web Remote exception:** PunchHole/RequestRelay from `PANEL_SIGNAL_PROXY_CIDRS` (default loopback `127.0.0.0/8,::1/128`) are accepted without a peer registration. The Node panel authenticates the operator (or guest) at `/ws/rendezvous` upgrade before TCP-bridging to hbbs. Split panel↔Go installs must set the console container/host CIDR. Synthetic initiator id in audit logs: `panel-web-remote`.
- Commit references for GitHub issues should use `Refs #N` (not `Fixes`) when the user wants the issue left open.
