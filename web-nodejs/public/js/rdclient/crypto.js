/**
 * BetterDesk Web Remote Client - Encryption Layer
 * NaCl-compatible encryption using tweetnacl-js
 * Matches RustDesk's sodiumoxide crypto_box / crypto_secretbox
 *
 * RustDesk encryption protocol:
 * - Key exchange uses NaCl box (Curve25519-XSalsa20-Poly1305) to encrypt
 *   a random 32-byte symmetric key
 * - Stream encryption uses NaCl secretbox (XSalsa20-Poly1305) with
 *   sequential counter-based nonces (NOT random prepended)
 * - Nonce = u64 little-endian counter, zero-padded to 24 bytes
 * - secretbox output = 16-byte Poly1305 MAC + ciphertext (no nonce prefix)
 */

/* global nacl */

// eslint-disable-next-line no-unused-vars
class RDCrypto {
    constructor() {
        /** @type {Uint8Array|null} Symmetric encryption key (32 bytes, XSalsa20-Poly1305) */
        this.secretKey = null;
        /** @type {Object|null} Our ephemeral Curve25519 keypair {publicKey, secretKey} */
        this.asymKeyPair = null;
        /** @type {Uint8Array|null} Peer's ephemeral Curve25519 public key */
        this.peerPk = null;
        /** @type {boolean} Whether encryption is active */
        this.enabled = false;
        /** @type {number} Send sequence counter (incremented before each encrypt) */
        this._sendSeq = 0;
        /** @type {number} Recv sequence counter (incremented before each decrypt) */
        this._recvSeq = 0;
    }

    /**
     * Generate a new ephemeral Curve25519 keypair for key exchange
     */
    generateKeyPair() {
        this.asymKeyPair = nacl.box.keyPair();
        return this.asymKeyPair;
    }

    /**
     * Generate a random 32-byte symmetric key for secretbox encryption
     */
    generateSymmetricKey() {
        this.secretKey = nacl.randomBytes(nacl.secretbox.keyLength);
        return this.secretKey;
    }

    /**
     * Set the peer's ephemeral Curve25519 public key
     * @param {Uint8Array} pk - 32-byte Curve25519 public key
     */
    setPeerPublicKey(pk) {
        this.peerPk = pk;
    }

    /**
     * Create the encrypted symmetric key message for key exchange.
     * Uses NaCl box to encrypt our symmetric key with the peer's ephemeral pk.
     * Matches RustDesk's create_symmetric_key_msg():
     *   sealed = box::seal(symKey, zero_nonce, their_pk, our_sk)
     *
     * @param {Uint8Array} theirPk - Peer's ephemeral Curve25519 public key (32 bytes)
     * @returns {{ asymmetricValue: Uint8Array, symmetricValue: Uint8Array }}
     */
    createSymmetricKeyMsg(theirPk) {
        if (!this.asymKeyPair) throw new Error('No keypair generated');
        if (!this.secretKey) throw new Error('No symmetric key generated');

        // All-zero nonce (safe because ephemeral keys are one-time use)
        const zeroNonce = new Uint8Array(nacl.box.nonceLength); // 24 bytes of zeros

        // Encrypt symmetric key using NaCl box (DH + XSalsa20-Poly1305)
        const sealed = nacl.box(
            this.secretKey,           // plaintext: our 32-byte symmetric key
            zeroNonce,                // 24-byte zero nonce
            theirPk,                  // peer's ephemeral Curve25519 pk
            this.asymKeyPair.secretKey // our ephemeral Curve25519 sk
        );

        return {
            asymmetricValue: this.asymKeyPair.publicKey, // our ephemeral pk (32 bytes)
            symmetricValue: sealed  // box-encrypted symmetric key (48 bytes = 16 MAC + 32 key)
        };
    }

    /**
     * Parse SignedId.id bytes to extract peer's identity and ephemeral public key.
     * Format: 64-byte Ed25519 signature + protobuf(IdPk { id: string, pk: bytes })
     *
     * @param {Uint8Array} signedIdBytes - The raw id field from SignedId message
     * @param {Object} idPkType - protobufjs IdPk message type for decoding
     * @returns {{ peerId: string, peerPk: Uint8Array, signature: Uint8Array, payload: Uint8Array, signatureVerified: boolean|null }|null}
     */
    parseSignedId(signedIdBytes, idPkType) {
        if (!signedIdBytes || signedIdBytes.length < 64 + 4) {
            console.warn('[RDCrypto] SignedId too short:', signedIdBytes?.length);
            return null;
        }

        // Ed25519 signature is first 64 bytes
        const signature = signedIdBytes.slice(0, 64);
        const payload = signedIdBytes.slice(64);

        try {
            const idPk = idPkType.decode(payload);
            const peerId = idPk.id || '';
            const peerPk = idPk.pk || null;

            if (!peerPk || peerPk.length !== 32) {
                console.warn('[RDCrypto] Invalid peer pk length:', peerPk?.length);
                return null;
            }

            return {
                peerId,
                peerPk: new Uint8Array(peerPk),
                signature: new Uint8Array(signature),
                payload: new Uint8Array(payload),
                signatureVerified: null // set by verifySignedId()
            };
        } catch (err) {
            console.warn('[RDCrypto] Failed to decode IdPk:', err.message);
            return null;
        }
    }

