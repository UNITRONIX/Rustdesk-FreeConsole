/**
 * BetterDesk Web Remote Client - Video Decoder
 * Uses WebCodecs API for hardware-accelerated video decoding (preferred).
 * Falls back to JMuxer (H.264 via MSE) when WebCodecs is unavailable
 * (e.g., insecure HTTP context on non-localhost).
 * Supports VP9, H.264, AV1, VP8 codecs via WebCodecs;
 * H.264 only via JMuxer fallback.
 */

// eslint-disable-next-line no-unused-vars
class RDVideo {
    constructor() {
        /** @type {VideoDecoder|null} */
        this.decoder = null;
        /** @type {string|null} Current codec */
        this.currentCodec = null;
        /** @type {Function|null} Callback for decoded frames */
        /** @type {Function|null} Callback for decoded frames */
        this.onFrame = null;
        /** @type {boolean} Skip decode/render while viewer tab is in background */
        this._backgroundMode = false;
        /** @type {Function|null} Callback for errors */
        this.onError = null;
        /** @type {number} Decoded frame counter */
        this.frameCount = 0;
        /** @type {number} Dropped frame counter */
        this.droppedFrames = 0;
        /** @type {boolean} */
        this.initialized = false;
        /** @type {number} Display width */
        this.displayWidth = 0;
        /** @type {number} Display height */
        this.displayHeight = 0;
        /** @type {boolean} Using JMuxer fallback mode */
        this.fallbackMode = false;
        /** @type {JMuxer|null} JMuxer instance for H.264 MSE fallback */
        this._jmuxer = null;
        /** @type {HTMLVideoElement|null} Hidden video element for JMuxer */
        this._videoEl = null;
        /** @type {number} RAF id for video-to-canvas sync */
        this._syncRafId = 0;
        /** @type {boolean} Whether JMuxer video has started playing */
        this._videoPlaying = false;
        /** @type {number[]} Timestamps of recent feeds for FPS calculation */
        this._feedTimestamps = [];
        /** @type {number} Monotonic feed counter for new-frame detection */
        this._feedId = 0;
        /** @type {number} Health check interval id */
        this._healthInterval = 0;
        /** @type {number} Last diagnostic log time */
        this._lastDiagTime = 0;
        /** @type {number} Last feed timestamp for stall detection */
        this._lastFeedTime = 0;
        /** @type {boolean} Whether autoplay is currently blocked */
        this._autoplayBlocked = false;
        /** @type {Function|null} Callback when autoplay is blocked */
        this.onAutoplayBlocked = null;
        /** @type {boolean} WebCodecs decoder is waiting for a keyframe before it can decode */
        this._needKeyframe = false;
        /** @type {Function|null} Callback asking the client to request a keyframe (refresh_video) */
        this.onNeedKeyframe = null;
        /** @type {number} Monotonic counter for WebCodecs chunk timestamps */
        this._decodeInputCount = 0;
        /** @type {Object|null} Last WebCodecs decoder configuration (for recovery) */
        this._codecConfig = null;
        /** @type {boolean} Whether we already retried software decoding after a hardware failure */
        this._softwareRetry = false;
        /** @type {Function|null} Called when decoder cannot recover (codec switch needed) */
        this.onCodecFailed = null;
        /** @type {number} Decode attempts since last successful frame */
        this._decodeErrorsSinceFrame = 0;
        /** @type {boolean} Whether AV1 description was applied from a keyframe */
        this._av1DescriptionApplied = false;
        /** @type {number} Last decoder error timestamp (ms) for throttled recovery */
        this._lastDecodeErrorTime = 0;
    }

    /**
     * Check if hardware WebCodecs is supported (requires secure context)
     * @returns {boolean}
     */
    static isSupported() {
        return typeof VideoDecoder !== 'undefined';
    }

    /**
     * Check if secure context is available (needed for WebCodecs)
     * @returns {boolean}
     */
    static isSecureContext() {
        return window.isSecureContext === true;
    }

    /** WebKitGTK / Safari — AV1 HW decode is often broken; prefer software. */
    static isWebKit() {
        const ua = navigator.userAgent || '';
        return /AppleWebKit/i.test(ua) && !/Edg\//.test(ua) && !/Chrome\//.test(ua);
    }

    /** Chromium / WebView2 — full WebCodecs stack (incl. AV1 on recent builds). */
    static isChromiumWebView() {
        const ua = navigator.userAgent || '';
        return /Chrome\//.test(ua) || /Edg\//.test(ua);
    }

    /** Tauri RdClient desktop shell (WebKitGTK on Linux, WKWebView on macOS, WebView2 on Windows). */
    static isRdClientDesktop() {
        return window.__BETTERDESK_RDCLIENT_DESKTOP__ === true
            || !!(window.__TAURI__ && window.__TAURI__.core);
    }

