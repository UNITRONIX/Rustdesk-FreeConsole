'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { syncSessionMediaCapture } = require('../lib/sessionMediaSync');

function loadBrowserScript(relativePath, extraGlobals) {
    const filename = path.join(__dirname, '..', relativePath);
    const sandbox = {
        console,
        window: {},
        globalThis: {},
        ...extraGlobals,
    };
    if (!extraGlobals || extraGlobals.window === undefined) {
        sandbox.window = sandbox;
    }
    sandbox.globalThis = sandbox.window;
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return sandbox;
}

describe('syncSessionMediaCapture', () => {
    it('activates only the active streaming session', () => {
        const clientA = { setSessionActive: jest.fn() };
        const clientB = { setSessionActive: jest.fn() };
        const sessions = new Map([
            ['device-a', { deviceId: 'device-a', state: 'streaming', client: clientA }],
            ['device-b', { deviceId: 'device-b', state: 'streaming', client: clientB }],
        ]);

        syncSessionMediaCapture(sessions, 'device-b');

        expect(clientA.setSessionActive).toHaveBeenCalledWith(false);
        expect(clientB.setSessionActive).toHaveBeenCalledWith(true);
    });

    it('does not activate a non-streaming tab even when selected', () => {
        const client = { setSessionActive: jest.fn() };
        const sessions = new Map([
            ['device-a', { deviceId: 'device-a', state: 'connecting', client }],
        ]);

        syncSessionMediaCapture(sessions, 'device-a');

        expect(client.setSessionActive).toHaveBeenCalledWith(false);
    });

    it('ignores sessions without a transport client', () => {
        const sessions = new Map([
            ['device-a', { deviceId: 'device-a', state: 'streaming', client: null }],
        ]);

        expect(() => syncSessionMediaCapture(sessions, 'device-a')).not.toThrow();
    });
});

describe('RDAudio session isolation', () => {
    let RDAudio;

    beforeAll(() => {
        class MockGainNode {
            constructor() { this.gain = { value: 1 }; }
            connect() {}
        }
        class MockAudioContext {
            constructor() {
                this.state = 'running';
                this.currentTime = 0;
                this.destination = {};
            }
            createGain() { return new MockGainNode(); }
            createBuffer() {
                return { getChannelData: () => new Float32Array(1) };
            }
            createBufferSource() {
                return { connect() {}, start() {} };
            }
            resume() { return Promise.resolve(); }
            close() { this.state = 'closed'; }
        }

        const sandbox = loadBrowserScript('public/js/rdclient/audio.js', {
            AudioContext: MockAudioContext,
            webkitAudioContext: MockAudioContext,
            AudioDecoder: undefined,
        });
        RDAudio = sandbox.RDAudio;
    });

    it('skips playback when the session tab is inactive', async () => {
        const audio = new RDAudio();
        await audio.init();
        audio.setSessionActive(false);

        audio.play({ data: new Uint8Array([0, 0, 1, 0]), timestamp: 0 });

        expect(audio.framesPlayed).toBe(0);
    });

    it('respects toolbar mute independently of tab activity', async () => {
        const audio = new RDAudio();
        await audio.init();
        audio.setSessionActive(true);
        audio.setMuted(true);

        expect(audio.gainNode.gain.value).toBe(0);

        audio.setSessionActive(false);
        expect(audio.gainNode.gain.value).toBe(0);

        audio.setSessionActive(true);
        audio.setMuted(false);
        expect(audio.gainNode.gain.value).toBe(1);
    });
});

describe('RDInput multi-session keyboard isolation', () => {
    let RDInput;
    let keydownHandlers;

    beforeAll(() => {
        keydownHandlers = [];

        const documentListeners = { keydown: [], keyup: [], pointerlockchange: [] };
        const document = {
            activeElement: null,
            addEventListener(type, fn) {
                if (documentListeners[type]) documentListeners[type].push(fn);
            },
            removeEventListener(type, fn) {
                if (!documentListeners[type]) return;
                documentListeners[type] = documentListeners[type].filter((h) => h !== fn);
            },
            exitPointerLock() {},
            _listeners: documentListeners,
            _dispatch(type, event) {
                for (const fn of documentListeners[type] || []) fn(event);
            },
        };

        function makeCanvas() {
            const listeners = {};
            return {
                tabIndex: -1,
                addEventListener(type, fn) { listeners[type] = fn; },
                removeEventListener(type, fn) { if (listeners[type] === fn) delete listeners[type]; },
                focus() { document.activeElement = this; },
            };
        }

        const windowStub = {
            addEventListener() {},
            removeEventListener() {},
        };

        const sandbox = loadBrowserScript('public/js/rdclient/input.js', {
            document,
            window: windowStub,
            RDProtocol: {},
            RDKeyboardScancode: {
                MODIFIER_CODES: ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
                    'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'],
                codeToScancode: () => null,
            },
            makeCanvas,
        });
        RDInput = sandbox.window.RDInput;
        sandbox.makeCanvas = makeCanvas;
        sandbox.document = document;
    });

    function makeInput(sendMessage) {
        const canvas = {
            tabIndex: -1,
            listeners: {},
            addEventListener(type, fn) { this.listeners[type] = fn; },
            removeEventListener(type, fn) { if (this.listeners[type] === fn) delete this.listeners[type]; },
            focus() {},
        };
        const renderer = { mapCoords: (x, y) => ({ x, y }) };
        return new RDInput(canvas, renderer, sendMessage);
    }

    it('does not send keys after stop() even though the handler stays registered', () => {
        const sendA = jest.fn();
        const sendB = jest.fn();
        const inputA = makeInput(sendA);
        const inputB = makeInput(sendB);

        inputA.start();
        inputB.start();
        inputA.stop();
        sendA.mockClear();

        const event = {
            code: 'KeyA',
            key: 'a',
            repeat: false,
            preventDefault() {},
            stopPropagation() {},
            ctrlKey: false,
            altKey: false,
            metaKey: false,
        };

        inputA._handleKeyDown(event);
        inputB._handleKeyDown(event);

        expect(sendA).not.toHaveBeenCalled();
        expect(sendB).toHaveBeenCalled();
    });
});

