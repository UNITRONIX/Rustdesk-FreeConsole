/**
 * BetterDesk Web Remote Client - Input Manager
 * Captures keyboard and mouse events and converts them to RustDesk protocol messages
 */

/* global RDProtocol, RDKeyboardScancode */

// eslint-disable-next-line no-unused-vars
class RDInput {
    /**
     * @param {HTMLCanvasElement} canvas - The canvas element to capture events from
     * @param {RDRenderer} renderer - Renderer for coordinate mapping
     * @param {Function} sendMessage - Callback to send protocol messages
     */
    constructor(canvas, renderer, sendMessage) {
        /** @type {HTMLCanvasElement} */
        this.canvas = canvas;
        /** @type {RDRenderer} */
        this.renderer = renderer;
        /** @type {Function} */
        this.sendMessage = sendMessage;

        /** @type {boolean} */
        this.enabled = false;
        /** @type {boolean} Pointer lock active */
        this.pointerLocked = false;
        /** @type {Map<string, { key: string }>} Currently pressed keys (code → metadata) */
        this.pressedKeys = new Map();
        /** @type {number} Mouse button state bitmask */
        this.buttonMask = 0;

        /** @type {string} PeerInfo.platform for Map-mode scancode target */
        this.peerPlatform = '';
        /**
         * Keyboard wire mode: 'Legacy' | 'Map' | 'Auto'.
         * Auto uses Map for Windows peers (Hyper-V / VM console), Legacy otherwise.
         * @type {'Legacy'|'Map'|'Auto'}
         */
        this.keyboardMode = 'Auto';

        // Mouse move throttling (~60 Hz for smoother remote control)
        this._lastMouseSendTime = 0;
        this._mouseThrottleMs = 16;

        // Bound event handlers (for removal)
        this._onMouseMove = this._handleMouseMove.bind(this);
        this._onMouseDown = this._handleMouseDown.bind(this);
        this._onMouseUp = this._handleMouseUp.bind(this);
        this._onWheel = this._handleWheel.bind(this);
        this._onKeyDown = this._handleKeyDown.bind(this);
        this._onKeyUp = this._handleKeyUp.bind(this);
        this._onContextMenu = (e) => e.preventDefault();
        this._onPointerLockChange = this._handlePointerLockChange.bind(this);
        this._onWindowBlur = this._handleWindowBlur.bind(this);
        this._onVisibilityChange = this._handleVisibilityChange.bind(this);
    }

    /**
     * @param {string} platform - PeerInfo.platform from login response
     */
    setPeerPlatform(platform) {
        this.peerPlatform = platform || '';
    }

    /**
     * @param {'Legacy'|'Map'|'Auto'} mode
     */
    setKeyboardMode(mode) {
        const allowed = ['Legacy', 'Map', 'Auto'];
        this.keyboardMode = allowed.includes(mode) ? mode : 'Auto';
    }

    /**
     * Release all keys held on the remote side (toolbar / recovery).
     */
    resetKeyboard() {
        this._releaseAllKeys(true);
    }

    /**
     * Start capturing input events
     */
    start() {
        if (this.enabled) return;

        const c = this.canvas;
        c.addEventListener('mousemove', this._onMouseMove);
        c.addEventListener('mousedown', this._onMouseDown);
        c.addEventListener('mouseup', this._onMouseUp);
        c.addEventListener('wheel', this._onWheel, { passive: false });
        c.addEventListener('contextmenu', this._onContextMenu);

        // Keyboard events on document (canvas needs focus for key events)
        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('keyup', this._onKeyUp);

        // Pointer Lock change detection
        document.addEventListener('pointerlockchange', this._onPointerLockChange);

        // Release remote keys when the operator loses focus (prevents sticky modifiers)
        window.addEventListener('blur', this._onWindowBlur);
        document.addEventListener('visibilitychange', this._onVisibilityChange);

        // Make canvas focusable
        c.tabIndex = 0;
        c.focus();

        this.enabled = true;
    }

