/**
 * BetterDesk Web Remote Client - Canvas Renderer
 * Renders decoded video frames on canvas with cursor overlay
 */

// eslint-disable-next-line no-unused-vars
class RDRenderer {
    /**
     * @param {HTMLCanvasElement} canvas - The rendering canvas element
     */
    constructor(canvas) {
        /** @type {HTMLCanvasElement} */
        this.canvas = canvas;
        /** @type {CanvasRenderingContext2D} */
        this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
        /** @type {HTMLCanvasElement} Offscreen canvas for cursor */
        this.cursorCanvas = document.createElement('canvas');
        /** @type {CanvasRenderingContext2D} */
        this.cursorCtx = this.cursorCanvas.getContext('2d');

        /** @type {number} Remote display width */
        this.remoteWidth = 0;
        /** @type {number} Remote display height */
        this.remoteHeight = 0;

        /** @type {string} Scale mode: fit | fill | 1:1 | stretch */
        this.scaleMode = 'fit';

        /** @type {Object} Current scale/offset applied */
        this.transform = { scale: 1, offsetX: 0, offsetY: 0 };

        /** @type {ImageBitmap|null} Current cursor image (software overlay) */
        this.cursorImage = null;
        /** @type {Object} Cursor hotspot */
        this.cursorHotspot = { x: 0, y: 0 };
        /** @type {Object} Cursor position (remote coordinates) */
        this.cursorPos = { x: 0, y: 0 };
        /**
         * Draw remote cursor as a software overlay at CursorPosition.
         * Default off: controlling sessions use a CSS cursor (local pointer + remote shape)
         * so resize/edge cursors track the OS mouse without RTT lag.
         * @type {boolean}
         */
        this.showCursor = false;

        /** @type {Map<string, { cssUrl: string, hotspot: {x:number,y:number}, image: ImageBitmap|null }>} */
        this._cursorCache = new Map();
        /** @type {string[]} */
        this._cursorCacheOrder = [];
        /** @type {number} */
        this._cursorCacheMax = 64;
        /** @type {string} Last applied CSS cursor value */
        this._cssCursor = '';

        /** @type {number} Frames rendered counter */
        this.framesRendered = 0;
        /** @type {number} Last FPS measurement time */
        this._fpsTime = 0;
        /** @type {number} Frames in current second */
        this._fpsCount = 0;
        /** @type {number} Current FPS */
        this.fps = 0;

        /** @type {number} Animation frame ID */
        this._rafId = 0;
        /** @type {VideoFrame|null} Latest frame to render */
        this._pendingFrame = null;
        /** @type {boolean} */
        this._renderLoopActive = false;
    }

    /**
     * Set remote display dimensions and recalculate transform
     * @param {number} width
     * @param {number} height
     */
    setRemoteSize(width, height) {
        if (this.remoteWidth === width && this.remoteHeight === height) return;
        this.remoteWidth = width;
        this.remoteHeight = height;
        this._updateTransform();
    }

    /**
     * Recalculate canvas size (call on window resize or fullscreen toggle)
     */
    resize() {
        const container = this.canvas.parentElement;
        if (!container) return;

        const rect = container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.canvas.style.width = rect.width + 'px';
        this.canvas.style.height = rect.height + 'px';

        this._updateTransform();

        // Request a keyframe after resize to avoid blurry/corrupted frames
        if (this.onResizeRefresh) {
            this.onResizeRefresh();
        }
    }

    /**
     * Set scale mode
     * @param {'fit'|'fill'|'1:1'|'stretch'} mode
     */
    setScaleMode(mode) {
        this.scaleMode = mode;
        this._updateTransform();
    }

