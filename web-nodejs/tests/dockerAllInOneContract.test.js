'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');

describe('all-in-one Docker runtime contract', () => {
    test('defines every supervisord environment interpolation before launch', () => {
        const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
        const entrypoint = fs.readFileSync(path.join(root, 'docker/entrypoint.sh'), 'utf8');
        const supervisor = fs.readFileSync(path.join(root, 'docker/supervisord.conf'), 'utf8');

        expect(dockerfile).not.toContain('\\nENV');

        const referenced = [...supervisor.matchAll(/%\(ENV_([A-Z0-9_]+)\)s/g)]
            .map((match) => match[1]);
        expect(referenced.length).toBeGreaterThan(0);

        for (const name of new Set(referenced)) {
            const imageDefault = new RegExp(`^\\s*ENV\\s+${name}=`, 'm').test(dockerfile);
            const entrypointExport = new RegExp(`^\\s*export\\s+${name}=`, 'm').test(entrypoint);
            if (!imageDefault && !entrypointExport) {
                throw new Error(`Missing default or entrypoint export for supervisord variable ${name}`);
            }
        }
    });
});
