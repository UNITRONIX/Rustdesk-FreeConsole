/**
 * Regression: Auth2FA must serialize under auth_2fa (not auth2Fa).
 * Wrong field names produce empty Message payloads — peer never receives the code.
 */
const protobuf = require('protobufjs');
const path = require('path');

describe('RDClient Auth2FA protobuf encoding', () => {
    let Message;

    beforeAll(async () => {
        const root = await protobuf.load([
            path.join(__dirname, '../protos/message.proto')
        ]);
        Message = root.lookupType('hbb.Message');
    });

    it('encodes auth_2fa with a non-empty payload', () => {
        const msg = Message.fromObject({ auth_2fa: { code: '741626' } });
        const buf = Message.encode(msg).finish();
        expect(buf.length).toBeGreaterThan(0);

        const decoded = Message.decode(buf).toJSON();
        expect(decoded.auth_2fa).toEqual({ code: '741626' });
    });

    it('does not encode auth2Fa camelCase alias (protobuf.js quirk)', () => {
        const msg = Message.fromObject({ auth2Fa: { code: '741626' } });
        const buf = Message.encode(msg).finish();
        expect(buf.length).toBe(0);
    });
});