    /** Linux WebKitGTK — WebCodecs AV1 is advertised but fails at decode time. */
    static isWebKitGTK() {
        if (RDVideo.isChromiumWebView()) return false;
        const ua = navigator.userAgent || '';
        if (!/AppleWebKit/i.test(ua)) return false;
        if (/Linux/i.test(ua)) return true;
        return RDVideo.isRdClientDesktop() && !/Macintosh|Windows|CrOS/i.test(ua);
    }

    /**
     * Whether AV1 should be offered to the encoder. WebKit runtimes often pass
     * VideoDecoder.isConfigSupported for AV1 but fail with "Decode error" at runtime.
     * @returns {boolean}
     */
    static av1ReliableOnRuntime() {
        if (RDVideo.isWebKitGTK()) return false;
        if (RDVideo.isWebKit() && !RDVideo.isChromiumWebView()) return false;
        return true;
    }

    /**
     * Default hardwareAcceleration for a logical codec on this runtime.
     * @param {string} codecName
     * @returns {string|undefined}
     */
    static defaultAcceleration(codecName) {
        if (codecName === 'av1' && RDVideo.isWebKit()) {
            return 'prefer-software';
        }
        return 'prefer-hardware';
    }

    /**
     * Check if JMuxer fallback is available
     * @returns {boolean}
     */
    static isJMuxerAvailable() {
        return typeof JMuxer !== 'undefined';
    }

    /**
     * Codec string candidates per logical codec (broadest / HW-friendly first).
     * @param {string} codecName
     * @returns {string[]}
     */
    static codecCandidates(codecName) {
        const map = {
            vp9: ['vp09.00.10.08', 'vp09.00.40.08', 'vp09.00.50.08'],
            h264: ['avc1.640028', 'avc1.4d4028', 'avc1.42E01E'],
            av1: ['av01.0.04M.08', 'av01.0.08M.08', 'av01.0.05M.08', 'av01.0.01M.08', 'av01.0.15M.08'],
            vp8: ['vp8'],
            h265: ['hev1.1.6.L93.B0', 'hvc1.1.6.L93.B0']
        };
        return map[codecName] || [];
    }

    /**
     * Pick the first VideoDecoder-supported config from codec candidates.
     * @param {string} codecName
     * @param {string} [accel] hardwareAcceleration preference
     * @returns {Promise<Object|null>} supported VideoDecoderConfig
     */
    static async resolveCodecConfig(codecName, accel, explicitCodec) {
        const candidates = explicitCodec
            ? [explicitCodec].concat(RDVideo.codecCandidates(codecName).filter((c) => c !== explicitCodec))
            : RDVideo.codecCandidates(codecName);
        if (!candidates.length) return null;

        const baseAccel = accel || RDVideo.defaultAcceleration(codecName);
        const probes = baseAccel
            ? [{ hardwareAcceleration: baseAccel }, { hardwareAcceleration: 'prefer-software' }, {}]
            : [{ hardwareAcceleration: 'prefer-hardware' }, { hardwareAcceleration: 'prefer-software' }, {}];

        for (const codec of candidates) {
            for (const extra of probes) {
                try {
                    const cfg = { codec, optimizeForLatency: true, ...extra };
                    const support = await VideoDecoder.isConfigSupported(cfg);
                    if (support && support.supported === true) {
                        return support.config || cfg;
                    }
                } catch {
                    /* try next */
                }
            }
        }
        return null;
    }

    /**
     * Get supported codecs
     * @returns {Object} Map of codec name to boolean
     */
    static async getSupportedCodecs() {
        if (!RDVideo.isSupported()) {
            // In fallback mode, only H.264 via JMuxer is supported
            return {
                vp9: false,
                h264: RDVideo.isJMuxerAvailable(),
                av1: false,
                vp8: false,
                h265: false
            };
        }

        const names = ['vp9', 'h264', 'av1', 'vp8', 'h265'];
        const result = {};
        for (const name of names) {
            if (name === 'av1' && !RDVideo.av1ReliableOnRuntime()) {
                result[name] = false;
                continue;
            }
            result[name] = !!(await RDVideo.resolveCodecConfig(name, RDVideo.defaultAcceleration(name)));
        }
        return result;
    }

    /**
     * Ordered wire codecs safe to advertise to the agent (most efficient first).
     * AV1 is omitted when the runtime cannot decode it reliably (WebKit HW bugs).
     * @returns {Promise<string[]>}
     */
    static async probeDecodableWireCodecs() {
        const list = [];
        if (!RDVideo.isSupported()) {
            if (RDVideo.isJMuxerAvailable()) list.push('h264');
            list.push('webp', 'jpeg');
            return list;
        }
        const support = await RDVideo.getSupportedCodecs();
        if (support.av1 && RDVideo.av1ReliableOnRuntime()) list.push('av1');
        if (support.vp9) list.push('vp9');
        if (support.h264) list.push('h264');
        list.push('webp', 'jpeg');
        return list;
    }

