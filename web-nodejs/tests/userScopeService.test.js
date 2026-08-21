/**
 * User scope — peer grant sync fail-closed behaviour (Issue #380 follow-up)
 */

const userScopeService = require('../services/userScopeService');

describe('userScopeService peer grants', () => {
    it('syncUserPeerGrants persists normalized peer ids', async () => {
        const db = {
            setUserPeerGrants: jest.fn().mockResolvedValue(['a', 'b']),
            getPeerById: jest.fn().mockResolvedValue({ id: 'a' }),
        };

        const result = await userScopeService.syncUserPeerGrants(db, 7, [' a ', 'b', 'a', '']);

        expect(db.setUserPeerGrants).toHaveBeenCalledWith(7, ['a', 'b']);
        expect(result).toEqual(['a', 'b']);
    });

    it('syncUserPeerGrants fails closed when setter is missing', async () => {
        await expect(userScopeService.syncUserPeerGrants({}, 7, ['123']))
            .rejects.toMatchObject({
                code: 'PEER_GRANTS_UNAVAILABLE',
                status: 500,
            });
    });

    it('getUserPeerGrantIds soft-fails to [] when getter is missing', async () => {
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(userScopeService.getUserPeerGrantIds({}, 7)).resolves.toEqual([]);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    it('warnUnknownPeerIds never throws and logs unknown devices', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const db = {
            getPeerById: jest.fn()
                .mockResolvedValueOnce({ id: '1' })
                .mockResolvedValueOnce(null),
        };

        await expect(userScopeService.warnUnknownPeerIds(db, ['1', 'missing'])).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown device id: missing'));
        warn.mockRestore();
    });
});
