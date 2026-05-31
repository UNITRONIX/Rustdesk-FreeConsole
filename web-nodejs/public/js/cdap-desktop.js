/**
 * BetterDesk Console — CDAP Remote Desktop Widget
 * Provides interactive remote desktop access to CDAP devices via WebSocket.
 * Renders screen frames on canvas and relays mouse/keyboard input.
 * Supports: clipboard sync, custom cursors, quality reporting, codec
 * negotiation, multi-monitor selection, and keyframe requests.
 */

(function () {
    'use strict';

    const activeSessions = {};

    // ── Mouse encoding (matching RustDesk mask format) ───────────────────

    const MOUSE_TYPE_DOWN  = 1;
    const MOUSE_TYPE_UP    = 2;
    const MOUSE_TYPE_MOVE  = 0;
    const MOUSE_TYPE_WHEEL = 3;

    const MOUSE_BUTTON_LEFT   = 1;
    const MOUSE_BUTTON_RIGHT  = 2;
    const MOUSE_BUTTON_MIDDLE = 4;

    // Quality reporting interval (ms)
    const QUALITY_REPORT_INTERVAL = 5000;
    // Presence ping interval (ms) — paired with the 30s server-side dead-man
    // switch in api/cdap_handlers.go. Half the timeout gives one missed ping
    // of slack before the server tears the session down.
    const PRESENCE_PING_INTERVAL = 15000;
    // Cursor cache limit
    const CURSOR_CACHE_MAX = 50;

    // ── Codec capability detection ───────────────────────────────────────
    //
    // The agent picks an encoder by intersecting its own ability with the
    // list the operator advertises here. MJPEG ('jpeg') and WebP decode
    // through the standard image pipeline (Blob + createImageBitmap) and are
    // always safe. The hardware video codecs (h264/vp9/av1) require the
    // WebCodecs `VideoDecoder` API, which browsers only expose in a secure
    // context (HTTPS / localhost). When unavailable we simply omit them and
    // the agent transparently falls back to image codecs.

    const HAS_VIDEO_DECODER =
        typeof window !== 'undefined' &&
        window.isSecureContext &&
        typeof window.VideoDecoder !== 'undefined';

    // Media Source Extensions H.264 fallback. Unlike WebCodecs, MSE does NOT
    // require a secure context, so this unlocks GPU-accelerated H.264 over
    // plain HTTP (no HTTPS / domain / certificate). Decoding is delegated to
    // the shared RDVideo class (JMuxer/MSE machinery). Available only when
    // both the RDVideo helper and JMuxer library are loaded on the page.
    function hasMseH264() {
        return typeof window !== 'undefined' &&
            typeof window.RDVideo !== 'undefined' &&
            typeof window.JMuxer !== 'undefined' &&
            typeof window.MediaSource !== 'undefined' &&
            typeof window.MediaSource.isTypeSupported === 'function' &&
            window.MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"');
    }

    const HAS_MSE_H264 = hasMseH264();

    // WebCodecs codec strings used to configure a VideoDecoder when the
    // agent does not supply an explicit `codec_string` in desktop_meta.
    const DEFAULT_CODEC_STRINGS = {
        h264: 'avc1.42E01E',
        vp9: 'vp09.00.10.08',
        av1: 'av01.0.04M.08'
    };

    // Returns the codec list the operator can decode, ordered by preference.
    // Image codecs first guarantees a working stream everywhere; video
    // codecs are appended only when WebCodecs is available.
    function decodableCodecs() {
        const list = [];
        if (HAS_VIDEO_DECODER) {
            // Secure context — full WebCodecs decode of every codec.
            // Most-efficient first; the agent honours its own ordering too.
            list.push('av1', 'vp9', 'h264');
        } else if (HAS_MSE_H264) {
            // Plain HTTP — advertise H.264 so the agent still streams a
            // GPU-encoded bitstream (decoded via JMuxer/MSE) instead of
            // dropping to slow MJPEG. AV1/VP9 require WebCodecs (HTTPS).
            list.push('h264');
        }
        list.push('webp', 'jpeg');
        return list;
    }

    function isVideoCodec(fmt) {
        return fmt === 'h264' || fmt === 'vp9' || fmt === 'av1';
    }

    // ── Desktop Session Manager ──────────────────────────────────────────

    function openDesktop(deviceId, widgetId) {
        const key = `${deviceId}:${widgetId}`;
        if (activeSessions[key]) return;

        const widgetEl = document.getElementById(`wval-${CSS.escape(widgetId)}`);
        if (!widgetEl) return;

        const canvas = widgetEl.querySelector('.cdap-desktop-canvas');
        const overlay = widgetEl.querySelector('.cdap-desktop-overlay');
        if (!canvas) return;

        const ctx = canvas.getContext('2d');

        // Show connecting state
        if (overlay) {
            overlay.querySelector('span:last-child').textContent = 'Connecting...';
        }

        // Open WebSocket
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${window.location.host}/api/cdap/devices/${encodeURIComponent(deviceId)}/desktop`;
        let ws;
        try {
            ws = new WebSocket(wsUrl, ['cdap-desktop']);
            // Binary frames carry raw JPEG bytes (no base64, no JSON envelope)
            // for the desktop fast path. Anything else is JSON text.
            ws.binaryType = 'arraybuffer';
        } catch (err) {
            console.error('[CDAPDesktop] WS creation failed:', err);
            return;
        }

        const session = {
            ws,
            canvas,
            ctx,
            overlay,
            widgetEl,
            widgetId,
            deviceId,
            sessionId: null,
            connected: false,
            // Match the actual physical screen if available; the agent may
            // override these in 'ready' / frame messages with the real size.
            width: (window.screen && window.screen.width) || 1920,
            height: (window.screen && window.screen.height) || 1080,
            _frameImg: new Image(),
            // Quality reporting
            _frameCount: 0,
            _frameBytes: 0,
            _lastFrameTime: 0,
            _droppedFrames: 0,
            _qualityTimer: null,
            // Custom cursor
            _cursorCache: {},
            _cursorCacheKeys: [],
            // Monitor list
            _monitors: [],
            _activeMonitor: 0,
            // Codec
            _videoCodec: null,
            _audioCodec: null,
            // Active desktop stream format ('jpeg' | 'webp' | 'h264' | 'vp9' |
            // 'av1'), taken from the most recent desktop_meta. Defaults to
            // jpeg so legacy agents that never send desktop_meta still render.
            _activeFormat: 'jpeg',
            _codecString: null,
            // WebCodecs decoder state for video codecs.
            _videoDecoder: null,
            _videoDecoderCodec: null,
            _gotKeyframe: false,
            // RDVideo (JMuxer/MSE) decoder used for H.264 over plain HTTP.
            _rdVideo: null,
            // Clipboard
            _clipboardEnabled: true
        };
        activeSessions[key] = session;

        ws.onopen = () => {
            // Send init message with desired resolution.
            // quality 75 + 30 fps targets a smooth helpdesk experience on
            // LAN; the agent will throttle if CPU/bandwidth cannot keep up.
            // Frames are delivered over the binary WS fast path (no base64).
            //
            // Hi-DPI awareness (Phase 3.6): report the browser's pixel
            // ratio and the canvas's CSS pixel size so the agent can
            // capture at the operator's effective resolution and avoid
            // double-scaling on Retina/4K displays. Unknown fields are
            // ignored by older agents.
            const dpr = window.devicePixelRatio || 1;
            const rect = session.canvas.getBoundingClientRect();
            ws.send(JSON.stringify({
                width: session.width,
                height: session.height,
                quality: 75,
                fps: 30,
                device_pixel_ratio: dpr,
                client_css_width: Math.round(rect.width || 0),
                client_css_height: Math.round(rect.height || 0),
                // Advertise the codecs this browser can decode so the agent
                // can pick a hardware-accelerated encoder. Older agents
                // ignore the field and keep streaming MJPEG.
                webcodecs: HAS_VIDEO_DECODER,
                codecs: decodableCodecs(),
                video_codec: 'auto'
            }));
            // Start sending presence pings every 15s. The Go server's
            // desktop read loop has a 30s deadline; missing pings cause
            // an automatic teardown so a crashed operator browser does
            // not leave the agent capturing forever.
            startPresencePing(session);
        };

        ws.onmessage = (event) => {
            // Binary fast path: raw JPEG bytes from the agent.
            if (event.data instanceof ArrayBuffer) {
                renderBinaryFrame(session, event.data);
                return;
            }
            try {
                const msg = JSON.parse(event.data);
                handleMessage(session, msg);
            } catch (_) {
                // Ignore non-JSON
            }
        };

        ws.onerror = () => {
            console.error('[CDAPDesktop] WS error for', deviceId);
        };

        ws.onclose = () => {
            if (activeSessions[key]) {
                setDisconnected(session);
                delete activeSessions[key];
            }
        };

        // Bind input events
        bindInputEvents(session);
    }

    function handleMessage(session, msg) {
        switch (msg.type) {
            case 'ready':
                session.sessionId = msg.session_id;
                session.connected = true;
                // Hide overlay
                if (session.overlay) {
                    session.overlay.classList.add('hidden');
                }
                // Start quality reporting
                startQualityReporting(session);
                // Send codec offer
                sendCodecOffer(session);
                break;

            case 'frame':
                renderFrame(session, msg);
                break;

            case 'desktop_meta':
                // First binary frame is about to start — size the canvas
                // to the agent's true capture dimensions so we don't
                // stretch and the input coordinates map 1:1.
                if (msg.width && msg.height) {
                    if (session.canvas.width !== msg.width || session.canvas.height !== msg.height) {
                        session.canvas.width = msg.width;
                        session.canvas.height = msg.height;
                    }
                    session.width = msg.width;
                    session.height = msg.height;
                }
                // Track the stream format so renderBinaryFrame knows whether
                // the following binary frames are images (jpeg/webp) or a
                // compressed video bitstream (h264/vp9/av1).
                {
                    const fmt = (msg.format || 'jpeg').toLowerCase();
                    if (fmt !== session._activeFormat) {
                        session._activeFormat = fmt;
                        session._codecString = msg.codec_string || null;
                        // Switching codecs invalidates any existing decoder.
                        closeVideoDecoder(session);
                        session._gotKeyframe = false;
                    } else if (msg.codec_string) {
                        session._codecString = msg.codec_string;
                    }
                }
                break;

            case 'cursor_update':
                applyCursor(session, msg);
                break;

            case 'clipboard_update':
                handleClipboardUpdate(session, msg);
                break;

            case 'codec_answer':
                session._videoCodec = msg.video_codec || null;
                session._audioCodec = msg.audio_codec || null;
                break;

            case 'monitor_list':
                handleMonitorList(session, msg);
                break;

            case 'quality_adjust':
                // Server-initiated quality change — informational only
                break;

            case 'error':
                console.error('[CDAPDesktop] Error:', msg.error);
                if (session.overlay) {
                    session.overlay.classList.remove('hidden');
                    const label = session.overlay.querySelector('span:last-child');
                    if (label) label.textContent = msg.error || 'Remote desktop error';
                }
                break;

            case 'end':
                setDisconnected(session);
                closeDesktop(session.deviceId, session.widgetId);
                break;
        }
    }

    // ── Frame Rendering ──────────────────────────────────────────────────

    // renderBinaryFrame decodes a raw JPEG buffer received over the binary
    // WS fast path and paints it onto the session canvas. createImageBitmap
    // is async-decoded off the main thread and is significantly faster than
    // the legacy data-URL+Image() path — critical for hitting 30+ fps.
    function renderBinaryFrame(session, buffer) {
        session._frameCount++;
        session._frameBytes += buffer.byteLength;
        session._lastFrameTime = Date.now();

        // Video bitstreams (h264/vp9/av1) carry a 1-byte flag header
        // (bit0 = keyframe) followed by the access unit. They are decoded
        // through WebCodecs instead of the image pipeline.
        if (isVideoCodec(session._activeFormat)) {
            decodeVideoFrame(session, buffer);
            return;
        }

        // Drop frames if the previous decode is still pending. Painting old
        // frames over fresher ones would only add latency.
        if (session._decodeInFlight) {
            session._droppedFrames++;
            return;
        }
        session._decodeInFlight = true;

        const mime = session._activeFormat === 'webp' ? 'image/webp' : 'image/jpeg';
        const blob = new Blob([buffer], { type: mime });
        createImageBitmap(blob)
            .then((bitmap) => {
                const { canvas, ctx } = session;
                if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                    canvas.width = bitmap.width;
                    canvas.height = bitmap.height;
                    session.width = bitmap.width;
                    session.height = bitmap.height;
                }
                ctx.drawImage(bitmap, 0, 0);
                if (typeof bitmap.close === 'function') bitmap.close();
            })
            .catch(() => {
                session._droppedFrames++;
            })
            .finally(() => {
                session._decodeInFlight = false;
            });
    }

    // ── WebCodecs Video Decode (h264 / vp9 / av1) ────────────────────────

    // Lazily creates (or recreates) a VideoDecoder for the session's active
    // codec. Decoded frames are painted straight onto the canvas. On any
    // configuration/decode error we tear the decoder down and ask the agent
    // for a fresh keyframe so the next IDR can restart decoding.
    function ensureVideoDecoder(session) {
        if (!HAS_VIDEO_DECODER) return null;
        if (session._videoDecoder && session._videoDecoderCodec === session._activeFormat) {
            return session._videoDecoder;
        }
        closeVideoDecoder(session);

        const codecString =
            session._codecString || DEFAULT_CODEC_STRINGS[session._activeFormat];
        if (!codecString) return null;

        let decoder;
        try {
            decoder = new window.VideoDecoder({
                output: (frame) => {
                    try {
                        const { canvas, ctx } = session;
                        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                            canvas.width = frame.displayWidth;
                            canvas.height = frame.displayHeight;
                            session.width = frame.displayWidth;
                            session.height = frame.displayHeight;
                        }
                        ctx.drawImage(frame, 0, 0);
                    } catch (_) {
                        session._droppedFrames++;
                    } finally {
                        frame.close();
                    }
                },
                error: () => {
                    // Decoder hit an unrecoverable error — drop it and
                    // request a keyframe to rebuild state.
                    closeVideoDecoder(session);
                    session._gotKeyframe = false;
                    requestKeyframe(session.deviceId, session.widgetId);
                }
            });
            decoder.configure({ codec: codecString, optimizeForLatency: true });
        } catch (err) {
            console.warn('[CDAPDesktop] VideoDecoder configure failed:', err);
            return null;
        }

        session._videoDecoder = decoder;
        session._videoDecoderCodec = session._activeFormat;
        return decoder;
    }

    function decodeVideoFrame(session, buffer) {
        // Plain-HTTP fast path: no WebCodecs, but H.264 can still be GPU
        // decoded through JMuxer/MSE via the shared RDVideo helper.
        if (!HAS_VIDEO_DECODER && HAS_MSE_H264 && session._activeFormat === 'h264') {
            decodeVideoFrameMse(session, buffer);
            return;
        }

        const decoder = ensureVideoDecoder(session);
        if (!decoder) {
            session._droppedFrames++;
            return;
        }

        const bytes = new Uint8Array(buffer);
        if (bytes.length < 2) return;
        const isKey = (bytes[0] & 0x01) === 1;
        const payload = bytes.subarray(1);

        // A decoder can only start from a keyframe. Skip delta frames until
        // the first IDR arrives, and proactively ask for one if needed.
        if (!session._gotKeyframe) {
            if (!isKey) {
                session._droppedFrames++;
                if (!session._keyframeRequested) {
                    session._keyframeRequested = true;
                    requestKeyframe(session.deviceId, session.widgetId);
                }
                return;
            }
            session._gotKeyframe = true;
            session._keyframeRequested = false;
        }

        try {
            const chunk = new window.EncodedVideoChunk({
                type: isKey ? 'key' : 'delta',
                timestamp: (session._frameCount * 1000000) / 30,
                data: payload
            });
            decoder.decode(chunk);
        } catch (err) {
            session._droppedFrames++;
            closeVideoDecoder(session);
            session._gotKeyframe = false;
        }
    }

    // ── MSE / JMuxer H.264 Decode (plain HTTP, no secure context) ────────

    // Lazily creates an RDVideo decoder bound to the session canvas. RDVideo
    // wraps JMuxer/MSE which the browser hardware-accelerates without a
    // secure context, making smooth H.264 possible over plain HTTP.
    function ensureRdVideo(session) {
        if (session._rdVideo && session._rdVideo.initialized) {
            return session._rdVideo;
        }
        if (typeof window.RDVideo === 'undefined') return null;

        const v = new window.RDVideo();
        v.onFrame = (frame) => {
            try {
                const { canvas, ctx } = session;
                const w = frame.displayWidth || canvas.width;
                const h = frame.displayHeight || canvas.height;
                if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
                    canvas.width = w;
                    canvas.height = h;
                    session.width = w;
                    session.height = h;
                }
                ctx.drawImage(frame._source || frame, 0, 0, canvas.width, canvas.height);
            } catch (_) {
                session._droppedFrames++;
            } finally {
                try { frame.close && frame.close(); } catch (_) { /* ignore */ }
            }
        };
        v.onError = () => {
            session._gotKeyframe = false;
            if (!session._keyframeRequested) {
                session._keyframeRequested = true;
                requestKeyframe(session.deviceId, session.widgetId);
            }
        };
        v.init('h264').catch(() => { session._rdVideo = null; });
        session._rdVideo = v;
        return v;
    }

    // Feeds one H.264 access unit (1-byte keyframe flag + Annex-B AU) into the
    // RDVideo / JMuxer decoder.
    function decodeVideoFrameMse(session, buffer) {
        const v = ensureRdVideo(session);
        if (!v) {
            session._droppedFrames++;
            return;
        }
        const bytes = new Uint8Array(buffer);
        if (bytes.length < 2) return;
        const isKey = (bytes[0] & 0x01) === 1;
        const payload = bytes.subarray(1);

        if (!session._gotKeyframe) {
            if (!isKey) {
                session._droppedFrames++;
                if (!session._keyframeRequested) {
                    session._keyframeRequested = true;
                    requestKeyframe(session.deviceId, session.widgetId);
                }
                return;
            }
            session._gotKeyframe = true;
            session._keyframeRequested = false;
        }

        try {
            v.decode({ data: payload, key: isKey, codec: 'h264' });
        } catch (_) {
            session._droppedFrames++;
        }
    }

    function closeVideoDecoder(session) {
        if (session._videoDecoder) {
            try {
                if (session._videoDecoder.state !== 'closed') {
                    session._videoDecoder.close();
                }
            } catch (_) { /* ignore */ }
            session._videoDecoder = null;
            session._videoDecoderCodec = null;
        }
        if (session._rdVideo) {
            try { session._rdVideo.close(); } catch (_) { /* ignore */ }
            session._rdVideo = null;
        }
    }

    function renderFrame(session, msg) {
        if (!msg.data) return;

        const { canvas, ctx, _frameImg } = session;
        const format = msg.format || 'jpeg';

        // Track quality stats
        session._frameCount++;
        session._frameBytes += msg.data.length * 0.75; // approximate decoded size
        session._lastFrameTime = Date.now();

        // Resize canvas if frame dimensions changed
        if (msg.width && msg.height) {
            if (canvas.width !== msg.width || canvas.height !== msg.height) {
                canvas.width = msg.width;
                canvas.height = msg.height;
            }
        }

        // Render base64-encoded frame
        const src = `data:image/${format};base64,${msg.data}`;
        const img = _frameImg;
        img.onload = () => {
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        };
        img.onerror = () => {
            session._droppedFrames++;
        };
        img.src = src;
    }

    // ── Custom Cursor ────────────────────────────────────────────────────

    function applyCursor(session, msg) {
        const { canvas } = session;

        // Hidden cursor
        if (msg.hidden) {
            canvas.style.cursor = 'none';
            return;
        }

        // Check cache
        if (msg.cursor_id && session._cursorCache[msg.cursor_id]) {
            canvas.style.cursor = session._cursorCache[msg.cursor_id];
            return;
        }

        if (!msg.data || !msg.width || !msg.height) {
            canvas.style.cursor = 'default';
            return;
        }

        const hotX = msg.hotspot_x || 0;
        const hotY = msg.hotspot_y || 0;
        const format = msg.format || 'png';

        if (format === 'png') {
            const cursorUrl = `url(data:image/png;base64,${msg.data}) ${hotX} ${hotY}, auto`;
            canvas.style.cursor = cursorUrl;
            cacheCursor(session, msg.cursor_id, cursorUrl);
        } else if (format === 'rgba') {
            // Convert raw RGBA to canvas → PNG data URL
            try {
                const w = msg.width;
                const h = msg.height;
                const raw = atob(msg.data);
                if (raw.length !== w * h * 4) {
                    canvas.style.cursor = 'default';
                    return;
                }
                const bytes = new Uint8ClampedArray(raw.length);
                for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                const imgData = new ImageData(bytes, w, h);
                const tmpCanvas = document.createElement('canvas');
                tmpCanvas.width = w;
                tmpCanvas.height = h;
                tmpCanvas.getContext('2d').putImageData(imgData, 0, 0);
                const dataUrl = tmpCanvas.toDataURL('image/png');
                const cursorUrl = `url(${dataUrl}) ${hotX} ${hotY}, auto`;
                canvas.style.cursor = cursorUrl;
                cacheCursor(session, msg.cursor_id, cursorUrl);
            } catch (_) {
                canvas.style.cursor = 'default';
            }
        }
    }

    function cacheCursor(session, cursorId, cursorUrl) {
        if (!cursorId) return;
        session._cursorCache[cursorId] = cursorUrl;
        session._cursorCacheKeys.push(cursorId);
        // Evict old entries
        while (session._cursorCacheKeys.length > CURSOR_CACHE_MAX) {
            const old = session._cursorCacheKeys.shift();
            delete session._cursorCache[old];
        }
    }

    // ── Clipboard Sync ───────────────────────────────────────────────────

    function handleClipboardUpdate(session, msg) {
        if (!session._clipboardEnabled || !msg.data) return;

        // Write to browser clipboard if Clipboard API available
        if (navigator.clipboard && navigator.clipboard.writeText && msg.format === 'text') {
            navigator.clipboard.writeText(msg.data).catch(() => {
                // Permission denied or not focused
            });
        }

        // Show clipboard indicator
        showClipboardIndicator(session, 'in');
    }

    function sendClipboard(session, text) {
        if (!session.connected || !session._clipboardEnabled || !text) return;
        sendMsg(session, {
            type: 'clipboard_set',
            format: 'text',
            data: text
        });
        showClipboardIndicator(session, 'out');
    }

    function showClipboardIndicator(session, direction) {
        const indicator = session.widgetEl?.querySelector('.cdap-desktop-clipboard-indicator');
        if (!indicator) return;
        indicator.classList.remove('hidden', 'clip-in', 'clip-out');
        indicator.classList.add(direction === 'in' ? 'clip-in' : 'clip-out');
        indicator.textContent = direction === 'in' ? '\u2193 Clipboard' : '\u2191 Clipboard';
        setTimeout(() => indicator.classList.add('hidden'), 1500);
    }

    // ── Presence ping (dead-man switch) ──────────────────────────────────

    function startPresencePing(session) {
        if (session._presenceTimer) clearInterval(session._presenceTimer);
        session._presenceTimer = setInterval(() => {
            if (!session.ws || session.ws.readyState !== WebSocket.OPEN) return;
            try {
                session.ws.send(JSON.stringify({
                    type: 'presence_ping',
                    ts: Date.now()
                }));
            } catch { /* ignore — onclose will reset state */ }
        }, PRESENCE_PING_INTERVAL);
    }

    function stopPresencePing(session) {
        if (session._presenceTimer) {
            clearInterval(session._presenceTimer);
            session._presenceTimer = null;
        }
    }

    // ── Quality Reporting ────────────────────────────────────────────────

    function startQualityReporting(session) {
        if (session._qualityTimer) clearInterval(session._qualityTimer);
        session._qrPrevFrames = 0;
        session._qrPrevBytes = 0;
        session._qrPrevDropped = 0;
        session._qrPrevTime = Date.now();

        session._qualityTimer = setInterval(() => sendQualityReport(session), QUALITY_REPORT_INTERVAL);
    }

    function sendQualityReport(session) {
        if (!session.connected || !session.sessionId) return;

        const now = Date.now();
        const elapsed = (now - session._qrPrevTime) / 1000;
        if (elapsed <= 0) return;

        const frames = session._frameCount - session._qrPrevFrames;
        const bytes = session._frameBytes - session._qrPrevBytes;
        const dropped = session._droppedFrames - session._qrPrevDropped;
        const fps = Math.round(frames / elapsed);
        const bandwidthKB = bytes / 1024 / elapsed;
        const frameLoss = frames > 0 ? dropped / (frames + dropped) : 0;

        // Estimate latency from frame timestamps (rough)
        const latencyMs = session._lastFrameTime > 0
            ? Math.max(0, now - session._lastFrameTime)
            : 0;

        sendMsg(session, {
            type: 'quality_report',
            session_id: session.sessionId,
            bandwidth_kb: Math.round(bandwidthKB * 10) / 10,
            latency_ms: latencyMs,
            frame_loss: Math.round(frameLoss * 1000) / 1000,
            fps: fps
        });

        session._qrPrevFrames = session._frameCount;
        session._qrPrevBytes = session._frameBytes;
        session._qrPrevDropped = session._droppedFrames;
        session._qrPrevTime = now;
    }

    // ── Codec Negotiation ────────────────────────────────────────────────

    function sendCodecOffer(session) {
        if (!session.sessionId) return;
        const video = decodableCodecs();
        sendMsg(session, {
            type: 'codec_offer',
            session_id: session.sessionId,
            video: video,
            audio: ['opus', 'pcm'],
            preferred: video[0] || 'jpeg'
        });
    }

    // ── Multi-Monitor ────────────────────────────────────────────────────

    function handleMonitorList(session, msg) {
        session._monitors = msg.monitors || [];
        session._activeMonitor = typeof msg.active === 'number' ? msg.active : 0;

        // Render monitor selector in toolbar
        const toolbar = session.widgetEl?.querySelector('.cdap-desktop-toolbar');
        if (!toolbar || session._monitors.length <= 1) return;

        let selectorEl = toolbar.querySelector('.cdap-monitor-selector');
        if (!selectorEl) {
            selectorEl = document.createElement('div');
            selectorEl.className = 'cdap-monitor-selector';
            toolbar.appendChild(selectorEl);
        }

        let html = '<span class="material-icons">monitor</span><select class="cdap-monitor-select">';
        for (const mon of session._monitors) {
            const label = mon.name || `Monitor ${mon.index + 1}`;
            const dims = `${mon.width}x${mon.height}`;
            const primary = mon.primary ? ' *' : '';
            const selected = mon.index === session._activeMonitor ? ' selected' : '';
            html += `<option value="${mon.index}"${selected}>${label} (${dims})${primary}</option>`;
        }
        html += '</select>';
        selectorEl.innerHTML = html;

        // Bind change event
        const select = selectorEl.querySelector('select');
        select.addEventListener('change', () => {
            const idx = parseInt(select.value, 10);
            selectMonitor(session, idx);
        });
    }

    function selectMonitor(session, index) {
        if (!session.connected || !session.sessionId) return;
        session._activeMonitor = index;
        sendMsg(session, {
            type: 'monitor_select',
            session_id: session.sessionId,
            index: index
        });
    }

    // ── Keyframe Request ─────────────────────────────────────────────────

    function requestKeyframe(deviceId, widgetId) {
        const key = `${deviceId}:${widgetId}`;
        const session = activeSessions[key];
        if (!session || !session.connected || !session.sessionId) return;
        sendMsg(session, {
            type: 'keyframe_request',
            session_id: session.sessionId
        });
    }

    // ── Input Events ─────────────────────────────────────────────────────

    function bindInputEvents(session) {
        const { canvas, ws } = session;

        // Mouse events
        canvas.addEventListener('mousedown', (e) => {
            if (!session.connected) return;
            sendMouseEvent(session, e, MOUSE_TYPE_DOWN);
            e.preventDefault();
        });

        canvas.addEventListener('mouseup', (e) => {
            if (!session.connected) return;
            sendMouseEvent(session, e, MOUSE_TYPE_UP);
            e.preventDefault();
        });

        canvas.addEventListener('mousemove', (e) => {
            if (!session.connected) return;
            sendMouseEvent(session, e, MOUSE_TYPE_MOVE);
        });

        canvas.addEventListener('wheel', (e) => {
            if (!session.connected) return;
            const rect = canvas.getBoundingClientRect();
            const x = Math.round((e.clientX - rect.left) / rect.width * canvas.width);
            const y = Math.round((e.clientY - rect.top) / rect.height * canvas.height);
            sendInput(session, {
                type: 'input',
                input_type: 'mouse',
                x, y,
                deltaX: e.deltaX,
                deltaY: e.deltaY,
                button: MOUSE_TYPE_WHEEL
            });
            e.preventDefault();
        }, { passive: false });

        canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // Keyboard events
        canvas.setAttribute('tabindex', '0');

        canvas.addEventListener('keydown', (e) => {
            if (!session.connected) return;
            // Phase 3.1: drop OS-level auto-repeat. The agent already
            // synthesises repeats on the remote side, and most apps treat
            // 30+ key presses per second as buggy paste-style input.
            if (e.repeat) { e.preventDefault(); return; }
            sendKeyEvent(session, e, 'keydown');
            e.preventDefault();
        });

        canvas.addEventListener('keyup', (e) => {
            if (!session.connected) return;
            sendKeyEvent(session, e, 'keyup');
            e.preventDefault();
        });

        // Clipboard paste (Ctrl+V / Cmd+V)
        canvas.addEventListener('paste', (e) => {
            if (!session.connected || !session._clipboardEnabled) return;
            const text = e.clipboardData?.getData('text/plain');
            if (text) sendClipboard(session, text);
            e.preventDefault();
        });

        // Clipboard copy (Ctrl+C / Cmd+C) — read from navigator.clipboard
        canvas.addEventListener('copy', (e) => {
            // Default browser copy is fine; clipboard_update from device handles inbound
            e.preventDefault();
        });

        // Focus canvas for keyboard input
        canvas.focus();
    }

    function sendMouseEvent(session, e, mouseType) {
        const { canvas } = session;
        const rect = canvas.getBoundingClientRect();
        const x = Math.round((e.clientX - rect.left) / rect.width * canvas.width);
        const y = Math.round((e.clientY - rect.top) / rect.height * canvas.height);

        let button = 0;
        if (e.button === 0) button = MOUSE_BUTTON_LEFT;
        else if (e.button === 2) button = MOUSE_BUTTON_RIGHT;
        else if (e.button === 1) button = MOUSE_BUTTON_MIDDLE;

        sendInput(session, {
            type: 'input',
            input_type: 'mouse',
            x, y,
            button: mouseType | (button << 3)
        });
    }

    function sendKeyEvent(session, e, eventType) {
        // Phase 3.1: when the browser produces a single non-ASCII character
        // (e.g. "ą", "@", "€"), the agent's per-letter VK fallback rejects
        // it. Route those through the `text` input path so the OS handles
        // the layout-aware translation. Only fire on keydown to avoid
        // double insertion. Modifiers are intentionally ignored here —
        // the browser already produced the resolved character.
        if (eventType === 'keydown'
            && typeof e.key === 'string'
            && e.key.length === 1
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
                sendInput(session, {
                    type: 'input',
                    input_type: 'text',
                    text: e.key
                });
                return;
            }
        }

        sendInput(session, {
            type: 'input',
            input_type: 'keyboard',
            key: e.key,
            code: e.code,
            modifiers: {
                ctrl: e.ctrlKey,
                alt: e.altKey,
                shift: e.shiftKey,
                meta: e.metaKey
            },
            down: eventType === 'keydown'
        });
    }

    // Phase 3.2: virtual paste — send arbitrary text as a single `text`
    // input event. Falls back to typing the clipboard contents when the
    // clipboard sync path is blocked (browser permission denied, remote
    // refuses incoming clipboard, or operator just wants to inject
    // canned text). Long strings are sent in a single payload; the agent
    // is responsible for splitting if needed.
    function sendText(session, text) {
        if (!session || !session.connected || !text) return false;
        sendInput(session, {
            type: 'input',
            input_type: 'text',
            text: String(text)
        });
        return true;
    }

    async function pasteFromClipboard(deviceId, widgetId) {
        const key = `${deviceId}:${widgetId}`;
        const session = activeSessions[key];
        if (!session || !session.connected) return false;

        let text = '';
        if (navigator.clipboard && navigator.clipboard.readText) {
            try {
                text = await navigator.clipboard.readText();
            } catch (err) {
                console.warn('[CDAPDesktop] Clipboard read failed:', err && err.message);
                return false;
            }
        } else {
            return false;
        }
        if (!text) return false;
        return sendText(session, text);
    }

    function sendInput(session, payload) {
        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify(payload));
        }
    }

    function sendMsg(session, payload) {
        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify(payload));
        }
    }

    // ── Disconnect / Cleanup ─────────────────────────────────────────────

    function setDisconnected(session) {
        session.connected = false;
        if (session._qualityTimer) {
            clearInterval(session._qualityTimer);
            session._qualityTimer = null;
        }
        stopPresencePing(session);
        // Release any WebCodecs video decoder so the GPU/decoder slot is
        // freed immediately rather than waiting for GC.
        closeVideoDecoder(session);
        session._gotKeyframe = false;
        // Stop recorder if still rolling — we don't want to leave dangling
        // MediaRecorder + canvas captureStream when the session ends.
        if (session._recorder && session._recorder.state === 'recording') {
            try { session._recorder.stop(); } catch { /* ignore */ }
        }
        // Release fullscreen + keyboard lock if we held them.
        if (document.fullscreenElement && session.widgetEl && session.widgetEl.contains(document.fullscreenElement)) {
            try { document.exitFullscreen(); } catch {}
        }
        if (navigator.keyboard && navigator.keyboard.unlock) {
            try { navigator.keyboard.unlock(); } catch {}
        }
        if (session.overlay) {
            session.overlay.classList.remove('hidden');
            session.overlay.querySelector('span:last-child').textContent =
                window.BetterDesk?.t?.('cdap.disconnected') || 'Disconnected';
        }
        // Reset cursor
        if (session.canvas) session.canvas.style.cursor = 'default';
        // Show connect button again
        const connectDiv = session.widgetEl?.querySelector('.cdap-desktop-connect');
        if (connectDiv) connectDiv.classList.remove('hidden');
    }

    function closeDesktop(deviceId, widgetId) {
        const key = `${deviceId}:${widgetId}`;
        const session = activeSessions[key];
        if (!session) return;

        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            try { session.ws.send(JSON.stringify({ type: 'close' })); } catch {}
            try { session.ws.close(1000, 'client_close'); } catch {}
        }
        setDisconnected(session);
        delete activeSessions[key];
    }

    // Close every active desktop session — used by the tab-close / page-hide
    // handlers below so the agent tears down capture immediately instead of
    // waiting for a socket read timeout.
    function closeAllDesktops(reason) {
        const keys = Object.keys(activeSessions);
        for (const key of keys) {
            const session = activeSessions[key];
            if (!session) continue;
            if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                try {
                    session.ws.send(JSON.stringify({ type: 'close', reason: reason || 'tab_closed' }));
                } catch {}
                try { session.ws.close(1001, reason || 'tab_closed'); } catch {}
            }
            setDisconnected(session);
            delete activeSessions[key];
        }
    }

    // ── Fullscreen + Keyboard Lock (Phase 3.3) ───────────────────────────
    //
    // Fullscreen toggles the widget container into the OS-level fullscreen
    // mode and, when supported, asks the browser to capture system
    // keyboard shortcuts (Alt+Tab, Win, PrintScreen) via the Keyboard
    // Lock API. Pointer Lock is intentionally not used here because the
    // CDAP fast path encodes mouse coordinates as absolute canvas
    // positions; relative motion deltas would need a separate input
    // pipeline. Keyboard Lock is only valid in fullscreen.

    async function toggleFullscreen(deviceId, widgetId) {
        const key = `${deviceId}:${widgetId}`;
        const session = activeSessions[key];
        if (!session) return false;
        const target = session.widgetEl || session.canvas;

        if (!document.fullscreenElement) {
            try {
                await target.requestFullscreen();
            } catch (err) {
                console.warn('[CDAPDesktop] Fullscreen request failed:', err && err.message);
                return false;
            }
            if (navigator.keyboard && navigator.keyboard.lock) {
                try {
                    await navigator.keyboard.lock([
                        'Escape', 'Tab',
                        'MetaLeft', 'MetaRight',
                        'AltLeft', 'AltRight',
                        'ControlLeft', 'ControlRight',
                        'PrintScreen'
                    ]);
                } catch (err) {
                    console.warn('[CDAPDesktop] Keyboard lock failed:', err && err.message);
                }
            }
            // Refocus canvas so keystrokes route to the remote.
            try { session.canvas.focus(); } catch {}
            return true;
        }

        try { await document.exitFullscreen(); } catch {}
        if (navigator.keyboard && navigator.keyboard.unlock) {
            try { navigator.keyboard.unlock(); } catch {}
        }
        return false;
    }

    function isFullscreen(deviceId, widgetId) {
        const key = `${deviceId}:${widgetId}`;
        const session = activeSessions[key];
        if (!session || !session.widgetEl) return false;
        return !!(document.fullscreenElement && session.widgetEl.contains(document.fullscreenElement));
    }

    // ── Session Recording (Phase 3.4) ────────────────────────────────────
    //
    // Records the canvas frames to a WebM blob via MediaRecorder. The
    // frames are already painted on the canvas, so we capture from there
    // rather than re-decoding the JPEG stream. 15 fps + 2.5 Mbps gives a
    // legible audit recording without inflating disk usage. The blob is
    // built up in memory during the session and flushed on stop, so
    // operators should keep an eye on long sessions; future improvement:
    // periodic chunk download or server-side persistence.

    function startRecording(deviceId, widgetId) {
        const key = `${deviceId}:${widgetId}`;
        const session = activeSessions[key];
        if (!session || !session.connected) return false;
        if (session._recorder) return false;
        if (typeof session.canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
            console.warn('[CDAPDesktop] MediaRecorder / captureStream not supported');
            return false;
        }

        try {
            const stream = session.canvas.captureStream(15);
            let mimeType = 'video/webm;codecs=vp9,opus';
            if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm;codecs=vp8,opus';
            if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm';

            session._recordedChunks = [];
            session._recorder = new MediaRecorder(stream, {
                mimeType,
                videoBitsPerSecond: 2500000
            });
            session._recorder.ondataavailable = (ev) => {
                if (ev.data && ev.data.size > 0) session._recordedChunks.push(ev.data);
            };
            session._recorder.start(1000);
            session._recordingStartTime = Date.now();
            return true;
        } catch (err) {
            console.warn('[CDAPDesktop] Recording start failed:', err && err.message);
            session._recorder = null;
            return false;
        }
    }

    function stopRecording(deviceId, widgetId) {
        return new Promise((resolve) => {
            const key = `${deviceId}:${widgetId}`;
            const session = activeSessions[key];
            if (!session || !session._recorder || session._recorder.state === 'inactive') {
                resolve(null);
                return;
            }
            const recorder = session._recorder;
            recorder.onstop = () => {
                const blob = new Blob(session._recordedChunks || [], { type: recorder.mimeType });
                session._recordedChunks = [];
                session._recorder = null;
                resolve(blob);
            };
            try { recorder.stop(); } catch { resolve(null); }
        });
    }

    async function downloadRecording(deviceId, widgetId) {
        const blob = await stopRecording(deviceId, widgetId);
        if (!blob) return false;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `cdap_session_${deviceId}_${ts}.webm`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        return true;
    }

    function isRecording(deviceId, widgetId) {
        const key = `${deviceId}:${widgetId}`;
        const session = activeSessions[key];
        return !!(session && session._recorder && session._recorder.state === 'recording');
    }

    // ── Tab / window lifecycle: auto-end sessions on close ───────────────
    //
    // Without these hooks the browser may take several seconds to drop the
    // WebSocket when the tab is closed, especially on mobile or when the
    // OS suspends the page. That leaves the agent still streaming and
    // consuming CPU until the server-side read loop times out. We send an
    // explicit close frame via both `pagehide` (covers tab close,
    // navigation, bfcache) and `beforeunload` (legacy fallback).
    function installLifecycleHandlers() {
        if (window.__cdapDesktopLifecycleInstalled) return;
        window.__cdapDesktopLifecycleInstalled = true;

        const onGone = () => closeAllDesktops('tab_closed');
        // pagehide is the most reliable modern hook — fires for tab close,
        // navigation, and bfcache eviction.
        window.addEventListener('pagehide', onGone, { capture: true });
        // beforeunload is noisy but still useful as a secondary signal.
        window.addEventListener('beforeunload', onGone, { capture: true });
        // If the tab just becomes hidden, keep the session alive but
        // reduce load — future: request lower fps. For now this is a hook
        // point only.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                // Intentionally do not close here — users switching tabs
                // briefly should resume instantly. Browsers will fire
                // `pagehide` if the tab is truly being unloaded.
            }
        });
    }

    installLifecycleHandlers();

    // ── Public API ───────────────────────────────────────────────────────

    window.CDAPDesktop = {
        open: openDesktop,
        close: closeDesktop,
        isActive: (deviceId, widgetId) => !!activeSessions[`${deviceId}:${widgetId}`],
        requestKeyframe: requestKeyframe,
        selectMonitor: (deviceId, widgetId, index) => {
            const s = activeSessions[`${deviceId}:${widgetId}`];
            if (s) selectMonitor(s, index);
        },
        getMonitors: (deviceId, widgetId) => {
            const s = activeSessions[`${deviceId}:${widgetId}`];
            return s ? { monitors: s._monitors, active: s._activeMonitor } : null;
        },
        setClipboardEnabled: (deviceId, widgetId, enabled) => {
            const s = activeSessions[`${deviceId}:${widgetId}`];
            if (s) s._clipboardEnabled = !!enabled;
        },
        // Phase 3.3: fullscreen + keyboard lock
        toggleFullscreen,
        isFullscreen,
        // Phase 3.4: session recording
        startRecording,
        stopRecording,
        downloadRecording,
        isRecording,
        // Phase 3.2: virtual paste / arbitrary text injection
        sendText: (deviceId, widgetId, text) => {
            const s = activeSessions[`${deviceId}:${widgetId}`];
            return s ? sendText(s, text) : false;
        },
        pasteFromClipboard
    };

})();
