import fs from 'node:fs/promises';
import path from 'node:path';

const [target, outputDir = '.betterdesk-build/out'] = process.argv.slice(2);
const extensions = {
    'windows-x64-exe': '.exe', 'windows-x64-msi': '.msi', 'windows-x86-exe': '.exe',
    'linux-x64-deb': '.deb', 'linux-x64-appimage': '.appimage', 'linux-x64-flatpak': '.flatpak',
    'linux-arm64-deb': '.deb', 'linux-arm64-appimage': '.appimage', 'linux-arm64-flatpak': '.flatpak',
    'android-arm64-apk': '.apk', 'android-armv7-apk': '.apk', 'android-x64-apk': '.apk',
    'macos-x64-dmg': '.dmg', 'macos-arm64-dmg': '.dmg',
};
const expected = extensions[target];
if (!expected) throw new Error(`Target is not allow-listed: ${target}`);
const names = await fs.readdir(outputDir);
if (names.length !== 1) throw new Error(`Expected exactly one output file, found ${names.length}`);
const name = names[0];
if (name !== path.basename(name) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error('Output filename is unsafe');
if (!name.toLowerCase().endsWith(expected)) throw new Error(`Target ${target} requires a ${expected} artifact`);
const stat = await fs.lstat(path.join(outputDir, name));
if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 2 * 1024 * 1024 * 1024) throw new Error('Output file type or size is invalid');
process.stdout.write(`Validated one ${expected} build artifact.\n`);
