#!/usr/bin/env node
// Downloads the cr-sqlite v0.16.3 loadable extension for this OS/CPU into
// vendor/crsqlite/. Binaries are never committed (see .gitignore).
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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

// The API lookup can be blocked (proxies, rate limits); fall back to the
// predictable release-asset URL.
let asset;
try {
  const rel = await (await fetch(`https://api.github.com/repos/vlcn-io/cr-sqlite/releases/tags/${VERSION}`,
    { headers: { 'User-Agent': 'collab-fetch-crsqlite' } })).json();
  asset = (rel.assets ?? []).find((a) => a.name.endsWith('.zip') && want.every((w) => a.name.includes(w)));
} catch { /* fall through */ }
if (!asset) {
  const name = `crsqlite-${want.join('-')}.zip`;
  asset = { name, browser_download_url: `https://github.com/vlcn-io/cr-sqlite/releases/download/${VERSION}/${name}` };
}

mkdirSync(out, { recursive: true });
const zip = join(out, asset.name);
writeFileSync(zip, Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer()));
if (process.platform === 'win32') execFileSync('tar', ['-xf', zip, '-C', out]);
else execFileSync('unzip', ['-o', zip, '-d', out]);
const lib = readdirSync(out).find((f) => /^crsqlite\.(dll|so|dylib)$/.test(f));
if (!lib || !existsSync(join(out, lib))) { console.error('extracted, but no crsqlite.(dll|so|dylib) found in ' + out); process.exit(1); }
console.log(`cr-sqlite ${VERSION} -> ${join(out, lib)}`);
