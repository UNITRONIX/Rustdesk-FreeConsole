import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

const [payloadUrl, expectedBuildId, outputPath = '.betterdesk-build/payload.json'] = process.argv.slice(2);
const privateKey = process.env.REAL_CLIENT_PAYLOAD_PRIVATE_KEY;
const expectedOrigin = process.env.BETTERDESK_PAYLOAD_ORIGIN || '';

function fail(message) {
    process.stderr.write(`Real Client payload error: ${message}\n`);
    process.exit(1);
}

if (!payloadUrl || !expectedBuildId || !privateKey || !expectedOrigin) fail('URL, build ID, private-key secret and trusted origin are required');
if (!/^[0-9a-f-]{36}$/i.test(expectedBuildId)) fail('invalid build ID');

let url;
try { url = new URL(payloadUrl); } catch { fail('invalid payload URL'); }
let trustedOrigin;
try { trustedOrigin = new URL(expectedOrigin); } catch { fail('trusted payload origin is invalid'); }
if (trustedOrigin.protocol !== 'https:' || trustedOrigin.username || trustedOrigin.password
    || trustedOrigin.pathname !== '/' || trustedOrigin.search || trustedOrigin.hash) fail('trusted payload origin must be an origin-only HTTPS URL');
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('payload URL must be credential-free HTTPS without query or fragment');
if (url.origin !== trustedOrigin.origin) fail('payload origin does not match BETTERDESK_PAYLOAD_ORIGIN');
if (url.pathname !== `/api/generator/real-client/payload/${expectedBuildId}`) fail('payload URL path does not match the expected build');

let response;
try {
    response = await fetch(url, {
        redirect: 'error',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(180000),
    });
} catch (_) {
    fail('download failed or timed out');
}
if (!response.ok) fail(`download returned HTTP ${response.status}`);
const length = Number(response.headers.get('content-length') || 0);
if (length && length > 45 * 1024 * 1024) fail('encrypted payload is too large');
const raw = Buffer.from(await response.arrayBuffer());
if (raw.length > 45 * 1024 * 1024) fail('encrypted payload is too large');

let envelope;
try { envelope = JSON.parse(raw.toString('utf8')); } catch { fail('invalid encrypted envelope JSON'); }
if (envelope.schema !== 'betterdesk-real-client-payload/v1'
    || envelope.key_algorithm !== 'RSA-OAEP-SHA256'
    || envelope.content_algorithm !== 'AES-256-GCM') fail('unsupported payload envelope');

let plaintext;
try {
    const aesKey = crypto.privateDecrypt({
        key: privateKey.replace(/\\n/g, '\n'),
        oaepHash: 'sha256',
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    }, Buffer.from(envelope.wrapped_key, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.auth_tag, 'base64'));
    plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
} catch { fail('payload authentication or decryption failed'); }

const digest = crypto.createHash('sha256').update(plaintext).digest('hex');
if (!/^[0-9a-f]{64}$/i.test(String(envelope.plaintext_sha256 || ''))
    || !crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(envelope.plaintext_sha256))) fail('payload digest mismatch');

let payload;
try { payload = JSON.parse(plaintext.toString('utf8')); } catch { fail('decrypted payload is not valid JSON'); }
if (payload.schema !== 'betterdesk-real-client-build/v1' || payload.build?.id !== expectedBuildId) fail('decrypted build identity mismatch');

await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true, mode: 0o700 });
await fs.writeFile(outputPath, plaintext, { flag: 'wx', mode: 0o600 });
process.stdout.write('Encrypted BetterDesk payload verified.\n');
