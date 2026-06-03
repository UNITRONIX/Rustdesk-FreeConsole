# rdclient protobuf enum encoding pitfall

- web-nodejs/public/js/rdclient/protocol.js `serializeMessage` MUST use
  `Message.fromObject(obj)` (NOT `Message.create(obj)`) before `.encode()`.
- protobuf.js `create()` does NOT convert string enum names -> numeric values.
  So `keyEvent.controlKey: 'Backspace'` / `mode: 'Legacy'` encoded as 0 (Unknown)
  -> all non-character keys silently dropped by peer; only numeric `chr` letters worked.
- `fromObject()` converts enum name strings to numbers AND preserves Uint8Array
  byte fields (clipboard content, file blocks, password, pk). Verified round-trip.
- Fixed in commit 1411719 (main).
- input.js KEY_MAP sends ControlKey NAME strings (Backspace/Return/Space/...).
  ControlKey enum values: Backspace=2, Return=27, Space=30, Tab=31, Alt=1,
  Control=4, Shift=29, Meta=23, Escape=8 (see protos/message.proto).
- Validate JS edits: `cd web-nodejs && node --check public/js/rdclient/<file>.js`.
- protobufjs not an npm dep; vendored at public/js/vendor/protobuf.min.js.
