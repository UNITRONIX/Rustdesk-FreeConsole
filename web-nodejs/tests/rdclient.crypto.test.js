'use strict';

/**
 * Web Remote SignedId / server-key decoding (#313 follow-up).
 * id_ed25519.pub is base64; SignedId is peer-identity-signed (not server-signed).
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nacl = require('tweetnacl');
const protobuf = require('protobufjs');

function loadRDCrypto() {
    const sandbox = {
        console,
        nacl,
        Uint8Array,
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        Buffer,
        window: {},
        globalThis: {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'public/js/rdclient/crypto.js'),
        'utf8'
    );
    vm.runInNewContext(src + '\nglobalThis.RDCrypto = RDCrypto;', sandbox, {
        filename: 'crypto.js',
    });
    return sandbox.RDCrypto;
}

describe('RDCrypto server public key decoding', () => {
    let RDCrypto;

    beforeAll(() => {
        RDCrypto = loadRDCrypto();
    });

    it('decodes standard base64 id_ed25519.pub (44 chars)', () => {
        const kp = nacl.sign.keyPair();
        const b64 = Buffer.from(kp.publicKey).toString('base64');
        expect(b64.length).toBeLessThan(64);
        expect(RDCrypto.hasDecodablePublicKey(b64)).toBe(true);
        const decoded = RDCrypto.decodeServerPublicKey(b64);
        expect(decoded).toEqual(kp.publicKey);
    });

    it('decodes hex key_hex (64 chars)', () => {
        const kp = nacl.sign.keyPair();
        const hex = Buffer.from(kp.publicKey).toString('hex');
        expect(hex.length).toBe(64);
        const decoded = RDCrypto.decodeServerPublicKey(hex);
        expect(decoded).toEqual(kp.publicKey);
    });

    it('rejects empty / garbage keys', () => {
        expect(RDCrypto.decodeServerPublicKey('')).toBeNull();
        expect(RDCrypto.decodeServerPublicKey('not-a-key')).toBeNull();
        expect(RDCrypto.hasDecodablePublicKey('')).toBe(false);
    });
});

describe('RDCrypto SignedId verification chain', () => {
    let RDCrypto;
    let IdPk;

    beforeAll(async () => {
        RDCrypto = loadRDCrypto();
        const root = await protobuf.load([
            path.join(__dirname, '../protos/message.proto'),
        ]);
        IdPk = root.lookupType('hbb.IdPk');
    });

    function signIdPk(signSecretKey, peerId, boxPk) {
        const payload = IdPk.encode(
            IdPk.create({ id: peerId, pk: boxPk })
        ).finish();
        const sig = nacl.sign.detached(payload, signSecretKey);
        const combined = new Uint8Array(sig.length + payload.length);
        combined.set(sig, 0);
        combined.set(payload, sig.length);
        return combined;
    }

    it('verifies RelayResponse.pk with server key and SignedId with peer identity', () => {
        const server = nacl.sign.keyPair();
        const peerIdentity = nacl.sign.keyPair();
        const ephemeral = nacl.box.keyPair();

        // Server signs peer identity public key (RegisterPk / RelayResponse.pk)
        const relayPk = signIdPk(server.secretKey, '123456789', peerIdentity.publicKey);
        // Peer signs ephemeral box key (Message.SignedId)
        const signedId = signIdPk(peerIdentity.secretKey, '123456789', ephemeral.publicKey);

        const serverKeyB64 = Buffer.from(server.publicKey).toString('base64');
        const identity = RDCrypto.verifyAndDecodeIdPk(relayPk, serverKeyB64, IdPk);
        expect(identity).not.toBeNull();
        expect(identity.peerId).toBe('123456789');
        expect(identity.peerPk).toEqual(peerIdentity.publicKey);

        const session = new RDCrypto().parseSignedId(signedId, IdPk);
        expect(session).not.toBeNull();
        expect(
            RDCrypto.verifySignedId(session.signature, session.payload, identity.peerPk)
        ).toBe(true);
        expect(session.peerPk).toEqual(ephemeral.publicKey);
    });

    it('rejects SignedId when verified with the server key (wrong signer)', () => {
        const server = nacl.sign.keyPair();
        const peerIdentity = nacl.sign.keyPair();
        const ephemeral = nacl.box.keyPair();
        const signedId = signIdPk(peerIdentity.secretKey, '123456789', ephemeral.publicKey);
        const serverKeyB64 = Buffer.from(server.publicKey).toString('base64');

        const parsed = new RDCrypto().parseSignedId(signedId, IdPk);
        expect(
            RDCrypto.verifySignedId(parsed.signature, parsed.payload, serverKeyB64)
        ).toBe(false);
    });
});
