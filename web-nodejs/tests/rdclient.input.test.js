'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadBrowserScripts(relativePaths, extraGlobals) {
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
    for (const rel of relativePaths) {
        const filename = path.join(__dirname, '..', rel);
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    }
    return sandbox;
}

function makeDocument() {
    const documentListeners = {
        keydown: [],
        keyup: [],
        pointerlockchange: [],
        visibilitychange: [],
    };
    return {
        activeElement: null,
        visibilityState: 'visible',
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
}

function makeInputHarness(extraGlobals) {
    const document = makeDocument();
    const windowListeners = { blur: [] };
    const win = {
        addEventListener(type, fn) {
            if (windowListeners[type]) windowListeners[type].push(fn);
        },
        removeEventListener(type, fn) {
            if (!windowListeners[type]) return;
            windowListeners[type] = windowListeners[type].filter((h) => h !== fn);
        },
        _dispatch(type, event) {
            for (const fn of windowListeners[type] || []) fn(event);
        },
    };

    const sandbox = loadBrowserScripts([
        'public/js/rdclient/keyboard-scancode.js',
        'public/js/rdclient/input.js',
    ], {
        document,
        window: win,
        RDProtocol: {},
        ...extraGlobals,
    });

    function makeInput(sendMessage) {
        const canvas = {
            tabIndex: -1,
            listeners: {},
            addEventListener(type, fn) { this.listeners[type] = fn; },
            removeEventListener(type, fn) { if (this.listeners[type] === fn) delete this.listeners[type]; },
            focus() { document.activeElement = this; },
        };
        const renderer = {
            remoteWidth: 1920,
            remoteHeight: 1080,
            canvasToRemote: (x, y) => ({ x, y }),
        };
        return new sandbox.window.RDInput(canvas, renderer, sendMessage);
    }

    return { sandbox, document, win, makeInput };
}

describe('RDKeyboardScancode', () => {
    let RDKeyboardScancode;

    beforeAll(() => {
        const sandbox = loadBrowserScripts(['public/js/rdclient/keyboard-scancode.js'], {});
        RDKeyboardScancode = sandbox.RDKeyboardScancode;
    });

    it('maps Digit1 and KeyN to distinct Windows scancodes', () => {
        expect(RDKeyboardScancode.codeToScancode('Digit1', 'Windows')).toBe(0x02);
        expect(RDKeyboardScancode.codeToScancode('KeyN', 'Windows')).toBe(0x31);
    });
});

describe('RDInput keyboard release sync', () => {
    let makeInput;
    let RDInput;

    beforeAll(() => {
        const harness = makeInputHarness({});
        makeInput = harness.makeInput;
        RDInput = harness.sandbox.window.RDInput;
    });

    it('sends keyup for held keys when stop() is called', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.start();

        input._handleKeyDown({
            code: 'ShiftLeft',
            key: 'Shift',
            repeat: false,
            preventDefault() {},
            stopPropagation() {},
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            shiftKey: true,
        });
        input._handleKeyDown({
            code: 'KeyA',
            key: 'a',
            repeat: false,
            preventDefault() {},
            stopPropagation() {},
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            shiftKey: true,
        });

        sent.length = 0;
        input.stop();

        const keyups = sent.filter((m) => m.keyEvent && m.keyEvent.down === false);
        expect(keyups.length).toBeGreaterThanOrEqual(2);
        expect(input.pressedKeys.size).toBe(0);
    });

    it('releases keys on window blur while capture is active', () => {
        const sent = [];
        const harness = makeInputHarness({});
        const input = harness.makeInput((msg) => sent.push(msg));
        input.start();
        input._handleKeyDown({
            code: 'ControlLeft',
            key: 'Control',
            repeat: false,
            preventDefault() {},
            stopPropagation() {},
            ctrlKey: true,
            altKey: false,
            metaKey: false,
            shiftKey: false,
        });

        sent.length = 0;
        harness.win._dispatch('blur', new Event('blur'));

        expect(sent.some((m) => m.keyEvent && m.keyEvent.down === false)).toBe(true);
        expect(input.pressedKeys.size).toBe(0);
    });

    it('resetKeyboard() releases modifier keys on the remote', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.start();
        input.setPeerPlatform('Windows');
        input.setKeyboardMode('Legacy');

        sent.length = 0;
        input.resetKeyboard();

        const releases = sent.filter((m) =>
            m.keyEvent &&
            m.keyEvent.down === false &&
            m.keyEvent.controlKey
        );
        expect(releases.length).toBeGreaterThanOrEqual(4);
    });

    it('stop() does not blast unpressed modifiers', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.start();
        sent.length = 0;
        input.stop();
        const releases = sent.filter((m) => m.keyEvent && m.keyEvent.down === false);
        expect(releases.length).toBe(0);
    });
});

