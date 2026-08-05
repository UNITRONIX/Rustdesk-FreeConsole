import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const [inputPath = '.betterdesk-build/input/custom-config.json', outputPath = '.betterdesk-build/input/custom_.txt', sourceRoot = '.'] = process.argv.slice(2);
const privatePem = String(process.env.REAL_CLIENT_CUSTOM_CONFIG_SIGNING_KEY || '').replace(/\\n/g, '\n');
if (!privatePem) throw new Error('REAL_CLIENT_CUSTOM_CONFIG_SIGNING_KEY is required');

const privateKey = crypto.createPrivateKey(privatePem);
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Custom configuration signing key must be Ed25519');
const publicJwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
if (!publicJwk.x) throw new Error('Could not derive Ed25519 public key');
const publicRaw = Buffer.from(publicJwk.x, 'base64url');
if (publicRaw.length !== 32) throw new Error('Derived Ed25519 public key has an invalid size');

const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
if (!input.custom || typeof input.custom !== 'object' || Array.isArray(input.custom)) throw new Error('Custom RustDesk configuration is missing');
const message = Buffer.from(JSON.stringify(input.custom), 'utf8');
const signature = crypto.sign(null, message, privateKey);
if (signature.length !== 64) throw new Error('Ed25519 signature has an invalid size');

// RustDesk verifies custom.txt with a built-in Ed25519 public key. Replace
// only the key local to read_custom_client(); verification remains enabled.
const commonPath = path.join(sourceRoot, 'src', 'common.rs');
let common = await fs.readFile(commonPath, 'utf8');
const functionOffset = common.indexOf('pub fn read_custom_client(config: &str)');
if (functionOffset < 0) throw new Error('RustDesk read_custom_client() was not found; source revision is incompatible');
const tail = common.slice(functionOffset);
const nextFunctionOffset = tail.slice(1).search(/\n(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+[A-Za-z0-9_]+\s*\(/);
const functionRegion = nextFunctionOffset < 0 ? tail : tail.slice(0, nextFunctionOffset + 1);
const keyMatches = [...functionRegion.matchAll(/const KEY: &str = "[A-Za-z0-9+/=]+";/g)];
if (keyMatches.length !== 1) throw new Error(`Expected exactly one RustDesk custom-client verification key; found ${keyMatches.length}`);
const keyMatch = keyMatches[0];
if (!keyMatch) throw new Error('RustDesk custom-client verification key was not found');
const absoluteOffset = functionOffset + keyMatch.index;
const replacement = `const KEY: &str = "${publicRaw.toString('base64')}";`;
const officialKey = 'const KEY: &str = "5Qbwsde3unUcJBtrx9ZkvUmwFNoExHzpryHuPUdqlWM=";';
if (keyMatch[0] !== officialKey && keyMatch[0] !== replacement) {
    throw new Error('RustDesk custom-client verification key is not the approved upstream key');
}
common = common.slice(0, absoluteOffset) + replacement + common.slice(absoluteOffset + keyMatch[0].length);
await fs.writeFile(outputPath, Buffer.concat([signature, message]).toString('base64'), { flag: 'wx', mode: 0o600 });
await fs.writeFile(commonPath, common, 'utf8');
process.stdout.write('RustDesk custom configuration signed; signature verification remains enabled.\n');
