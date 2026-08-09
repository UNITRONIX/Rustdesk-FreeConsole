/**
 * BetterDesk Console - RustDesk address book sync helper tests
 */

const sync = require('../services/rustdeskAddressBookSync');

describe('rustdeskAddressBookSync', () => {
    it('merges panel tags into existing address book peers without turning folders into tags', () => {
        const result = JSON.parse(sync.mergeAddressBookData(JSON.stringify({
            peers: [{ id: '123456789', tags: ['Existing'] }],
            tags: ['Existing']
        }), {
            devices: [
                { id: '123456789', hostname: 'PC-1', tags: ['Internal'], folder_id: 2 },
                { id: '987654321', hostname: 'PC-2', tags: 'External' }
            ],
            folders: [{ id: 2, name: 'Workstations' }],
            assignments: {},
            includeDevices: true
        }));

        expect(result.tags).toEqual(['Existing', 'Internal', 'External']);
        expect(result.peers).toHaveLength(2);
        expect(result.peers[0].tags).toEqual(['Existing', 'Internal']);
        expect(result.peers[1]).toMatchObject({
            id: '987654321',
            hostname: 'PC-2',
            tags: ['External']
        });
    });

    it('does not add new peers when includeDevices is false', () => {
        const result = JSON.parse(sync.mergeAddressBookData('{}', {
            devices: [{ id: '123456789', tags: ['Internal'] }],
            includeDevices: false
        }));

        expect(result.peers).toEqual([]);
        expect(result.tags).toEqual([]);
    });

    it('preserves address book tags that share names with folders', () => {
        const result = JSON.parse(sync.mergeAddressBookData(JSON.stringify({
            peers: [{ id: '123456789', tags: ['Servers', 'Windows'] }],
            tags: ['Servers', 'Windows']
        }), {
            devices: [{ id: '123456789', tags: ['Servers', 'Internal'] }],
            folders: [{ id: 1, name: 'Servers' }],
            includeDevices: false
        }));

        expect(result.tags).toEqual(['Servers', 'Windows', 'Internal']);
        expect(result.peers[0].tags).toEqual(['Servers', 'Windows', 'Internal']);
    });

    it('keeps visible device tags even when a folder has the same name', () => {
        const tags = sync.collectVisibleTags(
            [{ id: '123456789', tags: ['Servers'], folder_id: 1 }],
            [{ id: 1, name: 'Servers' }],
            { '123456789': 1 }
        );

        expect(tags).toEqual(['Servers']);
    });

    it('collects a sorted unique tag list for suggestions', () => {
        const tags = sync.collectVisibleTags(
            [
                { id: '123456789', tags: ['Internal', 'Windows'] },
                { id: '987654321', tags: 'External, Windows', folder_id: 4 }
            ],
            [{ id: 4, name: 'Laptops' }],
            {}
        );

        expect(tags).toEqual(['External', 'Internal', 'Windows']);
    });

    it('extracts peer tag updates from client address book data', () => {
        const updates = sync.collectPeerTagUpdates(JSON.stringify({
            peers: [
                { id: '123456789', tags: ['Client', 'Windows', 'Servers'] },
                { id: '987654321' }
            ],
            tags: ['Client']
        }), { folders: [{ id: 1, name: 'Servers' }] });

        expect(updates).toEqual([
            { id: '123456789', tags: ['Client', 'Windows', 'Servers'] }
        ]);
    });

    it('filters known out-of-scope peers while keeping typed remote IDs', () => {
        const result = JSON.parse(sync.filterAddressBookPeersByScope(JSON.stringify({
            peers: [
                { id: 'ALLOW1', alias: 'Ok' },
                { id: 'DENY1', alias: 'Hidden' },
                { id: 'REMOTE', alias: 'Typed' }
            ],
            tags: ['X']
        }), {
            visibleIds: new Set(['ALLOW1']),
            knownDeviceIds: ['ALLOW1', 'DENY1']
        }));

        expect(result.peers.map(p => p.id)).toEqual(['ALLOW1', 'REMOTE']);
    });

    it('allowlist-only when knownDeviceIds is empty (no fail-open)', () => {
        const result = JSON.parse(sync.filterAddressBookPeersByScope(JSON.stringify({
            peers: [
                { id: 'ALLOW1' },
                { id: 'DENY1' },
                { id: 'REMOTE' }
            ],
            tags: []
        }), {
            visibleIds: new Set(['ALLOW1']),
            knownDeviceIds: []
        }));

        expect(result.peers.map(p => p.id)).toEqual(['ALLOW1']);
    });

    it('maps panel display_name to alias and hides hostname on the card', () => {
        const result = JSON.parse(sync.mergeAddressBookData(JSON.stringify({
            peers: [{ id: '1031876693', hostname: 'dcstrainingserver', note: 'Training', tags: [] }],
            tags: []
        }), {
            devices: [{
                id: '1031876693',
                hostname: 'dcstrainingserver',
                display_name: 'Training',
                note: 'Training',
                tags: []
            }],
            includeDevices: false
        }));

        expect(result.peers[0]).toMatchObject({
            id: '1031876693',
            alias: 'Training',
            hostname: '',
            username: '',
            note: ''
        });
    });

    it('uses device note as alias when display_name is empty', () => {
        const result = JSON.parse(sync.mergeAddressBookData(JSON.stringify({
            peers: [{ id: '1', tags: [] }],
            tags: []
        }), {
            devices: [{ id: '1', hostname: 'pc-1', note: 'Front desk', tags: [] }],
            includeDevices: false
        }));

        expect(result.peers[0]).toMatchObject({
            id: '1',
            alias: 'Front desk',
            hostname: ''
        });
        expect(result.peers[0].note || '').toBe('');
    });

    it('keeps hostname when the panel has no display label', () => {
        const result = JSON.parse(sync.mergeAddressBookData(JSON.stringify({
            peers: [{ id: '1', tags: [] }],
            tags: []
        }), {
            devices: [{ id: '1', hostname: 'pc-1', username: 'alice', tags: [] }],
            includeDevices: false
        }));

        expect(result.peers[0]).toMatchObject({
            id: '1',
            hostname: 'pc-1',
            username: 'alice'
        });
        expect(result.peers[0].alias).toBeUndefined();
    });
});
