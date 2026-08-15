'use strict';

const http = require('http');
const {
    checkEndpoint,
    checkPort,
    checkCertificateHostname,
} = require('../../scripts/installer-protocol-check');

describe('installer protocol check', () => {
    let server;
    let port;

    beforeAll(async () => {
        server = http.createServer((request, response) => {
            if (request.url === '/redirect') {
                response.writeHead(302, { Location: '/health' });
                response.end();
                return;
            }
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end('{"status":"ok"}');
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
    });

    test('accepts health responses and reports redirects', async () => {
        await expect(checkEndpoint(`http://127.0.0.1:${port}/health`))
            .resolves.toMatchObject({ ok: true, statusCode: 200 });
        await expect(checkEndpoint(`http://127.0.0.1:${port}/redirect`))
            .resolves.toMatchObject({ ok: true, statusCode: 302, redirect: '/health' });
    });

    test('checks TCP listeners and certificate SAN matching', async () => {
        await expect(checkPort(`127.0.0.1:${port}`))
            .resolves.toMatchObject({ ok: true });
        expect(checkCertificateHostname({ subjectaltname: 'DNS:panel.example.test' }, 'panel.example.test'))
            .toBe(true);
        expect(checkCertificateHostname({ subjectaltname: 'DNS:other.example.test' }, 'panel.example.test'))
            .toBe(false);
    });
});