    /**
     * Stop capturing input events
     */
    stop() {
        if (!this.enabled) return;

        // Notify remote before detaching listeners (tracked keys only)
        this._releaseAllKeys(false);

        const c = this.canvas;
        c.removeEventListener('mousemove', this._onMouseMove);
        c.removeEventListener('mousedown', this._onMouseDown);
        c.removeEventListener('mouseup', this._onMouseUp);
        c.removeEventListener('wheel', this._onWheel);
        c.removeEventListener('contextmenu', this._onContextMenu);

        document.removeEventListener('keydown', this._onKeyDown);
        document.removeEventListener('keyup', this._onKeyUp);
        document.removeEventListener('pointerlockchange', this._onPointerLockChange);
        window.removeEventListener('blur', this._onWindowBlur);
        document.removeEventListener('visibilitychange', this._onVisibilityChange);

        if (this.pointerLocked) {
            document.exitPointerLock();
        }

        this.pressedKeys.clear();
        this.buttonMask = 0;
        this.enabled = false;
    }

    /**
     * Request pointer lock for better mouse capture
     */
    requestPointerLock() {
        this.canvas.requestPointerLock();
    }

    /**
     * Release pointer lock
     */
    exitPointerLock() {
        if (this.pointerLocked) {
            document.exitPointerLock();
        }
    }

    // ---- Mouse Event Handlers ----

    /**
     * RustDesk mouse event mask encoding:
     *   mask = EVENT_TYPE | (BUTTON << 3)
     *
     * Event types (bits 0-2):
     *   0 = move, 1 = down, 2 = up, 3 = wheel
     *
     * Button IDs (bits 3+):
     *   1 = left, 2 = right, 4 = middle, 8 = back, 16 = forward
     *
     * Wheel events (type 3): x/y carry scroll delta, not cursor position.
     * Match RustDesk Flutter client — normalized to -1 or 1 per axis.
     *
     * Examples:
     *   move          = 0
     *   left down     = 1 | (1 << 3) = 9
     *   left up       = 2 | (1 << 3) = 10
     *   right down    = 1 | (2 << 3) = 17
     *   right up      = 2 | (2 << 3) = 18
     *   middle down   = 1 | (4 << 3) = 33
     *   middle up     = 2 | (4 << 3) = 34
     *   scroll up     = 3, x=0, y=1
     *   scroll down   = 3, x=0, y=-1
     */
    static MOUSE_TYPE_DOWN  = 1;
    static MOUSE_TYPE_UP    = 2;
    static MOUSE_TYPE_WHEEL = 3;

    static MOUSE_BUTTON_LEFT   = 1;
    static MOUSE_BUTTON_RIGHT  = 2;
    static MOUSE_BUTTON_MIDDLE = 4;

    /** ControlKey enum values from message.proto (lock + modifier sync). */
    static MOD_ALT = 1;
    static MOD_CAPS_LOCK = 3;
    static MOD_CTRL = 4;
    static MOD_META = 23;
    static MOD_SHIFT = 29;
    static MOD_NUM_LOCK = 63;

    /** @param {string} code */
    static isLetterCode(code) {
        return /^Key[A-Z]$/.test(code);
    }

    /** @param {string} code */
    static isNumpadCode(code) {
        return /^Numpad/.test(code);
    }

    _handleMouseMove(e) {
        if (!this.enabled) return;

        // Throttle mouse moves to reduce bandwidth and improve responsiveness
        const now = performance.now();
        if (now - this._lastMouseSendTime < this._mouseThrottleMs) return;
        this._lastMouseSendTime = now;

        const pos = this._getRemotePosition(e);
        if (!pos) return;

        // Mouse move = mask 0
        this.sendMessage({
            mouseEvent: {
                mask: 0,
                x: pos.x,
                y: pos.y,
                modifiers: this._getModifiers(e)
            }
        });
    }

