/**
 * BetterDesk Web Remote — dedicated FILE_TRANSFER relay connection.
 * RustDesk peers only handle FileAction on ConnType::FILE_TRANSFER sessions.
 */

/* global RDConnection, RDProtocol, RDCrypto */

// eslint-disable-next-line no-unused-vars
class RDFileConnection {
    /**
     * @param {Object} opts
     * @param {string} opts.deviceId
     * @param {string} [opts.serverPubKey]
     * @param {string} [opts.myName]
     * @param {RDProtocol} [opts.proto] - shared loaded protocol instance
     * @param {'native'|'ws'} [opts.rdTransport='native']
     */
    constructor(opts = {}) {
        if (!opts.deviceId) throw new Error('deviceId required');
        this.deviceId = opts.deviceId;
        this.opts = opts;
        /** @type {'native'|'ws'} */
        this.rdTransport = opts.rdTransport === 'ws' ? 'ws' : 'native';
        this.conn = new RDConnection({ rdTransport: this.rdTransport });
        this.proto = opts.proto || new RDProtocol();
        if (!opts.proto) {
            this.proto.setTransportMode(this.rdTransport);
        }
        this.crypto = new RDCrypto();
        this._state = 'idle'; // idle | connecting | authenticating | ready | error | disconnected
        this._listeners = {};
        this._rendezvousDecoder = null;
        this._relayDecoder = null;
        this._relayConfirmReceived = false;
        this._keyExchangePending = false;
        this._keyExchangeDone = false;
        this._peerEncryptionConfirmed = false;
        this._loginChallenge = '';
        this._loginSalt = '';
        this._connectPromise = null;
        this._loginResolve = null;
        this._loginReject = null;
    }