    /**
     * Initialize decoder for a specific codec.
     * Uses WebCodecs if available, otherwise falls back to JMuxer for H.264.
     * @param {string} codecName - vp9, h264, av1, vp8
     * @param {Object} [opts]
     * @param {string} [opts.codecString] WebCodecs codec string from agent
     */
    async init(codecName, opts) {
        opts = opts || {};
        if (this.decoder || this._jmuxer) {
            this.close();
        }

        // If WebCodecs not available, use JMuxer fallback for H.264
        if (!RDVideo.isSupported()) {
            if (codecName !== 'h264') {
                console.warn('[RDVideo] WebCodecs unavailable and JMuxer only supports H.264, got:', codecName);
                // Still initialize — frames will be dropped but won't crash
            }

            if (!RDVideo.isJMuxerAvailable()) {
                console.error('[RDVideo] JMuxer not loaded. Cannot decode video in HTTP mode.');
                throw new Error('JMuxer not available for H.264 fallback decoding');
            }

            console.log('[RDVideo] Using JMuxer (H.264 via MSE) fallback for', codecName);
            this.fallbackMode = true;
            this._initJMuxer();
            this.currentCodec = codecName;
            this.frameCount = 0;
            this.droppedFrames = 0;
            this.initialized = true;
            return;
        }

        const codecMap = {
            vp9: 'vp09.00.10.08',
            h264: 'avc1.42E01E',
            av1: 'av01.0.08M.08',
            vp8: 'vp8',
            h265: 'hev1.1.6.L93.B0'
        };

        if (!codecMap[codecName]) {
            throw new Error(`Unsupported codec: ${codecName}`);
        }

        const accel = this._softwareRetry
            ? 'prefer-software'
            : RDVideo.defaultAcceleration(codecName);

        const resolved = await RDVideo.resolveCodecConfig(codecName, accel, opts.codecString || null);
        if (!resolved || !resolved.codec) {
            throw new Error(`Codec ${codecName} not supported by browser`);
        }

        this._softwareRetry = resolved.hardwareAcceleration === 'prefer-software'
            || resolved.hardwareAcceleration === 'no-preference';

        this.decoder = new VideoDecoder({
            output: (frame) => this._handleDecodedFrame(frame),
            error: (err) => this._handleError(err)
        });

        // Remember the configuration so the decoder can be rebuilt on error.
        this._codecConfig = {
            codec: resolved.codec,
            hardwareAcceleration: resolved.hardwareAcceleration || accel,
            optimizeForLatency: true
        };
        if (opts.description) {
            this._codecConfig.description = opts.description;
        }
        this.decoder.configure(this._codecConfig);

        console.log('[RDVideo] Configured', codecName, this._codecConfig.codec,
            'hw=' + (this._codecConfig.hardwareAcceleration || 'default'),
            'runtime=' + (RDVideo.isWebKitGTK() ? 'webkitgtk'
                : (RDVideo.isChromiumWebView() ? 'chromium' : 'other')));

        this.fallbackMode = false;
        this.currentCodec = codecName;
        this.frameCount = 0;
        this.droppedFrames = 0;
        this.initialized = true;
        // A freshly configured decoder must receive a keyframe before any delta
        // frame. Drop deltas until one arrives and proactively request one.
        this._needKeyframe = true;
        this._decodeInputCount = 0;
        this._decodeErrorsSinceFrame = 0;
        this._av1DescriptionApplied = false;
        if (this.onNeedKeyframe) {
            this.onNeedKeyframe();
        }
    }

