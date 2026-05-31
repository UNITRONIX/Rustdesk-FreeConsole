/**
 * BetterDesk Web Remote Client - Input Manager
 * Captures keyboard and mouse events and converts them to RustDesk protocol messages
 */

/* global RDProtocol */

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
        /** @type {Set<string>} Currently pressed keys */
        this.pressedKeys = new Set();
        /** @type {number} Mouse button state bitmask */
        this.buttonMask = 0;

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

        const c = this.canvas;
        c.removeEventListener('mousemove', this._onMouseMove);
        c.removeEventListener('mousedown', this._onMouseDown);
        c.removeEventListener('mouseup', this._onMouseUp);
        c.removeEventListener('wheel', this._onWheel);
        c.removeEventListener('contextmenu', this._onContextMenu);

        document.removeEventListener('keydown', this._onKeyDown);
        document.removeEventListener('keyup', this._onKeyUp);
        document.removeEventListener('pointerlockchange', this._onPointerLockChange);

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
     * Scroll directions (encoded in button bits for wheel type):
     *   0 = up, 1 = down, 2 = right, 3 = left
     *
     * Examples:
     *   move          = 0
     *   left down     = 1 | (1 << 3) = 9
     *   left up       = 2 | (1 << 3) = 10
     *   right down    = 1 | (2 << 3) = 17
     *   right up      = 2 | (2 << 3) = 18
     *   middle down   = 1 | (4 << 3) = 33
     *   middle up     = 2 | (4 << 3) = 34
     *   scroll up     = 3 | (0 << 3) = 3
     *   scroll down   = 3 | (1 << 3) = 11
     */
    static MOUSE_TYPE_DOWN  = 1;
    static MOUSE_TYPE_UP    = 2;
    static MOUSE_TYPE_WHEEL = 3;

    static MOUSE_BUTTON_LEFT   = 1;
    static MOUSE_BUTTON_RIGHT  = 2;
    static MOUSE_BUTTON_MIDDLE = 4;

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

        const pos = this._getRemotePosition(e);
        if (!pos) return;

        // Scroll direction encoded in button bits: 0=up, 1=down, 2=right, 3=left
        let direction = -1;
        if (e.deltaY < 0) direction = 0;        // Scroll up
        else if (e.deltaY > 0) direction = 1;   // Scroll down
        else if (e.deltaX > 0) direction = 2;   // Scroll right
        else if (e.deltaX < 0) direction = 3;   // Scroll left

        if (direction >= 0) {
            const mask = RDInput.MOUSE_TYPE_WHEEL | (direction << 3);
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
        this.pressedKeys.add(keyCode);

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

    /**
     * Build and dispatch a single RustDesk Legacy key event.
     * @param {KeyboardEvent} e
     * @param {boolean} down  - key is pressed down
     * @param {boolean} press - key click (down+up), used for repeats
     */
    _sendKey(e, down, press) {
        const controlKey = RDInput.KEY_MAP[e.code];

        if (controlKey) {
            // Special / navigation / modifier key
            this.sendMessage({
                keyEvent: {
                    controlKey: controlKey,
                    down: down,
                    press: press,
                    modifiers: this._getKeyModifiers(e, false),
                    mode: 'Legacy'
                }
            });
            return;
        }

        // Character key — forward the produced character so layout-specific and
        // accented glyphs (ą, ę, ü, etc.) resolve correctly on the remote side.
        const key = e.key;
        if (!key || key.length === 0 || key === 'Unidentified' || key === 'Dead') return;

        const codePoint = key.codePointAt(0);
        if (codePoint === undefined) return;

        this.sendMessage({
            keyEvent: {
                chr: codePoint,
                down: down,
                press: press,
                modifiers: this._getKeyModifiers(e, true),
                mode: 'Legacy'
            }
        });
    }

    // ---- Helpers ----

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
        // Values must match ControlKey enum in message.proto:
        // Alt=1, Control=4, Meta=23, Shift=29
        const mods = [];
        if (e.shiftKey) mods.push(29);  // ControlKey.Shift
        if (e.ctrlKey) mods.push(4);    // ControlKey.Control
        if (e.altKey) mods.push(1);     // ControlKey.Alt
        if (e.metaKey) mods.push(23);   // ControlKey.Meta
        return mods;
    }

    /**
     * Get keyboard modifier flags
     * @param {KeyboardEvent} e
     * @param {boolean} [isChar=false] - true for printable-character events
     * @returns {number[]}
     */
    _getKeyModifiers(e, isChar) {
        // Values must match ControlKey enum in message.proto:
        // Alt=1, Control=4, Meta=23, Shift=29
        const mods = [];
        if (e.shiftKey) mods.push(29); // ControlKey.Shift

        // AltGr (Right Alt) is reported on Windows as a phantom Ctrl+Alt
        // combination. When AltGr produced a printable character the produced
        // glyph already encodes it, so forwarding Ctrl+Alt makes the remote
        // side treat it as a hotkey instead of typing the character.
        const altGraph = typeof e.getModifierState === 'function' &&
            e.getModifierState('AltGraph');
        if (isChar && altGraph) {
            return mods;
        }

        if (e.ctrlKey) mods.push(4);  // ControlKey.Control
        if (e.altKey) mods.push(1);   // ControlKey.Alt
        if (e.metaKey) mods.push(23); // ControlKey.Meta
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
