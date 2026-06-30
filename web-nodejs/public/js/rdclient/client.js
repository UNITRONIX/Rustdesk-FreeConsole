/**
 * BetterDesk Web Remote Client - Main Client Orchestrator
 * Ties together all rdclient modules: connection, protocol, crypto,
 * video, audio, renderer, and input.
 *
 * Usage:
 *   const client = new RDClient(canvas, { deviceId: 'ABC123' });
 *   client.on('state', (state) => updateUI(state));
 *   await client.connect();
 *   // user enters password...
 *   await client.authenticate(password);
 *   // ...session runs...
 *   client.disconnect();
 */

/* global RDConnection, RDProtocol, RDCrypto, RDVideo, RDAudio, RDRenderer, RDInput, RDFileConnection, RDClipboard */

// eslint-disable-next-line no-unused-vars
class RDClient {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {Object} opts
     * @param {string} opts.deviceId - Target device ID
     * @param {boolean} [opts.disableAudio=false]
     * @param {number} [opts.fps=30]
     * @param {string} [opts.scaleMode='fit']
     */
    constructor(canvas, opts = {}) {
        if (!canvas) throw new Error('Canvas element required');
        if (!opts.deviceId) throw new Error('deviceId required');

        this.deviceId = opts.deviceId;
        this.opts = opts;

        // Sub-modules
        this.conn = new RDConnection();
        this.proto = new RDProtocol();
        this.crypto = new RDCrypto();
        this.video = new RDVideo();
        this.audio = new RDAudio();
        this.renderer = new RDRenderer(canvas);
        this.input = new RDInput(canvas, this.renderer, (msg) => this._sendPeerMessage(msg));
        this._fileConnection = null;
        this._sessionPassword = '';
        this.fileTransfer = new RDFileTransfer({
            proto: this.proto,
            sendMessage: (msg) => this._sendFileTransferMessage(msg),
            emit: (event, ...args) => this._emit(event, ...args),
            ensureConnected: () => this.ensureFileConnection(),
            isConnected: () => this.isFileConnectionReady()
        });

        // State
        this._state = 'idle'; // idle | connecting | waiting_password | waiting_2fa | authenticating | streaming | disconnected | error
        this._listeners = {};
        this._peerInfo = null;
        this._loginChallenge = null;
        this._pingInterval = null;
        this._statsInterval = null;

        // Stream decoders for RustDesk variable-length frame codec (TCP reassembly)
        this._rendezvousDecoder = null;
        this._relayDecoder = null;

        // Codec / quality control
        this._codecAbilities = null;          // probed VideoDecoder support map
        this._preferCodec = opts.preferCodec || 'Auto';
        this._adaptivePaused = false;         // true once the user picks codec/quality manually
        this._codecFallbackDone = false;      // one automatic downgrade per session

        // Relay state tracking
        this._relayFrameIdx = 0;         // Counter for relay frames (debugging)
        this._relayConfirmReceived = false; // Whether hbbr's RelayResponse confirmation was consumed
        this._peerEncryptionConfirmed = false; // Whether peer has started encrypting
        this._keyExchangePending = false;  // True when we have keys ready but haven't sent PublicKey yet
        this._keyExchangeDone = false;     // True after PublicKey was sent and crypto enabled

        // Settings
        this.renderer.setScaleMode(opts.scaleMode || 'fit');

        // Multi-session viewer: remote.js toggles these when switching tabs
        this._sessionActive = true;
        this._clipboardToLocalEnabled = true;
        this._savedActiveFps = null;
        this._backgroundFps = 1;
        this._streamThrottledActive = null;
        this.video.getAudioContext = () => this.audio.audioCtx;
    }

    get state() { return this._state; }
    get peerInfo() { return this._peerInfo; }

    // ---- Event Emitter ----

