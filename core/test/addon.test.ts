import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkAddon, installAddon, platformKey } from '../src/addon.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function fakeRoot(libContent: string | null, libSha: string) {
  const root = mkdtempSync(join(tmpdir(), 'collab-addon-'));
  writeFileSync(join(root, 'addon-manifest.json'), JSON.stringify({
    version: 'v0.16.3',
    platforms: { 'linux-x64': { asset: 'a.zip', zipSha256: 'z', lib: 'crsqlite.so', libSha256: libSha } },
  }));
  if (libContent !== null) { mkdirSync(join(root, 'vendor', 'crsqlite'), { recursive: true }); writeFileSync(join(root, 'vendor', 'crsqlite', 'crsqlite.so'), libContent); }
  return root;
}

test('platform keys', () => { assert.equal(platformKey('win32', 'x64'), 'win32-x64'); });

test('ok when the file is there and its hash matches', () => {
  const root = fakeRoot('LIB', sha('LIB'));
  try { assert.equal(checkAddon({ root, platform: 'linux', arch: 'x64', env: {} }).state, 'ok'); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('hash mismatch is refused', () => {
  const root = fakeRoot('TAMPERED', sha('LIB'));
  try { assert.equal(checkAddon({ root, platform: 'linux', arch: 'x64', env: {} }).state, 'hash-mismatch'); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing, unsupported, and COLLAB_CRSQLITE_PATH override', () => {
  const root = fakeRoot(null, sha('LIB'));
  try {
    assert.equal(checkAddon({ root, platform: 'linux', arch: 'x64', env: {} }).state, 'missing');
    assert.equal(checkAddon({ root, platform: 'aix', arch: 'ppc', env: {} }).state, 'unsupported');
    assert.equal(checkAddon({ root, platform: 'linux', arch: 'x64', env: { COLLAB_CRSQLITE_PATH: '/x/crsqlite' } }).state, 'override');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installAddon refuses a download whose hash does not match and leaves no library behind', async () => {
  const root = fakeRoot(null, sha('LIB'));
  try {
    const fetchImpl = (async () => new Response(Buffer.from('NOT THE ZIP'))) as unknown as typeof fetch;
    const r = await installAddon({ root, fetchImpl, platform: 'linux', arch: 'x64' });
    assert.equal(r.state, 'hash-mismatch');
    const dir = join(root, 'vendor', 'crsqlite');
    const libs = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('crsqlite.')) : [];
    assert.deepEqual(libs, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