    _handleMouseDown(e) {
        if (!this.enabled) return;
        e.preventDefault();

        // Focus canvas for keyboard events
        this.canvas.focus();

        const pos = this._getRemotePosition(e);
        if (!pos) return;

        let button = 0;
        switch (e.button) {
        case 0: button = RDInput.MOUSE_BUTTON_LEFT; break;
        case 1: button = RDInput.MOUSE_BUTTON_MIDDLE; break;
        case 2: button = RDInput.MOUSE_BUTTON_RIGHT; break;
        }

        if (button) {
            const mask = RDInput.MOUSE_TYPE_DOWN | (button << 3);
            this.buttonMask |= button;
            this.sendMessage({
                mouseEvent: {
                    mask: mask,
                    x: pos.x,
                    y: pos.y,
                    modifiers: this._getModifiers(e)
                }
            });
        }
    }

    _handleMouseUp(e) {
        if (!this.enabled) return;
        e.preventDefault();

        const pos = this._getRemotePosition(e);
        if (!pos) return;

        let button = 0;
        switch (e.button) {
        case 0: button = RDInput.MOUSE_BUTTON_LEFT; break;
        case 1: button = RDInput.MOUSE_BUTTON_MIDDLE; break;
        case 2: button = RDInput.MOUSE_BUTTON_RIGHT; break;
        }

        if (button) {
            const mask = RDInput.MOUSE_TYPE_UP | (button << 3);
            this.buttonMask &= ~button;
            this.sendMessage({
                mouseEvent: {
                    mask: mask,
                    x: pos.x,
                    y: pos.y,
                    modifiers: this._getModifiers(e)
                }
            });
        }
    }

    _handleWheel(e) {
        if (!this.enabled) return;
        e.preventDefault();

        const delta = this._normalizeWheelDelta(e);
        if (!delta) return;

        this.sendMessage({
            mouseEvent: {
                mask: RDInput.MOUSE_TYPE_WHEEL,
                x: delta.dx,
                y: delta.dy,
                modifiers: this._getModifiers(e)
            }
        });
    }

    // ---- Keyboard Event Handlers ----

    /**
     * Map browser key code to RustDesk ControlKey enum value
     */
    static KEY_MAP = {
        'Escape': 'Escape',
        'Backspace': 'Backspace',
        'Tab': 'Tab',
        'Enter': 'Return',
        'ShiftLeft': 'Shift',
        'ShiftRight': 'RShift',
        'ControlLeft': 'Control',
        'ControlRight': 'RControl',
        'AltLeft': 'Alt',
        'AltRight': 'RAlt',
        'MetaLeft': 'Meta',
        'MetaRight': 'RWin',
        'Pause': 'Pause',
        'CapsLock': 'CapsLock',
        'Space': 'Space',
        'PageUp': 'PageUp',
        'PageDown': 'PageDown',
        'End': 'End',
        'Home': 'Home',
        'ArrowLeft': 'LeftArrow',
        'ArrowUp': 'UpArrow',
        'ArrowRight': 'RightArrow',
        'ArrowDown': 'DownArrow',
        'PrintScreen': 'Snapshot',
        'Insert': 'Insert',
        'Delete': 'Delete',
        'ScrollLock': 'Scroll',
        'NumLock': 'NumLock',
        'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4',
        'F5': 'F5', 'F6': 'F6', 'F7': 'F7', 'F8': 'F8',
        'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
        'Numpad0': 'Numpad0', 'Numpad1': 'Numpad1', 'Numpad2': 'Numpad2',
        'Numpad3': 'Numpad3', 'Numpad4': 'Numpad4', 'Numpad5': 'Numpad5',
        'Numpad6': 'Numpad6', 'Numpad7': 'Numpad7', 'Numpad8': 'Numpad8',
        'Numpad9': 'Numpad9',
        'NumpadMultiply': 'Multiply',
        'NumpadAdd': 'Add',
        'NumpadSubtract': 'Subtract',
        'NumpadDecimal': 'Decimal',
        'NumpadDivide': 'Divide',
        'NumpadEnter': 'NumpadEnter',
        'ContextMenu': 'Apps',
        'AudioVolumeMute': 'VolumeMute',
        'AudioVolumeDown': 'VolumeDown',
        'AudioVolumeUp': 'VolumeUp'
    };