    /**
     * Calculate transform based on canvas size, remote size, and scale mode
     */
    _updateTransform() {
        if (!this.remoteWidth || !this.remoteHeight) return;

        const cw = this.canvas.width;
        const ch = this.canvas.height;
        const rw = this.remoteWidth;
        const rh = this.remoteHeight;

        let scale, offsetX, offsetY;

        switch (this.scaleMode) {
        case 'fit': {
            // Fit entire remote display inside canvas, preserving aspect ratio
            scale = Math.min(cw / rw, ch / rh);
            offsetX = (cw - rw * scale) / 2;
            offsetY = (ch - rh * scale) / 2;
            break;
        }
        case 'fill': {
            // Fill canvas, cropping excess, preserving aspect ratio
            scale = Math.max(cw / rw, ch / rh);
            offsetX = (cw - rw * scale) / 2;
            offsetY = (ch - rh * scale) / 2;
            break;
        }
        case '1:1': {
            // Native resolution, centered
            const dpr = window.devicePixelRatio || 1;
            scale = dpr;
            offsetX = (cw - rw * scale) / 2;
            offsetY = (ch - rh * scale) / 2;
            break;
        }
        case 'stretch': {
            // Stretch to fill canvas (ignores aspect ratio)
            // Handled separately in render
            scale = 1;
            offsetX = 0;
            offsetY = 0;
            break;
        }
        default:
            scale = Math.min(cw / rw, ch / rh);
            offsetX = (cw - rw * scale) / 2;
            offsetY = (ch - rh * scale) / 2;
        }

        this.transform = { scale, offsetX, offsetY };
    }

    /**
     * Convert canvas coordinates to remote display coordinates
     * @param {number} canvasX
     * @param {number} canvasY
     * @returns {{ x: number, y: number }}
     */
    canvasToRemote(canvasX, canvasY) {
        const dpr = window.devicePixelRatio || 1;
        const px = canvasX * dpr;
        const py = canvasY * dpr;

        if (this.scaleMode === 'stretch') {
            return {
                x: Math.round(px / this.canvas.width * this.remoteWidth),
                y: Math.round(py / this.canvas.height * this.remoteHeight)
            };
        }

        const { scale, offsetX, offsetY } = this.transform;
        return {
            x: Math.round((px - offsetX) / scale),
            y: Math.round((py - offsetY) / scale)
        };
    }

    /**
     * Start the render loop
     */
    startRenderLoop() {
        if (this._renderLoopActive) return;
        this._renderLoopActive = true;
        this._fpsTime = performance.now();
        this._renderTick();
    }