    /**
     * Create hidden video element and JMuxer instance for H.264 MSE decoding.
     * JMuxer takes raw H.264 NALUs (Annex-B), wraps them in fMP4, and feeds to
     * a <video> element via MSE. We then draw the video to canvas each frame.
     */
    _initJMuxer() {
        // Create hidden video element
        this._videoEl = document.createElement('video');
        this._videoEl.id = 'rd-jmuxer-video';
        this._videoEl.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:1px;height:1px;';
        this._videoEl.muted = true;
        this._videoEl.autoplay = true;
        this._videoEl.playsInline = true;
        document.body.appendChild(this._videoEl);

        // Buffer for frames that arrive before JMuxer is ready
        this._pendingFeeds = [];
        this._jmuxerReady = false;

        this._videoEl.addEventListener('error', (e) => {
            const me = this._videoEl.error;
            console.error('[RDVideo] Video element error: code=' + (me ? me.code : '?')
                + ' message=' + (me ? me.message : e.type));
        });

        // Monitor stalled/waiting states for automatic recovery
        this._videoEl.addEventListener('stalled', () => {
            console.log('[RDVideo] Video stalled, recovering...');
            this._recoverVideo();
        });
        this._videoEl.addEventListener('waiting', () => {
            this._recoverVideo();
        });
        this._videoEl.addEventListener('ended', () => {
            console.log('[RDVideo] Video ended unexpectedly, recovering...');
            this._recoverVideo();
        });

        // Create JMuxer instance
        this._jmuxer = new JMuxer({
            node: this._videoEl,
            mode: 'video',
            flushingTime: 0,        // Flush immediately for low latency
            fps: 60,
            clearBuffer: false,     // We manage buffer trimming in _startHealthCheck
            debug: false,
            onReady: () => {
                console.log('[RDVideo] JMuxer ready, buffered frames:', this._pendingFeeds.length);
                this._jmuxerReady = true;
                // Replay any frames that arrived before ready
                for (const data of this._pendingFeeds) {
                    this._jmuxer.feed({ video: data });
                    this.frameCount++;
                    this._feedId++;
                    this._feedTimestamps.push(performance.now());
                }
                this._pendingFeeds = [];
                // Force play after feeding buffered data
                this._tryPlay();
                // Recover after MSE finishes processing initial data
                setTimeout(() => this._recoverVideo(), 100);
            },
            onError: (err) => {
                console.warn('[RDVideo] JMuxer error:', err);
            }
        });

        // Start the video-to-canvas sync loop and health checker
        this._startVideoSync();
        this._startHealthCheck();
    }

    /**
     * Attempt to play the hidden video element.
     * If autoplay is blocked by browser policy, signal the UI so it can
     * show a "click to start" overlay. When the user interacts, call retryPlay().
     */
    _tryPlay() {
        if (!this._videoEl) return;
        const playPromise = this._videoEl.play();
        if (playPromise && playPromise.catch) {
            playPromise.catch((err) => {
                if (err.name === 'NotAllowedError') {
                    if (!this._autoplayBlocked) {
                        this._autoplayBlocked = true;
                        console.warn('[RDVideo] Autoplay blocked by browser policy. User gesture required.');
                        if (this.onAutoplayBlocked) {
                            this.onAutoplayBlocked();
                        }
                    }
                } else {
                    console.warn('[RDVideo] play() failed:', err.message);
                }
            });
        }
    }

    /**
     * Retry play after a user gesture (e.g., clicking the canvas overlay).
     * Called from the UI layer when user clicks the "click to start" overlay.
     */
    retryPlay() {
        this._autoplayBlocked = false;
        if (this._videoEl) {
            this._videoEl.play().then(() => {
                console.log('[RDVideo] Playback started after user gesture');
            }).catch((err) => {
                console.warn('[RDVideo] retryPlay failed:', err.message);
            });
        }
        // Also resume AudioContext if it exists for this session
        if (typeof this.getAudioContext === 'function') {
            const ctx = this.getAudioContext();
            if (ctx && ctx.state === 'suspended') {
                ctx.resume();
            }
        }
    }

    /**
     * RAF loop that captures the <video> element content and emits as frames
     * for the renderer to draw on the main canvas.
     * Does NOT seek — seeking is handled by _recoverVideo() and health check.
     */
    _startVideoSync() {
        let loggedState = false;
        let lastRenderedFeedId = -1;
        const tick = () => {
            if (!this._videoEl || !this.fallbackMode) return;

            const v = this._videoEl;
            // Check if video has decodable data (readyState >= 2 = HAVE_CURRENT_DATA)
            if (v.videoWidth > 0 && v.videoHeight > 0 && v.readyState >= 2) {
                const vw = v.videoWidth;
                const vh = v.videoHeight;

                if (vw !== this.displayWidth || vh !== this.displayHeight) {
                    this.displayWidth = vw;
                    this.displayHeight = vh;
                    console.log('[RDVideo] JMuxer resolution:', vw, 'x', vh);
                }

                // Always emit frames (needed for cursor overlay), mark genuinely new ones
                if (this.onFrame) {
                    const isNew = this._feedId !== lastRenderedFeedId;
                    if (isNew) lastRenderedFeedId = this._feedId;
                    const proxyFrame = {
                        displayWidth: vw,
                        displayHeight: vh,
                        _source: v,
                        _isNew: isNew,
                        close: () => {}
                    };
                    this.onFrame(proxyFrame);
                }
                // No seeking here - health check handles buffer management
            } else if (!loggedState && this._jmuxerReady) {
                // Log once for diagnostics
                console.log('[RDVideo] Sync waiting: videoWidth=' + v.videoWidth
                    + ' readyState=' + v.readyState + ' paused=' + v.paused
                    + ' currentTime=' + v.currentTime.toFixed(2));
                loggedState = true;
            }

            this._syncRafId = requestAnimationFrame(tick);
        };
        this._syncRafId = requestAnimationFrame(tick);
    }