    _handleKeyDown(e) {
        if (!this.enabled) return;
        // Don't capture if focus is on an input element
        if (this._isInputFocused()) return;

        e.preventDefault();
        e.stopPropagation();

        const keyCode = e.code;
        // RustDesk legacy mode: keydown => down, key repeat => press (click).
        // Repeat is reported either via e.repeat or our own pressedKeys guard.
        const isRepeat = e.repeat || this.pressedKeys.has(keyCode);
        this.pressedKeys.set(keyCode, { key: e.key });

        if (isRepeat) {
            this._sendKey(e, false, true);
        } else {
            this._sendKey(e, true, false);
        }
    }

    _handleKeyUp(e) {
        if (!this.enabled) return;
        if (this._isInputFocused()) return;

        e.preventDefault();
        e.stopPropagation();

        this.pressedKeys.delete(e.code);
        this._sendKey(e, false, false);
    }

    _handleWindowBlur() {
        if (this.enabled) {
            this._releaseAllKeys(false);
        }
    }

    _handleVisibilityChange() {
        if (this.enabled && typeof document !== 'undefined' &&
            document.visibilityState === 'hidden') {
            this._releaseAllKeys(false);
        }
    }

    /**
     * Send keyup for every locally tracked key.
     * @param {boolean} [forceAllModifiers=false] - release all modifiers (toolbar recovery only)
     */
    _releaseAllKeys(forceAllModifiers) {
        const codes = [...this.pressedKeys.keys()];
        for (const code of codes) {
            const meta = this.pressedKeys.get(code);
            this._sendKeyForCode(code, meta?.key || '', false, false, []);
        }
        this.pressedKeys.clear();

        if (forceAllModifiers) {
            this._releaseAllModifiers();
        }
    }

    /** Release Shift/Ctrl/Alt/Meta on the remote side even if keyup was missed. */
    _releaseAllModifiers() {
        const mode = this._resolveKeyboardMode();
        const modCodes = this._getScancodeLib()?.MODIFIER_CODES ||
            ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
                'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];

        for (const code of modCodes) {
            if (mode === 'Map') {
                const scLib = this._getScancodeLib();
                const sc = scLib?.codeToScancode(code, this.peerPlatform);
                if (sc != null) {
                    this.sendMessage({
                        keyEvent: {
                            chr: sc,
                            down: false,
                            press: false,
                            modifiers: [],
                            mode: 'Map'
                        }
                    });
                    continue;
                }
            }
            const controlKey = RDInput.KEY_MAP[code];
            if (controlKey) {
                this.sendMessage({
                    keyEvent: {
                        controlKey: controlKey,
                        down: false,
                        press: false,
                        modifiers: [],
                        mode: 'Legacy'
                    }
                });
            }
        }
    }

    /**
     * @returns {typeof RDKeyboardScancode|null}
     */
    _getScancodeLib() {
        if (typeof RDKeyboardScancode !== 'undefined') return RDKeyboardScancode;
        if (typeof window !== 'undefined' && window.RDKeyboardScancode) {
            return window.RDKeyboardScancode;
        }
        return null;
    }

    /**
     * Map (scancode) is only used for letter keys — digits and punctuation use
     * Legacy chr so Shift+7, AltGr, PL layout symbols resolve correctly.
     * @param {string} code
     * @returns {boolean}
     */
    _shouldUseMapScancode(code) {
        return this._resolveKeyboardMode() === 'Map' && RDInput.isLetterCode(code);
    }

    /**
     * Legacy chr already encodes Shift/Caps; strip them unless Ctrl/Alt/Meta hotkey.
     * @param {number[]} mods
     * @param {KeyboardEvent} e
     * @returns {number[]}
     */
    _stripResolvedCharModifiers(mods, e) {
        if (e.ctrlKey || e.altKey || e.metaKey) return mods;
        return mods.filter((m) =>
            m !== RDInput.MOD_SHIFT && m !== RDInput.MOD_CAPS_LOCK
        );
    }

