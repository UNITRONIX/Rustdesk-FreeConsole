'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

describe('write-installer-env-subst', () => {
    test('writes special characters without shell expansion or truncation', () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-installer-subst-'));
        const output = path.join(tmpRoot, 'subst.json');
        const env = {
            ...process.env,
            BD_SUBST_DEFAULT_ADMIN_PASSWORD: 'p@$$ word&"quoted"=value',
            BD_SUBST_DATABASE_URL: 'postgres://user:p%40ss@db:5432/betterdesk?sslmode=disable',
            BD_SUBST_SSL_KEY_PATH: 'C:\\BetterDesk\\ssl\\private key.pem',
        };

        try {
            execFileSync(process.execPath, [
                path.join(__dirname, '..', 'scripts', 'write-installer-env-subst.js'),
                output,
            ], { env, stdio: 'pipe' });

            const parsed = JSON.parse(fs.readFileSync(output, 'utf8'));
            expect(parsed.DEFAULT_ADMIN_PASSWORD).toBe(env.BD_SUBST_DEFAULT_ADMIN_PASSWORD);
            expect(parsed.DATABASE_URL).toBe(env.BD_SUBST_DATABASE_URL);
            expect(parsed.SSL_KEY_PATH).toBe(env.BD_SUBST_SSL_KEY_PATH);
            if (process.platform !== 'win32') {
                expect(fs.statSync(output).mode & 0o777).toBe(0o600);
            }
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });
});
