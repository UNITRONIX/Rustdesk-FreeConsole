'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const bootstrapScript = path.resolve(__dirname, '..', '..', 'docker', 'bootstrap-admin-credentials.sh');
const hasPosixShell = spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0;

function runBootstrap(env) {
    return new Promise((resolve, reject) => {
        const child = spawn('sh', ['-c', '. "$BOOTSTRAP_SCRIPT"; printf "%s\\n" "$INIT_ADMIN_PASS" > "$RESULT_FILE"'], {
            env: {
                ...process.env,
                ...env,
                BOOTSTRAP_SCRIPT: bootstrapScript,
            },
            stdio: 'ignore',
        });
        child.on('error', reject);
        child.on('close', code => resolve(code));
    });
}

(hasPosixShell ? describe : describe.skip)('Docker bootstrap admin credentials', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'betterdesk-bootstrap-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('concurrent split entrypoints elect one shared password', async () => {
        const jobs = Array.from({ length: 8 }, (_, index) => runBootstrap({
            RUSTDESK_PATH: tempDir,
            RESULT_FILE: path.join(tempDir, `result-${index}`),
            BOOTSTRAP_CREDENTIALS_WAIT_SECONDS: '10',
            INIT_ADMIN_PASS: '',
            DEFAULT_ADMIN_PASSWORD: '',
            ADMIN_PASSWORD: '',
        }));

        const codes = await Promise.all(jobs);
        expect(codes).toEqual(Array(8).fill(0));

        const passwords = codes.map((_, index) =>
            fs.readFileSync(path.join(tempDir, `result-${index}`), 'utf8').trim());
        expect(new Set(passwords).size).toBe(1);

        const credentials = fs.readFileSync(path.join(tempDir, '.admin_credentials'), 'utf8');
        expect(credentials).toContain(`Admin Password: ${passwords[0]}`);
        expect(fs.existsSync(path.join(tempDir, '.admin_credentials.lock'))).toBe(false);
    });

    test('reuses an existing credentials file without replacing it', async () => {
        const credentialsPath = path.join(tempDir, '.admin_credentials');
        const original = 'Admin Username: admin\nAdmin Password: existing-password\n';
        fs.writeFileSync(credentialsPath, original, { mode: 0o600 });

        const code = await runBootstrap({
            RUSTDESK_PATH: tempDir,
            RESULT_FILE: path.join(tempDir, 'result'),
            INIT_ADMIN_PASS: '',
            DEFAULT_ADMIN_PASSWORD: '',
            ADMIN_PASSWORD: '',
        });

        expect(code).toBe(0);
        expect(fs.readFileSync(path.join(tempDir, 'result'), 'utf8').trim()).toBe('existing-password');
        expect(fs.readFileSync(credentialsPath, 'utf8')).toBe(original);
    });
});
