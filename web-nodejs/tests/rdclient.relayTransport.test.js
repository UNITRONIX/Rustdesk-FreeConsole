'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const protobuf = require('protobufjs');

function loadBrowserScript(relativePath, globals = {}) {
    const sandbox = {
        console,
        Uint8Array,
        ArrayBuffer,
        ...globals,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const filename = path.join(__dirname, '..', relativePath);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return sandbox;
}

describe('RDProtocol relay WebSocket serialization', () => {
    let RDProtocol;
    let RendezvousMessage;

    beforeAll(async () => {
        const root = await protobuf.load(path.join(__dirname, '../protos/rendezvous.proto'));
        RendezvousMessage = root.lookupType('hbb.RendezvousMessage');
        RDProtocol = loadBrowserScript('public/js/rdclient/protocol.js').RDProtocol;
    });

    it('keeps native WS payload raw while retaining TCP framing for rendezvous', () => {
        const protocol = new RDProtocol();
        protocol.types.RendezvousMessage = RendezvousMessage;
        const message = { requestRelay: { id: 'target', uuid: 'relay-test-uuid' } };

        const raw = protocol.serializeRendezvous(message);
        const framed = protocol.encodeRendezvous(message);
        const decodedFrames = protocol.createStreamDecoder().feed(framed);

        expect(decodedFrames).toHaveLength(1);
        expect(Buffer.from(decodedFrames[0]).equals(Buffer.from(raw))).toBe(true);
        expect(RendezvousMessage.decode(raw).requestRelay.uuid).toBe('relay-test-uuid');
        expect(Buffer.from(framed).equals(Buffer.from(raw))).toBe(false);
    });
});

describe('RDConnection native relay WebSocket transport', () => {
    it('selects message transport on the relay URL', async () => {
        const sockets = [];
        class MockWebSocket {
            static OPEN = 1;
            constructor(url) {
                this.url = url;
                sockets.push(this);
            }
        }
        const sandbox = loadBrowserScript('public/js/rdclient/connection.js', {
            location: { protocol: 'https:', host: 'console.example.test' },
            WebSocket: MockWebSocket,
        });
        const connection = new sandbox.RDConnection();

        const opening = connection.connectRelay();
        expect(sockets[0].url).toBe('wss://console.example.test/ws/relay?transport=message');
        sockets[0].onopen();
        await expect(opening).resolves.toBe(sockets[0]);
    });
});

describe('RDClient raw relay messages', () => {
    it('sends encrypted-or-plain protobuf bytes without adding TCP framing', () => {
        const RDClient = loadBrowserScript('public/js/rdclient/client.js').RDClient;
        const client = Object.create(RDClient.prototype);
        const raw = new Uint8Array([0x12, 0x01, 0x01]);
        client.proto = {
            loaded: true,
            serializeMessage: jest.fn(() => raw),
            frameBytes: jest.fn(() => { throw new Error('must not frame native WS messages'); }),
        };
        client.crypto = { enabled: false, processOutgoing: jest.fn() };
        client.conn = { sendRelay: jest.fn() };

        client._sendPeerMessage({ testDelay: { time: 1 } });

        expect(client.proto.frameBytes).not.toHaveBeenCalled();
        expect(client.conn.sendRelay).toHaveBeenCalledWith(raw);
    });

    it('treats each incoming WS message as exactly one relay payload', () => {
        const RDClient = loadBrowserScript('public/js/rdclient/client.js').RDClient;
        const client = Object.create(RDClient.prototype);
        client._handleRelayMessage = jest.fn();
        const raw = new Uint8Array([0x0a, 0x01, 0x01]);

        client._handleRelayData(raw.buffer);

        expect(client._handleRelayMessage).toHaveBeenCalledTimes(1);
        expect(Array.from(client._handleRelayMessage.mock.calls[0][0])).toEqual(Array.from(raw));
    });
});

describe('RDFileConnection raw relay messages', () => {
    it('does not add TCP framing to file-transfer WS payloads', () => {
        const RDFileConnection = loadBrowserScript('public/js/rdclient/file-connection.js').RDFileConnection;
        const connection = Object.create(RDFileConnection.prototype);
        const raw = new Uint8Array([0x22, 0x01, 0x01]);
        connection.proto = {
            serializeMessage: jest.fn(() => raw),
            frameBytes: jest.fn(() => { throw new Error('must not frame native WS messages'); }),
        };
        connection.crypto = { enabled: false, processOutgoing: jest.fn() };
        connection.conn = { sendRelay: jest.fn() };

        connection._sendPeerMessageRaw({ fileAction: {} });

        expect(connection.proto.frameBytes).not.toHaveBeenCalled();
        expect(connection.conn.sendRelay).toHaveBeenCalledWith(raw);
    });
});
