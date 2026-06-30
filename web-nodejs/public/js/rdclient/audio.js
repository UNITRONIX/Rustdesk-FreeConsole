/**
 * BetterDesk Web Remote Client - Audio Decoder
 * Uses AudioDecoder (WebCodecs) for Opus decoding when available.
 * Falls back to raw PCM playback when AudioDecoder is not supported.
 * RustDesk sends Opus-encoded audio frames at 48kHz stereo by default.
 */

// eslint-disable-next-line no-unused-vars
class RDAudio {
    constructor() {
        /** @type {AudioContext|null} */
        this.audioCtx = null;
        /** @type {number} Sample rate (from AudioFormat) */
        this.sampleRate = 48000;
        /** @type {number} Number of channels */
        this.channels = 2;
        /** @type {boolean} Toolbar mute toggle */
        this._userMuted = false;
        /** @type {boolean} Active tab in multi-session viewer */
        this._sessionActive = true;
        /** @type {boolean} */
        this.initialized = false;
        /** @type {number} Next scheduled playback time */
        this.nextPlayTime = 0;
        /** @type {GainNode|null} */
        this.gainNode = null;
        /** @type {number} Volume (0-1) */
        this.volume = 1.0;
        /** @type {number} Frames played counter */
        this.framesPlayed = 0;
        /** @type {AudioDecoder|null} WebCodecs audio decoder for Opus */
        this._audioDecoder = null;
        /** @type {boolean} Whether Opus decoding via AudioDecoder is available */
        this._opusSupported = false;
        /** @type {number} Monotonic timestamp counter for Opus decoder (microseconds) */
        this._opusTimestamp = 0;
    }

    /**
     * Check if Web Audio API is supported
     * @returns {boolean}
     */
    static isSupported() {
        return typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined';
    }

    /**
     * Check if AudioDecoder (WebCodecs audio) is available for Opus decoding
     * @returns {boolean}
     */
    static isAudioDecoderSupported() {
        return typeof AudioDecoder !== 'undefined';
    }

    /**
     * Initialize audio context (must be called after user gesture)
     * @param {Object} format - { sampleRate, channels }
     */
    async init(format = {}) {
        if (format.sampleRate) this.sampleRate = format.sampleRate;
        if (format.channels) this.channels = format.channels;

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AudioCtx({
            sampleRate: this.sampleRate,
            latencyHint: 'interactive'
        });

        // Expose for video.js retryPlay() to resume this session's context
        this._resumeHook = () => {
            if (this.audioCtx && this.audioCtx.state === 'suspended') {
                this.audioCtx.resume();
            }
        };

        // Create gain node for volume control
        this.gainNode = this.audioCtx.createGain();
        this.gainNode.gain.value = this.volume;
        this.gainNode.connect(this.audioCtx.destination);

        // Try to initialize Opus decoding via AudioDecoder
        if (RDAudio.isAudioDecoderSupported()) {
            try {
                const support = await AudioDecoder.isConfigSupported({
                    codec: 'opus',
                    sampleRate: this.sampleRate,
                    numberOfChannels: this.channels
                });
                if (support.supported) {
                    this._initOpusDecoder();
                    this._opusSupported = true;
                    console.log('[RDAudio] Opus decoding enabled via AudioDecoder');
                }
            } catch {
                console.log('[RDAudio] AudioDecoder Opus not supported, using raw PCM fallback');
            }
        }

        if (!this._opusSupported) {
            console.log('[RDAudio] Using raw PCM audio path (may produce noise if server sends Opus)');
        }

        this.nextPlayTime = 0;
        this.framesPlayed = 0;
        this._opusTimestamp = 0;
        this.initialized = true;
    }

    /**
     * Initialize AudioDecoder for Opus decoding
     */
    _initOpusDecoder() {
        this._audioDecoder = new AudioDecoder({
            output: (audioData) => this._handleDecodedAudio(audioData),
            error: (err) => console.warn('[RDAudio] Opus decode error:', err.message)
        });

        this._audioDecoder.configure({
            codec: 'opus',
            sampleRate: this.sampleRate,
            numberOfChannels: this.channels
        });
    }

    /**
     * Handle decoded audio data from AudioDecoder
     * @param {AudioData} audioData - Decoded audio samples
     */
    _handleDecodedAudio(audioData) {
        if (!this.audioCtx || !this.gainNode) {
            audioData.close();
            return;
        }

        const numFrames = audioData.numberOfFrames;
        const numChannels = audioData.numberOfChannels;
        const sampleRate = audioData.sampleRate;

        const audioBuffer = this.audioCtx.createBuffer(numChannels, numFrames, sampleRate);

        // Copy decoded data to AudioBuffer
        for (let ch = 0; ch < numChannels; ch++) {
            const channelData = audioBuffer.getChannelData(ch);
            audioData.copyTo(channelData, { planeIndex: ch, format: 'f32-planar' });
        }

        audioData.close();

        // Schedule playback
        const source = this.audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.gainNode);

