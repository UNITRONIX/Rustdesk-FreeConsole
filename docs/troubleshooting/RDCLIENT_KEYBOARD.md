# RdClient Web — keyboard troubleshooting

Symptoms such as wrong characters after some time, broken Shift/Caps Lock, or Hyper-V / VM Connect typing issues often involve **sticky remote modifiers**, **Legacy vs Map encoding**, or **nested remote keyboard translation**.

## Quick recovery (operator)

1. **Toolbar → Actions → Reset Keyboard State** — releases Shift/Ctrl/Alt/Meta on the remote host.
2. On the remote desktop, tap **Ctrl**, **Alt**, and **Shift** once each (no hold).
3. Check **keyboard layout** (PL/EN) and **Caps Lock** on the remote machine.

## Verify sticky-modifier hypothesis (rdclient web)

1. Connect via **Settings → Remote** (rdclient web).
2. Hold **Shift** or **Ctrl**, then switch to another browser tab or click the address bar **without** releasing the modifier.
3. Return to the remote tab and type — if characters are wrong, the issue matches missing keyup sync (fixed via blur/tab release).
4. Click **Reset Keyboard State** — typing should return to normal.

## Compare with native RustDesk client

| Step | Native RustDesk | rdclient web |
|------|-----------------|--------------|
| Same host, same task (e.g. Hyper-V Manager) | Baseline | Should match after parity encoder |
| Shift + letter | Uppercase | Same (Map scancode + Shift controlKey, or Legacy `a` + Shift modifier) |
| After tab switch with modifier held | May also stick | Auto-releases tracked keys on blur |
| Hyper-V VM Connect nested in session | Known fragile | Prefer **Auto** or **Map**; connect to guest when possible |

**Interpretation:** If native RustDesk works but rdclient web fails on the same host, try **Reset Keyboard State**, then **Legacy** mode for accented typing (ą, ü). If both fail inside VM Connect, prefer **Enhanced Session**, direct RDP to the guest, or RustDesk on the VM.

## Keyboard modes (Display settings)

| Mode | When to use |
|------|-------------|
| **Auto** (default) | **Map (scancode) for all keys** — same default as the RustDesk desktop client. Best for Windows, Hyper-V, VM console, Shift+symbols. |
| **Legacy** | Layout-specific characters (ą, ü, …), AltGr, or when Map misbehaves on a specific app |
| **Map** | Explicit scancode mode (same wire format as Auto) |

### Wire contract (matches RustDesk native)

- **Auto / Map:** printable keys → `KeyEvent.mode = Map`, scancode in `chr`; Shift/Ctrl/Alt sent as separate Legacy `controlKey` events; `modifiers` on Map chr events carry **CapsLock/NumLock only**.
- **Legacy:** printable keys → lowercase `chr` + `modifiers` (Shift/Ctrl/Alt as needed); server applies case via `need_to_uppercase()`.
- **Caps Lock / Num Lock / Scroll Lock keys:** no wire event (state synced via `modifiers` on following letter/numpad keys).

## Hyper-V / nested remote

Chain: **Browser → rdclient → RustDesk on host → Hyper-V / VM Connect → guest**.

- Avoid configuring VMs through double/triple nested remote when possible.
- Connect rdclient **directly to the guest** if it runs RustDesk.
- **Auto** (Map) is the recommended default for host Hyper-V Manager and VM Connect.

## Related code

- [`web-nodejs/public/js/rdclient/keyboard-encoder.js`](../../web-nodejs/public/js/rdclient/keyboard-encoder.js) — RustDesk-compatible KeyEvent encoder
- [`web-nodejs/public/js/rdclient/input.js`](../../web-nodejs/public/js/rdclient/input.js) — DOM capture, blur/stop release
- [`web-nodejs/public/js/rdclient/keyboard-scancode.js`](../../web-nodejs/public/js/rdclient/keyboard-scancode.js) — DOM `code` → scancode tables
- [`web-nodejs/tests/rdclient.input.test.js`](../../web-nodejs/tests/rdclient.input.test.js) — parity regression tests
