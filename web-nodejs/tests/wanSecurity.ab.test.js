'use strict';

const { pathWhitelist } = require('../middleware/wanSecurity');

function run(method, path) {
    const req = { method, path };
    let status = 200;
    const res = {
        status(code) {
            status = code;
            return this;
        },
        end() {},
        json() {}
    };
    let nextCalled = false;
    pathWhitelist(req, res, () => { nextCalled = true; });
    return { status, nextCalled };
}

describe('wanSecurity shared AB whitelist', () => {
    it('allows Pro shared-AB endpoints', () => {
        for (const [method, path] of [
            ['POST', '/api/ab/settings'],
            ['POST', '/api/ab/shared/profiles'],
            ['POST', '/api/ab/peers'],
            ['POST', '/api/ab/tags/betterdesk-devices'],
            ['POST', '/api/ab/tags/6ba7b810-9dad-11d1-80b4-00c04fd430c8'],
            ['POST', '/api/ab/peer/add/betterdesk-devices'],
            ['PUT', '/api/ab/peer/update/betterdesk-devices'],
            ['DELETE', '/api/ab/peer/betterdesk-devices'],
        ]) {
            const { status, nextCalled } = run(method, path);
            expect(nextCalled).toBe(true);
            expect(status).toBe(200);
        }
    });

    it('still blocks unknown paths with empty 404', () => {
        const { status, nextCalled } = run('POST', '/api/ab/unknown');
        expect(nextCalled).toBe(false);
        expect(status).toBe(404);
    });
});
