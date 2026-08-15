const http = require('http');
const WebSocket = require('ws');

jest.mock('../lib/deviceTokenAuth', () => ({
    verifyDeviceWsAuth: jest.fn(),
}));

const { verifyDeviceWsAuth } = require('../lib/deviceTokenAuth');
const { initChatRelay } = require('../services/chatRelay');

function openSocket(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

function waitForMessage(ws, predicate, timeout = 1500) {
    return new Promise((resolve, reject) => {
        const onMessage = (raw) => {
            let parsed;
            try {
                parsed = JSON.parse(raw.toString());
            } catch (_err) {
                return;
            }

            if (!predicate || predicate(parsed)) {
                cleanup();
                resolve(parsed);
            }
        };

        const cleanup = () => {
            clearTimeout(timer);
            ws.off('message', onMessage);
        };

        const timer = setTimeout(() => {
            cleanup();
            reject(new Error('Timed out waiting for WebSocket message'));
        }, timeout);

        ws.on('message', onMessage);
    });
}

function closeSocket(ws) {
    return new Promise((resolve) => {
        if (!ws || ws.readyState === WebSocket.CLOSED) {
            resolve();
            return;
        }

        const timer = setTimeout(() => {
            try {
                ws.terminate();
            } catch (_err) {
                // ignore forced-close errors
            }
        }, 100);

        const finish = () => {
            clearTimeout(timer);
            resolve();
        };
        ws.once('close', finish);

        try {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            } else {
                ws.terminate();
            }
        } catch (_err) {
            clearTimeout(timer);
            resolve();
        }
    });
}

describe('Chat Relay Protocol', () => {
    let server;
    let address;
    let sockets;
    let goApi;
    let deviceCounter;

    beforeEach(async () => {
        sockets = [];
        deviceCounter = 0;
        goApi = {
            get: jest.fn().mockRejectedValue(new Error('offline')),
            post: jest.fn().mockResolvedValue({ data: { success: true } }),
        };
        verifyDeviceWsAuth.mockResolvedValue(true);

        server = http.createServer();
        initChatRelay(server, (req, _res, next) => {
            req.session = {
                userId: 1,
                username: 'operator1',
                user: { role: 'operator', username: 'operator1' },
            };
            next();
        }, goApi);

        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        address = server.address();
    });

    afterEach(async () => {
        await Promise.all(sockets.map((ws) => closeSocket(ws)));
        await new Promise((resolve) => server.close(resolve));
    });

    function nextDeviceId(prefix = 'DEV') {
        deviceCounter += 1;
        return `${prefix}-${Date.now()}-${deviceCounter}`;
    }

    async function connect(path) {
        const agentPath = path.startsWith('/ws/chat/')
            ? `${path}${path.includes('?') ? '&' : '?'}token=valid-device-token`
            : path;
        const ws = await openSocket(`ws://127.0.0.1:${address.port}${agentPath}`);
        sockets.push(ws);
        return ws;
    }

    it('rejects an agent upgrade without a valid device token', async () => {
        verifyDeviceWsAuth.mockResolvedValueOnce(false);
        await expect(openSocket(`ws://127.0.0.1:${address.port}/ws/chat/UNAUTH-DEVICE`))
            .rejects.toThrow();
        expect(verifyDeviceWsAuth).toHaveBeenCalledWith(
            'UNAUTH-DEVICE',
            '',
            expect.any(Object),
        );
    });

    it('acknowledges agent hello frames with a welcome message and capabilities', async () => {
        const deviceId = nextDeviceId();
        const agent = await connect(`/ws/chat/${deviceId}`);

        agent.send(JSON.stringify({ type: 'hello', device_id: deviceId }));
        const welcome = await waitForMessage(agent, (msg) => msg.type === 'welcome');

        expect(welcome.device_id).toBe(deviceId);
        expect(welcome.capabilities).toContain('e2e_encryption');
        expect(welcome.capabilities).toContain('file_share');
    });

    it('falls back to operator and connected agents when contacts cannot be loaded from the API', async () => {
        const peerA = nextDeviceId('A');
        const peerB = nextDeviceId('B');
        await connect(`/ws/chat/${peerB}`);
        const agent = await connect(`/ws/chat/${peerA}`);

        agent.send(JSON.stringify({ type: 'get_contacts', device_id: peerA }));
        const contactsFrame = await waitForMessage(agent, (msg) => {
            return msg.type === 'contacts' && Array.isArray(msg.contacts) && msg.contacts.some((c) => c.id === peerB);
        });

        expect(contactsFrame.contacts.some((c) => c.id === 'operator')).toBe(true);
        expect(contactsFrame.contacts.some((c) => c.id === peerB)).toBe(true);
    });

    it('broadcasts agent messages to operators and persists them through the Go API', async () => {
        const deviceId = nextDeviceId();
        const agent = await connect(`/ws/chat/${deviceId}`);
        const operator = await connect(`/ws/chat-operator/${deviceId}`);

        agent.send(JSON.stringify({ type: 'message', text: 'hello operator', conversation_id: deviceId }));
        const message = await waitForMessage(operator, (msg) => msg.type === 'message' && msg.text === 'hello operator');

        expect(message.from).toBe(deviceId);
        expect(goApi.post).toHaveBeenCalledWith('/chat/messages', expect.objectContaining({
            conversation_id: deviceId,
            from_id: deviceId,
            text: 'hello operator',
        }));
    });

    it('relays operator key exchange frames to the connected agent', async () => {
        const deviceId = nextDeviceId();
        const agent = await connect(`/ws/chat/${deviceId}`);
        const operator = await connect(`/ws/chat-operator/${deviceId}`);

        operator.send(JSON.stringify({
            type: 'key_exchange',
            public_key: 'operator-public-key',
            conversation_id: deviceId,
        }));

        const keyExchange = await waitForMessage(agent, (msg) => msg.type === 'key_exchange' && msg.public_key === 'operator-public-key');

        expect(keyExchange.from).toBe('operator');
        expect(keyExchange.operator).toBe('operator1');
        expect(keyExchange.conversation_id).toBe(deviceId);
    });
});