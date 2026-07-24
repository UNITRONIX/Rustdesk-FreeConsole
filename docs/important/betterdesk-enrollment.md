# BetterDesk Enrollment

- Signal-mode Managed enrollment must create `pending_device_<peerID>` in `server_config` and deny registration until operator approval; Locked mode must deny without creating pending requests.
- Outbound session initiation (`PunchHoleRequest` / `RequestRelay`) requires an authorized initiator (#302):
  - All modes: initiator must be a live registered peer in the signal peer map (anonymous rendezvous is refused).
  - Managed / locked: initiator must also exist as an approved peer in the DB (`GetPeer`); pending queue alone is not enough.
- Commit references for GitHub issues should use `Refs #N` (not `Fixes`) when the user wants the issue left open.
