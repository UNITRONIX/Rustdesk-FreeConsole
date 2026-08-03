/**
 * BetterDesk Web Remote Client - Input Manager
 * Captures keyboard and mouse events and converts them to RustDesk protocol messages
 */

/* global RDProtocol, RDKeyboardScancode, RDKeyboardEncoder */

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

        /** @type {string} PeerInfo.platform for Map-mode scancode target */
        this.peerPlatform = '';
        /**
         * Keyboard wire mode: 'Legacy' | 'Map' | 'Auto'.
         * Auto resolves to Map (RustDesk native default).
         * @type {'Legacy'|'Map'|'Auto'}
         */
        this.keyboardMode = 'Auto';

        this._lastMouseSendTime = 0;
        this._mouseThrottleMs = 16;

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
     * Synthesize a Ctrl+V key combo on the remote side (used to auto-complete
     * a Cliprdr file paste right after a native drag-drop registers the
     * files, so the operator doesn't have to press Ctrl+V manually).
     */
    sendCtrlV() {
        this.pressedKeys.set('ControlLeft', { key: 'Control' });
        this._sendKeyForCode('ControlLeft', 'Control', true, false, null);
        this.pressedKeys.set('KeyV', { key: 'v' });
        this._sendKeyForCode('KeyV', 'v', true, false, null);
        this.pressedKeys.delete('KeyV');
        this._sendKeyForCode('KeyV', 'v', false, false, null);
        this.pressedKeys.delete('ControlLeft');
        this._sendKeyForCode('ControlLeft', 'Control', false, false, null);
    }

    start() {
        if (this.enabled) return;

        const c = this.canvas;
        c.addEventListener('mousemove', this._onMouseMove);
        c.addEventListener('mousedown', this._onMouseDown);
        c.addEventListener('mouseup', this._onMouseUp);
        c.addEventListener('wheel', this._onWheel, { passive: false });
        c.addEventListener('contextmenu', this._onContextMenu);

        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('keyup', this._onKeyUp);
        document.addEventListener('pointerlockchange', this._onPointerLockChange);
        window.addEventListener('blur', this._onWindowBlur);
        document.addEventListener('visibilitychange', this._onVisibilityChange);

        c.tabIndex = 0;
        c.focus();

        this.enabled = true;
    }

    stop() {
        if (!this.enabled) return;

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
        this.enabled = false;
    }

    requestPointerLock() {
        this.canvas.requestPointerLock();
    }

    exitPointerLock() {
        if (this.pointerLocked) {
            document.exitPointerLock();
        }
    }

    static MOUSE_TYPE_DOWN  = 1;
    static MOUSE_TYPE_UP    = 2;
    static MOUSE_TYPE_WHEEL = 3;

    static MOUSE_BUTTON_LEFT   = 1;
    static MOUSE_BUTTON_RIGHT  = 2;
    static MOUSE_BUTTON_MIDDLE = 4;

    _encoder() {
        if (typeof RDKeyboardEncoder !== 'undefined') return RDKeyboardEncoder;
        if (typeof window !== 'undefined' && window.RDKeyboardEncoder) {
            return window.RDKeyboardEncoder;
        }
        return null;
    }

    _getScancodeLib() {
        if (typeof RDKeyboardScancode !== 'undefined') return RDKeyboardScancode;
        if (typeof window !== 'undefined' && window.RDKeyboardScancode) {
            return window.RDKeyboardScancode;
        }
        return null;
    }

    _handleMouseMove(e) {
        if (!this.enabled) return;

        const now = performance.now();
        if (now - this._lastMouseSendTime < this._mouseThrottleMs) return;
        this._lastMouseSendTime = now;

        const pos = this._getRemotePosition(e);
        if (!pos) return;

        this.sendMessage({
            mouseEvent: {
                mask: 0,
                x: pos.x,
                y: pos.y,
                modifiers: this._getMouseModifiers(e)
            }
        });
    }

    _handleMouseDown(e) {
        if (!this.enabled) return;
        e.preventDefault();
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
            this.sendMessage({
                mouseEvent: {
                    mask: mask,
                    x: pos.x,
                    y: pos.y,
                    modifiers: this._getMouseModifiers(e)
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
            this.sendMessage({
                mouseEvent: {
                    mask: mask,
                    x: pos.x,
                    y: pos.y,
                    modifiers: this._getMouseModifiers(e)
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
                modifiers: this._getMouseModifiers(e)
            }
        });
    }

    _handleKeyDown(e) {
        if (!this.enabled) return;
        if (this._isInputFocused()) return;

        e.preventDefault();
        e.stopPropagation();

        const keyCode = e.code;
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

    _releaseAllKeys(forceAllModifiers) {
        const codes = [...this.pressedKeys.keys()];
        for (const code of codes) {
            const meta = this.pressedKeys.get(code);
            this._sendKeyForCode(code, meta?.key || '', false, false, null);
        }
        this.pressedKeys.clear();

        if (forceAllModifiers) {
            this._releaseAllModifiers();
        }
    }

    _releaseAllModifiers() {
        const enc = this._encoder();
        if (!enc) {
            console.error('[RDInput] RDKeyboardEncoder not loaded — cannot release modifiers');
            return;
        }
        const events = enc.buildModifierReleaseEvents(
            this._getScancodeLib(),
            this.keyboardMode,
            this.peerPlatform
        );
        for (const keyEvent of events) {
            this.sendMessage({ keyEvent });
        }
    }

    _sendKey(e, down, press) {
        this._sendKeyForCode(e.code, e.key, down, press, e);
    }

    /**
     * @param {string} code
     * @param {string} key
     * @param {boolean} down
     * @param {boolean} press
     * @param {KeyboardEvent|null} e
     */
    _sendKeyForCode(code, key, down, press, e) {
        const enc = this._encoder();
        if (!enc) {
            console.error('[RDInput] RDKeyboardEncoder not loaded — key event dropped:', code);
            return;
        }
        const scLib = this._getScancodeLib();
        if (!scLib) {
            console.error('[RDInput] RDKeyboardScancode not loaded — key event dropped:', code);
            return;
        }

        const keyEvent = enc.encodeKeyEvent({
            code,
            key,
            down,
            press,
            e,
            keyboardMode: this.keyboardMode,
            peerPlatform: this.peerPlatform,
            pressedCodes: this.pressedKeys.keys(),
            scancodeLib: scLib,
        });

        if (keyEvent) {
            this.sendMessage({ keyEvent });
        }
    }

    _normalizeWheelDelta(e) {
        let rawDx = e.deltaX;
        let rawDy = e.deltaY;

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

    _getRemotePosition(e) {
        const rect = this.canvas.getBoundingClientRect();
        const canvasX = e.clientX - rect.left;
        const canvasY = e.clientY - rect.top;

        const pos = this.renderer.canvasToRemote(canvasX, canvasY);

        if (pos.x < 0 || pos.y < 0 ||
            pos.x > this.renderer.remoteWidth ||
            pos.y > this.renderer.remoteHeight) {
            return null;
        }

        return pos;
    }

    _getMouseModifiers(e) {
        const enc = this._encoder();
        if (!enc) return [];
        const mods = [];
        if (e.shiftKey) mods.push(enc.MOD_SHIFT);
        if (e.ctrlKey) mods.push(enc.MOD_CTRL);
        if (e.altKey) mods.push(enc.MOD_ALT);
        if (e.metaKey) mods.push(enc.MOD_META);
        return mods;
    }

    _isInputFocused() {
        const el = document.activeElement;
        if (!el) return false;
        if (el.isContentEditable) return true;
        const tag = el.tagName?.toLowerCase();
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return false;
        if (el.type === 'hidden' || el.offsetParent === null) return false;
        return true;
    }

    close() {
        this.stop();
    }
}

window.RDInput = RDInput;