    /**
     * Recover video element from stalled/waiting state.
     * Seeks to the latest buffered data and ensures playback.
     */
    _recoverVideo() {
        const v = this._videoEl;
        if (!v || !v.buffered || v.buffered.length === 0) return;

        const end = v.buffered.end(v.buffered.length - 1);
        const start = v.buffered.start(0);

        // If currentTime is outside buffered range, or behind, seek to live edge
        if (v.currentTime < start || v.currentTime > end + 0.5 || (end - v.currentTime) > 0.1) {
            v.currentTime = Math.max(start, end - 0.02);
        }

        // Ensure video is playing
        if (v.paused) {
            this._tryPlay();
        }
    }

    /**
     * Periodic health check for MSE video element.
     * Monitors buffer state, recovers from stalls, and logs diagnostics.
     * Uses aggressive seeking and gentle playback rate adjustment.
     */
    _startHealthCheck() {
        this._healthInterval = setInterval(() => {
            if (!this._videoEl || !this.fallbackMode) return;
            const v = this._videoEl;

            // Periodic diagnostics (every 5 seconds)
            const now = performance.now();
            if (!this._lastDiagTime || now - this._lastDiagTime > 5000) {
                this._lastDiagTime = now;
                let bufInfo = 'none';
                if (v.buffered && v.buffered.length > 0) {
                    bufInfo = v.buffered.start(0).toFixed(2) + '-' + v.buffered.end(v.buffered.length - 1).toFixed(2);
                }
                // Count recent FPS
                while (this._feedTimestamps.length > 0 && this._feedTimestamps[0] < now - 1000) {
                    this._feedTimestamps.shift();
                }
                console.log('[RDVideo] Health: frames=' + this.frameCount
                    + ' fps=' + this._feedTimestamps.length
                    + ' readyState=' + v.readyState
                    + ' currentTime=' + v.currentTime.toFixed(2)
                    + ' buffered=' + bufInfo
                    + ' paused=' + v.paused
                    + ' dropped=' + this.droppedFrames);
            }

            // Recovery: catch up to live edge if fallen behind
            if (v.buffered && v.buffered.length > 0) {
                const end = v.buffered.end(v.buffered.length - 1);
                const start = v.buffered.start(0);
                const latency = end - v.currentTime;
                const bufferSize = end - start;

                if (latency > 0.3) {
                    // Fallen behind — hard seek to near live edge
                    v.currentTime = end - 0.02;
                    v.playbackRate = 1.0;
                } else if (latency > 0.06) {
                    // Slightly behind — speed up to catch up
                    v.playbackRate = 1.5;
                } else {
                    // At live edge — normal speed
                    v.playbackRate = 1.0;
                }

                // Trim old buffer data to prevent SourceBuffer overflow
                // Keep at most 3s of data, trim to last 1.5s
                if (bufferSize > 3.0 && this._jmuxer && this._jmuxer.sourceBuffer) {
                    try {
                        const sb = this._jmuxer.sourceBuffer;
                        if (sb.video && !sb.video.updating && start < end - 1.5) {
                            sb.video.remove(start, end - 1.5);
                        }
                    } catch (_) {
                        // SourceBuffer remove can fail if updating
                    }
                }

                // Resume if paused
                if (v.paused && this.frameCount > 0) {
                    this._tryPlay();
                }

                // If video appears stuck (readyState < 2 but we have buffer)
                if (v.readyState < 2 && end > 0) {
                    v.currentTime = end - 0.01;
                    this._tryPlay();
                }
            }

            // Reinit fallback: if frames are being fed but video never reaches
            // playable state (readyState < 2) for 3+ seconds, recreate JMuxer
            if (this._lastFeedTime > 0) {
                const feedAge = now - this._lastFeedTime;
                if (v.readyState < 2 && feedAge < 2000 && this.frameCount > 10
                    && (!this._lastReinitTime || now - this._lastReinitTime > 5000)) {
                    console.warn('[RDVideo] MSE stuck: readyState=' + v.readyState
                        + ' despite ' + this.frameCount + ' frames fed. Reinitializing...');
                    this._lastReinitTime = now;
                    this._reinitJMuxer();
                }
            }
        }, 300);
    }