    get state() { return this._state; }

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
        if (arr) arr.forEach(fn => { try { fn(...args); } catch (e) { console.error(e); } });
    }

    _setState(s) {
        if (this._state !== s) {
            this._state = s;
            this._emit('state', s);
        }
    }

    _connType() {
        return this.proto.enums.ConnType.values.FILE_TRANSFER;
    }

    _randomUUID() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }
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
    }

    /**
     * Open FILE_TRANSFER relay and authenticate (reuse desktop session password).
     * @param {string} [password]
     * @returns {Promise<void>}
     */
    connect(password) {
        if (this._state === 'ready') return Promise.resolve();
        if (this._connectPromise) return this._connectPromise;

        this._connectPromise = this._doConnect(password || '').finally(() => {
            this._connectPromise = null;
        });
        return this._connectPromise;
    }

    async _doConnect(password) {
        try {
            if (this.conn) {
                try { this.conn.close(); } catch (_e) { /* ignore */ }
            }
            this.conn = new RDConnection({ rdTransport: this.rdTransport });
            this.crypto = new RDCrypto();
            this._setState('connecting');
            this._emit('log', 'Opening file transfer session…');

            if (!this.proto.loaded) await this.proto.load();
            this.proto.setTransportMode(this.rdTransport);

            this._rendezvousDecoder = this.proto.createStreamDecoder();
            this._relayDecoder = this.proto.createStreamDecoder();
            this._relayConfirmReceived = false;
            this._keyExchangePending = false;
            this._keyExchangeDone = false;
            this._peerEncryptionConfirmed = false;
            this._loginChallenge = '';
            this._loginSalt = '';
            this._pendingPassword = password;

            const ct = this._connType();
            await this.conn.connectRendezvous();

            const punchData = this.proto.encodeRendezvous(
                this.proto.buildPunchHoleRequest(this.deviceId, this.opts.serverPubKey, ct)
            );
            this.conn.sendRendezvous(punchData);

            const rendezvousResponse = await this._waitForRendezvousResponse();
            if (rendezvousResponse.error) {
                throw new Error(rendezvousResponse.error);
            }

            let relayUUID = rendezvousResponse.uuid || '';
            let relayServer = rendezvousResponse.relayServer || '';

            if (!relayUUID) {
                relayUUID = this._randomUUID();
                const signalData = this.proto.encodeRendezvous(
                    this.proto.buildRequestRelay(
                        this.deviceId, relayUUID, relayServer, this.opts.serverPubKey, ct
                    )
                );
                this.conn.sendRendezvous(signalData);
                const relayConfirm = await this._waitForSignalRelayResponse();
                if (relayConfirm.error) throw new Error(relayConfirm.error);
                relayUUID = relayConfirm.uuid || relayUUID;
                relayServer = relayConfirm.relayServer || relayServer;
            }

            this.conn.closeRendezvous();
            await this.conn.connectRelay();

            this.conn.on('relay:message', (data) => this._handleRelayData(data));
            this.conn.on('relay:close', () => {
                if (this._state !== 'disconnected' && this._state !== 'error') {
                    this._setState('disconnected');
                    this._emit('disconnected', 'File transfer relay closed');
                }
            });

            const relayData = this.proto.encodeRendezvous(
                this.proto.buildRequestRelay(
                    this.deviceId, relayUUID, relayServer, this.opts.serverPubKey, ct
                )
            );
            this.conn.sendRelay(relayData);

            await this._waitForLogin(password);
            this._setState('ready');
            this._emit('ready');
            this._emit('log', 'File transfer session ready');
        } catch (err) {
            this._setState('error');
            this._emit('error', err.message || String(err));
            this.disconnect();
            throw err;
        }
    }

    _waitForLogin(password) {
        return new Promise((resolve, reject) => {
            this._loginResolve = resolve;
            this._loginReject = reject;
            const timeout = setTimeout(() => {
                reject(new Error('File transfer login timeout (30s)'));
            }, 30000);

            const done = () => {
                clearTimeout(timeout);
                this._loginResolve = null;
                this._loginReject = null;
            };

            const origResolve = resolve;
            const origReject = reject;
            this._loginResolve = () => { done(); origResolve(); };
            this._loginReject = (e) => { done(); origReject(e); };

            // If password provided upfront, authenticate when hash arrives or immediately after signedId
            this._pendingPassword = password;
        });
    }

    async _authenticate(password) {
        this._setState('authenticating');
        const hash = await this.crypto.hashPassword(
            password, this._loginSalt || '', this._loginChallenge || ''
        );
        const loginReq = this.proto.buildFileTransferLoginRequest(hash, {
            username: this.deviceId,
            myId: 'betterdesk-web-ft-' + Date.now().toString(36),
            myName: this.opts.myName || 'BetterDesk Web',
            showHidden: false
        });
        this._sendPeerMessageRaw(loginReq);
    }

    submit2FA(code) {
        this._sendPeerMessageRaw(this.proto.buildAuth2FA(String(code || '').trim()));
    }

    sendMessage(msgObj) {
        this._sendPeerMessage(msgObj);
    }

    _sendPeerMessage(msgObj) {
        if (!this.proto.loaded || this._state !== 'ready') return;
        let data = this.proto.serializeMessage(msgObj);
        if (this.crypto.enabled) {
            data = this.crypto.processOutgoing(data);
        }
        this.conn.sendRelay(this.proto.frameBytes(data));
    }

    disconnect() {
        if (this._loginReject) {
            this._loginReject(new Error('Disconnected'));
        }
        this._connectPromise = null;
        try { this.conn.close(); } catch (_e) { /* ignore */ }
        this._setState('disconnected');
    }

    _waitForRendezvousResponse() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.conn.off('rendezvous:message', handler);
                reject(new Error('File transfer rendezvous timeout'));
            }, 30000);

            const handler = (rawData) => {
                const frames = this.proto.framesFromWsPayload(rawData, this._rendezvousDecoder);
                for (const frame of frames) {
                    try {
                        const msg = this.proto.decodeRendezvous(frame);
                        if (msg.keyExchange || msg.hc) continue;

                        if (msg.punchHoleResponse) {
                            clearTimeout(timeout);
                            this.conn.off('rendezvous:message', handler);
                            const resp = msg.punchHoleResponse;
                            const hasRelay = resp.relayServer && resp.relayServer.length > 0;
                            const hasSocket = resp.socketAddr && resp.socketAddr.length > 0;
                            if (hasRelay || hasSocket) {
                                resolve({
                                    relayServer: resp.relayServer || '',
                                    uuid: resp.uuid || '',
                                    pk: resp.pk || null
                                });
                            } else {
                                const failureNames = {
                                    0: 'Device not found',
                                    2: 'Device offline',
                                    3: 'License mismatch',
                                    4: 'Too many connections'
                                };
                                resolve({
                                    error: resp.otherFailure || failureNames[resp.failure] || 'Connection failed'
                                });
                            }
                            return;
                        }

                        if (msg.relayResponse) {
                            clearTimeout(timeout);
                            this.conn.off('rendezvous:message', handler);
                            const rr = msg.relayResponse;
                            if (rr.refuseReason && rr.refuseReason.length > 0) {
                                resolve({ error: 'Relay refused: ' + rr.refuseReason });
                            } else {
                                resolve({
                                    relayServer: rr.relayServer || '',
                                    uuid: rr.uuid || '',
                                    pk: rr.pk || null
                                });
                            }
                            return;
                        }
                    } catch (err) {
                        console.warn('[RDFileConnection] rendezvous decode:', err.message);
                    }
                }
            };
            this.conn.on('rendezvous:message', handler);
        });
    }

    _waitForSignalRelayResponse() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.conn.off('rendezvous:message', handler);
                reject(new Error('File transfer RelayResponse timeout'));
            }, 15000);

            const handler = (rawData) => {
                const frames = this.proto.framesFromWsPayload(rawData, this._rendezvousDecoder);
                for (const frame of frames) {
                    try {
                        const msg = this.proto.decodeRendezvous(frame);
                        if (msg.keyExchange || msg.hc) continue;
                        if (msg.relayResponse) {
                            clearTimeout(timeout);
                            this.conn.off('rendezvous:message', handler);
                            const rr = msg.relayResponse;
                            if (rr.refuseReason && rr.refuseReason.length > 0) {
                                resolve({ error: 'Relay refused: ' + rr.refuseReason });
                            } else {
                                resolve({
                                    relayServer: rr.relayServer || '',
                                    uuid: rr.uuid || '',
                                    pk: rr.pk || null
                                });
                            }
                            return;
                        }
                    } catch (err) {
                        console.warn('[RDFileConnection] signal relay decode:', err.message);
                    }
                }
            };
            this.conn.on('rendezvous:message', handler);
        });
    }

    _handleRelayData(rawData) {
        try {
            const frames = this.proto.framesFromWsPayload(rawData, this._relayDecoder);
            for (const frame of frames) {
                this._handleRelayMessage(frame);
            }
        } catch (err) {
            console.warn('[RDFileConnection] relay decode:', err.message);
        }
    }

    _handleRelayMessage(frameData) {
        if (!this._relayConfirmReceived) {
            this._relayConfirmReceived = true;
            try {
                const rdvMsg = this.proto.decodeRendezvous(frameData);
                if (rdvMsg.relayResponse) return;
            } catch (_e) {
                // First frame is a peer Message, not relay confirmation
            }
        }

        let data = frameData;

        if (this._keyExchangePending && !this._keyExchangeDone) {
            let isPlaintext = false;
            try {
                const probe = this.proto.decodeMessage(frameData);
                const fields = Object.keys(probe).filter(k => probe[k] != null && k !== 'union');
                if (fields.length > 0) isPlaintext = true;
            } catch (_e) { /* encrypted */ }

            if (isPlaintext) {
                this._keyExchangePending = false;
                this._keyExchangeDone = false;
            } else {
                this._completeKeyExchange();
            }
        }

        if (this.crypto.secretKey && this._keyExchangeDone) {
            const spec = this.crypto.tryDecrypt(new Uint8Array(data));
            if (spec) {
                this.crypto.commitDecrypt(spec.seq);
                data = spec.plaintext;
                this._peerEncryptionConfirmed = true;
            } else if (this._peerEncryptionConfirmed) {
                return;
            }
        }

        const msg = this.proto.decodeMessage(data);
        this._dispatchMessage(msg);
    }

    _dispatchMessage(msg) {
        if (msg.signedId) {
            this._handleSignedId(msg.signedId);
            return;
        }
        if (msg.hash) {
            this._loginChallenge = msg.hash.challenge || '';
            this._loginSalt = msg.hash.salt || '';
            if (this._pendingPassword != null && this._pendingPassword !== undefined) {
                this._authenticate(this._pendingPassword).catch((e) => {
                    if (this._loginReject) this._loginReject(e);
                });
            }
            return;
        }
        if (msg.loginResponse) {
            this._handleLoginResponse(msg.loginResponse);
            return;
        }
        if (msg.fileResponse) {
            this._emit('file_response', msg.fileResponse);
            return;
        }
        if (msg.fileAction) {
            this._emit('file_action', msg.fileAction);
            return;
        }
        if (msg.peerInfo) {
            // Some peers send peerInfo before login completes on FT sessions
            return;
        }
    }

    _handleSignedId(signedId) {
        const idBytes = signedId.id;
        if (!idBytes || idBytes.length === 0) return;

        const parsed = this.crypto.parseSignedId(
            new Uint8Array(idBytes),
            this.proto.types.IdPk
        );
        if (!parsed) return;

        const serverPubKey = this.opts.serverPubKey || '';
        if (serverPubKey && serverPubKey.length >= 64) {
            RDCrypto.verifySignedId(parsed.signature, parsed.payload, serverPubKey);
        }

        this.crypto.generateKeyPair();
        this.crypto.generateSymmetricKey();
        this.crypto.setPeerPublicKey(parsed.peerPk);
        this._keyExchangePending = true;
        this._keyExchangeDone = false;

        // Unattended / no-password peers may send loginResponse without Hash
        if (this._pendingPassword === '' && this._loginResolve) {
            this._authenticate('').catch((e) => {
                if (this._loginReject) this._loginReject(e);
            });
        }
    }

    _completeKeyExchange() {
        if (this._keyExchangeDone || !this.crypto.peerPk) return;
        const keyMsg = this.crypto.createSymmetricKeyMsg(this.crypto.peerPk);
        const pkMsg = this.proto.buildPublicKey(keyMsg.asymmetricValue, keyMsg.symmetricValue);
        this._sendPeerMessageRaw(pkMsg);
        this.crypto.enabled = true;
        this.crypto._sendSeq = 0;
        this.crypto._recvSeq = 0;
        this._keyExchangePending = false;
        this._keyExchangeDone = true;
    }

    _sendPeerMessageRaw(msgObj) {
        let data = this.proto.serializeMessage(msgObj);
        if (this.crypto.enabled) data = this.crypto.processOutgoing(data);
        this.conn.sendRelay(this.proto.frameBytes(data));
    }

    _handleLoginResponse(resp) {
        if (resp.error && resp.error.length > 0) {
            const errLower = (resp.error || '').toLowerCase();
            if (errLower.includes('wrong 2fa') || errLower.includes('invalid 2fa')) {
                this._emit('2fa_error', resp.error);
                return;
            }
            if (errLower.includes('2fa required') || errLower.includes('totp')) {
                this._emit('2fa_required');
                return;
            }
            if (this._loginReject) this._loginReject(new Error(resp.error));
            this._emit('login_error', resp.error);
            return;
        }
        if (this._loginResolve) this._loginResolve();
    }
}

window.RDFileConnection = RDFileConnection;
