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
        'public/js/rdclient/keyboard-encoder.js',
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

function keyEvt(base) {
    return {
        repeat: false,
        preventDefault() {},
        stopPropagation() {},
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        getModifierState() { return false; },
        ...base,
    };
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

describe('RDKeyboardEncoder parity', () => {
    let RDKeyboardEncoder;

    beforeAll(() => {
        const sandbox = loadBrowserScripts([
            'public/js/rdclient/keyboard-scancode.js',
            'public/js/rdclient/keyboard-encoder.js',
        ], {});
        RDKeyboardEncoder = sandbox.RDKeyboardEncoder;
    });

    it('Auto resolves to Map wire mode', () => {
        expect(RDKeyboardEncoder.resolveWireMode('Auto')).toBe('Map');
    });

    it('legacyModifiers excludes self on ShiftLeft', () => {
        const mods = RDKeyboardEncoder.legacyModifiers('ShiftLeft', {
            shift: true, ctrl: false, alt: false, meta: false,
        });
        expect(mods).not.toContain(29);
    });

    it('Legacy Shift+A → chr 97 + Shift modifier', () => {
        const evt = RDKeyboardEncoder.encodeKeyEvent({
            code: 'KeyA',
            key: 'A',
            down: true,
            press: false,
            keyboardMode: 'Legacy',
            pressedCodes: new Set(['ShiftLeft']),
        });
        expect(evt.mode).toBe('Legacy');
        expect(evt.chr).toBe(97);
        expect(evt.modifiers).toContain(29);
    });

    it('Map Shift+7 → scancode 0x08, no Shift in modifiers', () => {
        const evt = RDKeyboardEncoder.encodeKeyEvent({
            code: 'Digit7',
            key: '&',
            down: true,
            press: false,
            keyboardMode: 'Map',
            peerPlatform: 'Windows',
            pressedCodes: new Set(['ShiftLeft']),
            scancodeLib: RDKeyboardEncoder._getScancodeLib(),
        });
        expect(evt.mode).toBe('Map');
        expect(evt.chr).toBe(0x08);
        expect(evt.modifiers).not.toContain(29);
    });

    it('CapsLock key alone produces no event', () => {
        const evt = RDKeyboardEncoder.encodeKeyEvent({
            code: 'CapsLock',
            key: 'CapsLock',
            down: true,
            press: false,
            keyboardMode: 'Legacy',
            pressedCodes: new Set(),
        });
        expect(evt).toBeNull();
    });

    it('Legacy Caps+A → chr 97 + CapsLock modifier', () => {
        const evt = RDKeyboardEncoder.encodeKeyEvent({
            code: 'KeyA',
            key: 'a',
            down: true,
            press: false,
            e: { getModifierState(s) { return s === 'CapsLock'; } },
            keyboardMode: 'Legacy',
            pressedCodes: new Set(),
        });
        expect(evt.chr).toBe(97);
        expect(evt.modifiers).toContain(3);
        expect(evt.modifiers).not.toContain(29);
    });
});

describe('RDInput keyboard release sync', () => {
    let makeInput;

    beforeAll(() => {
        ({ makeInput } = makeInputHarness({}));
    });

    it('sends keyup for held keys when stop() is called', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.start();

        input._handleKeyDown(keyEvt({
            code: 'ShiftLeft',
            key: 'Shift',
            shiftKey: true,
        }));
        input._handleKeyDown(keyEvt({
            code: 'KeyA',
            key: 'a',
            shiftKey: true,
        }));

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
        input._handleKeyDown(keyEvt({
            code: 'ControlLeft',
            key: 'Control',
            ctrlKey: true,
        }));

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

describe('RDInput keyboard parity (RustDesk contract)', () => {
    let makeInput;

    beforeAll(() => {
        ({ makeInput } = makeInputHarness({}));
    });

    it('ShiftLeft down (real DOM shiftKey) has no Shift in modifiers', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.setPeerPlatform('Windows');
        input.setKeyboardMode('Auto');
        input.start();

        input._handleKeyDown(keyEvt({
            code: 'ShiftLeft',
            key: 'Shift',
            shiftKey: true,
        }));

        expect(sent[0].keyEvent.mode).toBe('Legacy');
        expect(sent[0].keyEvent.controlKey).toBe('Shift');
        expect(sent[0].keyEvent.modifiers).not.toContain(29);
    });

    it('Auto/Windows Shift+A → Map scancode without Shift modifier', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.setPeerPlatform('Windows');
        input.setKeyboardMode('Auto');
        input.start();

        input._handleKeyDown(keyEvt({
            code: 'ShiftLeft',
            key: 'Shift',
            shiftKey: true,
        }));
        input._handleKeyDown(keyEvt({
            code: 'KeyA',
            key: 'A',
            shiftKey: true,
        }));

        const letter = sent.find((m) => m.keyEvent && m.keyEvent.chr === 0x1E);
        expect(letter).toBeDefined();
        expect(letter.keyEvent.mode).toBe('Map');
        expect(letter.keyEvent.modifiers).not.toContain(29);
    });

    it('Legacy Shift+A → lowercase chr + Shift modifier', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.setKeyboardMode('Legacy');
        input.start();

        input._handleKeyDown(keyEvt({
            code: 'ShiftLeft',
            key: 'Shift',
            shiftKey: true,
        }));
        input._handleKeyDown(keyEvt({
            code: 'KeyA',
            key: 'A',
            shiftKey: true,
        }));

        const letter = sent.find((m) => m.keyEvent && m.keyEvent.chr === 97);
        expect(letter).toBeDefined();
        expect(letter.keyEvent.mode).toBe('Legacy');
        expect(letter.keyEvent.modifiers).toContain(29);
    });

    it('Auto/Map Shift+7 uses Map scancode not Legacy chr', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.setPeerPlatform('Windows');
        input.setKeyboardMode('Auto');
        input.start();

        input._handleKeyDown(keyEvt({
            code: 'ShiftLeft',
            key: 'Shift',
            shiftKey: true,
        }));
        input._handleKeyDown(keyEvt({
            code: 'Digit7',
            key: '&',
            shiftKey: true,
        }));

        const digit = sent.find((m) => m.keyEvent && m.keyEvent.chr === 0x08);
        expect(digit).toBeDefined();
        expect(digit.keyEvent.mode).toBe('Map');
        expect(digit.keyEvent.modifiers).not.toContain(29);
    });

    it('Auto mode uses Map scancode for letters on Windows peers', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.setPeerPlatform('Windows');
        input.setKeyboardMode('Auto');
        input.start();

        input._handleKeyDown(keyEvt({ code: 'KeyA', key: 'a' }));

        expect(sent[0].keyEvent.mode).toBe('Map');
        expect(sent[0].keyEvent.chr).toBe(0x1E);
    });

    it('Legacy mode sends lowercase chr for letters', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.setKeyboardMode('Legacy');
        input.start();

        input._handleKeyDown(keyEvt({
            code: 'KeyA',
            key: 'a',
            getModifierState(state) {
                return state === 'CapsLock';
            },
        }));

        expect(sent[0].keyEvent.mode).toBe('Legacy');
        expect(sent[0].keyEvent.chr).toBe(97);
        expect(sent[0].keyEvent.modifiers).toContain(3);
    });

    it('Legacy mode sends digit chr for Digit1', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.setPeerPlatform('Linux');
        input.setKeyboardMode('Legacy');
        input.start();

        input._handleKeyDown(keyEvt({ code: 'Digit1', key: '1' }));

        expect(sent[0].keyEvent.mode).toBe('Legacy');
        expect(sent[0].keyEvent.chr).toBe(49);
    });

    it('CapsLock key alone sends no wire event', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.setKeyboardMode('Auto');
        input.start();

        input._handleKeyDown(keyEvt({ code: 'CapsLock', key: 'CapsLock' }));

        expect(sent.length).toBe(0);
    });

    it('includes CapsLock modifier on Map letter keys when Caps is on', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.setPeerPlatform('Windows');
        input.setKeyboardMode('Auto');
        input.start();

        input._handleKeyDown(keyEvt({
            code: 'KeyA',
            key: 'a',
            getModifierState(state) {
                return state === 'CapsLock';
            },
        }));

        expect(sent[0].keyEvent.mode).toBe('Map');
        expect(sent[0].keyEvent.modifiers).toContain(3);
        expect(sent[0].keyEvent.modifiers).not.toContain(29);
    });
});