    /**
     * Reinitialize JMuxer when MSE pipeline is stuck
     * (readyState stays below 2 despite continuous frame feeding).
     */
    _reinitJMuxer() {
        const savedFrameCount = this.frameCount;
        const savedDropped = this.droppedFrames;

        // Destroy current JMuxer
        if (this._jmuxer) {
            try { this._jmuxer.destroy(); } catch (_) { /* ignore */ }
            this._jmuxer = null;
        }

        // Remove old video element
        if (this._videoEl && this._videoEl.parentNode) {
            this._videoEl.pause();
            this._videoEl.removeAttribute('src');
            this._videoEl.parentNode.removeChild(this._videoEl);
            this._videoEl = null;
        }

        // Stop old sync/health loops (they will be restarted by _initJMuxer)
        if (this._syncRafId) {
            cancelAnimationFrame(this._syncRafId);
            this._syncRafId = 0;
        }
        if (this._healthInterval) {
            clearInterval(this._healthInterval);
            this._healthInterval = 0;
        }

        // Recreate everything
        this._initJMuxer();
        this.frameCount = savedFrameCount;
        this.droppedFrames = savedDropped;
    }

    /**
     * Pause local decode/render while the session tab is inactive.
     * The peer should already be throttled via customFps / quality_set.
     * @param {boolean} on
     */
    setBackgroundMode(on) {
        this._backgroundMode = !!on;
    }

    /**
     * Feed an encoded frame to the decoder
     * @param {Object} frameData - { data: Uint8Array, key: boolean, pts: number, codec: string }
     */
    async decode(frameData) {
        if (!this.initialized) {
            return;
        }

        if (this._backgroundMode) {
            this.droppedFrames++;
            return;
        }

        // Switch codec if needed
        if (frameData.codec && frameData.codec !== this.currentCodec) {
            await this.init(frameData.codec, { codecString: frameData.codecString });
        }

        // AV1: apply codec description from the first keyframe (WebKitGTK needs this).
        if (this.currentCodec === 'av1' && frameData.key && !this._av1DescriptionApplied) {
            const desc = RDVideo.av1DescriptionFromKeyframe(frameData.data);
            if (desc) {
                try {
                    this._codecConfig.description = desc;
                    if (this.decoder && this.decoder.state === 'configured') {
                        this.decoder.configure(this._codecConfig);
                    }
                    this._av1DescriptionApplied = true;
                    this._needKeyframe = false;
                } catch (e) {
                    console.warn('[RDVideo] AV1 description configure failed:', e && e.message);
                }
            }
        }

        // JMuxer fallback mode
        if (this.fallbackMode) {
            return this._decodeFallback(frameData);
        }

        if (!this.decoder) return;

        // Check decoder state
        if (this.decoder.state === 'closed') {
            return;
        }

        // A WebCodecs decoder must start from a keyframe. Drop delta frames
        // until the first keyframe (or one requested after an error) arrives.
        if (this._needKeyframe) {
            if (!frameData.key) {
                this.droppedFrames++;
                return;
            }
            this._needKeyframe = false;
        }

        // If the decode queue is backing up (slow/overloaded decoder), drop
        // delta frames to catch up. Keyframes are always decoded.
        if (!frameData.key && this.decoder.decodeQueueSize > 30) {
            this.droppedFrames++;
            return;
        }

        try {
            // WebCodecs expects monotonically increasing timestamps in
            // microseconds. Use a dedicated input counter (the output
            // frameCount can stay 0 while decoding has not produced a frame
            // yet, which would yield duplicate timestamps).
            const timestamp = (this._decodeInputCount++) * 16667; // ~60fps in microseconds
            const chunk = new EncodedVideoChunk({
                type: frameData.key ? 'key' : 'delta',
                timestamp: timestamp,
                data: frameData.data
            });

            this.decoder.decode(chunk);
        } catch (err) {
            this.droppedFrames++;
            // The next frame must be a keyframe to resynchronise the decoder.
            this._needKeyframe = true;
            this._handleError(err);
        }
    }

    /**
     * JMuxer fallback: feed H.264 NALUs to JMuxer for MSE decoding.
     * RustDesk sends H.264 frames as EncodedVideoFrame.data which contains
     * Annex-B formatted NAL units (with 00 00 00 01 start codes).
     * @param {Object} frameData - { data: Uint8Array, key: boolean }
     */
    _decodeFallback(frameData) {
        if (!frameData.data || frameData.data.length === 0) {
            this.droppedFrames++;
            return;
        }

        try {
            // Ensure we have a proper Uint8Array (protobuf.js may return Buffer-like)
            let videoData = frameData.data;
            if (!(videoData instanceof Uint8Array) || videoData.buffer.byteLength !== videoData.length) {
                videoData = new Uint8Array(videoData);
            }

            // Debug: log first frame details
            if (this.frameCount < 1) {
                const hex = Array.from(videoData.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' ');
                console.log('[RDVideo] H.264 feed: ' + videoData.length + ' bytes, key=' + frameData.key
                    + ', first 20: ' + hex);
            }

            // If JMuxer not ready yet, buffer the frame and replay on ready
            if (!this._jmuxerReady) {
                this._pendingFeeds.push(videoData);
                return;
            }

            this._jmuxer.feed({
                video: videoData
            });
            this.frameCount++;
            this._feedId++;
            const now = performance.now();
            this._feedTimestamps.push(now);
            this._lastFeedTime = now;

            // Ensure video is playing
            if (this._videoEl) {
                if (this._videoEl.paused) {
                    this._tryPlay();
                }
                // Nudge to live edge only when significantly behind (avoid stutter from constant seeks)
                if (this._videoEl.buffered && this._videoEl.buffered.length > 0) {
                    const end = this._videoEl.buffered.end(this._videoEl.buffered.length - 1);
                    if (end - this._videoEl.currentTime > 0.3) {
                        this._videoEl.currentTime = end - 0.02;
                    }
                }
            }
        } catch (err) {
            console.warn('[RDVideo] JMuxer feed error:', err);
            this.droppedFrames++;
            if (this.onError) {
                this.onError(err);
            }
        }
    }

