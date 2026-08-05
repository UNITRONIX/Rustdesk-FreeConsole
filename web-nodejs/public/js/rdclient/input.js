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
        /** When true, mouse events are not forwarded (OLE drag-out in progress). */
        this._suppressMouse = false;
        /** @type {null|function(): void} Fired when a local drag approaches the window edge. */
        this.onPotentialFileDragOut = null;
        this._lbuttonDown = false;
        this._dragOrigin = null;
        this._dragGesture = false;
        this._dragOutNotified = false;
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
        this._onPaste = this._handlePaste.bind(this);
        this._onContextMenu = (e) => e.preventDefault();
        this._onPointerLockChange = this._handlePointerLockChange.bind(this);
        this._onWindowBlur = this._handleWindowBlur.bind(this);
        this._onVisibilityChange = this._handleVisibilityChange.bind(this);

        /**
         * Browser cannot expose CF_HDROP; text/file paste uses the DOM paste event.
         * Called with plain text after Ctrl/Cmd+V (before remote KeyV is synthesized).
         * @type {null|function(string): (void|Promise<void>)}
         */
        this.onLocalPaste = null;
        /**
         * When the OS exposes File objects on paste (Explorer → browser), upload path.
         * @type {null|function(FileList|File[]): (void|Promise<void>)}
         */
        this.onLocalPasteFiles = null;
        this._awaitingBrowserPaste = false;
        this._pasteFallbackTimer = null;
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

    /**
     * Synthesize Ctrl+C on the remote (used to convert an Explorer file drag into
     * a Cliprdr FormatList so we can start a local OLE drag-out).
     */
    sendCtrlC() {
        this.pressedKeys.set('ControlLeft', { key: 'Control' });
        this._sendKeyForCode('ControlLeft', 'Control', true, false, null);
        this.pressedKeys.set('KeyC', { key: 'c' });
        this._sendKeyForCode('KeyC', 'c', true, false, null);
        this.pressedKeys.delete('KeyC');
        this._sendKeyForCode('KeyC', 'c', false, false, null);
        this.pressedKeys.delete('ControlLeft');
        this._sendKeyForCode('ControlLeft', 'Control', false, false, null);
    }

    /**
     * Click at canvas CSS coordinates (used before Ctrl+V after a native file drop
     * so paste targets the folder/desktop under the cursor).
     * @param {number} canvasX
     * @param {number} canvasY
     */
    clickAtCanvas(canvasX, canvasY) {
        if (!this.enabled || !this.renderer) return false;
        const pos = this.renderer.canvasToRemote(canvasX, canvasY);
        if (!pos || pos.x < 0 || pos.y < 0 ||
            pos.x > this.renderer.remoteWidth ||
            pos.y > this.renderer.remoteHeight) {
            return false;
        }
        const downMask = RDInput.MOUSE_TYPE_DOWN | (RDInput.MOUSE_BUTTON_LEFT << 3);
        const upMask = RDInput.MOUSE_TYPE_UP | (RDInput.MOUSE_BUTTON_LEFT << 3);
        this.sendMessage({ mouseEvent: { mask: 0, x: pos.x, y: pos.y, modifiers: [] } });
        this.sendMessage({ mouseEvent: { mask: downMask, x: pos.x, y: pos.y, modifiers: [] } });
        this.sendMessage({ mouseEvent: { mask: upMask, x: pos.x, y: pos.y, modifiers: [] } });
        return true;
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
        // Capture phase: paste targets the focused node; keydown preventDefault
        // used to block paste entirely — Ctrl/Cmd+V is now exempt so this fires.
        document.addEventListener('paste', this._onPaste, true);
        document.addEventListener('pointerlockchange', this._onPointerLockChange);
        window.addEventListener('blur', this._onWindowBlur);
        document.addEventListener('visibilitychange', this._onVisibilityChange);

        c.tabIndex = 0;
        c.focus();

        this.enabled = true;
    }

    stop() {
        if (!this.enabled) return;

        this._clearPasteWait();
        this._releaseAllKeys(false);

        const c = this.canvas;
        c.removeEventListener('mousemove', this._onMouseMove);
        c.removeEventListener('mousedown', this._onMouseDown);
        c.removeEventListener('mouseup', this._onMouseUp);
        c.removeEventListener('wheel', this._onWheel);
        c.removeEventListener('contextmenu', this._onContextMenu);

        document.removeEventListener('keydown', this._onKeyDown);
        document.removeEventListener('keyup', this._onKeyUp);
        document.removeEventListener('paste', this._onPaste, true);
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

    /**
     * Temporarily stop forwarding mouse to the remote (used during local OLE drag-out).
     * Also restores a visible local cursor — remote overlay uses cursor:none so the
     * file icon appears stuck at the video edge even when the OS pointer can leave.
     * @param {boolean} suppressed
     */
    setMouseSuppressed(suppressed) {
        const next = !!suppressed;
        if (next === this._suppressMouse) return;
        this._suppressMouse = next;

        const panel = this.canvas && this.canvas.closest
            ? this.canvas.closest('.session-panel')
            : null;
        if (panel) {
            panel.classList.toggle('ole-drag-out', next);
        }

        if (next) {
            // End the remote's in-progress drag so its cursor stops at the edge.
            this._sendSyntheticMouseUp(RDInput.MOUSE_BUTTON_LEFT);
            if (this.canvas && typeof this.canvas.releasePointerCapture === 'function') {
                try {
                    if (this.canvas.hasPointerCapture && this._lastPointerId != null) {
                        this.canvas.releasePointerCapture(this._lastPointerId);
                    }
                } catch (_) { /* ignore */ }
            }
            if (this.pointerLocked) {
                this.exitPointerLock();
            }
        }
    }

    /**
     * @param {number} button - RDInput.MOUSE_BUTTON_*
     */
    _sendSyntheticMouseUp(button) {
        if (!this.enabled || !this.sendMessage || !button) return;
        const x = Math.max(0, Math.floor((this.renderer && this.renderer.cursorPos
            ? this.renderer.cursorPos.x
            : 0) || 0));
        const y = Math.max(0, Math.floor((this.renderer && this.renderer.cursorPos
            ? this.renderer.cursorPos.y
            : 0) || 0));
        this.sendMessage({
            mouseEvent: {
                mask: RDInput.MOUSE_TYPE_UP | (button << 3),
                x: x,
                y: y,
                modifiers: []
            }
        });
    }

    _handleMouseMove(e) {
        if (this._lbuttonDown && this._dragOrigin && !this._dragOutNotified && !this._suppressMouse) {
            const dx = e.clientX - this._dragOrigin.x;
            const dy = e.clientY - this._dragOrigin.y;
            if ((dx * dx) + (dy * dy) >= 1600) {
                this._dragGesture = true;
            }
            if (this._dragGesture && this._isFileDragOutZone(e)) {
                this._dragOutNotified = true;
                if (typeof this.onPotentialFileDragOut === 'function') {
                    try { this.onPotentialFileDragOut(); } catch (_) { /* ignore */ }
                }
            }
        }

        if (!this.enabled || this._suppressMouse) return;

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

    /**
     * True when the pointer has left the session canvas (or the OS window).
     * Do NOT treat "near inner border" as leave — that fired during normal remote
     * work near the screen edge and froze input via Ctrl+C conversion.
     */
    _isFileDragOutZone(e) {
        const rect = this._dragCanvasRect || this.canvas.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right
            || e.clientY < rect.top || e.clientY > rect.bottom) {
            return true;
        }
        const winMargin = 2;
        return e.clientX <= winMargin || e.clientY <= winMargin
            || e.clientX >= window.innerWidth - winMargin
            || e.clientY >= window.innerHeight - winMargin;
    }

    _resetDragTracking() {
        this._lbuttonDown = false;
        this._dragOrigin = null;
        this._dragCanvasRect = null;
        this._dragGesture = false;
        this._dragOutNotified = false;
    }

    _handleMouseDown(e) {
        if (!this.enabled || this._suppressMouse) return;
        e.preventDefault();
        this.canvas.focus();
        if (e.pointerId != null) this._lastPointerId = e.pointerId;

        if (e.button === 0) {
            this._lbuttonDown = true;
            this._dragOrigin = { x: e.clientX, y: e.clientY };
            this._dragCanvasRect = this.canvas.getBoundingClientRect();
            this._dragGesture = false;
            this._dragOutNotified = false;
            try {
                if (e.pointerId != null && this.canvas.setPointerCapture) {
                    this.canvas.setPointerCapture(e.pointerId);
                }
            } catch (_) { /* ignore */ }
        }

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
        if (e.button === 0) {
            this._resetDragTracking();
            try {
                if (e.pointerId != null && this.canvas.releasePointerCapture
                    && this.canvas.hasPointerCapture
                    && this.canvas.hasPointerCapture(e.pointerId)) {
                    this.canvas.releasePointerCapture(e.pointerId);
                }
            } catch (_) { /* ignore */ }
        }

        if (!this.enabled || this._suppressMouse) return;
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

    /**
     * Ctrl/Cmd+V (not AltGr): let the browser fire `paste` so clipboardData is
     * available without clipboard-read permission. KeyV is not forwarded until
     * onLocalPaste has pushed text to the peer.
     * @param {KeyboardEvent} e
     * @returns {boolean}
     */
    _isPasteShortcut(e) {
        if (!e) return false;
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
        return e.code === 'KeyV' || e.key === 'v' || e.key === 'V';
    }

    _clearPasteWait() {
        this._awaitingBrowserPaste = false;
        if (this._pasteFallbackTimer) {
            clearTimeout(this._pasteFallbackTimer);
            this._pasteFallbackTimer = null;
        }
    }

    /**
     * @param {ClipboardEvent} e
     */
    _handlePaste(e) {
        if (!this.enabled) return;
        if (this._isInputFocused()) return;

        this._clearPasteWait();
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }

        const dt = e && e.clipboardData;
        const files = dt && dt.files && dt.files.length ? dt.files : null;
        if (files && typeof this.onLocalPasteFiles === 'function') {
            void this.onLocalPasteFiles(files);
            return;
        }

        let text = '';
        try {
            text = (dt && dt.getData('text/plain')) || '';
        } catch (_) {
            text = '';
        }

        if (typeof this.onLocalPaste === 'function') {
            void Promise.resolve(this.onLocalPaste(text)).then(() => {
                this._sendPasteKeyV();
            }).catch(() => {
                this._sendPasteKeyV();
            });
            return;
        }
        this._sendPasteKeyV();
    }

    /** Control/Meta already held from the real keydown — only synthesize KeyV. */
    _sendPasteKeyV() {
        if (!this.enabled) return;
        this._sendKeyForCode('KeyV', 'v', true, false, null);
        this._sendKeyForCode('KeyV', 'v', false, false, null);
    }

    async _pasteViaClipboardApi() {
        if (!this.enabled || typeof this.onLocalPaste !== 'function') {
            this._sendPasteKeyV();
            return;
        }
        let text = '';
        try {
            if (navigator.clipboard && navigator.clipboard.readText) {
                text = await navigator.clipboard.readText();
            }
        } catch (_) {
            text = '';
        }
        try {
            await this.onLocalPaste(text || '');
        } catch (_) { /* ignore */ }
        this._sendPasteKeyV();
    }

    _handleKeyDown(e) {
        if (!this.enabled) return;
        if (this._isInputFocused()) return;

        // Do not preventDefault on Ctrl/Cmd+V — that cancels the paste event.
        if (this._isPasteShortcut(e)) {
            e.stopPropagation();
            if (e.repeat) return;
            this._awaitingBrowserPaste = true;
            if (this._pasteFallbackTimer) clearTimeout(this._pasteFallbackTimer);
            const schedule = (typeof setTimeout === 'function') ? setTimeout : null;
            if (schedule) {
                this._pasteFallbackTimer = schedule(() => {
                    this._pasteFallbackTimer = null;
                    if (!this._awaitingBrowserPaste) return;
                    this._awaitingBrowserPaste = false;
                    void this._pasteViaClipboardApi();
                }, 120);
            }
            return;
        }

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

        // KeyV was never sent down during paste intercept — skip the up event.
        if (e.code === 'KeyV' && !this.pressedKeys.has('KeyV')) {
            e.stopPropagation();
            return;
        }

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
