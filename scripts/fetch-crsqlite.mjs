#!/usr/bin/env node
// Downloads the cr-sqlite v0.16.3 loadable extension for this OS/CPU into
// vendor/crsqlite/. Binaries are never committed (see .gitignore).
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const VERSION = 'v0.16.3';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'vendor', 'crsqlite');
const want = {
  'win32-x64': ['win', 'x86_64'],
  'linux-x64': ['linux', 'x86_64'],
  'linux-arm64': ['linux', 'aarch64'],
  'darwin-arm64': ['darwin', 'aarch64'],
  'darwin-x64': ['darwin', 'x86_64'],
}[`${process.platform}-${process.arch}`];
if (!want) { console.error(`no cr-sqlite build known for ${process.platform}-${process.arch}`); process.exit(1); }

// Exact asset name, never a substring match: "win" is inside "darwin", so
// matching by parts picked the macOS zip on Windows.
const name = `crsqlite-${want.join('-')}.zip`;
const url = `https://github.com/vlcn-io/cr-sqlite/releases/download/${VERSION}/${name}`;

mkdirSync(out, { recursive: true });
const zip = join(out, name);
const res = await fetch(url);
if (!res.ok) { console.error(`download failed (${res.status}): ${url}`); process.exit(1); }
writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
// Windows: call the OS tar by full path. Under `npm run` from Git Bash, plain
// `tar` is GNU tar, which reads "C:\..." as host "C" and fails.
if (process.platform === 'win32') {
  execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', out]);
} else execFileSync('unzip', ['-o', zip, '-d', out]);
rmSync(zip);
const lib = readdirSync(out).find((f) => /^crsqlite\.(dll|so|dylib)$/.test(f));
if (!lib || !existsSync(join(out, lib))) { console.error('extracted, but no crsqlite.(dll|so|dylib) found in ' + out); process.exit(1); }
console.log(`cr-sqlite ${VERSION} -> ${join(out, lib)}`);