    /**
     * Decode a 32-byte Ed25519 public key from RustDesk formats.
     * Prefer base64 (id_ed25519.pub / Key field); also accept hex (API key_hex).
     *
     * @param {string} encoded
     * @returns {Uint8Array|null} 32-byte public key, or null if invalid
     */
    static decodeServerPublicKey(encoded) {
        if (!encoded || typeof encoded !== 'string') return null;
        const trimmed = encoded.trim();
        if (!trimmed) return null;

        // Hex: 64 hex chars = 32 bytes (optional 0x prefix)
        const hexBody = trimmed.replace(/^0x/i, '');
        if (/^[0-9a-fA-F]{64}$/.test(hexBody)) {
            try {
                const bytes = RDCrypto._hexToBytes(hexBody);
                return bytes.length === 32 ? bytes : null;
            } catch {
                return null;
            }
        }

        // Base64 (standard RustDesk Key / id_ed25519.pub)
        try {
            let b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4) b64 += '=';
            const bin = (typeof atob === 'function')
                ? atob(b64)
                : Buffer.from(b64, 'base64').toString('binary');
            if (bin.length !== 32) return null;
            const out = new Uint8Array(32);
            for (let i = 0; i < 32; i++) out[i] = bin.charCodeAt(i);
            return out;
        } catch {
            return null;
        }
    }

    /**
     * True when encoded looks like a usable server/peer Ed25519 public key.
     * @param {string} encoded
     * @returns {boolean}
     */
    static hasDecodablePublicKey(encoded) {
        return RDCrypto.decodeServerPublicKey(encoded) != null;
    }

    /**
     * Verify Ed25519 detached signature over payload with a base64 or hex public key.
     *
     * RustDesk chain for Web Remote:
     *   1. RelayResponse.pk is IdPk signed by the **server** key (identity of target)
     *   2. Message.SignedId is IdPk signed by the **peer identity** key (ephemeral box pk)
     *
     * @param {Uint8Array} signature - 64-byte Ed25519 signature
     * @param {Uint8Array} payload - Signed protobuf payload (IdPk bytes after the 64-byte sig)
     * @param {string|Uint8Array} publicKey - Ed25519 public key (base64/hex string or raw 32 bytes)
     * @returns {boolean} True if signature is valid, false otherwise
     */
    static verifySignedId(signature, payload, publicKey) {
        if (!signature || signature.length !== 64) {
            console.warn('[RDCrypto] Invalid Ed25519 signature length:', signature?.length);
            return false;
        }
        if (!payload || !payload.length) {
            console.warn('[RDCrypto] Empty signed payload');
            return false;
        }

        let keyBytes = null;
        if (publicKey instanceof Uint8Array) {
            keyBytes = publicKey.length === 32 ? publicKey : null;
        } else {
            keyBytes = RDCrypto.decodeServerPublicKey(publicKey || '');
        }
        if (!keyBytes) {
            console.warn('[RDCrypto] No usable public key for Ed25519 verification');
            return false;
        }

        try {
            return nacl.sign.detached.verify(payload, signature, keyBytes);
        } catch (err) {
            console.warn('[RDCrypto] Ed25519 verification error:', err.message);
            return false;
        }
    }

    /**
     * Verify a NaCl combined signed blob [64-byte sig][payload] and decode IdPk.
     * @param {Uint8Array} signedBytes
     * @param {string|Uint8Array} publicKey
     * @param {Object} idPkType - protobufjs IdPk type
     * @returns {{ peerId: string, peerPk: Uint8Array, signatureVerified: boolean }|null}
     */
    static verifyAndDecodeIdPk(signedBytes, publicKey, idPkType) {
        const parsed = new RDCrypto().parseSignedId(signedBytes, idPkType);
        if (!parsed) return null;
        const ok = RDCrypto.verifySignedId(parsed.signature, parsed.payload, publicKey);
        if (!ok) return null;
        return {
            peerId: parsed.peerId,
            peerPk: parsed.peerPk,
            signatureVerified: true,
        };
    }

    /**
     * Convert hex string to Uint8Array
     * @param {string} hex
     * @returns {Uint8Array}
     */
    static _hexToBytes(hex) {
        const clean = hex.replace(/^0x/i, '');
        const bytes = new Uint8Array(clean.length / 2);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
        }
        return bytes;
    }

    /**
     * Build a sequential nonce from a counter value.
     * Matches RustDesk's FramedStream::get_nonce():
     *   nonce[0..8] = counter.to_le_bytes(), rest = 0
     * @param {number} counter
     * @returns {Uint8Array} 24-byte nonce
     */
    _counterNonce(counter) {
        const nonce = new Uint8Array(nacl.secretbox.nonceLength); // 24 bytes
        // Write counter as u64 little-endian (max safe integer in JS is 2^53)
        let val = counter;
        for (let i = 0; i < 8; i++) {
            nonce[i] = val & 0xFF;
            val = Math.floor(val / 256);
        }
        return nonce;
    }

    /**
     * Encrypt data using NaCl secretbox with sequential counter nonce.
     * Output format: 16-byte Poly1305 MAC + ciphertext (NO nonce prefix).
     * @param {Uint8Array} plaintext
     * @returns {Uint8Array} MAC + ciphertext
     */
    encrypt(plaintext) {
        if (!this.secretKey) throw new Error('No symmetric key set');

        this._sendSeq++;
        const nonce = this._counterNonce(this._sendSeq);
        return nacl.secretbox(plaintext, nonce, this.secretKey);
    }

    /**
     * Decrypt data using NaCl secretbox with sequential counter nonce.
     * Input format: 16-byte Poly1305 MAC + ciphertext (NO nonce prefix).
     * @param {Uint8Array} data - MAC + ciphertext
     * @returns {Uint8Array|null} plaintext or null if decryption fails
     */
    decrypt(data) {
        if (!this.secretKey) throw new Error('No symmetric key set');

        this._recvSeq++;
        const nonce = this._counterNonce(this._recvSeq);
        return nacl.secretbox.open(data, nonce, this.secretKey);
    }

    /**
     * Hash password for RustDesk login.
     * Algorithm matches RustDesk client (src/client.rs handle_hash + src/server/connection.rs validate_one_password):
     *   intermediate = sha256(password_bytes + salt_bytes)   // password FIRST, then salt
     *   final        = sha256(intermediate  + challenge_bytes) // hash FIRST, then challenge
     * @param {string} password - Raw password text
     * @param {string} salt - Salt from Hash message
     * @param {string} challenge - Challenge from Hash message
     * @returns {Promise<Uint8Array>} 32-byte hash to send in LoginRequest.password
     */
    async hashPassword(password, salt, challenge) {
        const encoder = new TextEncoder();
        const passwordBytes = encoder.encode(password);
        const saltBytes = encoder.encode(salt);
        const challengeBytes = encoder.encode(challenge);

        // Step 1: intermediate = sha256(password + salt)
        const step1Input = new Uint8Array(passwordBytes.length + saltBytes.length);
        step1Input.set(passwordBytes, 0);
        step1Input.set(saltBytes, passwordBytes.length);
        const intermediateBuf = await RDCrypto._sha256(step1Input);
        const intermediate = new Uint8Array(intermediateBuf);

        // Step 2: final = sha256(intermediate + challenge)
        const step2Input = new Uint8Array(intermediate.length + challengeBytes.length);
        step2Input.set(intermediate, 0);
        step2Input.set(challengeBytes, intermediate.length);
        const finalHash = await RDCrypto._sha256(step2Input);
        return new Uint8Array(finalHash);
    }

    /**
     * SHA-256 with fallback for insecure contexts (HTTP).
     * crypto.subtle is only available in secure contexts (HTTPS/localhost).
     * Falls back to pure JS implementation when unavailable.
     * @param {Uint8Array} data
     * @returns {Promise<ArrayBuffer>}
     */
    static async _sha256(data) {
        // Try native Web Crypto first (fast, available on HTTPS)
        if (typeof crypto !== 'undefined' && crypto.subtle) {
            return crypto.subtle.digest('SHA-256', data);
        }

        // Pure JS SHA-256 fallback for HTTP contexts
        return RDCrypto._sha256Fallback(data).buffer;
    }

    /**
     * Pure JavaScript SHA-256 implementation (RFC 6234).
     * Used as fallback when crypto.subtle is unavailable.
     * @param {Uint8Array} message
     * @returns {Uint8Array} 32-byte hash
     */
    static _sha256Fallback(message) {
        const K = new Uint32Array([
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ]);

        const rotr = (x, n) => (x >>> n) | (x << (32 - n));
        const ch = (x, y, z) => (x & y) ^ (~x & z);
        const maj = (x, y, z) => (x & y) ^ (x & z) ^ (y & z);
        const sigma0 = (x) => rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22);
        const sigma1 = (x) => rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25);
        const gamma0 = (x) => rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
        const gamma1 = (x) => rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10);

        // Pre-processing: padding
        const msgLen = message.length;
        const bitLen = msgLen * 8;
        const padLen = ((msgLen + 8) % 64 < 56) ? 56 - ((msgLen + 8) % 64) + 8 : 120 - ((msgLen + 8) % 64) + 8;
        const padded = new Uint8Array(msgLen + padLen + 8);
        padded.set(message);
        padded[msgLen] = 0x80;
        // Length in bits as big-endian 64-bit (we only use lower 32 bits since JS is 32-bit safe)
        const view = new DataView(padded.buffer);
        view.setUint32(padded.length - 4, bitLen, false);

        // Initialize hash values
        let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
        let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

        const W = new Uint32Array(64);

        // Process each 512-bit (64-byte) block
        for (let offset = 0; offset < padded.length; offset += 64) {
            for (let i = 0; i < 16; i++) {
                W[i] = view.getUint32(offset + i * 4, false);
            }
            for (let i = 16; i < 64; i++) {
                W[i] = (gamma1(W[i - 2]) + W[i - 7] + gamma0(W[i - 15]) + W[i - 16]) | 0;
            }

            let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

            for (let i = 0; i < 64; i++) {
                const t1 = (h + sigma1(e) + ch(e, f, g) + K[i] + W[i]) | 0;
                const t2 = (sigma0(a) + maj(a, b, c)) | 0;
                h = g; g = f; f = e; e = (d + t1) | 0;
                d = c; c = b; b = a; a = (t1 + t2) | 0;
            }

            h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
            h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
        }

        // Produce the final hash
        const result = new Uint8Array(32);
        const rv = new DataView(result.buffer);
        rv.setUint32(0, h0, false); rv.setUint32(4, h1, false);
        rv.setUint32(8, h2, false); rv.setUint32(12, h3, false);
        rv.setUint32(16, h4, false); rv.setUint32(20, h5, false);
        rv.setUint32(24, h6, false); rv.setUint32(28, h7, false);
        return result;
    }

    /**
     * Enable encryption for the session (resets counters).
     * Note: the peer may not yet be encrypting at this point (race condition
     * where peer sends messages before processing our PublicKey). Use
     * tryDecrypt() + commitDecrypt() for safe speculative decryption.
     */
    enable() {
        this.enabled = true;
        this._sendSeq = 0;
        this._recvSeq = 0;
    }

    /**
     * Attempt to decrypt data WITHOUT committing the receive sequence counter.
     * Used for speculative decryption when the peer may not yet be encrypting
     * (e.g., target sends Hash before processing our PublicKey).
     *
     * On success, call commitDecrypt(result.seq) to advance the counter.
     * On failure, the counter is unchanged and the caller can try plaintext.
     *
     * @param {Uint8Array} data - MAC + ciphertext
     * @returns {{ plaintext: Uint8Array, seq: number }|null}
     */
    tryDecrypt(data) {
        if (!this.secretKey) return null;
        const nextSeq = this._recvSeq + 1;
        const nonce = this._counterNonce(nextSeq);
        const result = nacl.secretbox.open(data, nonce, this.secretKey);
        if (!result) return null;
        return { plaintext: result, seq: nextSeq };
    }

    /**
     * Commit the receive sequence counter after a successful tryDecrypt().
     * @param {number} seq - The seq value from tryDecrypt result
     */
    commitDecrypt(seq) {
        this._recvSeq = seq;
    }

    /**
     * Process incoming data — decrypt if encryption is enabled
     * @param {Uint8Array} data
     * @returns {Uint8Array|null}
     */
    processIncoming(data) {
        if (!this.enabled) return data;
        return this.decrypt(data);
    }

    /**
     * Process outgoing data — encrypt if encryption is enabled
     * @param {Uint8Array} data
     * @returns {Uint8Array}
     */
    processOutgoing(data) {
        if (!this.enabled) return data;
        return this.encrypt(data);
    }
}

window.RDCrypto = RDCrypto;
