const { _relayFraming } = require('../services/wsRelay');

describe('wsRelay RustDesk message/TCP framing bridge', () => {
    test('round-trips fragmented BytesCodec frames at every header size', () => {
        const sizes = [1, 63, 64, 16383, 16384, 0x400000];
        const payloads = sizes.map((size, index) => Buffer.alloc(size, index + 1));
        const stream = Buffer.concat(payloads.map(_relayFraming.encodeRelayFrame));
        const decoder = _relayFraming.createRelayFrameDecoder();
        const decoded = [];

        // Deliberately split both headers and payloads across arbitrary TCP chunks.
        const chunkSizes = [1, 2, 7, 31, 257, 4096, 65535];
        let offset = 0;
        let chunkIndex = 0;
        while (offset < stream.length) {
            const end = Math.min(stream.length, offset + chunkSizes[chunkIndex % chunkSizes.length]);
            decoded.push(...decoder.feed(stream.subarray(offset, end)));
            offset = end;
            chunkIndex++;
        }

        expect(decoded).toHaveLength(payloads.length);
        decoded.forEach((payload, index) => expect(payload.equals(payloads[index])).toBe(true));
    });

    test('rejects empty WebSocket payloads instead of emitting invalid TCP frames', () => {
        expect(() => _relayFraming.encodeRelayFrame(Buffer.alloc(0))).toThrow('invalid relay frame size');
    });

    test('rejects an invalid zero-length TCP header', () => {
        const decoder = _relayFraming.createRelayFrameDecoder();
        expect(() => decoder.feed(Buffer.from([0]))).toThrow('invalid relay payload length');
    });
});
