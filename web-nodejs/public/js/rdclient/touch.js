/**
 * BetterDesk Web Remote Client — touch and touchpad input for tablet / fold devices.
 */

/* global RDInput */

// eslint-disable-next-line no-unused-vars
class RDTouch {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {RDRenderer} renderer
     * @param {Function} sendMessage
     */
    constructor(canvas, renderer, sendMessage) {
        this.canvas = canvas;
        this.renderer = renderer;
        this.sendMessage = sendMessage;
        /** @type {'direct'|'touchpad'} */
        this.mode = 'direct';
        this.enabled = false;
        this._activeTouches = new Map();
        this._touchpadLast = null;
        this._longPressTimer = null;
        this._lastMoveTime = 0;
        this._moveThrottleMs = 16;

        this._onTouchStart = this._handleTouchStart.bind(this);
        this._onTouchMove = this._handleTouchMove.bind(this);
        this._onTouchEnd = this._handleTouchEnd.bind(this);
        this._onTouchCancel = this._handleTouchEnd.bind(this);
    }

    setMode(mode) {
        this.mode = mode === 'touchpad' ? 'touchpad' : 'direct';
    }

    start() {
        if (this.enabled) return;
        const c = this.canvas;
        c.addEventListener('touchstart', this._onTouchStart, { passive: false });
        c.addEventListener('touchmove', this._onTouchMove, { passive: false });
        c.addEventListener('touchend', this._onTouchEnd, { passive: false });
        c.addEventListener('touchcancel', this._onTouchCancel, { passive: false });
        c.style.touchAction = 'none';
        this.enabled = true;
    }

    stop() {
        if (!this.enabled) return;
        const c = this.canvas;
        c.removeEventListener('touchstart', this._onTouchStart);
        c.removeEventListener('touchmove', this._onTouchMove);
        c.removeEventListener('touchend', this._onTouchEnd);
        c.removeEventListener('touchcancel', this._onTouchCancel);
        c.style.touchAction = '';
        clearTimeout(this._longPressTimer);
        this._activeTouches.clear();
        this.enabled = false;
    }

    _posFromTouch(touch) {
        const rect = this.canvas.getBoundingClientRect();
        const canvasX = touch.clientX - rect.left;
        const canvasY = touch.clientY - rect.top;
        const pos = this.renderer.canvasToRemote(canvasX, canvasY);
        if (pos.x < 0 || pos.y < 0 ||
            pos.x > this.renderer.remoteWidth ||
            pos.y > this.renderer.remoteHeight) {
            return null;
        }
        return pos;
    }

    _sendMove(x, y) {
        const now = performance.now();
        if (now - this._lastMoveTime < this._moveThrottleMs) return;
        this._lastMoveTime = now;
        this.sendMessage({
            mouseEvent: { mask: 0, x, y, modifiers: [] }
        });
    }

    _sendButton(type, button, x, y) {
        const mask = type | (button << 3);
        this.sendMessage({
            mouseEvent: { mask, x, y, modifiers: [] }
        });
    }

    _sendWheel(dx, dy) {
        this.sendMessage({
            mouseEvent: {
                mask: RDInput.MOUSE_TYPE_WHEEL,
                x: dx,
                y: dy,
                modifiers: []
            }
        });
    }

    _handleTouchStart(e) {
        if (!this.enabled) return;
        e.preventDefault();

        if (this.mode === 'touchpad') {
            if (e.touches.length === 1) {
                this._touchpadLast = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            }
            return;
        }

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            this._activeTouches.set(touch.identifier, { x: touch.clientX, y: touch.clientY });

            if (e.touches.length === 1) {
                const pos = this._posFromTouch(touch);
                if (!pos) continue;
                this._longPressTimer = setTimeout(() => {
                    this._sendButton(RDInput.MOUSE_TYPE_DOWN, RDInput.MOUSE_BUTTON_RIGHT, pos.x, pos.y);
                    this._sendButton(RDInput.MOUSE_TYPE_UP, RDInput.MOUSE_BUTTON_RIGHT, pos.x, pos.y);
                }, 550);
            }
        }
    }

    _handleTouchMove(e) {
        if (!this.enabled) return;
        e.preventDefault();
        clearTimeout(this._longPressTimer);

        if (this.mode === 'touchpad') {
            if (e.touches.length === 2) {
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const prevDy = this._touchpadPinchDy;
                this._touchpadPinchDy = dy;
                if (prevDy != null && Math.abs(dy - prevDy) > 8) {
                    this._sendWheel(0, dy > prevDy ? -1 : 1);
                }
                return;
            }
            if (e.touches.length === 1 && this._touchpadLast) {
                const t = e.touches[0];
                const dx = t.clientX - this._touchpadLast.x;
                const dy = t.clientY - this._touchpadLast.y;
                this._touchpadLast = { x: t.clientX, y: t.clientY };
                const sensitivity = 2;
                const last = this._touchpadCursor || { x: this.renderer.remoteWidth / 2, y: this.renderer.remoteHeight / 2 };
                const nx = Math.max(0, Math.min(this.renderer.remoteWidth, last.x + dx * sensitivity));
                const ny = Math.max(0, Math.min(this.renderer.remoteHeight, last.y + dy * sensitivity));
                this._touchpadCursor = { x: nx, y: ny };
                this._sendMove(nx, ny);
            }
            return;
        }

        if (e.touches.length === 2) {
            const t0 = e.touches[0];
            const t1 = e.touches[1];
            const midY = (t0.clientY + t1.clientY) / 2;
            const prev = this._pinchMidY;
            this._pinchMidY = midY;
            if (prev != null && Math.abs(midY - prev) > 6) {
                this._sendWheel(0, midY > prev ? -1 : 1);
            }
            return;
        }

        const touch = e.touches[0];
        if (!touch) return;
        const pos = this._posFromTouch(touch);
        if (!pos) return;
        this._sendMove(pos.x, pos.y);
    }

    _handleTouchEnd(e) {
        if (!this.enabled) return;
        e.preventDefault();
        clearTimeout(this._longPressTimer);
        this._pinchMidY = null;
        this._touchpadPinchDy = null;

        if (this.mode === 'touchpad') {
            if (e.touches.length === 0) {
                this._touchpadLast = null;
            }
            if (e.changedTouches.length === 1 && e.touches.length === 0) {
                const touch = e.changedTouches[0];
                const moved = this._touchpadLast && (
                    Math.abs(touch.clientX - this._touchpadLast.x) > 8 ||
                    Math.abs(touch.clientY - this._touchpadLast.y) > 8
                );
                if (!moved && this._touchpadCursor) {
                    const p = this._touchpadCursor;
                    this._sendButton(RDInput.MOUSE_TYPE_DOWN, RDInput.MOUSE_BUTTON_LEFT, p.x, p.y);
                    this._sendButton(RDInput.MOUSE_TYPE_UP, RDInput.MOUSE_BUTTON_LEFT, p.x, p.y);
                }
            }
            return;
        }

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            this._activeTouches.delete(touch.identifier);
            if (e.touches.length === 0) {
                const pos = this._posFromTouch(touch);
                if (!pos) continue;
                this._sendButton(RDInput.MOUSE_TYPE_DOWN, RDInput.MOUSE_BUTTON_LEFT, pos.x, pos.y);
                this._sendButton(RDInput.MOUSE_TYPE_UP, RDInput.MOUSE_BUTTON_LEFT, pos.x, pos.y);
            }
        }
    }
}