    /**
     * @returns {'Legacy'|'Map'}
     */
    _resolveKeyboardMode() {
        if (this.keyboardMode === 'Map') return 'Map';
        if (this.keyboardMode === 'Legacy') return 'Legacy';
        // Auto: Map for Windows peers (Hyper-V / VM console scancode path)
        const platform = (this.peerPlatform || '').toLowerCase();
        if (platform === 'windows') return 'Map';
        return 'Legacy';
    }

    /**
     * Build and dispatch a single RustDesk key event from a KeyboardEvent.
     * @param {KeyboardEvent} e
     * @param {boolean} down  - key is pressed down
     * @param {boolean} press - key click (down+up), used for repeats
     */
    _sendKey(e, down, press) {
        const isChar = !RDInput.KEY_MAP[e.code];
        let mods = this._getKeyModifiers(e, isChar);
        let key = e.key;
        const useMap = isChar && this._shouldUseMapScancode(e.code);

        if (isChar && !useMap) {
            if (RDInput.isLetterCode(e.code)) {
                key = this._resolveLegacyLetterCase(e);
            }
            mods = this._stripResolvedCharModifiers(mods, e);
        }

        this._sendKeyForCode(e.code, key, down, press, mods, useMap);
    }

    /**
     * Build and dispatch a key event from code/key strings (used for synthetic keyup).
     * @param {string} code
     * @param {string} key
     * @param {boolean} down
     * @param {boolean} press
     * @param {number[]} modifiers
     * @param {boolean} [useMap=false]
     */
    _sendKeyForCode(code, key, down, press, modifiers, useMap) {
        const controlKey = RDInput.KEY_MAP[code];

        // Navigation, modifiers, and lock keys always use Legacy controlKey —
        // Map scancode path breaks reliable Shift/Caps/NumLock handling on Windows.
        if (controlKey) {
            this.sendMessage({
                keyEvent: {
                    controlKey: controlKey,
                    down: down,
                    press: press,
                    modifiers: modifiers,
                    mode: 'Legacy'
                }
            });
            return;
        }

        if (useMap) {
            const scLib = this._getScancodeLib();
            const sc = scLib?.codeToScancode(code, this.peerPlatform);
            if (sc != null) {
                this.sendMessage({
                    keyEvent: {
                        chr: sc,
                        down: down,
                        press: press,
                        modifiers: modifiers,
                        mode: 'Map'
                    }
                });
                return;
            }
        }

        // Character key — forward the produced character so layout-specific and
        // accented glyphs (ą, ę, ü, etc.) resolve correctly on the remote side.
        if (!key || key.length === 0 || key === 'Unidentified' || key === 'Dead') return;

        const codePoint = key.codePointAt(0);
        if (codePoint === undefined) return;

        this.sendMessage({
            keyEvent: {
                chr: codePoint,
                down: down,
                press: press,
                modifiers: modifiers,
                mode: 'Legacy'
            }
        });
    }

    // ---- Helpers ----

    /**
     * Convert a browser WheelEvent into RustDesk scroll deltas.
     * Peers interpret x/y as scroll amount when mask type is wheel (3).
     * @param {WheelEvent} e
     * @returns {{ dx: number, dy: number }|null}
     */
    _normalizeWheelDelta(e) {
        let rawDx = e.deltaX;
        let rawDy = e.deltaY;

        // Shift+wheel often maps vertical motion to horizontal scrolling.
        if (e.shiftKey && rawDy !== 0 && rawDx === 0) {
            rawDx = rawDy;
            rawDy = 0;
        }

        if (rawDx === 0 && rawDy === 0) return null;

        let dx = 0;
        let dy = 0;
        if (Math.abs(rawDx) > Math.abs(rawDy)) {
            dx = rawDx > 0 ? -1 : 1;
        } else if (rawDy !== 0) {
            dy = rawDy > 0 ? -1 : 1;
        }

        if (dx === 0 && dy === 0) return null;
        return { dx, dy };
    }