        const currentTime = this.audioCtx.currentTime;
        if (this.nextPlayTime < currentTime) {
            this.nextPlayTime = currentTime + 0.005;
        } else if (this.nextPlayTime - currentTime > 0.3) {
            // Too far ahead — drop queued scheduling lag to avoid BufferSource buildup
            this.nextPlayTime = currentTime + 0.005;
        }

        source.start(this.nextPlayTime);
        this.nextPlayTime += audioBuffer.duration;
        this.framesPlayed++;
    }

    /**
     * Configure audio format (when AudioFormat message received)
     * @param {Object} format - { sampleRate, channels }
     */
    async configure(format) {
        if (this.sampleRate !== format.sampleRate || this.channels !== format.channels) {
            this.close();
            await this.init(format);
        }
    }

    /**
     * Decode and play an audio frame
     * @param {Object} audioFrame - { data: Uint8Array, timestamp: number }
     */
    play(audioFrame) {
        if (!this.initialized || !this._sessionActive || this._userMuted || !this.audioCtx) return;

        // Resume audio context if suspended (auto-play policy)
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }

        try {
            if (this._opusSupported && this._audioDecoder && this._audioDecoder.state !== 'closed') {
                // Decode Opus via AudioDecoder
                const chunk = new EncodedAudioChunk({
                    type: 'key',
                    timestamp: this._opusTimestamp,
                    data: audioFrame.data
                });
                this._audioDecoder.decode(chunk);
                // Each Opus frame is 20ms = 20000µs
                this._opusTimestamp += 20000;
            } else {
                // Fallback: treat as raw PCM (works if server sends raw PCM)
                this._playRawPcm(audioFrame.data);
            }
        } catch (err) {
            console.warn('[RDAudio] Playback error:', err.message);
        }
    }

    /**
     * Play raw PCM audio data (fallback path)
     * RustDesk sends 16-bit signed integer PCM, interleaved
     * @param {Uint8Array} pcmData
     */
    _playRawPcm(pcmData) {
        if (!pcmData || pcmData.length === 0) return;

        // Convert Int16 PCM to Float32
        const int16View = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 2);
        const numSamples = Math.floor(int16View.length / this.channels);

        if (numSamples === 0) return;

        const audioBuffer = this.audioCtx.createBuffer(this.channels, numSamples, this.sampleRate);

        // De-interleave channels and convert to float32
        for (let ch = 0; ch < this.channels; ch++) {
            const channelData = audioBuffer.getChannelData(ch);
            for (let i = 0; i < numSamples; i++) {
                channelData[i] = int16View[i * this.channels + ch] / 32768.0;
            }
        }

        // Schedule playback
        const source = this.audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.gainNode);

        const currentTime = this.audioCtx.currentTime;
        if (this.nextPlayTime < currentTime) {
            this.nextPlayTime = currentTime + 0.01;
        }

        source.start(this.nextPlayTime);
        this.nextPlayTime += audioBuffer.duration;
        this.framesPlayed++;
    }

    /**
     * Set volume level
     * @param {number} vol - 0.0 to 1.0
     */
    setVolume(vol) {
        this.volume = Math.max(0, Math.min(1, vol));
        this._updateGain();
    }

    /**
     * Mute/unmute audio (toolbar toggle)
     * @param {boolean} muted
     */
    setMuted(muted) {
        this._userMuted = !!muted;
        this._updateGain();
    }

    /**
     * Enable/disable playback for inactive viewer tabs
     * @param {boolean} active
     */
    setSessionActive(active) {
        this._sessionActive = active !== false;
        this._updateGain();
    }

    /** @private */
    _updateGain() {
        if (!this.gainNode) return;
        const silent = this._userMuted || !this._sessionActive;
        this.gainNode.gain.value = silent ? 0 : this.volume;
    }

    /**
     * Get audio stats
     */
    getStats() {
        return {
            initialized: this.initialized,
            enabled: this._sessionActive && !this._userMuted,
            sampleRate: this.sampleRate,
            channels: this.channels,
            framesPlayed: this.framesPlayed,
            volume: this.volume,
            state: this.audioCtx ? this.audioCtx.state : 'closed'
        };
    }

    /**
     * Close audio context and release resources
     */
    close() {
        // Close AudioDecoder for Opus
        if (this._audioDecoder && this._audioDecoder.state !== 'closed') {
            try {
                this._audioDecoder.close();
            } catch {
                // Ignore close errors
            }
        }
        this._audioDecoder = null;
        this._opusSupported = false;
        this._opusTimestamp = 0;

        if (this.audioCtx && this.audioCtx.state !== 'closed') {
            try {
                this.audioCtx.close();
            } catch {
                // Ignore close errors
            }
        }
        this.audioCtx = null;
        this._resumeHook = null;
        this.gainNode = null;
        this.initialized = false;
        this.framesPlayed = 0;
    }
}

window.RDAudio = RDAudio;