    /**
     * Handle decoded video frame (WebCodecs path)
     * @param {VideoFrame} frame
     */
    _handleDecodedFrame(frame) {
        this.frameCount++;
        this._decodeErrorsSinceFrame = 0;
        // Record timestamp so getStats() can report real FPS on the WebCodecs
        // path (previously only the JMuxer fallback fed this array, so HTTPS
        // sessions always reported 0 FPS).
        this._feedTimestamps.push(performance.now());

        // Track display dimensions
        if (frame.displayWidth !== this.displayWidth || frame.displayHeight !== this.displayHeight) {
            this.displayWidth = frame.displayWidth;
            this.displayHeight = frame.displayHeight;
        }

        if (this.onFrame) {
            if (this._backgroundMode) {
                frame.close();
                return;
            }
            this.onFrame(frame);
        } else {
            // Must close frame if not consumed
            frame.close();
        }
    }

    /**
     * Handle decoder error.
     * Rebuilds the WebCodecs decoder (falling back to software decoding once)
     * and requests a fresh keyframe so the stream can resynchronise instead of
     * staying stuck on a black screen.
     * @param {Error} err
     */
    _handleError(err) {
        console.error('[RDVideo] Decoder error:', err && err.message ? err.message : err);
        this._decodeErrorsSinceFrame++;
        if (this.onError) {
            this.onError(err);
        }

        if (this.fallbackMode || !RDVideo.isSupported()) {
            return;
        }

        // WebKitGTK / Safari: AV1 passes isConfigSupported but fails at runtime — switch codec immediately.
        if (this.currentCodec === 'av1' && !RDVideo.av1ReliableOnRuntime()) {
            console.warn('[RDVideo] AV1 decode failed on WebKit runtime — requesting VP9/H.264 fallback');
            if (this.onCodecFailed) {
                this.onCodecFailed(this.currentCodec, err);
            }
            return;
        }

        // Throttle recovery attempts to once per second.
        const now = performance.now();
        if (now - this._lastDecodeErrorTime < 1000) {
            return;
        }
        this._lastDecodeErrorTime = now;

        // First recovery after a hardware decode failure: retry with software.
        if (!this._softwareRetry) {
            this._softwareRetry = true;
            console.warn('[RDVideo] Rebuilding decoder with software decoding fallback');
        } else if (this._decodeErrorsSinceFrame > 8 && this.onCodecFailed) {
            console.warn('[RDVideo] Codec', this.currentCodec, 'unrecoverable — requesting fallback');
            this.onCodecFailed(this.currentCodec, err);
            return;
        }

        this._needKeyframe = true;
        this._av1DescriptionApplied = false;

        try {
            if (this.decoder && this.decoder.state !== 'closed') {
                this.decoder.close();
            }
        } catch {
            // ignore
        }

        const codecName = this.currentCodec;
        const savedCodecString = this._codecConfig && this._codecConfig.codec;
        this.decoder = null;
        this.initialized = false;
        if (codecName) {
            this.init(codecName, { codecString: savedCodecString }).catch((e) => {
                console.error('[RDVideo] Decoder rebuild failed:', e && e.message ? e.message : e);
                if (this.onCodecFailed) {
                    this.onCodecFailed(codecName, e);
                }
            });
        }
    }

