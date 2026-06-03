/**
 * BetterDesk Web Remote Client — CDAP Transport Adapter
 *
 * Drop-in replacement for `RDClient` when the target device is a
 * BetterDesk OS-agent (CDAP transport). Exposes the same public surface
 * (`connect`, `disconnect`, `authenticate`, `verify2fa`, event emitter
 * with `state`/`log`/`session_start`/`disconnected`/`error`/`stats`)
 * so `remote.js` can swap implementations without branching.
 *
 * The CDAP path:
 *   - opens `/api/cdap/devices/:id/desktop` (subprotocol `cdap-desktop`)
 *   - receives raw JPEG binary frames + JSON control messages
 *   - sends mouse / keyboard / text input as JSON over the same socket
 *
 * No password challenge (Go server gates the WS upgrade with the
 * operator session), so we transition straight from `connecting` →
 * `streaming` on `ready`.
 *
 * Phase 2.3 (unification plan): replaces the standalone `cdap-desktop.js`
 * widget for the full-screen `/remote/:id?transport=cdap` viewer. The
 * widget stays for inline device-detail panels.
 */

/* eslint-disable no-unused-vars */

(function () {
    'use strict';

    // Mouse encoding (MUST match cdap server expectations + cdap-desktop.js)
    const MOUSE_TYPE_MOVE   = 0;
    const MOUSE_TYPE_DOWN   = 1;
    const MOUSE_TYPE_UP     = 2;
    const MOUSE_TYPE_WHEEL  = 3;
    const MOUSE_BUTTON_LEFT   = 1;
    const MOUSE_BUTTON_RIGHT  = 2;
    const MOUSE_BUTTON_MIDDLE = 4;

    /** Normalize browser wheel deltas to ±1 (Windows agent multiplies by 120). */
    function normalizeWheelDelta(e) {
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

    const PRESENCE_PING_MS = 15000;
    const STATS_INTERVAL_MS = 1000;

    // Video codecs that can be hardware-decoded in the browser image formats
    // (webp/jpeg) are always handled by createImageBitmap.
    const VIDEO_CODECS = ['av1', 'vp9', 'h264'];
    const isVideoCodec = (fmt) => VIDEO_CODECS.indexOf(fmt) !== -1;

    /**
     * Probe whether the H.264 elementary stream can be decoded through Media
     * Source Extensions (JMuxer). MSE, unlike WebCodecs, does NOT require a
     * secure context, so this path enables GPU-accelerated H.264 over plain
     * HTTP (no HTTPS / domain / certificate needed).
     * @returns {boolean}
     */
    function hasMseH264() {
        return typeof window.JMuxer !== 'undefined'
            && typeof window.MediaSource !== 'undefined'
            && typeof window.MediaSource.isTypeSupported === 'function'
            && window.MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"');
    }

    /**
     * Whether the full WebCodecs `VideoDecoder` pipeline is usable. Requires a
     * secure context (HTTPS or localhost). When available it unlocks AV1/VP9/
     * H.264 hardware decode.
     * @returns {boolean}
     */
    function hasWebCodecs() {
        return window.isSecureContext === true
            && typeof window.VideoDecoder !== 'undefined';
    }

    /**
     * Build the ordered list of codecs the operator can decode, advertised to
     * the agent in the `desktop_start` payload. The agent intersects this with
     * its own GPU/encoder ability and picks the first match in its own
     * preference order (AV1 → VP9 → H264 → WebP).
     *
     * - Secure context (WebCodecs): advertise AV1/VP9/H264 for max quality.
     * - Plain HTTP with MSE H.264: advertise H264 so the agent still sends a
     *   GPU-encoded video stream (decoded via JMuxer/MSE) instead of falling
     *   back to MJPEG — this is the key to smooth video without HTTPS.
     * - Otherwise: image formats only (WebP/JPEG).
     * @returns {string[]}
     */
    function decodableCodecs() {
        const list = [];
        if (hasWebCodecs()) {
            list.push('av1', 'vp9', 'h264');
        } else if (hasMseH264()) {
            list.push('h264');
        }
        list.push('webp', 'jpeg');
        return list;
    }

    /**
     * Stub renderer that mirrors the subset of `RDRenderer` used by
     * `remote.js` (resize + scale mode). Frames are painted directly by
     * the adapter; no codec pipeline is involved.
     */
    class CDAPRenderer {
        constructor(canvas) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.scaleMode = 'fit';
        }
        resize() {
            // Canvas auto-sizes from `desktop_meta`; this is a no-op stub.
            // We still update the CSS object-fit rule on `setScaleMode`.
        }
        setScaleMode(mode) {
            this.scaleMode = mode;
            const map = {
                'fit': 'contain',
                'fill': 'cover',
                '1:1': 'none',
                'stretch': 'fill',
            };
            this.canvas.style.objectFit = map[mode] || 'contain';
        }
        // Subset of RDRenderer used elsewhere — left as no-ops so the
        // shared toolbar code does not throw when wired against CDAP.
        drawCursor() { /* handled by canvas.style.cursor on cursor_update */ }
        clear() {
            try { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }
            catch { /* noop */ }
        }
    }

    class CDAPSession {
        /**
         * @param {HTMLCanvasElement} canvas
         * @param {Object} opts
         * @param {string} opts.deviceId
         * @param {string} [opts.scaleMode]
         * @param {number} [opts.fps]
         * @param {string} [opts.imageQuality] — 'Best' | 'Balanced' | 'Low'
         */
        constructor(canvas, opts = {}) {
            if (!canvas) throw new Error('Canvas element required');
            if (!opts.deviceId) throw new Error('deviceId required');

            this.deviceId = opts.deviceId;
            this.opts = opts;

            this._state = 'idle';
            this._listeners = {};

            this.renderer = new CDAPRenderer(canvas);
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');

            // Public RDClient-compatible stubs so the shared toolbar code
            // does not crash. None of them are functional for the CDAP
            // transport yet (see Phase 2.5 / 2.6 in the unification plan).
            this.input = {
                start: () => { /* keyboard/mouse are bound on connect */ },
                stop:  () => { /* released in disconnect */ },
                blockInput: () => false,
                setBlockInput: () => false,
            };
            // No-op file transfer stub (PR 2.5 will wire real CDAP file
            // transfer). Keeps the toolbar callbacks in `remote.js` from
            // throwing when the operator clicks file-browser buttons.
            this.fileTransfer = {
                browseParent: () => this._emit('log', 'File browser is not yet supported over CDAP.'),
                browseDir:    () => this._emit('log', 'File browser is not yet supported over CDAP.'),
                cancelTransfer: () => false,
                upload: () => false,
                download: () => false,
            };

            this._ws = null;
            this._connected = false;
            this._inputBound = false;
            this._presenceTimer = null;
            this._statsTimer = null;
            this._readyTimer = null;
            this._monitors = [];
            this._activeMonitor = 0;
            this._sessionId = null;

            // Stats counters
            this._frameCount = 0;
            this._frameBytes = 0;
            this._lastStatsTime = 0;
            this._lastFrameTime = 0;

            // Video decode pipeline (WebCodecs / JMuxer-MSE). `_activeFormat`
            // tracks the encoding the agent is currently sending; it is set
            // from `desktop_meta` and defaults to the legacy MJPEG path.
            this._activeFormat = 'jpeg';
            this._codecString = null;
            this._video = null;          // RDVideo instance (lazy)
            this._gotKeyframe = false;
            this._keyframeRequestedAt = 0;

            // Bound handlers (so remove works on disconnect)
            this._onMouseDown = this._handleMouseDown.bind(this);
            this._onMouseUp   = this._handleMouseUp.bind(this);
            this._onMouseMove = this._handleMouseMove.bind(this);
            this._onWheel     = this._handleWheel.bind(this);
            this._onKeyDown   = this._handleKeyDown.bind(this);
            this._onKeyUp     = this._handleKeyUp.bind(this);
            this._onContextMenu = (e) => e.preventDefault();
            this._onPaste = this._handlePaste.bind(this);
        }

        get state() { return this._state; }
        get peerInfo() {
            return {
                username: this.deviceId,
                hostname: this.deviceId,
                version: 'cdap',
                platform: '',
            };
        }

        // ── Event Emitter ────────────────────────────────────────────────

        on(event, fn) {
            (this._listeners[event] = this._listeners[event] || []).push(fn);
            return this;
        }
        off(event, fn) {
            const arr = this._listeners[event];
            if (arr) this._listeners[event] = arr.filter(f => f !== fn);
            return this;
        }
        _emit(event, ...args) {
            const arr = this._listeners[event];
            if (arr) arr.forEach(fn => { try { fn(...args); } catch (e) { console.error(e); } });
        }

        _setState(s) {
            if (this._state === s) return;
            this._state = s;
            this._emit('state', s);
        }

        // ── Public API (RDClient-compatible) ─────────────────────────────

        async connect() {
            this._setState('connecting');
            this._emit('log', 'Opening CDAP desktop session…');
            console.log('[CDAP] connect()', this.deviceId);

            const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const url = `${proto}//${window.location.host}/api/cdap/devices/${encodeURIComponent(this.deviceId)}/desktop`;
            let ws;
            try {
                ws = new WebSocket(url, ['cdap-desktop']);
                ws.binaryType = 'arraybuffer';
            } catch (err) {
                this._setState('error');
                this._emit('error', err.message || 'WebSocket open failed');
                throw err;
            }
            this._ws = ws;

            ws.addEventListener('open',    () => this._handleOpen());
            ws.addEventListener('message', (e) => this._handleMessage(e));
            ws.addEventListener('error',   () => {
                console.warn('[CDAP] socket error');
                this._emit('log', 'CDAP socket error');
            });
            ws.addEventListener('close',   (e) => this._handleClose(e));

            // Phase 3: don't let the operator stare at "Connecting…" forever.
            // If the agent never replies with `ready` (e.g. screen capture
            // permission denied, agent offline, no admin role on device),
            // surface a clear error after 20s.
            this._readyTimer = setTimeout(() => {
                if (this._state === 'connecting') {
                    console.warn('[CDAP] ready timeout — agent did not respond');
                    this._emit('error',
                        'Agent did not start the desktop session (timeout). ' +
                        'Check that the agent is online and screen capture is enabled.');
                    try { this._ws && this._ws.close(4001, 'ready_timeout'); } catch { /* noop */ }
                }
            }, 20000);
        }

        disconnect() {
            this._unbindInput();
            this._stopPresencePing();
            this._stopStats();
            this._closeVideoDecoder();
            if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
            if (this._ws && this._ws.readyState !== WebSocket.CLOSED) {
                try { this._ws.close(1000, 'client_disconnect'); }
                catch { /* ignore */ }
            }
            this._ws = null;
            this._connected = false;
            this._setState('disconnected');
            this._emit('disconnected', 'user');
        }

        authenticate(_password) {
            // CDAP transport does not use a password challenge.
            return Promise.resolve();
        }
        verify2fa(_code) {
            return Promise.resolve();
        }

        // RDClient toolbar-shim methods. Most are no-ops because the
        // CDAP transport renegotiates quality/cursor/etc. via dedicated
        // control messages instead of in-band login options. They MUST
        // exist so the shared toolbar code in `remote.js` does not throw
        // when the operator clicks them.

        setQuality(label) {
            const q = this._qualityFromLabel(label);
            this._send({ type: 'quality_set', quality: q });
        }
        setQualityPreset(preset) {
            // 'best' | 'balanced' | 'speed'
            const map = { best: 92, balanced: 75, speed: 50 };
            const q = map[String(preset || '').toLowerCase()] || 75;
            this._send({ type: 'quality_set', quality: q });
        }
        setFps(fps) {
            this._send({ type: 'quality_set', fps: this._normaliseFps(fps) });
        }
        setScaleMode(mode) {
            try { this.renderer.setScaleMode(mode); } catch { /* noop */ }
        }
        setShowCursor(_b)        { /* CDAP cursor is server-driven */ }
        setShowRemoteCursor(b)   { this._send({ type: 'show_cursor', enabled: !!b }); }
        setLockAfterSession(b)   { this._send({ type: 'lock_after_session', enabled: !!b }); }
        setPrivacyMode(b)        { this._send({ type: 'privacy_mode', enabled: !!b }); }
        setDisableClipboard(b)   { this._send({ type: 'disable_clipboard', enabled: !!b }); }
        setBlockInput(b)         { this._send({ type: 'block_input', enabled: !!b }); }
        setAudioMuted(_b)        { /* audio is handled via separate /audio WS */ }

        requestKeyframe() {
            this._send({ type: 'keyframe_request' });
        }
        sendRefreshScreen() {
            this._send({ type: 'keyframe_request' });
        }
        sendCAD()                { this.sendCtrlAltDel(); }
        sendCtrlAltDel() {
            // Synthesised as Ctrl+Alt+Delete key combo.
            const send = (key, code, down) => this._send({
                type: 'input', input_type: 'keyboard',
                key, code, down,
                modifiers: { ctrl: down, alt: down, shift: false, meta: false },
            });
            send('Control', 'ControlLeft', true);
            send('Alt',     'AltLeft',     true);
            send('Delete',  'Delete',      true);
            send('Delete',  'Delete',      false);
            send('Alt',     'AltLeft',     false);
            send('Control', 'ControlLeft', false);
        }
        sendLockScreen() {
            this._send({ type: 'lock_screen' });
        }
        sendRestart()             { this.sendRestartRemoteDevice(); }
        sendRestartRemoteDevice() { this._send({ type: 'restart_device' }); }
        sendClipboard(text) {
            if (!text) return false;
            return this.sendText(text);
        }
        toggleAudio() { /* page-level CDAPAudio handles this */ }
        sendChat(_msg) { /* not yet relayed via CDAP desktop channel */ }

        // Monitors — populated from `monitor_list` control messages.
        getMonitors() { return this._monitors.slice(); }
        switchMonitor(idx) {
            const i = Math.max(0, Math.min(idx | 0, Math.max(this._monitors.length - 1, 0)));
            this._activeMonitor = i;
            this._send({ type: 'monitor_select', index: i });
        }

        // Fullscreen — delegate to the container the toolbar passes in.
        toggleFullscreen(container) {
            const target = container || this.canvas.closest('.viewer-container') || this.canvas;
            if (!document.fullscreenElement) {
                if (target.requestFullscreen) target.requestFullscreen().catch(() => {});
            } else if (document.exitFullscreen) {
                document.exitFullscreen().catch(() => {});
            }
        }

        // Local recording stubs — `remote.js btn-record` uses MediaRecorder
        // directly via canvas.captureStream(), so these are reserved for
        // future remote-side recording.
        startRecording()    { return false; }
        stopRecording()     { return false; }
        downloadRecording() { return false; }
        isRecording()       { return false; }

        getStats() {
            return {
                frames: this._frameCount,
                bytes: this._frameBytes,
                fps: 0,
                kbps: 0,
                transport: 'cdap',
            };
        }

        // ── Internal: WS lifecycle ───────────────────────────────────────

        _handleOpen() {
            const dpr = window.devicePixelRatio || 1;
            const rect = this.canvas.getBoundingClientRect();
            const screenW = (window.screen && window.screen.width)  || 1920;
            const screenH = (window.screen && window.screen.height) || 1080;

            const quality = this._qualityFromLabel(this.opts.imageQuality);
            const fps = this._normaliseFps(this.opts.fps);

            this._send({
                width: screenW,
                height: screenH,
                quality,
                fps,
                device_pixel_ratio: dpr,
                client_css_width:  Math.round(rect.width  || 0),
                client_css_height: Math.round(rect.height || 0),
                // Advertise the codecs this browser can decode so the agent
                // sends a GPU-encoded video stream. Over plain HTTP this still
                // includes H.264 (decoded via JMuxer/MSE), avoiding the slow
                // MJPEG fallback. See decodableCodecs().
                codecs: decodableCodecs(),
                video_codec: 'auto',
            });

            this._startPresencePing();
        }

        _handleClose(e) {
            this._unbindInput();
            this._stopPresencePing();
            this._stopStats();
            this._closeVideoDecoder();
            if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
            this._connected = false;
            const reason = (e && e.reason) || 'closed';
            console.log('[CDAP] socket closed', e && e.code, reason);
            this._setState('disconnected');
            this._emit('disconnected', reason);
        }

        _handleMessage(event) {
            // Binary fast path: encoded frame bytes. Route to the video
            // decoder for codec streams (h264/vp9/av1) or the image path for
            // MJPEG/WebP, based on the format last reported via desktop_meta.
            if (event.data instanceof ArrayBuffer) {
                if (isVideoCodec(this._activeFormat)) {
                    this._feedVideoFrame(event.data);
                } else {
                    this._renderBinaryFrame(event.data);
                }
                return;
            }
            let msg;
            try { msg = JSON.parse(event.data); }
            catch { return; }
            this._dispatchControl(msg);
        }

        _dispatchControl(msg) {
            switch (msg.type) {
                case 'ready':
                    if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
                    this._sessionId = msg.session_id || null;
                    this._connected = true;
                    this._setState('streaming');
                    this._bindInput();
                    this._startStats();
                    this._emit('login_success');
                    this._emit('session_start');
                    this._emit('log', 'Streaming');
                    console.log('[CDAP] ready, session=', this._sessionId);
                    break;

                case 'desktop_meta':
                    if (msg.width && msg.height) {
                        if (this.canvas.width !== msg.width)  this.canvas.width  = msg.width;
                        if (this.canvas.height !== msg.height) this.canvas.height = msg.height;
                    }
                    this._applyFormat(msg.format, msg.codec_string);
                    break;

                case 'frame':
                    // Legacy JSON frame envelope (data URI / base64 jpeg).
                    if (msg.data) this._renderEncodedFrame(msg);
                    break;

                case 'cursor_update':
                    this._applyCursor(msg);
                    break;

                case 'clipboard_update':
                    this._handleClipboardUpdate(msg);
                    break;

                case 'monitor_list': {
                    // Agent reports the available displays. Cache and notify
                    // remote.js so the toolbar can populate its dropdown.
                    const list = Array.isArray(msg.monitors) ? msg.monitors : [];
                    this._monitors = list.map((m, idx) => ({
                        idx: typeof m.idx === 'number' ? m.idx : idx,
                        name: m.name || `Monitor ${idx + 1}`,
                        primary: !!m.primary,
                        width: m.width | 0,
                        height: m.height | 0,
                    }));
                    if (typeof msg.active === 'number') this._activeMonitor = msg.active;
                    console.log('[CDAP] monitor_list', this._monitors);
                    this._emit('monitors', this._monitors);
                    break;
                }

                case 'codec_answer':
                case 'quality_adjust':
                    // Informational only.
                    break;

                case 'consent_required':
                case 'permission_required':
                    this._emit('log', msg.message || 'Awaiting user consent on the device…');
                    console.log('[CDAP] consent_required', msg);
                    break;

                case 'error':
                    if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
                    console.error('[CDAP] error', msg);
                    this._emit('error', msg.error || msg.message || 'CDAP error');
                    break;

                case 'end':
                    if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
                    console.log('[CDAP] end', msg);
                    this._setState('disconnected');
                    this._emit('disconnected', msg.reason || 'agent_end');
                    break;

                default:
                    // Surface unknown types in dev tools so we can spot
                    // protocol drift between agent and gateway quickly.
                    console.debug('[CDAP] unhandled message', msg.type, msg);
                    break;
            }
        }

        // ── Frame rendering ──────────────────────────────────────────────

        _renderBinaryFrame(buf) {
            const mime = this._activeFormat === 'webp' ? 'image/webp' : 'image/jpeg';
            const blob = new Blob([buf], { type: mime });
            this._frameCount++;
            this._frameBytes += buf.byteLength;
            this._lastFrameTime = performance.now();
            // Prefer createImageBitmap (off-thread decode); fall back to Image.
            if (typeof createImageBitmap === 'function') {
                createImageBitmap(blob).then(bm => {
                    if (bm.width !== this.canvas.width || bm.height !== this.canvas.height) {
                        if (bm.width > 0 && bm.height > 0) {
                            this.canvas.width = bm.width;
                            this.canvas.height = bm.height;
                        }
                    }
                    try { this.ctx.drawImage(bm, 0, 0); } catch { /* noop */ }
                    bm.close && bm.close();
                }).catch(() => { /* drop frame on decode error */ });
            } else {
                const url = URL.createObjectURL(blob);
                const img = new Image();
                img.onload = () => {
                    try {
                        if (img.width !== this.canvas.width || img.height !== this.canvas.height) {
                            this.canvas.width = img.width;
                            this.canvas.height = img.height;
                        }
                        this.ctx.drawImage(img, 0, 0);
                    } catch { /* noop */ }
                    URL.revokeObjectURL(url);
                };
                img.onerror = () => URL.revokeObjectURL(url);
                img.src = url;
            }
        }

        // ── Video decode pipeline (WebCodecs / JMuxer-MSE) ───────────────

        /**
         * React to a format change announced by the agent (`desktop_meta`).
         * Tears down or (re)creates the video decoder as needed so the binary
         * frame path knows whether to feed the codec decoder or the image
         * decoder.
         * @param {string} [format] e.g. 'h264' | 'vp9' | 'av1' | 'webp' | 'jpeg'
         * @param {string} [codecString] WebCodecs codec string from the agent
         */
        _applyFormat(format, codecString) {
            const fmt = (format || this._activeFormat || 'jpeg').toLowerCase();
            if (fmt === this._activeFormat && codecString === this._codecString) return;
            const prevWasVideo = isVideoCodec(this._activeFormat);
            this._activeFormat = fmt;
            this._codecString = codecString || null;
            this._gotKeyframe = false;

            if (isVideoCodec(fmt)) {
                this._ensureVideoDecoder(fmt);
            } else if (prevWasVideo) {
                // Switched back to an image format — release the decoder.
                this._closeVideoDecoder();
            }
        }

        /**
         * Lazily create the shared `RDVideo` decoder (WebCodecs when secure,
         * JMuxer/MSE H.264 otherwise) and bind its decoded-frame callback to
         * the canvas.
         * @param {string} codecName
         */
        _ensureVideoDecoder(codecName) {
            if (typeof RDVideo === 'undefined') {
                console.warn('[CDAP] RDVideo unavailable — cannot decode', codecName);
                return;
            }
            if (this._video && this._video.currentCodec === codecName && this._video.initialized) {
                return;
            }
            this._closeVideoDecoder();
            const v = new RDVideo();
            this._video = v;
            v.onFrame = (frame) => this._drawVideoFrame(frame);
            v.onError = () => {
                // A decode error usually means we fed a delta frame before the
                // first keyframe — ask the agent for a fresh keyframe.
                this._gotKeyframe = false;
                this._requestKeyframe();
            };
            v.init(codecName).catch((err) => {
                console.warn('[CDAP] video decoder init failed:', err && err.message);
                this._video = null;
            });
        }

        /**
         * Feed one binary video frame to the decoder. The agent prefixes each
         * access unit with a single flag byte (bit0 = keyframe); the Node proxy
         * has already stripped the 64-byte session id prefix.
         * @param {ArrayBuffer} buf
         */
        _feedVideoFrame(buf) {
            const bytes = new Uint8Array(buf);
            if (bytes.length < 2) return;
            const isKey = (bytes[0] & 1) === 1;
            const payload = bytes.subarray(1);

            this._frameCount++;
            this._frameBytes += buf.byteLength;
            this._lastFrameTime = performance.now();

            if (!this._video) {
                this._ensureVideoDecoder(this._activeFormat);
                if (!this._video) return;
            }
            // Wait for the first keyframe before feeding the decoder; delta
            // frames decoded without a reference produce errors/artifacts.
            if (!this._gotKeyframe) {
                if (!isKey) {
                    this._requestKeyframe();
                    return;
                }
                this._gotKeyframe = true;
            }

            this._video.decode({ data: payload, key: isKey, codec: this._activeFormat });
        }

        /**
         * Draw a decoded frame (WebCodecs `VideoFrame` or JMuxer `<video>`
         * proxy) onto the canvas, resizing it to the frame dimensions.
         * @param {Object} frame
         */
        _drawVideoFrame(frame) {
            try {
                const w = frame.displayWidth || this.canvas.width;
                const h = frame.displayHeight || this.canvas.height;
                if (w > 0 && h > 0 && (this.canvas.width !== w || this.canvas.height !== h)) {
                    this.canvas.width = w;
                    this.canvas.height = h;
                }
                const src = frame._source || frame;
                this.ctx.drawImage(src, 0, 0, this.canvas.width, this.canvas.height);
            } catch { /* drop frame on draw error */ }
            finally {
                try { frame.close && frame.close(); } catch { /* noop */ }
            }
        }

        /** Ask the agent to emit a fresh keyframe (throttled to ~1/s). */
        _requestKeyframe() {
            const now = performance.now();
            if (now - this._keyframeRequestedAt < 1000) return;
            this._keyframeRequestedAt = now;
            this._send({ type: 'keyframe_request' });
        }

        /** Tear down the video decoder and release GPU/DOM resources. */
        _closeVideoDecoder() {
            if (this._video) {
                try { this._video.close(); } catch { /* noop */ }
                this._video = null;
            }
            this._gotKeyframe = false;
        }

        _renderEncodedFrame(msg) {
            const fmt = msg.format || 'jpeg';
            const src = msg.data.startsWith('data:') ? msg.data : `data:image/${fmt};base64,${msg.data}`;
            this._frameCount++;
            this._lastFrameTime = performance.now();
            const img = new Image();
            img.onload = () => {
                try {
                    if (msg.width && this.canvas.width !== msg.width) this.canvas.width = msg.width;
                    if (msg.height && this.canvas.height !== msg.height) this.canvas.height = msg.height;
                    this.ctx.drawImage(img, 0, 0);
                } catch { /* noop */ }
            };
            img.src = src;
        }

        // ── Cursor + clipboard ───────────────────────────────────────────

        _applyCursor(msg) {
            if (msg.hidden) {
                this.canvas.style.cursor = 'none';
                return;
            }
            // Best-effort: leave system cursor visible. Custom cursor PNG
            // assembly mirrors `cdap-desktop.js` but is costly per frame;
            // CDAP cursor frames are infrequent so this can be added in a
            // follow-up without affecting steady-state perf.
            this.canvas.style.cursor = 'default';
        }

        _handleClipboardUpdate(msg) {
            // Mirror device → operator clipboard when the agent allows it.
            const text = msg.text;
            if (!text) return;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).catch(() => { /* permission denied */ });
            }
            this._emit('clipboard', text);
        }

        // ── Input ────────────────────────────────────────────────────────

        _bindInput() {
            if (this._inputBound) return;
            const c = this.canvas;
            c.addEventListener('mousedown',   this._onMouseDown);
            c.addEventListener('mouseup',     this._onMouseUp);
            c.addEventListener('mousemove',   this._onMouseMove);
            c.addEventListener('wheel',       this._onWheel, { passive: false });
            c.addEventListener('contextmenu', this._onContextMenu);
            c.addEventListener('paste',       this._onPaste);
            document.addEventListener('keydown', this._onKeyDown);
            document.addEventListener('keyup',   this._onKeyUp);
            c.tabIndex = 0;
            c.focus();
            this._inputBound = true;
        }

        _unbindInput() {
            if (!this._inputBound) return;
            const c = this.canvas;
            c.removeEventListener('mousedown',   this._onMouseDown);
            c.removeEventListener('mouseup',     this._onMouseUp);
            c.removeEventListener('mousemove',   this._onMouseMove);
            c.removeEventListener('wheel',       this._onWheel);
            c.removeEventListener('contextmenu', this._onContextMenu);
            c.removeEventListener('paste',       this._onPaste);
            document.removeEventListener('keydown', this._onKeyDown);
            document.removeEventListener('keyup',   this._onKeyUp);
            this._inputBound = false;
        }

        _isInputFocused() {
            const el = document.activeElement;
            if (!el) return false;
            // Hidden inputs (e.g. password field after authenticate) do
            // not block keyboard capture.
            if (el.offsetParent === null) return false;
            const tag = el.tagName;
            return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
        }

        _coords(e) {
            const rect = this.canvas.getBoundingClientRect();
            return {
                x: Math.round((e.clientX - rect.left) / rect.width  * this.canvas.width),
                y: Math.round((e.clientY - rect.top)  / rect.height * this.canvas.height),
            };
        }

        _mouseButton(e) {
            if (e.button === 0) return MOUSE_BUTTON_LEFT;
            if (e.button === 2) return MOUSE_BUTTON_RIGHT;
            if (e.button === 1) return MOUSE_BUTTON_MIDDLE;
            return 0;
        }

        _handleMouseDown(e) {
            if (!this._connected) return;
            const { x, y } = this._coords(e);
            const btn = this._mouseButton(e);
            this._send({ type: 'input', input_type: 'mouse', x, y, button: MOUSE_TYPE_DOWN | (btn << 3) });
            e.preventDefault();
            this.canvas.focus();
        }
        _handleMouseUp(e) {
            if (!this._connected) return;
            const { x, y } = this._coords(e);
            const btn = this._mouseButton(e);
            this._send({ type: 'input', input_type: 'mouse', x, y, button: MOUSE_TYPE_UP | (btn << 3) });
            e.preventDefault();
        }
        _handleMouseMove(e) {
            if (!this._connected) return;
            const { x, y } = this._coords(e);
            this._send({ type: 'input', input_type: 'mouse', x, y, button: MOUSE_TYPE_MOVE });
        }
        _handleWheel(e) {
            if (!this._connected) return;
            const { x, y } = this._coords(e);
            const delta = normalizeWheelDelta(e);
            if (!delta) return;
            this._send({
                type: 'input', input_type: 'mouse',
                x, y,
                deltaX: delta.dx,
                deltaY: delta.dy,
                button: MOUSE_TYPE_WHEEL,
            });
            e.preventDefault();
        }

        _handleKeyDown(e) {
            if (!this._connected) return;
            if (this._isInputFocused()) return;
            // Phase 3.1: drop OS-level auto-repeat — the agent synthesises
            // repeats on the remote side.
            if (e.repeat) { e.preventDefault(); return; }
            // Phase 3.1: Unicode → text fallback (modifierless single
            // printable non-alphanumeric char gets routed via input_type:
            // text so the agent's OS-side layout handles it).
            if (typeof e.key === 'string' && e.key.length === 1
                && !e.ctrlKey && !e.altKey && !e.metaKey) {
                const cc = e.key.charCodeAt(0);
                const printable = cc >= 0x20 && cc !== 0x7F;
                const ascii = cc < 0x80;
                const isAlphaNum = ascii && (
                    (cc >= 0x30 && cc <= 0x39) ||
                    (cc >= 0x41 && cc <= 0x5A) ||
                    (cc >= 0x61 && cc <= 0x7A)
                );
                if (printable && (!isAlphaNum || !ascii)) {
                    this._send({ type: 'input', input_type: 'text', text: e.key });
                    e.preventDefault();
                    return;
                }
            }
            this._sendKeyEvent(e, true);
            e.preventDefault();
        }
        _handleKeyUp(e) {
            if (!this._connected) return;
            if (this._isInputFocused()) return;
            this._sendKeyEvent(e, false);
            e.preventDefault();
        }

        _sendKeyEvent(e, down) {
            this._send({
                type: 'input',
                input_type: 'keyboard',
                key: e.key,
                code: e.code,
                modifiers: {
                    ctrl: e.ctrlKey,
                    alt: e.altKey,
                    shift: e.shiftKey,
                    meta: e.metaKey,
                },
                down,
            });
        }

        _handlePaste(e) {
            if (!this._connected) return;
            const text = e.clipboardData?.getData('text/plain');
            if (text) this._send({ type: 'input', input_type: 'text', text });
            e.preventDefault();
        }

        // ── Public helpers used by `remote.js` toolbar (Paste / Text) ────

        sendText(text) {
            if (!this._connected || !text) return false;
            this._send({ type: 'input', input_type: 'text', text: String(text) });
            return true;
        }

        async pasteFromClipboard() {
            if (!navigator.clipboard || !navigator.clipboard.readText) return false;
            try {
                const text = await navigator.clipboard.readText();
                if (!text) return false;
                return this.sendText(text);
            } catch {
                return false;
            }
        }

        // ── Wire helpers ─────────────────────────────────────────────────

        _send(payload) {
            const ws = this._ws;
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(payload));
            }
        }

        _qualityFromLabel(label) {
            switch (String(label || '').toLowerCase()) {
                case 'best':     return 92;
                case 'low':      return 50;
                case 'speed':    return 50;
                case 'balanced':
                default:         return 75;
            }
        }
        _normaliseFps(fps) {
            const n = Number(fps);
            if (!Number.isFinite(n) || n <= 0) return 30;
            return Math.min(60, Math.max(5, Math.round(n)));
        }

        // ── Presence ping (Phase 3.5) ────────────────────────────────────

        _startPresencePing() {
            this._stopPresencePing();
            this._presenceTimer = setInterval(() => {
                this._send({ type: 'ping', t: Date.now() });
            }, PRESENCE_PING_MS);
        }
        _stopPresencePing() {
            if (this._presenceTimer) {
                clearInterval(this._presenceTimer);
                this._presenceTimer = null;
            }
        }

        // ── Stats (1s aggregate, fed to the toolbar) ─────────────────────

        _startStats() {
            this._stopStats();
            this._lastStatsTime = performance.now();
            this._statsTimer = setInterval(() => {
                const now = performance.now();
                const dt = (now - this._lastStatsTime) / 1000;
                if (dt <= 0) return;
                const fps = this._frameCount / dt;
                const kbps = (this._frameBytes * 8 / 1000) / dt;
                this._frameCount = 0;
                this._frameBytes = 0;
                this._lastStatsTime = now;
                this._emit('stats', {
                    fps: Math.round(fps * 10) / 10,
                    kbps: Math.round(kbps),
                    transport: 'cdap',
                });
            }, STATS_INTERVAL_MS);
        }
        _stopStats() {
            if (this._statsTimer) {
                clearInterval(this._statsTimer);
                this._statsTimer = null;
            }
        }
    }

    window.CDAPSession = CDAPSession;
})();