    on(event, fn) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(fn);
        return this;
    }

    off(event, fn) {
        const arr = this._listeners[event];
        if (arr) this._listeners[event] = arr.filter(f => f !== fn);
        return this;
    }

    _emit(event, ...args) {
        const arr = this._listeners[event];
        if (arr) arr.forEach(fn => { try { fn(...args); } catch(e) { console.error(e); } });
    }

    // ---- Main Connection Flow ----

    /**
     * Start connection to remote device
     * Flow: load proto → rendezvous → punch hole → relay → wait for SignedId → key exchange → encrypted session
     *
     * RustDesk handshake (after relay pairing):
     *   1. Target sends SignedId (unencrypted, signed with Ed25519)
     *   2. We verify, extract target's ephemeral Curve25519 pk
     *   3. We generate keypair + symmetric key, encrypt symkey with NaCl box
     *   4. We send PublicKey { our_pk, encrypted_symkey }
     *   5. Target decrypts symkey, enables encryption
     *   6. Target sends Hash (encrypted) - password challenge
     *   7. We decrypt, show password prompt
     */
    async connect() {
        try {
            this._setState('connecting');
            this._emit('log', 'Loading protocol definitions...');

            // Step 1: Load protobuf definitions
            await this.proto.load();

            // Step 2: Check WebCodecs support (non-blocking, fallback available)
            if (!RDVideo.isSupported()) {
                this._emit('log', 'WebCodecs unavailable, using software fallback');
            }

            // Step 3: Create stream decoders for TCP frame reassembly
            this._rendezvousDecoder = this.proto.createStreamDecoder();
            this._relayDecoder = this.proto.createStreamDecoder();

            // Step 4: Connect to rendezvous server via WS proxy
            this._emit('log', 'Connecting to rendezvous server...');
            await this.conn.connectRendezvous();

            // Step 5: Send PunchHoleRequest (with server public key for licence validation)
            this._emit('log', `Requesting connection to ${this.deviceId}...`);
            const punchHole = this.proto.buildPunchHoleRequest(this.deviceId, this.opts.serverPubKey);
            const punchData = this.proto.encodeRendezvous(punchHole);
            this.conn.sendRendezvous(punchData);

            // Step 6: Wait for PunchHoleResponse / RelayResponse from hbbs
            const rendezvousResponse = await this._waitForRendezvousResponse();

            if (rendezvousResponse.error) {
                throw new Error(`Connection refused: ${rendezvousResponse.error}`);
            }

            // Store peer's server-signed pk for SignedId verification (from RelayResponse.pk)
            this._peerSignedPk = rendezvousResponse.pk || null;

            // Step 7: Determine relay UUID.
            //
            // PunchHoleResponse does NOT contain a UUID — only natType and relayServer.
            // The signal server expects us to send RequestRelay{uuid} back on the SAME
            // rendezvous connection so it can forward the UUID to the target device.
            // Both sides then connect to hbbr with the same UUID → relay pairs them.
            //
            // If we already received a RelayResponse (which has a UUID), skip this step.
            let relayUUID = rendezvousResponse.uuid || '';
            let relayServer = rendezvousResponse.relayServer || '';

            if (!relayUUID) {
                relayUUID = (window.crypto && typeof window.crypto.randomUUID === 'function'
                    ? window.crypto.randomUUID()
                    : (() => {
                        const bytes = new Uint8Array(16);
                        if (window.crypto && window.crypto.getRandomValues) {
                            window.crypto.getRandomValues(bytes);
                        } else {
                            for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
                        }
                        bytes[6] = (bytes[6] & 0x0f) | 0x40;
                        bytes[8] = (bytes[8] & 0x3f) | 0x80;
                        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
                        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
                    })());

                // Step 8: Send RequestRelay back to hbbs (signal server) via rendezvous
                // so it can tell the target device to connect to relay with our UUID.
                this._emit('log', `Requesting relay (uuid: ${relayUUID.substring(0, 8)}...)...`);
                const requestRelaySignal = this.proto.buildRequestRelay(
                    this.deviceId,
                    relayUUID,
                    relayServer,
                    this.opts.serverPubKey
                );
                const signalData = this.proto.encodeRendezvous(requestRelaySignal);
                this.conn.sendRendezvous(signalData);

                // Step 9: Wait for RelayResponse from hbbs confirming the relay setup
                const relayConfirm = await this._waitForSignalRelayResponse();
                if (relayConfirm.error) {
                    throw new Error(`Relay refused: ${relayConfirm.error}`);
                }
                // Use the confirmed UUID and relay server from hbbs
                relayUUID = relayConfirm.uuid || relayUUID;
                relayServer = relayConfirm.relayServer || relayServer;
                if (relayConfirm.pk) {
                    this._peerSignedPk = relayConfirm.pk;
                }
                console.log(`[RDClient] RelayResponse confirmed: uuid=${relayUUID.substring(0, 8)}... relay=${relayServer}`);
            }

            // Step 10: Close rendezvous, connect to relay
            this.conn.closeRendezvous();

            this._emit('log', 'Connecting to relay server...');
            await this.conn.connectRelay();

            // Step 11: Setup relay message handler BEFORE sending anything
            this.conn.on('relay:message', (data) => this._handleRelayData(data));
            this.conn.on('relay:close', () => {
                if (this._state !== 'disconnected' && this._state !== 'error') {
                    this._handleDisconnect('Relay connection closed');
                }
            });
            this.conn.on('relay:error', (e) => this._handleDisconnect('Relay error: ' + e.message));

            // Step 12: Send RequestRelay to hbbr (relay expects this as first message for pairing)
            this._emit('log', `Connecting to relay (uuid: ${relayUUID.substring(0, 8)}...)...`);
            const requestRelay = this.proto.buildRequestRelay(
                this.deviceId,
                relayUUID,
                relayServer,
                this.opts.serverPubKey
            );
            const relayData = this.proto.encodeRendezvous(requestRelay);
            this.conn.sendRelay(relayData);

            // Step 13: Wait for target's SignedId (first message from relay)
            // Target sends SignedId FIRST (unencrypted, signed with their Ed25519 key).
            // We do NOT send anything until we process SignedId and perform key exchange.
            this._emit('log', 'Waiting for peer handshake...');
            this._setState('waiting_password');

        } catch (err) {
            this._handleError(err);
        }
    }

    /**
     * Open dedicated FILE_TRANSFER relay (lazy). Reuses desktop session password.
     * @returns {Promise<void>}
     */
    isFileConnectionReady() {
        return !!(this._fileConnection && this._fileConnection.state === 'ready');
    }

    async ensureFileConnection() {
        if (typeof RDFileConnection !== 'function') {
            throw new Error('File transfer module not loaded');
        }
        if (!this.proto.loaded) await this.proto.load();
        if (!this._fileConnection) {
            this._fileConnection = new RDFileConnection({
                deviceId: this.deviceId,
                serverPubKey: this.opts.serverPubKey || '',
                myName: this.opts.myName || 'BetterDesk Web',
                proto: this.proto
            });
            this._fileConnection.on('file_response', (resp) => {
                this.fileTransfer.handleFileResponse(resp);
            });
            this._fileConnection.on('file_action', (action) => {
                if (action.sendConfirm) {
                    this.fileTransfer.handleSendConfirm(action.sendConfirm);
                }
            });
            this._fileConnection.on('2fa_required', () => this._emit('2fa_required'));
            this._fileConnection.on('2fa_error', (err) => this._emit('2fa_error', err));
            this._fileConnection.on('login_error', (err) => this._emit('login_error', err));
            this._fileConnection.on('disconnected', () => {
                if (this._fileConnection && this._fileConnection.state !== 'ready') {
                    this._fileConnection = null;
                }
            });
        }
        if (this._fileConnection.state === 'ready') return;
        try {
            await this._fileConnection.connect(this._sessionPassword || '');
        } catch (err) {
            this.disconnectFileConnection();
            throw err;
        }
    }

    _sendFileTransferMessage(msgObj) {
        if (!this._fileConnection || this._fileConnection.state !== 'ready') {
            throw new Error('File transfer session is not connected');
        }
        this._fileConnection.sendMessage(msgObj);
    }

    disconnectFileConnection() {
        if (this._fileConnection) {
            this._fileConnection.disconnect();
            this._fileConnection = null;
        }
    }

    /**
     * Authenticate with password
     * @param {string} password
     */
    async authenticate(password) {
        try {
            this._setState('authenticating');
            this._emit('log', 'Authenticating...');
            this._sessionPassword = password != null ? String(password) : '';

            // Hash the password
            const challenge = this._loginChallenge || '';
            const salt = this._loginSalt || '';
            console.log('[RDClient] Auth: challenge=' + JSON.stringify(challenge).substring(0, 80)
                + ' salt=' + JSON.stringify(salt) + ' passLen=' + password.length);

            const hash = await this.crypto.hashPassword(password, salt, challenge);
            console.log('[RDClient] Auth: hash=' + Array.from(hash.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('')
                + '... (' + hash.length + ' bytes)');

            // Probe which codecs this browser's VideoDecoder can actually decode so we
            // only advertise real abilities (avoids the peer sending a codec we can't decode).
            if (!this._codecAbilities) {
                try { this._codecAbilities = await RDVideo.getSupportedCodecs(); }
                catch { this._codecAbilities = null; }
            }

            // Build and send LoginRequest
            // username must be set to target device ID (RustDesk validates: is_ip || is_domain_port || == Config::get_id())
            const loginReq = this.proto.buildLoginRequest(hash, {
                username: this.deviceId,
                myId: 'betterdesk-web-' + Date.now().toString(36),
                myName: this.opts.myName || this.opts.myName || 'BetterDesk Web',
                disableAudio: this.opts.disableAudio || false,
                fps: this.opts.fps || 60,
                imageQuality: this.opts.imageQuality || 'Best',
                codecAbilities: this._codecAbilities,
                preferCodec: this._preferCodec
            });

            console.log('[RDClient] Auth: sending LoginRequest, crypto.enabled=' + this.crypto.enabled
                + ' sendSeq=' + this.crypto._sendSeq + ' relayWsState=' + (this.conn.relayWs?.readyState));
            this._sendPeerMessage(loginReq);
            console.log('[RDClient] Auth: LoginRequest sent, sendSeq now=' + this.crypto._sendSeq);

            // The response will be handled in _handleRelayMessage

        } catch (err) {
            this._handleError(err);
        }
    }

    /**
     * Submit 2FA verification code (TOTP)
     * @param {string} code - 6-digit TOTP code
     */
    submit2FA(code) {
        try {
            this._setState('authenticating');
            this._emit('log', 'Verifying 2FA code...');

            // Field must be auth_2fa — auth2Fa encodes as an empty Message (protobuf.js quirk).
            this._sendPeerMessage(this.proto.buildAuth2FA(code.trim()));
            console.log('[RDClient] Auth2FA sent');
        } catch (err) {
            this._handleError(err);
        }
    }

    /**
     * Disconnect from remote device
     */
    disconnect() {
        this._cleanup();
        this._setState('disconnected');
        this._emit('log', 'Disconnected');
    }

    // ---- Message Handling ----

    /**
     * Wait for rendezvous server response (PunchHoleResponse or RelayResponse)
     * 
     * Flow: After PunchHoleRequest, hbbs either:
     * - Sends PunchHoleResponse(failure) immediately if target not found/offline
     * - Forwards PunchHole to target peer, then later forwards RelayResponse 
     *   (from target peer) back to us through the same TCP connection
     * 
     * @returns {Promise<Object>}
     */
    _waitForRendezvousResponse() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.conn.off('rendezvous:message', handler);
                reject(new Error('Rendezvous response timeout (30s) - target device may be offline'));
            }, 30000);

            const handler = (rawData) => {
                // Decode frames from raw TCP data via stream decoder
                const frames = this._rendezvousDecoder.feed(rawData);
                if (frames.length === 0) return; // Incomplete frame, wait for more data

                // Process ALL decoded frames — the first may be a KeyExchange
                // from the server's secure TCP handshake; we skip it and wait
                // for the actual PunchHoleResponse or RelayResponse.
                for (const frame of frames) {
                    try {
                        const msg = this.proto.decodeRendezvous(frame);

                        // Skip KeyExchange from the Go signal server's NaCl
                        // secure TCP negotiation — the WS proxy bridges raw TCP
                        // bytes so we see the server's greeting before our response.
                        if (msg.keyExchange) {
                            console.log('[RDClient] Skipping server KeyExchange (secure TCP greeting)');
                            continue;
                        }

                        // Skip HealthCheck and other housekeeping messages
                        if (msg.hc) {
                            continue;
                        }

                        if (msg.punchHoleResponse) {
                            clearTimeout(timeout);
                            this.conn.off('rendezvous:message', handler);
                            const resp = msg.punchHoleResponse;
                            console.log('[RDClient] PunchHoleResponse:', JSON.stringify({
                                failure: resp.failure,
                                relayServer: resp.relayServer,
                                otherFailure: resp.otherFailure,
                                hasSocketAddr: !!(resp.socketAddr && resp.socketAddr.length),
                                hasPk: !!(resp.pk && resp.pk.length),
                                natType: resp.natType
                            }));
                            // Check for failure:
                            // Proto3 default enum = 0 (ID_NOT_EXIST), so we check if we got
                            // a relay server or socket_addr to determine success
                            const hasRelay = resp.relayServer && resp.relayServer.length > 0;
                            const hasSocket = resp.socketAddr && resp.socketAddr.length > 0;

                            if (hasRelay || hasSocket) {
                                resolve({
                                    relayServer: resp.relayServer || '',
                                    uuid: resp.uuid || '',
                                    pk: resp.pk || null,
                                    natType: resp.natType
                                });
                            } else {
                                const failureNames = {
                                    0: 'Device not found',     // ID_NOT_EXIST
                                    2: 'Device offline',       // OFFLINE
                                    3: 'License mismatch',     // LICENSE_MISMATCH
                                    4: 'Too many connections'  // LICENSE_OVERUSE
                                };
                                const reason = resp.otherFailure
                                    || failureNames[resp.failure]
                                    || `Unknown error (code: ${resp.failure})`;
                                resolve({ error: reason });
                            }
                            return;
                        }

                        if (msg.relayResponse) {
                            clearTimeout(timeout);
                            this.conn.off('rendezvous:message', handler);
                            const rr = msg.relayResponse;
                            console.log('[RDClient] RelayResponse from hbbs:', JSON.stringify({
                                relayServer: rr.relayServer || '',
                                uuid: (rr.uuid || '').substring(0, 8) + '...',
                                id: rr.id || '',
                                hasPk: !!(rr.pk && rr.pk.length),
                                refuseReason: rr.refuseReason || ''
                            }));
                            if (rr.refuseReason && rr.refuseReason.length > 0) {
                                resolve({ error: 'Relay refused: ' + rr.refuseReason });
                            } else {
                                resolve({
                                    relayServer: rr.relayServer || '',
                                    uuid: rr.uuid || '',
                                    pk: rr.pk || null,
                                    id: rr.id || ''
                                });
                            }
                            return;
                        }

                        // Unknown message type — log and skip, keep waiting
                        const fieldNames = Object.keys(msg).filter(k => msg[k] != null && k !== 'union');
                        console.log('[RDClient] Skipping rendezvous message:', fieldNames.join(', ') || 'empty');
                    } catch (err) {
                        // Protobuf decode error — skip this frame and continue
                        console.warn('[RDClient] Failed to decode rendezvous frame, skipping:', err.message);
                    }
                }
            };

            this.conn.on('rendezvous:message', handler);
        });
    }

    /**
     * Wait for RelayResponse from signal server (hbbs) after sending RequestRelay.
     *
     * After PunchHoleResponse (natType=SYMMETRIC), we send RequestRelay{uuid} back
     * to hbbs on the same rendezvous connection. hbbs forwards the request to the
     * target device (tells it to connect to relay with our UUID) and sends back a
     * RelayResponse confirming the UUID and relay server.
     *
     * @returns {Promise<{uuid: string, relayServer: string, pk: Uint8Array|null, error?: string}>}
     */
    _waitForSignalRelayResponse() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.conn.off('rendezvous:message', handler);
                reject(new Error('RelayResponse timeout (15s) — target device may be unreachable'));
            }, 15000);

            const handler = (rawData) => {
                const frames = this._rendezvousDecoder.feed(rawData);
                if (frames.length === 0) return;

                for (const frame of frames) {
                    try {
                        const msg = this.proto.decodeRendezvous(frame);

                        // Skip KeyExchange, HealthCheck, and other housekeeping
                        if (msg.keyExchange || msg.hc) continue;

                        if (msg.relayResponse) {
                            clearTimeout(timeout);
                            this.conn.off('rendezvous:message', handler);
                            const rr = msg.relayResponse;
                            console.log('[RDClient] Signal RelayResponse:', JSON.stringify({
                                relayServer: rr.relayServer || '',
                                uuid: (rr.uuid || '').substring(0, 8) + '...',
                                hasPk: !!(rr.pk && rr.pk.length),
                                refuseReason: rr.refuseReason || ''
                            }));
                            if (rr.refuseReason && rr.refuseReason.length > 0) {
                                resolve({ error: rr.refuseReason });
                            } else {
                                resolve({
                                    uuid: rr.uuid || '',
                                    relayServer: rr.relayServer || '',
                                    pk: rr.pk || null
                                });
                            }
                            return;
                        }

                        // PunchHoleSent may arrive from target — it's just an update,
                        // not what we are waiting for. Log and continue.
                        if (msg.punchHoleResponse || msg.punchHoleSent) {
                            console.log('[RDClient] Skipping late PunchHoleResponse/Sent while waiting for RelayResponse');
                            continue;
                        }

                        const fieldNames = Object.keys(msg).filter(k => msg[k] != null && k !== 'union');
                        console.log('[RDClient] Skipping signal message while waiting for RelayResponse:', fieldNames.join(', '));
                    } catch (err) {
                        console.warn('[RDClient] Failed to decode signal frame:', err.message);
                    }
                }
            };

            this.conn.on('rendezvous:message', handler);
        });
    }

    /**
     * Handle raw incoming relay data (TCP chunks via WebSocket)
     * Uses stream decoder for frame reassembly, then dispatches each complete message.
     *
     * After hbbr pairs both peers (by UUID), the relay operates in raw mode — just
     * bridging TCP bytes. However, the FIRST framed message from hbbr is a
     * RendezvousMessage.RelayResponse confirmation (not a peer Message).
     * We detect and skip it, then process all subsequent frames as peer Messages.
     *
     * @param {ArrayBuffer} rawData
     */
    _handleRelayData(rawData) {
        try {
            const frames = this._relayDecoder.feed(rawData);
            for (const frame of frames) {
                this._handleRelayMessage(frame);
            }
        } catch (err) {
            console.warn('[RDClient] Error decoding relay data:', err.message);
        }
    }

    /**
     * Handle a single decoded relay frame (protobuf bytes).
     *
     * Frame sequence on a relay connection:
     *   #1: hbbr RelayResponse confirmation (RendezvousMessage — skip this)
     *   #2: Target's SignedId (Message, unencrypted)
     *   #3+: Target's Hash, TestDelay etc. — may be plaintext OR encrypted
     *        depending on whether the target has processed our PublicKey yet
     *   #N:  Once peer encryption is confirmed, all subsequent frames are encrypted
     *
     * Deferred key exchange: after receiving SignedId we prepare the keys but
     * do NOT send PublicKey yet.  We wait for the next peer frame:
     *   • If it is plaintext (e.g. Hash) → peer is NOT encrypting → we skip the
     *     key exchange entirely and communicate in plaintext.
     *   • If it is encrypted → peer already processed our PublicKey (shouldn’t
     *     happen since we haven’t sent it yet in this flow) or peer uses some
     *     other encryption setup — handled via speculative decrypt.
     *
     * @param {Uint8Array} frameData - Raw protobuf bytes (frame header already stripped)
     */
    _handleRelayMessage(frameData) {
        try {
            this._relayFrameIdx++;
            const idx = this._relayFrameIdx;
            const hex20 = Array.from(frameData.slice(0, 20))
                .map(b => b.toString(16).padStart(2, '0')).join(' ');
            console.log(`[RDClient] Relay frame #${idx}: ${frameData.length} bytes [${hex20}]`);

            // The relay server (hbbr) sends a RendezvousMessage.RelayResponse
            // as the first frame after pairing both peers.  Skip it.
            if (!this._relayConfirmReceived) {
                this._relayConfirmReceived = true;
                try {
                    const rdvMsg = this.proto.decodeRendezvous(frameData);
                    if (rdvMsg.relayResponse) {
                        const uuid = (rdvMsg.relayResponse.uuid || '').substring(0, 8);
                        console.log(`[RDClient] Relay confirmation received (UUID: ${uuid}...), skipping`);
                        return;
                    }
                } catch (_e) {
                    console.log('[RDClient] First relay frame is not a relay confirmation');
                }
            }

            let data = frameData;

            // --- Deferred key exchange decision ---
            // If we have keys prepared (_keyExchangePending) but haven't sent
            // PublicKey yet, this frame tells us whether the peer uses encryption.
            if (this._keyExchangePending && !this._keyExchangeDone) {
                // Try decoding as plaintext Message first.
                let isPlaintext = false;
                try {
                    const probe = this.proto.decodeMessage(frameData);
                    // Check if the decoded message has any meaningful field set.
                    // A plaintext Hash (field 9) with human-readable salt/challenge
                    // is the strongest signal that the peer is NOT encrypting.
                    const fields = Object.keys(probe).filter(k => probe[k] != null && k !== 'union');
                    if (fields.length > 0) {
                        isPlaintext = true;
                    }
                } catch (_e) {
                    // Decode failed — likely encrypted data
                }

                if (isPlaintext) {
                    // Peer is NOT encrypting.  Abandon the key exchange — do NOT
                    // send PublicKey.  All communication stays in plaintext.
                    console.warn(`[RDClient] Frame #${idx}: peer sent plaintext → connection NOT encrypted`);
                    this._keyExchangePending = false;
                    this._keyExchangeDone = false;
                    this._emit('encryption_warning', 'Connection is not encrypted — peer did not use encryption.');
                    // Fall through to process this frame as plaintext
                } else {
                    // Frame doesn't decode as plaintext Message — peer might be
                    // encrypting (unlikely since we haven't sent PublicKey, but
                    // handle defensively).  Complete the key exchange now, then
                    // try to decrypt.
                    console.log(`[RDClient] Frame #${idx}: not plaintext → completing key exchange`);
                    this._completeKeyExchange();
                    // Try to decrypt below
                }
            }

            // --- Speculative decryption ---
            if (this.crypto.secretKey && this._keyExchangeDone) {
                const spec = this.crypto.tryDecrypt(new Uint8Array(data));

                if (spec) {
                    this.crypto.commitDecrypt(spec.seq);
                    data = spec.plaintext;

                    if (!this._peerEncryptionConfirmed) {
                        this._peerEncryptionConfirmed = true;
                        console.log(`[RDClient] Peer encryption confirmed at frame #${idx} (seq=${spec.seq})`);
                    }
                } else if (this._peerEncryptionConfirmed) {
                    const failHex = Array.from(frameData.slice(0, 48))
                        .map(b => b.toString(16).padStart(2, '0')).join(' ');
                    console.warn(`[RDClient] Decryption FAILED (peer was encrypting)`
                        + ` nextSeq=${this.crypto._recvSeq + 1} frameLen=${frameData.length}`);
                    console.warn(`[RDClient] Ciphertext[0..48]: ${failHex}`);
                    return;
                } else {
                    // Key exchange done but peer hasn't encrypted yet — plaintext
                    console.log(`[RDClient] Frame #${idx}: plaintext (peer crypto not yet active)`);
                }
            }

            const msg = this.proto.decodeMessage(data);
            const fields = Object.keys(msg).filter(k => msg[k] != null && k !== 'union');
            if (idx <= 10 || fields.length === 0) {
                console.log(`[RDClient] Frame #${idx} → ${fields.join(', ') || '(empty Message)'}`);
            }
            this._dispatchMessage(msg);

        } catch (err) {
            console.warn('[RDClient] Error handling relay message:', err.message, err.stack);
        }
    }

    /**
     * Dispatch decoded peer message to appropriate handler
     * @param {Object} msg - Decoded protobuf Message
     */
    _dispatchMessage(msg) {
        // Hash challenge (before login)
        if (msg.hash) {
            this._loginChallenge = msg.hash.challenge || '';
            this._loginSalt = msg.hash.salt || '';
            this._emit('log', 'Password required');
            this._setState('waiting_password');
            this._emit('password_required');
            return;
        }

        // Login response
        if (msg.loginResponse) {
            this._handleLoginResponse(msg.loginResponse);
            return;
        }

        // Video frame
        if (msg.videoFrame) {
            this._handleVideoFrame(msg.videoFrame);
            return;
        }

        // Audio frame
        if (msg.audioFrame) {
            this._handleAudioFrame(msg.audioFrame);
            return;
        }

        // Cursor data (cursor image)
        if (msg.cursorData) {
            this.renderer.updateCursor(msg.cursorData).catch(() => {
                // Handled inside updateCursor — ignore unhandled promise rejection
            });
            return;
        }

        // Cursor position
        if (msg.cursorPosition) {
            this.renderer.updateCursorPosition(msg.cursorPosition);
            return;
        }

        // Cursor ID (predefined cursor)
        if (msg.cursorId) {
            this._emit('cursor_id', msg.cursorId);
            return;
        }

        // Clipboard (legacy single entry)
        if (msg.clipboard) {
            this._handleClipboard(msg.clipboard);
            return;
        }

        // Multi-format clipboard (RustDesk >= 1.3.0)
        if (msg.multiClipboards) {
            this._handleMultiClipboards(msg.multiClipboards);
            return;
        }

        // Test delay (ping/pong)
        if (msg.testDelay) {
            this._handleTestDelay(msg.testDelay);
            return;
        }

        // Misc messages
        if (msg.misc) {
            this._handleMisc(msg.misc);
            return;
        }

        // Audio format
        if (msg.audioFormat) {
            this.audio.configure({
                sampleRate: msg.audioFormat.sampleRate || 48000,
                channels: msg.audioFormat.channels || 2
            });
            return;
        }

        // Peer info
        if (msg.peerInfo) {
            this._handlePeerInfo(msg.peerInfo);
            return;
        }

        // Public key from peer
        if (msg.publicKey) {
            this._handlePeerPublicKey(msg.publicKey);
            return;
        }

        // File response (directory listing, transfer blocks, digest, done, error)
        if (msg.fileResponse) {
            this.fileTransfer.handleFileResponse(msg.fileResponse);
            return;
        }

        // Signed ID from peer
        if (msg.signedId) {
            this._handleSignedId(msg.signedId);
            return;
        }
    }

    // ---- Specific Message Handlers ----

    _handlePeerPublicKey(pk) {
        // This handler is for the case where the peer sends PublicKey
        // (non-standard flow). In standard RustDesk flow, the target
        // sends SignedId first, and WE send PublicKey back.
        console.log('[RDClient] Received unexpected PublicKey from peer');
    }

    /**
     * Handle SignedId from target peer.
     * SignedId.id = 64-byte Ed25519 signature + protobuf(IdPk{ id, pk })
     * where pk is the target's EPHEMERAL Curve25519 public key.
     *
     * DEFERRED key exchange: We prepare the cryptographic material but do NOT
     * send PublicKey yet.  The next incoming frame will tell us whether the
     * peer uses encryption:
     *   - Plaintext Hash → peer sent Hash before enabling crypto → skip key
     *     exchange entirely, communicate in plaintext.
     *   - Encrypted data → complete the key exchange (send PublicKey, enable
     *     secretbox). This covers the standard RustDesk flow where the target
     *     waits for our PublicKey before sending Hash.
     */
    _handleSignedId(signedId) {
        const idBytes = signedId.id;
        if (!idBytes || idBytes.length === 0) {
            this._emit('log', 'Received empty SignedId');
            return;
        }

        // Parse SignedId: extract target's ephemeral Curve25519 pk
        const parsed = this.crypto.parseSignedId(
            new Uint8Array(idBytes),
            this.proto.types.IdPk
        );

        if (!parsed) {
            this._emit('log', 'Failed to parse SignedId');
            return;
        }

        this._emit('log', `Peer identified: ${parsed.peerId}`);
        const peerPkHex = Array.from(parsed.peerPk.slice(0, 8))
            .map(b => b.toString(16).padStart(2, '0')).join('');
        console.log(`[RDClient] Peer ephemeral pk: ${parsed.peerPk.length} bytes [${peerPkHex}...]`);

        // Verify Ed25519 signature against server public key (MITM protection)
        const serverPubKey = this.opts.serverPubKey || '';
        if (serverPubKey && serverPubKey.length >= 64) {
            const verified = RDCrypto.verifySignedId(parsed.signature, parsed.payload, serverPubKey);
            parsed.signatureVerified = verified;
            if (verified) {
                console.log('[RDClient] Ed25519 signature VERIFIED — peer identity authenticated');
                this._emit('log', 'Peer identity verified (Ed25519)');
            } else {
                console.warn('[RDClient] Ed25519 signature FAILED — possible MITM attack!');
                this._emit('signature_warning', 'Ed25519 signature verification failed. Connection may be intercepted.');
                this._emit('log', 'WARNING: Peer signature verification failed');
            }
        } else {
            console.log('[RDClient] No server public key available — signature not verified');
        }

        // Prepare key material but DO NOT send PublicKey yet.
        // We defer the decision until we see the next peer frame.
        this.crypto.generateKeyPair();
        this.crypto.generateSymmetricKey();
        this.crypto.setPeerPublicKey(parsed.peerPk);

        const ourPkHex = Array.from(this.crypto.asymKeyPair.publicKey.slice(0, 8))
            .map(b => b.toString(16).padStart(2, '0')).join('');
        const symKeyHex = Array.from(this.crypto.secretKey.slice(0, 8))
            .map(b => b.toString(16).padStart(2, '0')).join('');
        console.log(`[RDClient] Keys prepared (deferred): ourPk=[${ourPkHex}...] symKey=[${symKeyHex}...]`);

        this._keyExchangePending = true;
        this._keyExchangeDone = false;
        this._emit('log', 'Key exchange prepared, waiting for peer to decide encryption mode...');
    }

    /**
     * Complete the deferred key exchange: send PublicKey and enable encryption.
     * Called when we detect the peer IS using encryption.
     */
    _completeKeyExchange() {
        if (this._keyExchangeDone) return;
        if (!this.crypto.peerPk) {
            console.warn('[RDClient] Cannot complete key exchange: no peer pk');
            return;
        }

        const keyMsg = this.crypto.createSymmetricKeyMsg(this.crypto.peerPk);
        console.log(`[RDClient] Completing key exchange: sealed=${keyMsg.symmetricValue.length} bytes`);

        const pkMsg = this.proto.buildPublicKey(
            keyMsg.asymmetricValue,
            keyMsg.symmetricValue
        );
        this._sendPeerMessage(pkMsg);

        // Enable outgoing encryption (counters start at 0)
        this.crypto.enabled = true;
        this.crypto._sendSeq = 0;
        this.crypto._recvSeq = 0;

        this._keyExchangePending = false;
        this._keyExchangeDone = true;
        console.log('[RDClient] Key exchange completed: encryption enabled');
    }

    _is2faWrongError(error) {
        const errLower = (error || '').toLowerCase();
        return errLower.includes('wrong 2fa') || errLower.includes('invalid 2fa');
    }

    _is2faRequiredError(error) {
        if (this._is2faWrongError(error)) return false;
        const errLower = (error || '').toLowerCase();
        return errLower.includes('2fa required')
            || errLower.includes('totp')
            || errLower.includes('verification code');
    }

    _handleLoginResponse(resp) {
        console.log('[RDClient] LoginResponse:', JSON.stringify(resp, (k, v) => {
            if (v && v.type === 'Buffer') return '<Buffer>';
            if (v instanceof Uint8Array) return '<bytes:' + v.length + '>';
            return v;
        }).substring(0, 500));

        if (resp.error && resp.error.length > 0) {
            console.log('[RDClient] Login error: ' + resp.error);

            // RustDesk peer errors: REQUIRE_2FA = "2FA Required", LOGIN_MSG_2FA_WRONG = "Wrong 2FA Code"
            if (this._is2faWrongError(resp.error)) {
                console.log('[RDClient] 2FA code rejected: ' + resp.error);
                this._setState('waiting_2fa');
                this._emit('2fa_error', resp.error);
                return;
            }
            if (this._is2faRequiredError(resp.error)) {
                console.log('[RDClient] 2FA required by peer');
                this._setState('waiting_2fa');
                this._emit('2fa_required');
                return;
            }

            this._emit('login_error', resp.error);
            this._setState('waiting_password');
            return;
        }

        // Login successful
        this._peerInfo = resp.peerInfo || null;
        console.log('[RDClient] Login successful, peerInfo:', this._peerInfo ? 'present' : 'null');
        this._processPeerInfo(this._peerInfo);
        this._emit('log', 'Login successful');
        this._emit('login_success', resp);
        if (this._peerInfo) this._emit('peer_info', this._peerInfo);
        this._startSession();
    }

    _handlePeerInfo(info) {
        this._peerInfo = info;
        this._processPeerInfo(info);
        this._emit('peer_info', info);

        // If we got peer info without hash challenge, session can start
        if (this._state === 'waiting_password') {
            // Some devices don't require password
            this._emit('log', 'No password required');
            this._startSession();
        }
    }

    async _handleVideoFrame(videoFrame) {
        // Send video_received ack IMMEDIATELY before any decoding
        // Without this, RustDesk peer throttles down to 1-5 FPS
        // Sending before decode ensures the ack goes out even if decode is slow
        this._sendPeerMessage(this.proto.buildMisc('videoReceived', true));

        // Track total video frames from peer for diagnostics
        this._peerFrameCount = (this._peerFrameCount || 0) + 1;
        this._lastVideoFrameTime = Date.now();
        if (this._peerFrameCount <= 3 || this._peerFrameCount % 300 === 0) {
            console.log('[RDClient] VideoFrame #' + this._peerFrameCount + ' from peer');
        }

        const codec = this.proto.detectVideoCodec(videoFrame);
        if (!codec || codec === 'rgb' || codec === 'yuv') return;

        // Initialize video decoder if needed
        if (!this.video.initialized || this.video.currentCodec !== codec) {
            try {
                await this.video.init(codec);
                this._emit('log', `Video codec: ${codec.toUpperCase()}`);
            } catch (err) {
                this._emit('log', `Video codec ${codec} not supported: ${err.message}`);
                return;
            }
        }

        // Decode each encoded frame
        const frames = this.proto.getEncodedFrames(videoFrame);
        for (const frame of frames) {
            await this.video.decode(frame);
        }
    }

    _handleAudioFrame(audioFrame) {
        if (audioFrame.data) {
            this.audio.play({
                data: audioFrame.data,
                timestamp: audioFrame.timestamp || 0
            });
        }
    }

    async _applyRemoteClipboard(clipboards) {
        const list = clipboards || [];
        if (!list.length) return;

        const decoded = await RDClipboard.decodeEntries(list);
        const text = RDClipboard.pickBestText(decoded);
        if (text) {
            this._emit('clipboard', text);
        }

        await RDClipboard.applyToLocal(decoded, {
            enabled: this._clipboardToLocalEnabled
        });
    }

    _handleClipboard(clipboard) {
        void this._applyRemoteClipboard([clipboard]);
    }

    _handleMultiClipboards(multiClipboards) {
        const list = multiClipboards && multiClipboards.clipboards
            ? multiClipboards.clipboards
            : [];
        void this._applyRemoteClipboard(list);
    }

    _handleTestDelay(testDelay) {
        if (!testDelay.fromClient) {
            // This is the controlled peer's QoS probe. RustDesk's video QoS
            // controller measures the round-trip delay of this exact message to
            // size the target bitrate AND framerate. We MUST echo it back
            // verbatim (same `time`, `from_client` stays false, original
            // last_delay/target_bitrate). Replying with a fresh timestamp makes
            // the peer compute a bogus delay and throttle the stream down to
            // ~1 fps. Echoing correctly keeps the full 24-30 fps stream.
            this._sendPeerMessage({
                testDelay: {
                    time: testDelay.time,
                    fromClient: false,
                    lastDelay: testDelay.lastDelay || 0,
                    targetBitrate: testDelay.targetBitrate || 0
                }
            });
        } else {
            // Our own ping came back - calculate RTT
            const rtt = Date.now() - (testDelay.time || 0);
            this._emit('latency', rtt);
        }
    }

    _handleMisc(misc) {
        if (misc.closeReason) {
            this._handleDisconnect('Remote: ' + misc.closeReason);
            return;
        }
        if (misc.chatMessage) {
            this._emit('chat', misc.chatMessage.text || '');
            return;
        }
        if (misc.option) {
            this._emit('option', misc.option);
            return;
        }
        if (misc.permissionInfo) {
            this._emit('permission', misc.permissionInfo);
            return;
        }
        if (misc.switchDisplay) {
            if (typeof misc.switchDisplay.display === 'number') {
                this._currentDisplay = misc.switchDisplay.display;
            }
            this._emit('switch_display', misc.switchDisplay);
            return;
        }
    }

    // ---- Session Management ----

    /**
     * Start the streaming session after successful login
     */
    _startSession() {
        this._setState('streaming');
        this._codecFallbackDone = false;
        this.conn.setConnected();

        // Enable file transfer
        this.fileTransfer.enable();
        this.ensureFileConnection().catch(function (err) {
            console.warn('[RDClient] File transfer preconnect:', err.message || err);
        });

        // Initialize video decoder callbacks
        this.video.onFrame = (frame) => this.renderer.pushFrame(frame);
        this.video.onError = (err) => this._emit('log', 'Video error: ' + (err && err.message ? err.message : err));

        // The decoder asks for a keyframe whenever it (re)configures or recovers
        // from an error; forward that as a refresh_video request to the peer.
        this.video.onNeedKeyframe = () => {
            if (this._state === 'streaming') {
                this._sendPeerMessage(this.proto.buildMisc('refreshVideo', true));
            }
        };
        this.video.onCodecFailed = (failedCodec) => {
            this._handleCodecFallback(failedCodec);
        };

        // Request keyframe on resize/fullscreen to fix blur
        this.renderer.onResizeRefresh = () => {
            this._sendPeerMessage(this.proto.buildMisc('refreshVideo', true));
        };

        // Signal CSS when remote cursor data is available (hide local crosshair)
        this.renderer.onCursorReady = (ready) => {
            const container = this.canvas.parentElement;
            if (container) {
                container.classList.toggle('has-remote-cursor', !!ready);
            }
        };

        // Start render loop
        this.renderer.startRenderLoop();

        // Input capture is started by remote.js via setSessionActive() for the active tab only

        // Initialize audio (will actually start on first audio data)
        if (!this.opts.disableAudio && RDAudio.isSupported()) {
            this.audio.init().catch(() => {
                this._emit('log', 'Audio init failed');
            });
        }

        // Tell peer our desired FPS and image quality after session establishment
        const fps = this.opts.fps || 60;
        this._savedActiveFps = fps;
        const quality = this.opts.imageQuality || 'Best';
        this._sendPeerMessage(this.proto.buildOptionMisc({
            customFps: fps,
            imageQuality: quality
        }));

        // Proactively request an initial keyframe so the decoder can start
        // immediately even if we joined an already-running stream on a delta.
        this._sendPeerMessage(this.proto.buildMisc('refreshVideo', true));

        // Start ping interval
        this._pingInterval = setInterval(() => {
            if (this._state === 'streaming') {
                const ping = this.proto.buildTestDelay();
                this._sendPeerMessage(ping);
            }
        }, 3000);

        // Start stats reporting
        this._statsInterval = setInterval(() => {
            if (this._state === 'streaming') {
                this._emit('stats', this.getStats());
            }
        }, 1000);

        // Stall recovery. Two cases trigger a keyframe request:
        //  1. No VideoFrame at all from the peer for 3s.
        //  2. The peer keeps sending frames but the decoder produces no output
        //     (e.g. we joined mid-stream on delta frames) for 2s.
        this._lastDecodedCount = 0;
        this._lastDecodeProgressTime = Date.now();
        this._stallCheckInterval = setInterval(() => {
            if (this._state !== 'streaming') return;
            const now = Date.now();

            const decoded = this.video ? this.video.frameCount : 0;
            if (decoded !== this._lastDecodedCount) {
                this._lastDecodedCount = decoded;
                this._lastDecodeProgressTime = now;
            }

            const lastFrame = this._lastVideoFrameTime || 0;
            const noPeerFrames = lastFrame > 0 && now - lastFrame > 3000;
            const peerFramesButNoDecode = (this._peerFrameCount || 0) > 0
                && decoded === 0 && now - this._lastDecodeProgressTime > 2000;

            if (noPeerFrames || peerFramesButNoDecode) {
                this._emit('log', 'Video stall detected, requesting keyframe');
                this._sendPeerMessage(this.proto.buildMisc('refreshVideo', true));
                if (this.video) {
                    this.video._needKeyframe = true;
                }
                this._lastVideoFrameTime = now; // prevent rapid retries
                this._lastDecodeProgressTime = now;
            }
        }, 1500);

        this._lastVideoFrameTime = Date.now();

        // ---- Adaptive Quality ----
        // Measures decoded FPS and drop rate. Demotes quality under load,
        // promotes back up when the pipeline is healthy. Avoids the 3-7 FPS
        // pin that occurred when Best@60 overwhelmed the JMuxer fallback path.
        if (this.opts.adaptiveQuality !== false) {
            this._startAdaptiveQuality();
        }

        this._emit('session_start');
        if (!this._sessionActive) {
            this._streamThrottledActive = null;
            this._syncStreamThrottle();
        }
    }

    /**
     * Adaptive quality monitor.
     * Tiers (low to high): Low@30 < Balanced@30 < Balanced@45 < Best@45 < Best@60
     * Demotes after 2 consecutive bad samples, promotes after 3 good.
     */
    _startAdaptiveQuality() {
        const tiers = [
            { id: 0, quality: 'Low',      fps: 30 },
            { id: 1, quality: 'Balanced', fps: 30 },
            { id: 2, quality: 'Balanced', fps: 45 },
            { id: 3, quality: 'Best',     fps: 45 },
            { id: 4, quality: 'Best',     fps: 60 }
        ];
        // Start near tier 1 (Balanced@30) to match opts
        let current = 1;
        let badCount = 0;
        let goodCount = 0;
        let lastChange = Date.now();

        const apply = (tier) => {
            try {
                this._sendPeerMessage(this.proto.buildOptionMisc({
                    imageQuality: tier.quality,
                    customFps: tier.fps
                }));
                this._emit('log', '[Adaptive] ' + tier.quality + '@' + tier.fps + 'fps');
                this._emit('quality_changed', tier.quality + '@' + tier.fps);
            } catch { /* ignore */ }
        };

        this._adaptiveInterval = setInterval(() => {
            if (this._state !== 'streaming') return;
            if (!this._sessionActive) return;
            if (this._adaptivePaused) return; // user took manual control of quality/codec
            const stats = this.video.getStats();
            const fps = stats.videoFps || 0;
            const target = tiers[current].fps;
            const now = Date.now();

            // Grace period after a change
            if (now - lastChange < 5000) return;

            // Bad sample: measured FPS is less than 60% of target and above zero
            const bad = fps > 0 && fps < target * 0.6;
            // Good sample: measured FPS is within 85% of target
            const good = fps >= target * 0.85;

            if (bad) {
                badCount++;
                goodCount = 0;
                if (badCount >= 2 && current > 0) {
                    current--;
                    badCount = 0;
                    lastChange = now;
                    apply(tiers[current]);
                }
            } else if (good) {
                goodCount++;
                badCount = 0;
                if (goodCount >= 3 && current < tiers.length - 1) {
                    current++;
                    goodCount = 0;
                    lastChange = now;
                    apply(tiers[current]);
                }
            } else {
                // Neutral sample: decay counters
                if (badCount > 0) badCount--;
                if (goodCount > 0) goodCount--;
            }
        }, 2000);
    }

    // ---- Send Helpers ----

    /**
     * Send a peer-to-peer message through the relay
     * Order: serialize protobuf → encrypt (if enabled) → frame → send
     * @param {Object} msgObj - Message object (will be encoded as Message protobuf)
     */
    _sendPeerMessage(msgObj) {
        if (!this.proto.loaded) return;

        // Step 1: Serialize to raw protobuf bytes (no frame header)
        let data = this.proto.serializeMessage(msgObj);

        // Step 2: Encrypt if enabled (encrypts the raw protobuf)
        if (this.crypto.enabled) {
            data = this.crypto.processOutgoing(data);
        }

        // Step 3: Add frame header to the (possibly encrypted) bytes
        const framed = this.proto.frameBytes(data);

        // Step 4: Send over relay WebSocket
        this.conn.sendRelay(framed);
    }

    // ---- State & Cleanup ----

    _setState(state) {
        if (this._state !== state) {
            const prev = this._state;
            this._state = state;
            this._emit('state', state, prev);
        }
    }

    _handleError(err) {
        console.error('[RDClient]', err);
        const msg = err && err.message ? err.message : String(err);
        // Detect peer-offline scenarios where the agent is reachable through
        // bd-signal/CDAP but not through the RustDesk relay (no peer registration).
        // In that case, signal the UI that a CDAP fallback viewer is available.
        const offlineHint = /target offline|relay refused|peer.*offline|not online|not registered/i.test(msg);
        this._emit('error', msg, { cdapFallback: offlineHint });
        if (offlineHint) {
            this._emit('cdap_fallback_available', this.deviceId);
        }
        this._cleanup();
        this._setState('error');
    }

    _handleDisconnect(reason) {
        this._emit('log', `Disconnected: ${reason}`);
        this._cleanup();
        this._setState('disconnected');
        this._emit('disconnected', reason);
    }

    _cleanup() {
        if (this._pingInterval) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
        }
        if (this._statsInterval) {
            clearInterval(this._statsInterval);
            this._statsInterval = null;
        }
        if (this._stallCheckInterval) {
            clearInterval(this._stallCheckInterval);
            this._stallCheckInterval = null;
        }
        if (this._adaptiveInterval) {
            clearInterval(this._adaptiveInterval);
            this._adaptiveInterval = null;
        }

        this.input.stop();
        this.renderer.stopRenderLoop();
        this.video.close();
        this.audio.close();
        this.fileTransfer.disable();
        this.disconnectFileConnection();
        this._sessionPassword = '';
        this.conn.close();
        this._codecFallbackDone = false;
    }

    // ---- Public Utility Methods ----

    /**
     * Send clipboard text to remote
     * @param {string} text
     */
    sendClipboard(text) {
        if (this._state !== 'streaming') return;
        void this._sendClipboard(text);
    }

    async _sendClipboard(text) {
        const msg = await this.proto.buildClipboard(text);
        this._sendPeerMessage(msg);
    }

    /**
     * Send Ctrl+Alt+Delete to remote
     */
    sendCtrlAltDel() {
        if (this._state !== 'streaming') return;
        this._sendPeerMessage({
            keyEvent: { controlKey: 'CtrlAltDel', down: true, press: true, modifiers: [], mode: 'Legacy' }
        });
    }

    /**
     * Send Lock Screen command to remote
     */
    sendLockScreen() {
        if (this._state !== 'streaming') return;
        this._sendPeerMessage({
            keyEvent: { controlKey: 'LockScreen', down: true, press: true, modifiers: [], mode: 'Legacy' }
        });
    }

    /**
     * Request screen refresh (force new keyframe)
     */
    sendRefreshScreen() {
        if (this._state !== 'streaming') return;
        this._sendPeerMessage(this.proto.buildMisc('refreshVideo', true));
    }

    // ---- Session Recording (WebM via MediaRecorder) ----

    /**
     * Start recording the remote session as WebM video.
     * @returns {boolean} True if recording started
     */
    startRecording() {
        if (this._recorder) return false;
        if (this._state !== 'streaming') return false;

        try {
            var canvas = this.renderer.canvas;
            var stream = canvas.captureStream(15); // 15fps recording

            // Add audio if available
            if (this.audio && this.audio._audioCtx && this.audio._audioCtx.state === 'running') {
                try {
                    var dest = this.audio._audioCtx.createMediaStreamDestination();
                    if (this.audio._gainNode) this.audio._gainNode.connect(dest);
                    stream.addTrack(dest.stream.getAudioTracks()[0]);
                } catch (_) { /* audio capture optional */ }
            }

            var mimeType = 'video/webm;codecs=vp9,opus';
            if (!MediaRecorder.isTypeSupported(mimeType)) {
                mimeType = 'video/webm;codecs=vp8,opus';
            }
            if (!MediaRecorder.isTypeSupported(mimeType)) {
                mimeType = 'video/webm';
            }

            this._recordedChunks = [];
            this._recorder = new MediaRecorder(stream, {
                mimeType: mimeType,
                videoBitsPerSecond: 2500000 // 2.5 Mbps
            });

            this._recorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) {
                    this._recordedChunks.push(e.data);
                }
            };

            this._recorder.onstop = () => {
                this._emit('recording_stopped', this._recordedChunks);
            };

            this._recorder.start(1000); // 1 second chunks
            this._recordingStartTime = Date.now();
            this._emit('recording_started');
            return true;
        } catch (err) {
            console.warn('[RDClient] Recording failed:', err.message);
            return false;
        }
    }

    /**
     * Stop recording and return the WebM blob.
     * @returns {Promise<Blob|null>}
     */
    stopRecording() {
        return new Promise((resolve) => {
            if (!this._recorder || this._recorder.state === 'inactive') {
                resolve(null);
                return;
            }

            this._recorder.onstop = () => {
                var blob = new Blob(this._recordedChunks, { type: this._recorder.mimeType });
                this._recordedChunks = [];
                this._recorder = null;
                this._emit('recording_stopped');
                resolve(blob);
            };

            this._recorder.stop();
        });
    }

    /**
     * Download recorded session as a file.
     */
    async downloadRecording() {
        var blob = await this.stopRecording();
        if (!blob) return;

        var ts = new Date().toISOString().replace(/[:.]/g, '-');
        var filename = 'session_' + this.deviceId + '_' + ts + '.webm';

        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    /** @returns {boolean} Whether recording is active */
    get isRecording() {
        return this._recorder && this._recorder.state === 'recording';
    }

    /** @returns {number} Recording duration in seconds */
    get recordingDuration() {
        if (!this._recordingStartTime || !this.isRecording) return 0;
        return Math.floor((Date.now() - this._recordingStartTime) / 1000);
    }

    // ---- Monitor Switching ----

    /**
     * Get list of available remote monitors.
     * @returns {Array<{idx:number, name:string, width:number, height:number}>}
     */
    getMonitors() {
        if (!this._peerInfo || !this._peerInfo.displays) return [];
        var current = this.getCurrentDisplay();
        return this._peerInfo.displays.map(function (d, i) {
            return {
                idx: i,
                name: d.name || ('Monitor ' + (i + 1)),
                width: d.width || 0,
                height: d.height || 0,
                // A display positioned at the origin is the primary one.
                primary: (d.x === 0 && d.y === 0),
                current: (i === current)
            };
        });
    }

    /**
     * Index of the currently captured remote display.
     * @returns {number}
     */
    getCurrentDisplay() {
        if (typeof this._currentDisplay === 'number') return this._currentDisplay;
        if (this._peerInfo && typeof this._peerInfo.currentDisplay === 'number') {
            return this._peerInfo.currentDisplay;
        }
        return 0;
    }

    /**
     * Switch to a specific monitor (RustDesk-compatible).
     * Sends a SwitchDisplay message followed by a CaptureDisplays message
     * (matching the desktop client's software-render switch path), then
     * forces a fresh keyframe.
     * @param {number} monitorIdx - Monitor index
     */
    switchMonitor(monitorIdx) {
        if (this._state !== 'streaming') return;
        this._currentDisplay = monitorIdx;
        this._sendPeerMessage(this.proto.buildMisc('switchDisplay', {
            display: monitorIdx,
            width: 0,
            height: 0
        }));
        this._sendPeerMessage(this.proto.buildMisc('captureDisplays', {
            add: [],
            sub: [],
            set: [monitorIdx]
        }));
        if (this.video) this.video._needKeyframe = true;
        this.sendRefreshScreen();
        this._emit('display_switched', monitorIdx);
    }

    // ---- Virtual Displays (RustDesk IDD / Amyuni IDD) ----

    /**
     * Parse peer info into cached current-display and virtual-display state.
     * @param {Object} info - PeerInfo from login response or peer_info message
     */
    _processPeerInfo(info) {
        if (!info) return;
        if (typeof info.currentDisplay === 'number') {
            this._currentDisplay = info.currentDisplay;
        } else if (typeof this._currentDisplay !== 'number') {
            this._currentDisplay = 0;
        }
        this._virtualDisplay = this._parseVirtualDisplaySupport(info);
    }

    /**
     * Derive virtual-display support from PeerInfo.platformAdditions (JSON).
     * @param {Object} info
     * @returns {{supported:boolean, impl:string, rustdeskDisplays:Array<number>, amyuniCount:number}}
     */
    _parseVirtualDisplaySupport(info) {
        var result = { supported: false, impl: '', rustdeskDisplays: [], amyuniCount: 0 };
        if (!info) return result;
        var platform = info.platform || '';
        var additions = info.platformAdditions || info.platform_additions || '';
        if (typeof additions === 'string') {
            if (!additions) return result;
            try { additions = JSON.parse(additions); } catch (e) { return result; }
        }
        if (!additions || typeof additions !== 'object') return result;
        var isInstalled = additions['is_installed'] === true;
        var impl = additions['idd_impl'] || '';
        if (platform !== 'Windows' || !isInstalled) return result;
        if (impl === 'rustdesk_idd') {
            result.supported = true;
            result.impl = impl;
            var list = additions['rustdesk_virtual_displays'];
            if (Array.isArray(list)) result.rustdeskDisplays = list.slice();
        } else if (impl === 'amyuni_idd') {
            result.supported = true;
            result.impl = impl;
            var count = additions['amyuni_virtual_displays'];
            result.amyuniCount = (typeof count === 'number') ? count : 0;
        }
        return result;
    }

    /**
     * Virtual-display capability of the connected peer.
     * @returns {{supported:boolean, impl:string, rustdeskDisplays:Array<number>, amyuniCount:number}}
     */
    getVirtualDisplaySupport() {
        return this._virtualDisplay || { supported: false, impl: '', rustdeskDisplays: [], amyuniCount: 0 };
    }

    /**
     * Plug in / plug out a virtual display (RustDesk-compatible).
     * @param {number} index - Display index. Use -1 to plug out all.
     * @param {boolean} on - True to plug in, false to plug out
     */
    toggleVirtualDisplay(index, on) {
        if (this._state !== 'streaming') return;
        this._sendPeerMessage(this.proto.buildMisc('toggleVirtualDisplay', {
            display: index,
            on: !!on
        }));
        this._emit('virtual_display_toggled', { index: index, on: !!on });
    }

    // ---- Image Quality Control ----

    /**
     * Set image quality preset.
     * @param {'speed'|'balanced'|'quality'|'best'} preset
     */
    setQualityPreset(preset) {
        if (this._state !== 'streaming') return;

        var config = {
            speed:    { imageQuality: 'Low',      customFps: 60 },
            balanced: { imageQuality: 'Balanced', customFps: 30 },
            quality:  { imageQuality: 'Best',     customFps: 30 },
            best:     { imageQuality: 'Best',     customFps: 60 }
        };

        var c = config[preset] || config.balanced;
        this._adaptivePaused = true; // explicit user choice — stop auto-adjusting
        this._savedActiveFps = c.customFps;
        this.opts.qualityPreset = preset;
        this._sendPeerMessage(this.proto.buildOptionMisc({ imageQuality: c.imageQuality, customFps: c.customFps }));
        this._emit('quality_changed', preset);
    }

    // ---- Codec Control ----

    /**
     * Request the remote peer to (re)encode using a specific codec.
     * @param {'Auto'|'VP9'|'AV1'|'H264'|'H265'|'VP8'} codec
     */
    setCodec(codec) {
        if (this._state !== 'streaming') return;
        const name = codec || 'Auto';
        this._preferCodec = name;
        this._adaptivePaused = true; // explicit user choice
        // Re-advertise abilities with the new preferred codec so the peer switches encoder.
        this._sendPeerMessage(this.proto.buildOptionMisc({
            supportedDecoding: { abilities: this._codecAbilities, prefer: name }
        }));
        // The encoder restarts with a fresh keyframe; force our decoder to wait for it.
        if (this.video) this.video._needKeyframe = true;
        this._sendPeerMessage(this.proto.buildMisc('refreshVideo', true));
        this.opts.preferCodec = name;
        this._emit('codec_changed', name);
    }

    /**
     * Downgrade to the next working codec when WebCodecs fails at runtime.
     * @param {string} failedCodec
     */
    _handleCodecFallback(failedCodec) {
        const failed = String(failedCodec || '').toLowerCase();
        if (!failed || this._codecFallbackDone || this._state !== 'streaming') return;
        this._codecFallbackDone = true;

        if (!this._codecAbilities) this._codecAbilities = {};
        this._codecAbilities[failed] = false;

        const order = ['vp9', 'h264', 'vp8'];
        let next = 'H264';
        for (let i = 0; i < order.length; i++) {
            const candidate = order[i];
            if (candidate === failed) continue;
            if (this._codecAbilities[candidate] !== false) {
                next = candidate === 'h264' ? 'H264' : candidate.toUpperCase();
                break;
            }
        }

        this._emit('log', 'Codec ' + failed.toUpperCase() + ' failed — switching to ' + next);
        this.setCodec(next);
    }

    /**
     * Request remote device restart
     */
    sendRestartRemoteDevice() {
        if (this._state !== 'streaming') return;
        this._sendPeerMessage(this.proto.buildMisc('restartRemoteDevice', true));
    }

    /**
     * Send chat message to remote peer
     * @param {string} text
     */
    sendChat(text) {
        if (this._state !== 'streaming') return;
        this._sendPeerMessage(this.proto.buildChatMessage(text));
    }

    /**
     * Change image quality during session
     * @param {'Best'|'Balanced'|'Low'} quality
     */
    setImageQuality(quality) {
        if (this._state !== 'streaming') return;
        this._adaptivePaused = true; // explicit user choice
        this._sendPeerMessage(this.proto.buildOptionMisc({ imageQuality: quality }));
    }

    /**
     * Change custom FPS during session
     * @param {number} fps
     */
    setCustomFps(fps) {
        if (this._state !== 'streaming') return;
        this._sendPeerMessage(this.proto.buildOptionMisc({ customFps: fps }));
    }

    /**
     * Toggle remote cursor visibility
     * @param {boolean} show
     */
    setShowRemoteCursor(show) {
        if (this._state !== 'streaming') return;
        this._sendPeerMessage(this.proto.buildOptionMisc({ showRemoteCursor: show }));
    }

    /**
     * Toggle input blocking on remote side
     * @param {boolean} block
     */
    setBlockInput(block) {
        if (this._state !== 'streaming') return;
        this._sendPeerMessage(this.proto.buildOptionMisc({ blockInput: block }));
    }

    /**
     * Toggle lock after session end
     * @param {boolean} lock
     */
    setLockAfterSession(lock) {
        if (this._state !== 'streaming') return;
        this._sendPeerMessage(this.proto.buildOptionMisc({ lockAfterSessionEnd: lock }));
    }

    /**
     * Toggle privacy mode on remote
     * @param {boolean} on
     */
    setPrivacyMode(on) {
        if (this._state !== 'streaming') return;
        this._sendPeerMessage(this.proto.buildTogglePrivacyMode(on));
    }

    /**
     * Toggle clipboard sharing
     * @param {boolean} disable
     */
    setDisableClipboard(disable) {
        if (this._state !== 'streaming') return;
        this._sendPeerMessage(this.proto.buildOptionMisc({ disableClipboard: disable }));
    }

    /**
     * Toggle audio on remote side
     * @param {boolean} disable
     */
    setDisableAudio(disable) {
        if (this._state !== 'streaming') return;
        this._sendPeerMessage(this.proto.buildOptionMisc({ disableAudio: disable }));
    }

    /**
     * Toggle view-only mode (local only: disables input capture)
     * @param {boolean} on
     */
    setViewOnly(on) {
        this._viewOnly = on;
        this._syncInputCapture();
        this._emit('view_only', on);
    }

    /**
     * Mark whether this client is the active tab in the multi-session viewer.
     * Gates keyboard/mouse capture, inbound clipboard, and audio playback.
     * @param {boolean} active
     */
    setSessionActive(active) {
        const next = !!active;
        const changed = next !== this._sessionActive;
        this._sessionActive = next;
        this._clipboardToLocalEnabled = next;
        if (this.audio.setSessionActive) {
            this.audio.setSessionActive(next);
        }
        this._syncInputCapture();
        if (this._state === 'streaming') {
            this._syncStreamThrottle();
        } else if (changed) {
            this._syncStreamThrottle();
        }
    }

    /**
     * Background FPS for inactive viewer tabs (RustDesk customFps option).
     * @param {number} fps
     */
    setBackgroundFps(fps) {
        const n = Number(fps);
        if (Number.isFinite(n) && n >= 1 && n <= 5) {
            this._backgroundFps = Math.round(n);
        }
    }

    /** @private Target FPS for the active tab based on quality preset */
    _getActiveStreamFps() {
        if (this._savedActiveFps) return this._savedActiveFps;
        const preset = this.opts.qualityPreset || 'best';
        const map = { speed: 60, balanced: 30, quality: 30, best: 60 };
        return map[preset] || this.opts.fps || 60;
    }

    /** @private Throttle peer encode rate and pause local decode when tab is hidden */
    _syncStreamThrottle() {
        if (this._state !== 'streaming') return;
        const wantActive = this._sessionActive;
        if (this._streamThrottledActive === wantActive) return;
        this._streamThrottledActive = wantActive;
        if (wantActive) {
            this._resumeActiveStream();
        } else {
            this._throttleBackgroundStream();
        }
    }

    _throttleBackgroundStream() {
        if (!this._savedActiveFps) {
            this._savedActiveFps = this._getActiveStreamFps();
        }
        this.renderer.stopRenderLoop();
        if (this.video.setBackgroundMode) {
            this.video.setBackgroundMode(true);
        }
        this.setCustomFps(this._backgroundFps || 1);
    }

    _resumeActiveStream() {
        if (this.video.setBackgroundMode) {
            this.video.setBackgroundMode(false);
        }
        this.renderer.startRenderLoop();
        const fps = this._getActiveStreamFps();
        this.setCustomFps(fps);
        this._sendPeerMessage(this.proto.buildMisc('refreshVideo', true));
    }

    /** @private Sync input listeners with session/tab and view-only state */
    _syncInputCapture() {
        const shouldCapture = this._sessionActive && !this._viewOnly && this._state === 'streaming';
        if (shouldCapture) {
            this.input.start();
        } else {
            this.input.stop();
        }
    }

    /** @returns {boolean} Whether view-only mode is active */
    get viewOnly() { return this._viewOnly || false; }

    /**
     * Toggle fullscreen
     * @param {HTMLElement} container
     */
    async toggleFullscreen(container) {
        if (document.fullscreenElement) {
            await document.exitFullscreen();
        } else {
            await container.requestFullscreen();
        }
        // Resize after fullscreen change
        setTimeout(() => this.renderer.resize(), 100);
    }

    /**
     * Set scale mode
     * @param {'fit'|'fill'|'1:1'|'stretch'} mode
     */
    setScaleMode(mode) {
        this.renderer.setScaleMode(mode);
        this.opts.scaleMode = mode;
    }

    /**
     * Set audio volume
     * @param {number} volume - 0 to 1
     */
    setVolume(volume) {
        this.audio.setVolume(volume);
    }

    /**
     * Toggle audio mute
     * @param {boolean} muted
     */
    setAudioMuted(muted) {
        this.audio.setMuted(muted);
    }

    /**
     * Get aggregated statistics
     * @returns {Object}
     */
    getStats() {
        return {
            state: this._state,
            video: this.video.getStats(),
            audio: this.audio.getStats(),
            renderer: this.renderer.getStats(),
            connection: this.conn.state
        };
    }
}

window.RDClient = RDClient;