    /**
     * Build WebCodecs AV1CodecConfigurationRecord (av1C) from a keyframe OBU stream.
     * @param {Uint8Array} data
     * @returns {Uint8Array|null}
     */
    static av1DescriptionFromKeyframe(data) {
        if (!data || data.length < 2) return null;
        let i = 0;
        let fullSeqObu = null;
        let seqPayload = null;
        while (i < data.length) {
            const obuStart = i;
            const hdr = data[i++];
            const obuType = (hdr >> 3) & 0x0F;
            const extFlag = (hdr >> 2) & 0x01;
            const hasSize = (hdr >> 1) & 0x01;
            if (extFlag === 1 && i < data.length) i++;
            let size;
            if (hasSize === 1) {
                const parsed = RDVideo._readLeb128(data, i);
                if (!parsed) break;
                size = parsed.value;
                i += parsed.bytes;
            } else {
                size = data.length - i;
            }
            if (i + size > data.length) break;
            if (obuType === 1) {
                fullSeqObu = data.subarray(obuStart, i + size);
                seqPayload = data.subarray(i, i + size);
            }
            i += size;
        }
        if (!fullSeqObu || !seqPayload || seqPayload.length < 4) return null;

        const br = { data: seqPayload, pos: 0 };
        const read = (n) => RDVideo._readBits(br, n);
        const profile = read(3);
        const level = read(5);
        const tier = read(1);
        const highBitdepth = read(1);
        const twelveBit = read(1);
        const monochrome = read(1);
        const subsamplingX = read(1);
        const subsamplingY = read(1);
        const samplePos = read(2);
        read(3); // reserved

        const out = new Uint8Array(4 + fullSeqObu.length);
        out[0] = 0x81;
        out[1] = (profile << 5) | (level & 0x1F);
        out[2] = ((level >> 5) & 0xFF) | (tier << 7) | (highBitdepth << 6)
            | (twelveBit << 5) | (monochrome << 4) | (subsamplingX << 3)
            | (subsamplingY << 2) | (samplePos >> 1);
        out[3] = ((samplePos & 1) << 7);
        out.set(fullSeqObu, 4);
        return out;
    }

    /** @private */
    static _readLeb128(b, start) {
        let v = 0;
        for (let i = 0; i < 8 && start + i < b.length; i++) {
            const byte = b[start + i];
            v |= (byte & 0x7F) << (7 * i);
            if ((byte & 0x80) === 0) {
                return { value: v, bytes: i + 1 };
            }
        }
        return null;
    }

    /** @private */
    static _readBits(br, n) {
        let v = 0;
        for (let i = 0; i < n; i++) {
            const bytePos = br.pos >> 3;
            if (bytePos >= br.data.length) {
                br.pos++;
                v <<= 1;
                continue;
            }
            const bit = (br.data[bytePos] >> (7 - (br.pos & 7))) & 1;
            v = (v << 1) | bit;
            br.pos++;
        }
        return v;
    }

    /**
     * Flush pending frames
     */
    async flush() {
        if (this.decoder && this.decoder.state !== 'closed') {
            try {
                await this.decoder.flush();
            } catch {
                // Ignore flush errors on closed decoder
            }
        }
    }

    /**
     * Get decoder statistics
     */
    getStats() {
        // Calculate actual video FPS from recent feed timestamps (last 1 second)
        const now = performance.now();
        while (this._feedTimestamps.length > 0 && this._feedTimestamps[0] < now - 1000) {
            this._feedTimestamps.shift();
        }
        const videoFps = this._feedTimestamps.length;

        return {
            codec: this.currentCodec,
            initialized: this.initialized,
            frameCount: this.frameCount,
            droppedFrames: this.droppedFrames,
            displayWidth: this.displayWidth,
            displayHeight: this.displayHeight,
            queueSize: this.decoder ? this.decoder.decodeQueueSize : 0,
            fallbackMode: this.fallbackMode,
            videoFps: videoFps
        };
    }

    /**
     * Close the decoder and release resources
     */
    close() {
        // Close WebCodecs decoder
        if (this.decoder && this.decoder.state !== 'closed') {
            try {
                this.decoder.close();
            } catch {
                // Ignore close errors
            }
        }
        this.decoder = null;

        // Stop video sync loop
        if (this._syncRafId) {
            cancelAnimationFrame(this._syncRafId);
            this._syncRafId = 0;
        }

        // Stop health check
        if (this._healthInterval) {
            clearInterval(this._healthInterval);
            this._healthInterval = 0;
        }

        // Clear feed tracking
        this._feedTimestamps = [];
        this._feedId = 0;

        // Destroy JMuxer
        if (this._jmuxer) {
            try {
                this._jmuxer.destroy();
            } catch {
                // Ignore destroy errors
            }
            this._jmuxer = null;
        }

        // Remove hidden video element
        if (this._videoEl) {
            this._videoEl.pause();
            this._videoEl.src = '';
            if (this._videoEl.parentNode) {
                this._videoEl.parentNode.removeChild(this._videoEl);
            }
            this._videoEl = null;
        }

        this._videoPlaying = false;
        this.fallbackMode = false;
        this.currentCodec = null;
        this.initialized = false;
        this._softwareRetry = false;
        this._av1DescriptionApplied = false;
    }
}

window.RDVideo = RDVideo;
