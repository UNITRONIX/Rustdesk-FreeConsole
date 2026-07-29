/**
 * Web Remote WS Mode bridge (#314): when rdTransport=ws, panel forwards
 * binary WebSocket frames 1:1 to Go :21118/:21119 (no BytesCodec / TCP).
 */

const http = require('http');
const WebSocket = require('ws');
const { wantsWsTransport, handleWsBridge } = require('../services/wsRelay');

describe('wsRelay — wantsWsTransport', () => {
    test('true when rdTransport=ws', () => {
        expect(wantsWsTransport({
            url: '/ws/rendezvous?rdTransport=ws',
            headers: { host: 'localhost' },
        })).toBe(true);
    });

    test('false when missing or native', () => {
        expect(wantsWsTransport({
            url: '/ws/rendezvous',
            headers: { host: 'localhost' },
        })).toBe(false);
        expect(wantsWsTransport({
            url: '/ws/relay?guest=abc',
            headers: { host: 'localhost' },
        })).toBe(false);
    });
});

describe('wsRelay — handleWsBridge binary 1:1', () => {
    let upstreamServer;
    let upstreamPort;
    let receivedFromClient;
    let upstreamWss;

    beforeEach(() => new Promise((resolve) => {
        receivedFromClient = [];
        upstreamServer = http.createServer((_req, res) => {
            res.writeHead(404);
            res.end();
        });
        upstreamWss = new WebSocket.Server({ server: upstreamServer, path: '/ws/id' });
        upstreamWss.on('connection', (ws) => {
            ws.on('message', (data, isBinary) => {
                receivedFromClient.push({
                    data: Buffer.from(data),
                    isBinary: !!isBinary,
                });
                ws.send(Buffer.from([0xde, 0xad, 0xbe, 0xef]), { binary: true });
            });
        });
        upstreamServer.listen(0, '127.0.0.1', () => {
            upstreamPort = upstreamServer.address().port;
            resolve();
        });
    }));

    afterEach(() => new Promise((resolve) => {
        const finish = () => {
            if (upstreamServer && upstreamServer.listening) {
                upstreamServer.close(() => resolve());
            } else {
                resolve();
            }
        };
        if (upstreamWss) {
            upstreamWss.close(() => finish());
        } else {
            finish();
        }
    }));

    test('forwards binary frames both ways without coalescing', async () => {
        const panelServer = http.createServer((_req, res) => {
            res.writeHead(404);
            res.end();
        });
        const panelWss = new WebSocket.Server({ noServer: true });

        panelServer.on('upgrade', (req, socket, head) => {
            panelWss.handleUpgrade(req, socket, head, (ws) => {
                handleWsBridge(ws, req, `ws://127.0.0.1:${upstreamPort}/ws/id`, 'test-bridge');
            });
        });

        await new Promise((resolve) => panelServer.listen(0, '127.0.0.1', resolve));
        const panelPort = panelServer.address().port;

        try {
            const browser = new WebSocket(`ws://127.0.0.1:${panelPort}/ws/rendezvous?rdTransport=ws`);
            browser.binaryType = 'nodebuffer';

            const payload = Buffer.from([0x01, 0x02, 0x03, 0xaa, 0xbb]);
            const echo = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('bridge timeout')), 5000);
                browser.on('open', () => {
                    browser.send(payload, { binary: true });
                });
                browser.on('message', (data) => {
                    clearTimeout(t);
                    resolve(Buffer.from(data));
                });
                browser.on('error', (err) => {
                    clearTimeout(t);
                    reject(err);
                });
            });

            expect(echo.equals(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toBe(true);
            expect(receivedFromClient.length).toBe(1);
            expect(receivedFromClient[0].data.equals(payload)).toBe(true);
            browser.close();
        } finally {
            await new Promise((resolve) => {
                panelWss.close(() => {
                    panelServer.close(resolve);
                });
            });
        }
    }, 10000);
});

/**
 * Contract for RDProtocol transportMode (browser): WS Mode skips BytesCodec.
 */
describe('rdTransportMode framing contract', () => {
    function frameBytes(rawBytes, mode) {
        if (mode === 'ws') return rawBytes;
        const len = rawBytes.length;
        const header = Buffer.alloc(1);
        header[0] = (len << 2) & 0xff;
        return Buffer.concat([header, Buffer.from(rawBytes)]);
    }

    function framesFromWsPayload(rawData, mode, streamFeed) {
        if (mode === 'ws') {
            const u8 = Buffer.from(rawData);
            return u8.length ? [u8] : [];
        }
        return streamFeed(rawData);
    }

    test('ws mode does not prepend BytesCodec header', () => {
        const raw = Buffer.from([0x10, 0x20, 0x30]);
        expect(frameBytes(raw, 'ws')).toEqual(raw);
        expect(frameBytes(raw, 'native').length).toBe(raw.length + 1);
    });

    test('ws mode treats each payload as one frame', () => {
        const raw = Buffer.from([0xab, 0xcd]);
        const frames = framesFromWsPayload(raw, 'ws', () => {
            throw new Error('stream decoder must not run in ws mode');
        });
        expect(frames).toHaveLength(1);
        expect(frames[0]).toEqual(raw);
    });

    test('native mode uses stream decoder', () => {
        const fed = [];
        framesFromWsPayload(Buffer.from([1, 2]), 'native', (d) => {
            fed.push(d);
            return [Buffer.from(d)];
        });
        expect(fed).toHaveLength(1);
    });
});
