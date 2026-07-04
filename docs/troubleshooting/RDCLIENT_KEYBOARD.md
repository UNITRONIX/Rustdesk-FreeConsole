# RdClient Web — keyboard troubleshooting

Symptoms such as wrong characters after some time, broken shortcuts, or Hyper-V / VM Connect typing issues often involve **sticky remote modifiers** or **nested remote keyboard translation**.

## Quick recovery (operator)

1. **Toolbar → Actions → Reset Keyboard State** — releases Shift/Ctrl/Alt/Meta on the remote host.
2. On the remote desktop, tap **Ctrl**, **Alt**, and **Shift** once each (no hold).
3. Check **keyboard layout** (PL/EN) and **Caps Lock** on the remote machine.

## Verify sticky-modifier hypothesis (rdclient web)

1. Connect via **Settings → Remote** (rdclient web).
2. Hold **Shift** or **Ctrl**, then switch to another browser tab or click the address bar **without** releasing the modifier.
3. Return to the remote tab and type — if characters are wrong, the issue matches missing keyup sync (fixed in recent builds via blur/tab release).
4. Click **Reset Keyboard State** — typing should return to normal.

## Compare with native RustDesk client

| Step | Native RustDesk | rdclient web |
|------|-----------------|--------------|
| Same host, same task (e.g. Hyper-V Manager) | Baseline | If only web fails → web pipeline |
| After tab switch with modifier held | May also stick | Should auto-release after fix |
| Hyper-V VM Connect nested in session | Known fragile | Use **Keyboard Mode → Map** or connect directly to guest |

**Interpretation:** If native RustDesk works but rdclient web fails on the same host, focus on web client settings (Keyboard Mode, Reset Keyboard). If both fail inside VM Connect, prefer **Enhanced Session**, direct RDP to the guest, or RustDesk installed on the VM.

## Keyboard modes (Display settings)

| Mode | When to use |
|------|-------------|
| **Auto** (default) | Map (scancode) for Windows peers; Legacy elsewhere |
| **Legacy** | Normal text entry, accented characters (ą, ü, …) |
| **Map** | Hyper-V, VM console, BIOS, apps needing physical key positions |

Map mode sends RustDesk `KeyEvent` with `mode: Map` and scancode in `chr` (same contract as the desktop client).

## Hyper-V / nested remote

Chain: **Browser → rdclient → RustDesk on host → Hyper-V / VM Connect → guest**.

- Avoid configuring VMs through double/triple nested remote when possible.
- Connect rdclient **directly to the guest** if it runs RustDesk.
- For host-only Hyper-V Manager work, **Map** or **Auto** mode on Windows peers improves scancode fidelity.

## Related code

- [`web-nodejs/public/js/rdclient/input.js`](../../web-nodejs/public/js/rdclient/input.js) — capture, release, Legacy/Map
- [`web-nodejs/public/js/rdclient/keyboard-scancode.js`](../../web-nodejs/public/js/rdclient/keyboard-scancode.js) — DOM `code` → scancode tables
- [`web-nodejs/tests/rdclient.input.test.js`](../../web-nodejs/tests/rdclient.input.test.js) — regression tests