    /**
     * Stop the render loop
     */
    stopRenderLoop() {
        this._renderLoopActive = false;
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = 0;
        }
    }

    /**
     * Queue a VideoFrame for rendering
     * @param {VideoFrame} frame
     */
    pushFrame(frame) {
        // Close previous pending frame if not yet rendered
        if (this._pendingFrame) {
            this._pendingFrame.close();
        }
        this._pendingFrame = frame;
    }

    /**
     * Internal render tick
     */
    _renderTick() {
        if (!this._renderLoopActive) return;

        if (this._pendingFrame) {
            // Count FPS only for genuinely new frames from the peer
            if (this._pendingFrame._isNew) {
                this._fpsCount++;
            }
            this._renderFrame(this._pendingFrame);
            this._pendingFrame = null;
        }

        // FPS calculation (actual new video frames per second from peer)
        const now = performance.now();
        if (now - this._fpsTime >= 1000) {
            this.fps = this._fpsCount;
            this._fpsCount = 0;
            this._fpsTime = now;
        }

        this._rafId = requestAnimationFrame(() => this._renderTick());
    }

    /**
     * Render a single video frame to canvas
     * @param {VideoFrame|Object} frame - VideoFrame or fallback proxy with _source
     */
    _renderFrame(frame) {
        // Update remote dimensions from frame
        this.setRemoteSize(frame.displayWidth, frame.displayHeight);

        const ctx = this.ctx;
        const cw = this.canvas.width;
        const ch = this.canvas.height;
        // Use _source (ImageBitmap) for fallback frames, otherwise frame itself (VideoFrame)
        const drawSource = frame._source || frame;

        // Clear canvas
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, cw, ch);

        if (this.scaleMode === 'stretch') {
            ctx.drawImage(drawSource, 0, 0, cw, ch);
        } else {
            const { scale, offsetX, offsetY } = this.transform;
            ctx.drawImage(drawSource, offsetX, offsetY,
                this.remoteWidth * scale, this.remoteHeight * scale);
        }

        frame.close();
        this.framesRendered++;

        // Draw cursor overlay
        if (this.showCursor && this.cursorImage) {
            this._drawCursor(ctx);
        }
    }

    /**
     * Normalize CursorData / cursor_id keys (protobufjs may use Long).
     * @param {number|string|object|null|undefined} id
     * @returns {string|null}
     */
    static cursorCacheKey(id) {
        if (id == null || id === '') return null;
        if (typeof id === 'object' && typeof id.toString === 'function') {
            const s = id.toString();
            return s === '0' ? '0' : s;
        }
        return String(id);
    }

    /**
     * Resolve RDCompress at call time (script order may load compress.js later).
     * @returns {{ decompressZstd: Function, isZstdMagic?: Function }|null}
     */
    _getCompress() {
        if (typeof RDCompress !== 'undefined') return RDCompress;
        if (typeof window !== 'undefined' && window.RDCompress) return window.RDCompress;
        if (typeof globalThis !== 'undefined' && globalThis.RDCompress) return globalThis.RDCompress;
        return null;
    }

    /**
     * Update cursor image from CursorData message (RustDesk peer: zstd-compressed RGBA).
     * Applies shape as a CSS cursor on the canvas so resize/I-beam/etc. track the local pointer.
     * @param {Object} cursorData - { colors|data, hotx, hoty, width, height, id }
     */
    async updateCursor(cursorData) {
        try {
            // Proto field is 'colors' (RGBA pixel data), support both for compatibility
            const pixelData = cursorData.colors || cursorData.data;
            if (!pixelData || !cursorData.width || !cursorData.height) return;

            const w = cursorData.width | 0;
            const h = cursorData.height | 0;
            if (w <= 0 || h <= 0 || w > 256 || h > 256) return;
            const expectedLen = w * h * 4;

            let bytes = (pixelData instanceof Uint8Array)
                ? pixelData
                : new Uint8Array(pixelData);

            // RustDesk compresses cursor RGBA with zstd before send
            const compress = this._getCompress();
            if (compress && typeof compress.decompressZstd === 'function') {
                bytes = await compress.decompressZstd(bytes);
            } else if (bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5
                && bytes[2] === 0x2f && bytes[3] === 0xfd) {
                // No decompressor available — cannot render compressed cursor
                return;
            }

            if (bytes.length < expectedLen) return;
            if (bytes.length > expectedLen) {
                bytes = bytes.subarray(0, expectedLen);
            }

            // RustDesk: all-zero bitmaps render as a black square — keep one alpha sample
            let anyNonZero = false;
            for (let i = 0; i < bytes.length; i++) {
                if (bytes[i] !== 0) { anyNonZero = true; break; }
            }
            if (!anyNonZero && bytes.length >= 4) {
                bytes = new Uint8Array(bytes);
                bytes[3] = 1;
            }

            const hotx = cursorData.hotx || 0;
            const hoty = cursorData.hoty || 0;
            this.cursorHotspot.x = hotx;
            this.cursorHotspot.y = hoty;

            const imgData = new ImageData(new Uint8ClampedArray(bytes), w, h);

            // CSS cursor so the OS pointer shows remote shapes (ns-resize, etc.)
            const cssUrl = this._rgbaToCssCursor(imgData, hotx, hoty);
            if (cssUrl) {
                this._applyCssCursor(cssUrl);
            }

            // Optional software overlay (follower / show-remote-cursor style)
            let image = null;
            if (typeof createImageBitmap === 'function') {
                try {
                    image = await createImageBitmap(imgData);
                } catch (_) { /* CSS cursor is enough */ }
            }
            if (this.cursorImage && this.cursorImage !== image) {
                this._releaseCursorImage(this.cursorImage);
            }
            this.cursorImage = image;

            const cacheKey = RDRenderer.cursorCacheKey(cursorData.id);
            if (cacheKey != null) {
                this._putCursorCache(cacheKey, {
                    cssUrl: cssUrl || this._cssCursor,
                    hotspot: { x: hotx, y: hoty },
                    image: image
                });
            }

            // Notify host: CSS cursor is active (do not force cursor:none)
            if (this.onCursorReady) {
                this.onCursorReady(true);
            }
        } catch (err) {
            // Silently skip invalid cursor data to prevent crash
        }
    }

    /**
     * Switch to a previously cached cursor (peer sends cursor_id after first CursorData).
     * @param {number|string|object} cursorId
     * @returns {boolean} true if cache hit
     */
    setCursorById(cursorId) {
        const key = RDRenderer.cursorCacheKey(cursorId);
        if (key == null) return false;
        const cached = this._cursorCache.get(key);
        if (!cached) return false;

        this.cursorHotspot.x = cached.hotspot.x;
        this.cursorHotspot.y = cached.hotspot.y;
        if (cached.cssUrl) {
            this._applyCssCursor(cached.cssUrl);
        }
        if (cached.image && cached.image !== this.cursorImage) {
            // Keep shared ImageBitmap from cache; do not close it here
            this.cursorImage = cached.image;
        }
        if (this.onCursorReady) {
            this.onCursorReady(true);
        }
        return true;
    }

    /**
     * @param {ImageBitmap|null} image
     */
    _releaseCursorImage(image) {
        if (!image) return;
        for (const entry of this._cursorCache.values()) {
            if (entry.image === image) return;
        }
        try { image.close(); } catch (_) { /* ignore */ }
    }

    /**
     * @param {string} key
     * @param {{ cssUrl: string, hotspot: {x:number,y:number}, image: ImageBitmap|null }} entry
     */
    _putCursorCache(key, entry) {
        if (this._cursorCache.has(key)) {
            const prev = this._cursorCache.get(key);
            this._cursorCacheOrder = this._cursorCacheOrder.filter((k) => k !== key);
            if (prev && prev.image && prev.image !== entry.image && prev.image !== this.cursorImage) {
                try { prev.image.close(); } catch (_) { /* ignore */ }
            }
        }
        this._cursorCache.set(key, entry);
        this._cursorCacheOrder.push(key);
        while (this._cursorCacheOrder.length > this._cursorCacheMax) {
            const old = this._cursorCacheOrder.shift();
            const evicted = this._cursorCache.get(old);
            this._cursorCache.delete(old);
            if (evicted && evicted.image && evicted.image !== this.cursorImage) {
                try { evicted.image.close(); } catch (_) { /* ignore */ }
            }
        }
    }

    /**
     * @param {ImageData} imgData
     * @param {number} hotx
     * @param {number} hoty
     * @returns {string|null}
     */
    _rgbaToCssCursor(imgData, hotx, hoty) {
        try {
            const tmp = document.createElement('canvas');
            tmp.width = imgData.width;
            tmp.height = imgData.height;
            const ctx = tmp.getContext('2d');
            if (!ctx) return null;
            ctx.putImageData(imgData, 0, 0);
            const dataUrl = tmp.toDataURL('image/png');
            const hx = Math.max(0, Math.min(imgData.width - 1, hotx | 0));
            const hy = Math.max(0, Math.min(imgData.height - 1, hoty | 0));
            return `url(${dataUrl}) ${hx} ${hy}, auto`;
        } catch (_) {
            return null;
        }
    }

    /**
     * @param {string} cssUrl
     */
    _applyCssCursor(cssUrl) {
        if (!cssUrl || !this.canvas) return;
        this._cssCursor = cssUrl;
        // Inline style overrides streaming crosshair fallback; tracks local OS pointer
        this.canvas.style.cursor = cssUrl;
    }

    /**
     * Update cursor position from CursorPosition message
     * @param {Object} pos - { x: number, y: number }
     */
    updateCursorPosition(pos) {
        this.cursorPos.x = pos.x || 0;
        this.cursorPos.y = pos.y || 0;
    }

    /**
     * Draw cursor on canvas
     * @param {CanvasRenderingContext2D} ctx
     */
    _drawCursor(ctx) {
        const { scale, offsetX, offsetY } = this.transform;

        const cx = offsetX + (this.cursorPos.x - this.cursorHotspot.x) * scale;
        const cy = offsetY + (this.cursorPos.y - this.cursorHotspot.y) * scale;
        const cw = this.cursorImage.width * scale;
        const ch = this.cursorImage.height * scale;

        ctx.drawImage(this.cursorImage, cx, cy, cw, ch);
    }

    /**
     * Get renderer statistics
     */
    getStats() {
        return {
            fps: this.fps,
            framesRendered: this.framesRendered,
            remoteWidth: this.remoteWidth,
            remoteHeight: this.remoteHeight,
            canvasWidth: this.canvas.width,
            canvasHeight: this.canvas.height,
            scaleMode: this.scaleMode,
            scale: this.transform.scale
        };
    }

    /**
     * Close and release resources
     */
    close() {
        this.stopRenderLoop();
        if (this._pendingFrame) {
            this._pendingFrame.close();
            this._pendingFrame = null;
        }
        for (const entry of this._cursorCache.values()) {
            if (entry.image) {
                try { entry.image.close(); } catch (_) { /* ignore */ }
            }
        }
        this._cursorCache.clear();
        this._cursorCacheOrder = [];
        this.cursorImage = null;
        this._cssCursor = '';
        if (this.canvas) {
            this.canvas.style.cursor = '';
        }
    }
}

window.RDRenderer = RDRenderer;