    _handlePointerLockChange() {
        this.pointerLocked = document.pointerLockElement === this.canvas;
    }

    /**
     * Get remote coordinates from mouse event
     * @param {MouseEvent} e
     * @returns {{ x: number, y: number }|null}
     */
    _getRemotePosition(e) {
        const rect = this.canvas.getBoundingClientRect();
        const canvasX = e.clientX - rect.left;
        const canvasY = e.clientY - rect.top;

        const pos = this.renderer.canvasToRemote(canvasX, canvasY);

        // Clamp to remote display bounds
        if (pos.x < 0 || pos.y < 0 ||
            pos.x > this.renderer.remoteWidth ||
            pos.y > this.renderer.remoteHeight) {
            return null;
        }

        return pos;
    }

    /**
     * Get mouse modifier flags
     * @param {MouseEvent} e
     * @returns {number[]}
     */
    _getModifiers(e) {
        const mods = [];
        if (e.shiftKey) mods.push(RDInput.MOD_SHIFT);
        if (e.ctrlKey) mods.push(RDInput.MOD_CTRL);
        if (e.altKey) mods.push(RDInput.MOD_ALT);
        if (e.metaKey) mods.push(RDInput.MOD_META);
        return mods;
    }

    /**
     * Apply Shift XOR CapsLock case for Legacy ASCII letters (matches RustDesk client).
     * @param {KeyboardEvent} e
     * @returns {string}
     */
    _resolveLegacyLetterCase(e) {
        const key = e.key;
        if (!key || key.length !== 1 || !RDInput.isLetterCode(e.code)) return key;
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
    }

    /**
     * Get keyboard modifier flags
     * @param {KeyboardEvent} e
     * @param {boolean} [isChar=false] - true for printable-character events
     * @returns {number[]}
     */
    _getKeyModifiers(e, isChar) {
        // Values must match ControlKey enum in message.proto:
        // Alt=1, CapsLock=3, Control=4, Meta=23, Shift=29, NumLock=63
        const mods = [];
        if (e.shiftKey) mods.push(RDInput.MOD_SHIFT);

        // AltGr (Right Alt) is reported on Windows as a phantom Ctrl+Alt
        // combination. When AltGr produced a printable character the produced
        // glyph already encodes it, so forwarding Ctrl+Alt makes the remote
        // side treat it as a hotkey instead of typing the character.
        const altGraph = typeof e.getModifierState === 'function' &&
            e.getModifierState('AltGraph');
        if (isChar && altGraph) {
            return mods;
        }

        if (e.ctrlKey) mods.push(RDInput.MOD_CTRL);
        if (e.altKey) mods.push(RDInput.MOD_ALT);
        if (e.metaKey) mods.push(RDInput.MOD_META);

        // RustDesk LockModesHandler: sync remote Caps/Num lock from modifier flags
        // on letter / numpad events (required for Map scancode path and chr fallback).
        if (typeof e.getModifierState === 'function') {
            if (isChar && RDInput.isLetterCode(e.code) &&
                e.getModifierState('CapsLock')) {
                mods.push(RDInput.MOD_CAPS_LOCK);
            }
            if (RDInput.isNumpadCode(e.code) && e.getModifierState('NumLock')) {
                mods.push(RDInput.MOD_NUM_LOCK);
            }
        }

        return mods;
    }

    /**
     * Check if a visible input-like element has focus (not the remote canvas)
     * @returns {boolean}
     */
    _isInputFocused() {
        const el = document.activeElement;
        if (!el) return false;
        const tag = el.tagName?.toLowerCase();
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return false;
        // Ignore hidden inputs (e.g. password field after login)
        if (el.type === 'hidden' || el.offsetParent === null) return false;
        return true;
    }

    /**
     * Close and release all resources
     */
    close() {
        this.stop();
    }
}

window.RDInput = RDInput;