describe('RDInput KeyboardMode.Map', () => {
    let makeInput;

    beforeAll(() => {
        ({ makeInput } = makeInputHarness({}));
    });

    it('Auto mode uses Map scancode for letters on Windows peers', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.setPeerPlatform('Windows');
        input.setKeyboardMode('Auto');
        input.start();

        input._handleKeyDown({
            code: 'KeyA',
            key: 'a',
            repeat: false,
            preventDefault() {},
            stopPropagation() {},
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            shiftKey: false,
        });

        expect(sent[0].keyEvent.mode).toBe('Map');
        expect(sent[0].keyEvent.chr).toBe(0x1E);
    });

    it('Auto mode uses Legacy chr for Shift+digit symbols on Windows', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.setPeerPlatform('Windows');
        input.setKeyboardMode('Auto');
        input.start();

        input._handleKeyDown({
            code: 'Digit7',
            key: '&',
            repeat: false,
            preventDefault() {},
            stopPropagation() {},
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            shiftKey: true,
        });

        expect(sent[0].keyEvent.mode).toBe('Legacy');
        expect(sent[0].keyEvent.chr).toBe('&'.codePointAt(0));
        expect(sent[0].keyEvent.modifiers).not.toContain(29);
    });

    it('Legacy mode sends character chr for printable keys', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.setPeerPlatform('Linux');
        input.setKeyboardMode('Legacy');
        input.start();

        input._handleKeyDown({
            code: 'Digit1',
            key: '1',
            repeat: false,
            preventDefault() {},
            stopPropagation() {},
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            shiftKey: false,
        });

        expect(sent[0].keyEvent.mode).toBe('Legacy');
        expect(sent[0].keyEvent.chr).toBe(49);
    });

    it('Auto mode sends Legacy controlKey for Shift', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.setPeerPlatform('Windows');
        input.setKeyboardMode('Auto');
        input.start();

        input._handleKeyDown({
            code: 'ShiftLeft',
            key: 'Shift',
            repeat: false,
            preventDefault() {},
            stopPropagation() {},
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            shiftKey: false,
        });

        expect(sent[0].keyEvent.mode).toBe('Legacy');
        expect(sent[0].keyEvent.controlKey).toBe('Shift');
    });

    it('includes CapsLock modifier on Map letter keys when Caps is on', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.setPeerPlatform('Windows');
        input.setKeyboardMode('Auto');
        input.start();

        input._handleKeyDown({
            code: 'KeyA',
            key: 'a',
            repeat: false,
            preventDefault() {},
            stopPropagation() {},
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            shiftKey: false,
            getModifierState(state) {
                return state === 'CapsLock';
            },
        });

        expect(sent[0].keyEvent.mode).toBe('Map');
        expect(sent[0].keyEvent.modifiers).toContain(3);
    });

    it('Legacy mode uppercases letters when CapsLock is on', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.setKeyboardMode('Legacy');
        input.start();

        input._handleKeyDown({
            code: 'KeyA',
            key: 'a',
            repeat: false,
            preventDefault() {},
            stopPropagation() {},
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            shiftKey: false,
            getModifierState(state) {
                return state === 'CapsLock';
            },
        });

        expect(sent[0].keyEvent.chr).toBe(65);
    });
});
