/**
 * DOM KeyboardEvent.code → platform scancode tables for KeyboardMode.Map.
 *
 * RustDesk Map mode stores the scancode in KeyEvent.chr (see upstream
 * keyboard.rs / input_service.rs). Windows peers expect Set-1 scancodes;
 * extended keys use 0xE000 | low byte (e.g. Right Ctrl = 0xE01D).
 */
/* eslint-disable no-unused-vars */

/** @type {Record<string, number>} Windows Set-1 scancodes keyed by DOM code */
const CODE_TO_WIN_SCAN = {
    Escape: 0x01,
    Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
    Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0A, Digit0: 0x0B,
    Minus: 0x0C, Equal: 0x0D, Backspace: 0x0E, Tab: 0x0F,
    KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14,
    KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
    BracketLeft: 0x1A, BracketRight: 0x1B, Enter: 0x1C,
    ControlLeft: 0x1D,
    KeyA: 0x1E, KeyS: 0x1F, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22,
    KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
    Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
    ShiftLeft: 0x2A, Backslash: 0x2B,
    KeyZ: 0x2C, KeyX: 0x2D, KeyC: 0x2E, KeyV: 0x2F, KeyB: 0x30,
    KeyN: 0x31, KeyM: 0x32,
    Comma: 0x33, Period: 0x34, Slash: 0x35,
    ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39,
    CapsLock: 0x3A,
    F1: 0x3B, F2: 0x3C, F3: 0x3D, F4: 0x3E, F5: 0x3F, F6: 0x40,
    F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
    NumLock: 0x45, ScrollLock: 0x46,
    Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4A,
    Numpad4: 0x4B, Numpad5: 0x4C, Numpad6: 0x4D, NumpadAdd: 0x4E,
    Numpad1: 0x4F, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52,
    NumpadDecimal: 0x53,
    F11: 0x57, F12: 0x58,
    // Extended keys (0xE0 prefix)
    ControlRight: 0xE01D,
    NumpadEnter: 0xE01C,
    NumpadDivide: 0xE035,
    PrintScreen: 0xE037,
    AltRight: 0xE038,
    Home: 0xE047, ArrowUp: 0xE048, PageUp: 0xE049,
    ArrowLeft: 0xE04B, ArrowRight: 0xE04D,
    End: 0xE04F, ArrowDown: 0xE050, PageDown: 0xE051,
    Insert: 0xE052, Delete: 0xE053,
    MetaLeft: 0xE05B, MetaRight: 0xE05C, ContextMenu: 0xE05D,
    Pause: 0xE046,
};

/**
 * Linux evdev-based scancodes (X11 keycode = evdev + 8) for Map mode on Linux peers.
 * Subset aligned with common US QWERTY layout.
 * @type {Record<string, number>}
 */
const CODE_TO_LINUX_SCAN = {
    Escape: 9, Digit1: 10, Digit2: 11, Digit3: 12, Digit4: 13, Digit5: 14,
    Digit6: 15, Digit7: 16, Digit8: 17, Digit9: 18, Digit0: 19,
    Minus: 20, Equal: 21, Backspace: 22, Tab: 23,
    KeyQ: 24, KeyW: 25, KeyE: 26, KeyR: 27, KeyT: 28,
    KeyY: 29, KeyU: 30, KeyI: 31, KeyO: 32, KeyP: 33,
    BracketLeft: 34, BracketRight: 35, Enter: 36,
    ControlLeft: 37,
    KeyA: 38, KeyS: 39, KeyD: 40, KeyF: 41, KeyG: 42,
    KeyH: 43, KeyJ: 44, KeyK: 45, KeyL: 46,
    Semicolon: 47, Quote: 48, Backquote: 49,
    ShiftLeft: 50, Backslash: 51,
    KeyZ: 52, KeyX: 53, KeyC: 54, KeyV: 55, KeyB: 56,
    KeyN: 57, KeyM: 58,
    Comma: 59, Period: 60, Slash: 61,
    ShiftRight: 62, NumpadMultiply: 63, AltLeft: 64, Space: 65,
    CapsLock: 66,
    F1: 67, F2: 68, F3: 69, F4: 70, F5: 71, F6: 72,
    F7: 73, F8: 74, F9: 75, F10: 76, F11: 95, F12: 96,
    NumLock: 77, ScrollLock: 78,
    Numpad7: 79, Numpad8: 80, Numpad9: 81, NumpadSubtract: 82,
    Numpad4: 83, Numpad5: 84, Numpad6: 85, NumpadAdd: 86,
    Numpad1: 87, Numpad2: 88, Numpad3: 89, Numpad0: 90,
    NumpadDecimal: 91,
    ControlRight: 105, AltRight: 108,
    Home: 110, ArrowUp: 111, PageUp: 112,
    ArrowLeft: 113, ArrowRight: 114,
    End: 115, ArrowDown: 116, PageDown: 117,
    Insert: 118, Delete: 119,
    MetaLeft: 133, MetaRight: 134, ContextMenu: 135,
    NumpadEnter: 104, NumpadDivide: 106, PrintScreen: 107, Pause: 119,
};

/** Modifier DOM codes released on keyboard reset / blur */
const MODIFIER_CODES = [
    'ShiftLeft', 'ShiftRight',
    'ControlLeft', 'ControlRight',
    'AltLeft', 'AltRight',
    'MetaLeft', 'MetaRight',
];

/**
 * @param {string} code - KeyboardEvent.code
 * @param {string} [peerPlatform] - PeerInfo.platform (e.g. "Windows", "Linux")
 * @returns {number|null}
 */
function codeToScancode(code, peerPlatform) {
    const platform = (peerPlatform || '').toLowerCase();
    if (platform === 'linux') {
        return CODE_TO_LINUX_SCAN[code] ?? null;
    }
    // Default / Windows / macOS remote on Windows host
    return CODE_TO_WIN_SCAN[code] ?? null;
}

window.RDKeyboardScancode = {
    CODE_TO_WIN_SCAN,
    CODE_TO_LINUX_SCAN,
    MODIFIER_CODES,
    codeToScancode,
};