describe('RDClient setSessionActive contract', () => {
    function makeClientStub() {
        const input = {
            start: jest.fn(),
            stop: jest.fn(),
        };
        const audio = { setSessionActive: jest.fn() };
        const renderer = { stopRenderLoop: jest.fn(), startRenderLoop: jest.fn() };
        const video = { setBackgroundMode: jest.fn() };
        const client = {
            _sessionActive: true,
            _viewOnly: false,
            _state: 'streaming',
            _clipboardToLocalEnabled: true,
            _streamThrottledActive: null,
            _backgroundFps: 1,
            _savedActiveFps: 60,
            input,
            audio,
            renderer,
            video,
            setCustomFps: jest.fn(),
            _sendPeerMessage: jest.fn(),
            proto: { buildMisc: () => ({ misc: {} }) },
            setSessionActive(active) {
                const next = !!active;
                this._sessionActive = next;
                this._clipboardToLocalEnabled = next;
                this.audio.setSessionActive(next);
                this._syncInputCapture();
                if (this._state === 'streaming') this._syncStreamThrottle();
            },
            _syncInputCapture() {
                const shouldCapture = this._sessionActive && !this._viewOnly && this._state === 'streaming';
                if (shouldCapture) this.input.start();
                else this.input.stop();
            },
            _getActiveStreamFps() { return this._savedActiveFps || 60; },
            _syncStreamThrottle() {
                if (this._state !== 'streaming') return;
                const wantActive = this._sessionActive;
                if (this._streamThrottledActive === wantActive) return;
                this._streamThrottledActive = wantActive;
                if (wantActive) this._resumeActiveStream();
                else this._throttleBackgroundStream();
            },
            _throttleBackgroundStream() {
                this.renderer.stopRenderLoop();
                this.video.setBackgroundMode(true);
                this.setCustomFps(this._backgroundFps);
            },
            _resumeActiveStream() {
                this.video.setBackgroundMode(false);
                this.renderer.startRenderLoop();
                this.setCustomFps(this._getActiveStreamFps());
                this._sendPeerMessage(this.proto.buildMisc('refreshVideo', true));
            },
        };
        return client;
    }

    it('starts input only for the active streaming session', () => {
        const active = makeClientStub();
        const background = makeClientStub();

        active.setSessionActive(true);
        background.setSessionActive(false);

        expect(active.input.start).toHaveBeenCalled();
        expect(background.input.stop).toHaveBeenCalled();
        expect(active._clipboardToLocalEnabled).toBe(true);
        expect(background._clipboardToLocalEnabled).toBe(false);
    });

    it('throttles background stream to 1fps and resumes active stream at 60fps', () => {
        const client = makeClientStub();
        client.setSessionActive(false);

        expect(client.renderer.stopRenderLoop).toHaveBeenCalled();
        expect(client.video.setBackgroundMode).toHaveBeenCalledWith(true);
        expect(client.setCustomFps).toHaveBeenCalledWith(1);

        client.setSessionActive(true);
        expect(client.video.setBackgroundMode).toHaveBeenCalledWith(false);
        expect(client.renderer.startRenderLoop).toHaveBeenCalled();
        expect(client.setCustomFps).toHaveBeenCalledWith(60);
    });

    it('keeps input stopped in view-only mode even when active', () => {
        const client = makeClientStub();
        client._viewOnly = true;
        client.setSessionActive(true);

        expect(client.input.start).not.toHaveBeenCalled();
        expect(client.input.stop).toHaveBeenCalled();
    });
});

describe('CDAPSession setSessionActive contract', () => {
    function makeCdapStub() {
        const client = {
            _sessionActive: true,
            _connected: true,
            _clipboardToLocalEnabled: true,
            _inputBound: false,
            _bindInput() {
                this._inputBound = true;
            },
            _unbindInput() {
                this._inputBound = false;
            },
            setSessionActive(active) {
                this._sessionActive = !!active;
                this._clipboardToLocalEnabled = !!active;
                this._syncInputCapture();
            },
            _syncInputCapture() {
                if (this._sessionActive && this._connected) this._bindInput();
                else this._unbindInput();
            },
        };
        return client;
    }

    it('binds input only for the active connected session', () => {
        const active = makeCdapStub();
        const background = makeCdapStub();

        active.setSessionActive(true);
        background.setSessionActive(false);

        expect(active._inputBound).toBe(true);
        expect(background._inputBound).toBe(false);
    });
});
