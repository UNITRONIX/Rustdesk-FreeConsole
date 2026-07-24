/**
 * RustDesk-compatible KeyEvent encoder (mirrors upstream keyboard.rs client path).
 *
 * Map/Auto: scancode in chr for physical keys (including Shift/Ctrl/Alt); lock_modes only.
 * Auto/Windows hybrid: letters + modifiers/nav → Map; unshifted digits/symbols → Legacy chr.
 * Legacy: controlKey for nav/modifiers; lowercase chr + legacy_modifiers for printable keys.
 */
/* eslint-disable no-unused-vars */
/* global RDKeyboardScancode */

const RDKeyboardEncoder = {
    MOD_ALT: 1,
    MOD_CAPS_LOCK: 3,
    MOD_CTRL: 4,
    MOD_META: 23,
    MOD_SHIFT: 29,
    MOD_NUM_LOCK: 63,

    /** Upstream legacy_keyboard_mode: no wire event for lock keys. */
    SILENT_LOCK_CODES: ['CapsLock', 'NumLock', 'ScrollLock'],

    /** DOM code → RustDesk ControlKey name (Legacy fallback). */
    KEY_MAP: {
        Escape: 'Escape',
        Backspace: 'Backspace',
        Tab: 'Tab',
        Enter: 'Return',
        ShiftLeft: 'Shift',
        ShiftRight: 'RShift',
        ControlLeft: 'Control',
        ControlRight: 'RControl',
        AltLeft: 'Alt',
        AltRight: 'RAlt',
        MetaLeft: 'Meta',
        MetaRight: 'RWin',
        Pause: 'Pause',
        CapsLock: 'CapsLock',
        Space: 'Space',
        PageUp: 'PageUp',
        PageDown: 'PageDown',
        End: 'End',
        Home: 'Home',
        ArrowLeft: 'LeftArrow',
        ArrowUp: 'UpArrow',
        ArrowRight: 'RightArrow',
        ArrowDown: 'DownArrow',
        PrintScreen: 'Snapshot',
        Insert: 'Insert',
        Delete: 'Delete',
        ScrollLock: 'Scroll',
        NumLock: 'NumLock',
        F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4',
        F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8',
        F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
        Numpad0: 'Numpad0', Numpad1: 'Numpad1', Numpad2: 'Numpad2',
        Numpad3: 'Numpad3', Numpad4: 'Numpad4', Numpad5: 'Numpad5',
        Numpad6: 'Numpad6', Numpad7: 'Numpad7', Numpad8: 'Numpad8',
        Numpad9: 'Numpad9',
        NumpadMultiply: 'Multiply',
        NumpadAdd: 'Add',
        NumpadSubtract: 'Subtract',
        NumpadDecimal: 'Decimal',
        NumpadDivide: 'Divide',
        NumpadEnter: 'NumpadEnter',
        ContextMenu: 'Apps',
        AudioVolumeMute: 'VolumeMute',
        AudioVolumeDown: 'VolumeDown',
        AudioVolumeUp: 'VolumeUp',
    },

    /** Physical key → Legacy chr (lowercase), upstream legacy_keyboard_mode. */
    LEGACY_CHAR_MAP: {
        Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5',
        Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9', Digit0: '0',
        KeyA: 'a', KeyB: 'b', KeyC: 'c', KeyD: 'd', KeyE: 'e', KeyF: 'f',
        KeyG: 'g', KeyH: 'h', KeyI: 'i', KeyJ: 'j', KeyK: 'k', KeyL: 'l',
        KeyM: 'm', KeyN: 'n', KeyO: 'o', KeyP: 'p', KeyQ: 'q', KeyR: 'r',
        KeyS: 's', KeyT: 't', KeyU: 'u', KeyV: 'v', KeyW: 'w', KeyX: 'x',
        KeyY: 'y', KeyZ: 'z',
        Comma: ',', Period: '.', Semicolon: ';', Quote: '\'',
        BracketLeft: '[', BracketRight: ']', Slash: '/', Backslash: '\\',
        Minus: '-', Equal: '=', Backquote: '`',
    },

    isLetterCode(code) {
        return /^Key[A-Z]$/.test(code);
    },

    isNumpadCode(code) {
        return /^Numpad/.test(code);
    },

    /**
     * Whether this key should use Map scancode encoding.
     * @param {string} code
     * @param {'Legacy'|'Map'|'Auto'} keyboardMode
     * @param {string} peerPlatform
     * @param {{ shift: boolean, ctrl: boolean, alt: boolean, meta: boolean }} modState
     * @param {object|null} scancodeLib
     * @returns {boolean}
     */
    shouldUseMapScancode(code, keyboardMode, peerPlatform, modState, scancodeLib) {
        if (keyboardMode === 'Legacy') return false;
        if (keyboardMode === 'Map') return true;

        const platform = (peerPlatform || '').toLowerCase();
        if (platform !== 'windows') return false;

        if (this.isLetterCode(code)) return true;
        if (this.KEY_MAP[code]) return true;

        const scLib = this._getScancodeLib(scancodeLib);
        if (modState.shift || modState.ctrl || modState.alt || modState.meta) {
            return scLib?.codeToScancode(code, peerPlatform) != null;
        }
        return false;
    },

    /**
     * @param {Iterable<string>} pressedCodes
     * @returns {{ shift: boolean, ctrl: boolean, alt: boolean, meta: boolean }}
     */
    modifierStateFromPressed(pressedCodes) {
        const set = pressedCodes instanceof Set ? pressedCodes : new Set(pressedCodes);
        return {
            shift: set.has('ShiftLeft') || set.has('ShiftRight'),
            ctrl: set.has('ControlLeft') || set.has('ControlRight'),
            alt: set.has('AltLeft') || set.has('AltRight'),
            meta: set.has('MetaLeft') || set.has('MetaRight'),
        };
    },

    /**
     * Port client::legacy_modifiers — exclude self-referential control keys.
     * @param {string} code
     * @param {{ shift: boolean, ctrl: boolean, alt: boolean, meta: boolean }} modState
     * @returns {number[]}
     */
    legacyModifiers(code, modState) {
        const mods = [];
        if (modState.alt && code !== 'AltLeft' && code !== 'AltRight') {
            mods.push(this.MOD_ALT);
        }
        if (modState.shift && code !== 'ShiftLeft' && code !== 'ShiftRight') {
            mods.push(this.MOD_SHIFT);
        }
        if (modState.ctrl && code !== 'ControlLeft' && code !== 'ControlRight') {
            mods.push(this.MOD_CTRL);
        }
        if (modState.meta && code !== 'MetaLeft' && code !== 'MetaRight') {
            mods.push(this.MOD_META);
        }
        return mods;
    },

    /**
     * Port add_lock_modes_modifiers (Caps/Num only).
     * @param {string} code
     * @param {KeyboardEvent|null} e
     * @returns {number[]}
     */
    lockModeModifiers(code, e) {
        const mods = [];
        if (!e || typeof e.getModifierState !== 'function') return mods;
        if (this.isLetterCode(code) && e.getModifierState('CapsLock')) {
            mods.push(this.MOD_CAPS_LOCK);
        }
        if (this.isNumpadCode(code) && e.getModifierState('NumLock')) {
            mods.push(this.MOD_NUM_LOCK);
        }
        return mods;
    },

    /**
     * Apply Shift XOR CapsLock case for Legacy ASCII letters (matches RustDesk client).
     * @param {KeyboardEvent|null} e
     * @returns {string}
     */
    resolveLegacyLetterCase(e) {
        const key = e?.key;
        if (!key || key.length !== 1 || !this.isLetterCode(e.code)) return key || '';
        const cp = key.codePointAt(0);
        if (cp === undefined || cp < 0x41 || cp > 0x7A) return key;
        if (cp > 0x5A && cp < 0x61) return key;

        const caps = typeof e.getModifierState === 'function' &&
            e.getModifierState('CapsLock');
        const upper = e.shiftKey !== caps;
        if (upper) {
            return String.fromCodePoint(cp <= 0x5A ? cp : cp - 32);
        }
        return String.fromCodePoint(cp >= 0x61 ? cp : cp + 32);
    },

    /**
     * Legacy chr already encodes Shift/Caps; strip them unless Ctrl/Alt/Meta hotkey.
     * @param {number[]} mods
     * @param {KeyboardEvent|null} e
     * @returns {number[]}
     */
    stripResolvedCharModifiers(mods, e) {
        if (!e || e.ctrlKey || e.altKey || e.metaKey) return mods;
        return mods.filter((m) => m !== this.MOD_SHIFT && m !== this.MOD_CAPS_LOCK);
    },

    /**
     * @param {string} code
     * @param {string} key
     * @param {KeyboardEvent|null} e
     * @returns {number|null}
     */
    legacyCharCodePoint(code, key, e) {
        if (this.isLetterCode(code) && e) {
            const resolved = this.resolveLegacyLetterCase(e);
            if (resolved && resolved.length === 1) {
                return resolved.codePointAt(0);
            }
        }
        const mapped = this.LEGACY_CHAR_MAP[code];
        if (mapped) return mapped.codePointAt(0);
        if (!key || key.length === 0 || key === 'Unidentified' || key === 'Dead') {
            return null;
        }
        return key.codePointAt(0) ?? null;
    },

    /**
     * AltGr on Windows appears as Ctrl+Alt; for printable Legacy chr omit Ctrl+Alt.
     * @param {string} code
     * @param {KeyboardEvent|null} e
     * @param {number[]} mods
     * @returns {number[]}
     */
    applyAltGrLegacyFilter(code, e, mods) {
        if (this.KEY_MAP[code]) return mods;
        const altGraph = e && typeof e.getModifierState === 'function' &&
            e.getModifierState('AltGraph');
        if (!altGraph) return mods;
        return mods.filter((m) => m !== this.MOD_CTRL && m !== this.MOD_ALT);
    },

    _getScancodeLib(scancodeLib) {
        if (scancodeLib) return scancodeLib;
        if (typeof RDKeyboardScancode !== 'undefined') return RDKeyboardScancode;
        if (typeof window !== 'undefined' && window.RDKeyboardScancode) {
            return window.RDKeyboardScancode;
        }
        return null;
    },

    /**
     * Build zero or one RustDesk keyEvent payload.
     * @param {object} opts
     * @param {string} opts.code
     * @param {string} opts.key
     * @param {boolean} opts.down
     * @param {boolean} opts.press
     * @param {KeyboardEvent|null} [opts.e]
     * @param {'Legacy'|'Map'|'Auto'} opts.keyboardMode
     * @param {string} [opts.peerPlatform]
     * @param {Set<string>|Iterable<string>} opts.pressedCodes
     * @param {object|null} [opts.scancodeLib]
     * @returns {object|null}
     */
    encodeKeyEvent(opts) {
        const {
            code,
            key,
            down,
            press,
            e = null,
            keyboardMode,
            peerPlatform = '',
            pressedCodes,
            scancodeLib = null,
        } = opts;

        const modState = this.modifierStateFromPressed(pressedCodes);
        const scLib = this._getScancodeLib(scancodeLib);
        const controlKey = this.KEY_MAP[code];
        const useMap = this.shouldUseMapScancode(
            code, keyboardMode, peerPlatform, modState, scLib
        );

        if (this.SILENT_LOCK_CODES.includes(code)) {
            return null;
        }

        if (useMap) {
            const sc = scLib?.codeToScancode(code, peerPlatform);
            if (sc != null) {
                return {
                    chr: sc,
                    down,
                    press,
                    modifiers: this.lockModeModifiers(code, e),
                    mode: 'Map',
                };
            }
            if (controlKey) {
                let modifiers = this.legacyModifiers(code, modState);
                modifiers = modifiers.concat(this.lockModeModifiers(code, e));
                return {
                    controlKey,
                    down,
                    press,
                    modifiers,
                    mode: 'Legacy',
                };
            }
        }

        if (controlKey) {
            let modifiers = this.legacyModifiers(code, modState);
            modifiers = modifiers.concat(this.lockModeModifiers(code, e));
            return {
                controlKey,
                down,
                press,
                modifiers,
                mode: 'Legacy',
            };
        }

        const chr = this.legacyCharCodePoint(code, key, e);
        if (chr == null) return null;

        let modifiers = this.legacyModifiers(code, modState);
        modifiers = modifiers.concat(this.lockModeModifiers(code, e));
        modifiers = this.applyAltGrLegacyFilter(code, e, modifiers);
        modifiers = this.stripResolvedCharModifiers(modifiers, e);

        return {
            chr,
            down,
            press,
            modifiers,
            mode: 'Legacy',
        };
    },

    /**
     * Build modifier keyup events for toolbar recovery.
     * @param {object|null} scancodeLib
     * @param {'Legacy'|'Map'|'Auto'} keyboardMode
     * @param {string} [peerPlatform]
     * @returns {object[]}
     */
    buildModifierReleaseEvents(scancodeLib, keyboardMode, peerPlatform = '') {
        const lib = this._getScancodeLib(scancodeLib);
        const codes = lib?.MODIFIER_CODES || [
            'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
            'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
        ];
        const platform = (peerPlatform || '').toLowerCase();
        const useMapRelease = keyboardMode === 'Map' ||
            (keyboardMode === 'Auto' && platform === 'windows');

        const events = [];
        for (const code of codes) {
            if (useMapRelease) {
                const sc = lib?.codeToScancode(code, peerPlatform);
                if (sc != null) {
                    events.push({
                        chr: sc,
                        down: false,
                        press: false,
                        modifiers: [],
                        mode: 'Map',
                    });
                    continue;
                }
            }
            const ck = this.KEY_MAP[code];
            if (ck) {
                events.push({
                    controlKey: ck,
                    down: false,
                    press: false,
                    modifiers: [],
                    mode: 'Legacy',
                });
            }
        }
        return events;
    },
};

window.RDKeyboardEncoder = RDKeyboardEncoder;
