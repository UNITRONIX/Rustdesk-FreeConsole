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

    it('shouldUseMapScancode: Auto/Windows letters and modifiers use Map', () => {
        const scLib = RDKeyboardEncoder._getScancodeLib();
        const empty = { shift: false, ctrl: false, alt: false, meta: false };
        expect(RDKeyboardEncoder.shouldUseMapScancode(
            'KeyA', 'Auto', 'Windows', empty, scLib
        )).toBe(true);
        expect(RDKeyboardEncoder.shouldUseMapScancode(
            'ShiftLeft', 'Auto', 'Windows', empty, scLib
        )).toBe(true);
        expect(RDKeyboardEncoder.shouldUseMapScancode(
            'Digit7', 'Auto', 'Windows', empty, scLib
        )).toBe(false);
    });

    it('shouldUseMapScancode: Auto/Linux uses Legacy for letters', () => {
        const scLib = RDKeyboardEncoder._getScancodeLib();
        const empty = { shift: false, ctrl: false, alt: false, meta: false };
        expect(RDKeyboardEncoder.shouldUseMapScancode(
            'KeyA', 'Auto', 'Linux', empty, scLib
        )).toBe(false);
    });

    it('Map mode ShiftLeft → scancode 0x2A', () => {
        const evt = RDKeyboardEncoder.encodeKeyEvent({
            code: 'ShiftLeft',
            key: 'Shift',
            down: true,
            press: false,
            keyboardMode: 'Map',
            peerPlatform: 'Windows',
            pressedCodes: new Set(['ShiftLeft']),
            scancodeLib: RDKeyboardEncoder._getScancodeLib(),
        });
        expect(evt.mode).toBe('Map');
        expect(evt.chr).toBe(0x2A);
        expect(evt.controlKey).toBeUndefined();
    });

    it('Map mode ControlLeft → scancode 0x1D', () => {
        const evt = RDKeyboardEncoder.encodeKeyEvent({
            code: 'ControlLeft',
            key: 'Control',
            down: true,
            press: false,
            keyboardMode: 'Map',
            peerPlatform: 'Windows',
            pressedCodes: new Set(['ControlLeft']),
            scancodeLib: RDKeyboardEncoder._getScancodeLib(),
        });
        expect(evt.mode).toBe('Map');
        expect(evt.chr).toBe(0x1D);
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

    it('Auto/Windows unshifted Digit7 → Legacy chr 55', () => {
        const evt = RDKeyboardEncoder.encodeKeyEvent({
            code: 'Digit7',
            key: '7',
            down: true,
            press: false,
            keyboardMode: 'Auto',
            peerPlatform: 'Windows',
            pressedCodes: new Set(),
            scancodeLib: RDKeyboardEncoder._getScancodeLib(),
        });
        expect(evt.mode).toBe('Legacy');
        expect(evt.chr).toBe(55);
    });

    it('Legacy Polish character uses e.key codepoint', () => {
        const evt = RDKeyboardEncoder.encodeKeyEvent({
            code: 'KeyA',
            key: 'ą',
            down: true,
            press: false,
            e: { key: 'ą', code: 'KeyA', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false },
            keyboardMode: 'Legacy',
            pressedCodes: new Set(),
        });
        expect(evt.mode).toBe('Legacy');
        expect(evt.chr).toBe('ą'.codePointAt(0));
    });

    it('Legacy Norwegian symbol keys use e.key not US LEGACY_CHAR_MAP', () => {
        // Physical Slash produces '-' on Norwegian QWERTY; map would wrongly send '/'.
        const hyphen = RDKeyboardEncoder.encodeKeyEvent({
            code: 'Slash',
            key: '-',
            down: true,
            press: false,
            e: { key: '-', code: 'Slash', shiftKey: false },
            keyboardMode: 'Legacy',
            pressedCodes: new Set(),
        });
        expect(hyphen.mode).toBe('Legacy');
        expect(hyphen.chr).toBe('-'.codePointAt(0));

        // Physical Minus produces '+' on Norwegian; map would wrongly send '-'.
        const plus = RDKeyboardEncoder.encodeKeyEvent({
            code: 'Minus',
            key: '+',
            down: true,
            press: false,
            e: { key: '+', code: 'Minus', shiftKey: false },
            keyboardMode: 'Legacy',
            pressedCodes: new Set(),
        });
        expect(plus.chr).toBe('+'.codePointAt(0));

        // Physical Equal often produces '\\' on Norwegian; map would send '='.
        const backslash = RDKeyboardEncoder.encodeKeyEvent({
            code: 'Equal',
            key: '\\',
            down: true,
            press: false,
            e: { key: '\\', code: 'Equal', shiftKey: false },
            keyboardMode: 'Legacy',
            pressedCodes: new Set(),
        });
        expect(backslash.chr).toBe('\\'.codePointAt(0));

        // Shift+, → ';' on Norwegian (and US); must not force unshifted ','.
        const semicolon = RDKeyboardEncoder.encodeKeyEvent({
            code: 'Comma',
            key: ';',
            down: true,
            press: false,
            e: { key: ';', code: 'Comma', shiftKey: true },
            keyboardMode: 'Legacy',
            pressedCodes: new Set(['ShiftLeft']),
        });
        expect(semicolon.chr).toBe(';'.codePointAt(0));
    });

    it('Legacy Caps+A → uppercase chr when Caps Lock is on', () => {
        const evt = RDKeyboardEncoder.encodeKeyEvent({
            code: 'KeyA',
            key: 'a',
            down: true,
            press: false,
            e: {
                key: 'a',
                code: 'KeyA',
                shiftKey: false,
                getModifierState(s) { return s === 'CapsLock'; },
            },
            keyboardMode: 'Legacy',
            pressedCodes: new Set(),
        });
        expect(evt.chr).toBe(65);
        expect(evt.modifiers).not.toContain(3);
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

    it('resetKeyboard() in Auto/Windows releases Map scancode keyups', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.start();
        input.setPeerPlatform('Windows');
        input.setKeyboardMode('Auto');

        sent.length = 0;
        input.resetKeyboard();

        const mapReleases = sent.filter((m) =>
            m.keyEvent &&
            m.keyEvent.down === false &&
            m.keyEvent.mode === 'Map' &&
            m.keyEvent.chr != null
        );
        expect(mapReleases.length).toBeGreaterThanOrEqual(4);
    });

    it('resetKeyboard() in Legacy releases controlKey keyups', () => {
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

    it('releases keys on visibilitychange when tab is hidden', () => {
        const sent = [];
        const harness = makeInputHarness({});
        const input = harness.makeInput((msg) => sent.push(msg));
        input.start();
        input._handleKeyDown(keyEvt({
            code: 'ShiftLeft',
            key: 'Shift',
            shiftKey: true,
        }));

        sent.length = 0;
        harness.document.visibilityState = 'hidden';
        harness.document._dispatch('visibilitychange', new Event('visibilitychange'));

        expect(sent.some((m) => m.keyEvent && m.keyEvent.down === false)).toBe(true);
        expect(input.pressedKeys.size).toBe(0);
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

    it('ShiftLeft down in Auto/Windows → Map scancode 0x2A', () => {
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

        expect(sent[0].keyEvent.mode).toBe('Map');
        expect(sent[0].keyEvent.chr).toBe(0x2A);
        expect(sent[0].keyEvent.controlKey).toBeUndefined();
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

    it('Legacy Shift+A → resolved uppercase chr without Shift modifier', () => {
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

        const letter = sent.find((m) => m.keyEvent && m.keyEvent.chr === 65);
        expect(letter).toBeDefined();
        expect(letter.keyEvent.mode).toBe('Legacy');
        expect(letter.keyEvent.modifiers).not.toContain(29);
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

    it('Auto/Windows unshifted Digit7 → Legacy chr 55', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.setPeerPlatform('Windows');
        input.setKeyboardMode('Auto');
        input.start();

        input._handleKeyDown(keyEvt({ code: 'Digit7', key: '7' }));

        expect(sent[0].keyEvent.mode).toBe('Legacy');
        expect(sent[0].keyEvent.chr).toBe(55);
    });

    it('Auto/Linux KeyA → Legacy chr (not Map)', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.setPeerPlatform('Linux');
        input.setKeyboardMode('Auto');
        input.start();

        input._handleKeyDown(keyEvt({ code: 'KeyA', key: 'a' }));

        expect(sent[0].keyEvent.mode).toBe('Legacy');
        expect(sent[0].keyEvent.chr).toBe(97);
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

    it('Legacy mode sends resolved case for letters with Caps Lock', () => {
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
        expect(sent[0].keyEvent.chr).toBe(65);
        expect(sent[0].keyEvent.modifiers).not.toContain(3);
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

    it('maps Pause to Windows extended scancode 0xE046', () => {
        const sent = [];
        const input = makeInput((msg) => sent.push(msg));
        input.setPeerPlatform('Windows');
        input.setKeyboardMode('Map');
        input.start();

        input._handleKeyDown(keyEvt({ code: 'Pause', key: 'Pause' }));

        expect(sent[0].keyEvent.mode).toBe('Map');
        expect(sent[0].keyEvent.chr).toBe(0xE046);
    });

    it('maps Delete and Pause to distinct Linux scancodes', () => {
        const sc = loadBrowserScripts(['public/js/rdclient/keyboard-scancode.js']);
        const codeToScancode = sc.RDKeyboardScancode.codeToScancode;
        expect(codeToScancode('Delete', 'Linux')).toBe(111);
        expect(codeToScancode('Pause', 'Linux')).toBe(119);
    });
});
