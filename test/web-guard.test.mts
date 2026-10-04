import { test } from 'node:test';
import assert from 'node:assert';
import { checkApiRequest, checkHost } from '../server/src/guard.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWebKey, readWebKey, injectKey } from '../server/src/web-key.ts';

const PORT = 7473;
const KEY = 'a'.repeat(64);
const ok = (extra: Record<string, string> = {}) => ({
  method: 'GET',
  headers: { host: `127.0.0.1:${PORT}`, 'x-collab-key': KEY, ...extra },
});
const check = (req: any) => checkApiRequest(req, { port: PORT, key: KEY });

test('the right key from the right host is allowed', () => {
  assert.equal(check(ok()), null);
});

test('no key -> 403 key', () => {
  const r = ok(); delete (r.headers as any)['x-collab-key'];
  assert.deepEqual(check(r), { status: 403, reason: 'key' });
});

test('wrong key, and a key of a different length, -> 403 key without throwing', () => {
  assert.deepEqual(check(ok({ 'x-collab-key': 'b'.repeat(64) })), { status: 403, reason: 'key' });
  assert.deepEqual(check(ok({ 'x-collab-key': 'short' })), { status: 403, reason: 'key' });
});

test('foreign Origin -> 403 origin, even with the right key', () => {
  assert.deepEqual(check(ok({ origin: 'https://evil.example' })), { status: 403, reason: 'origin' });
});

test('Origin null is refused', () => {
  assert.deepEqual(check(ok({ origin: 'null' })), { status: 403, reason: 'origin' });
});

test('same-site Origin (127.0.0.1 or localhost) is allowed', () => {
  assert.equal(check(ok({ origin: `http://127.0.0.1:${PORT}` })), null);
  assert.equal(check(ok({ origin: `http://localhost:${PORT}`, host: `localhost:${PORT}` })), null);
});

test('rebinding Host -> 403 host', () => {
  assert.deepEqual(check(ok({ host: `evil.example:${PORT}` })), { status: 403, reason: 'host' });
  assert.deepEqual(checkHost({ host: `evil.example:${PORT}` }, PORT), { status: 403, reason: 'host' });
  assert.deepEqual(checkHost({ host: `127.0.0.1:9999` }, PORT), { status: 403, reason: 'host' });
  assert.equal(checkHost({ host: `LOCALHOST:${PORT}` }, PORT), null);
});

test('body without JSON type -> 415; JSON body or empty POST allowed', () => {
  const post = (h: Record<string, string>) => ({ method: 'POST', headers: { ...ok().headers, ...h } });
  assert.deepEqual(check(post({ 'content-length': '5', 'content-type': 'text/plain' })), { status: 415, reason: 'content-type' });
  assert.deepEqual(check(post({ 'content-length': '5' })), { status: 415, reason: 'content-type' });
  assert.deepEqual(check(post({ 'transfer-encoding': 'chunked' })), { status: 415, reason: 'content-type' });
  assert.equal(check(post({ 'content-length': '5', 'content-type': 'application/json; charset=utf-8' })), null);
  assert.equal(check(post({ 'content-length': '0' })), null);
});

test('createWebKey writes a fresh 64-hex key that readWebKey reads back', () => {
  const file = path.join(os.tmpdir(), `collab-web-key-${crypto.randomUUID()}`, 'key');
  try {
    const k1 = createWebKey(file);
    assert.match(k1, /^[0-9a-f]{64}$/);
    assert.equal(readWebKey(file), k1);
    const k2 = createWebKey(file);
    assert.notEqual(k2, k1, 'a new key on every start');
    assert.equal(readWebKey(file), k2);
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('an unwritable key file does not stop the server: createWebKey still returns a key', () => {
  const blocker = path.join(os.tmpdir(), `collab-web-blocker-${crypto.randomUUID()}`);
  fs.writeFileSync(blocker, 'a file, not a folder');
  try {
    const k = createWebKey(path.join(blocker, 'web', 'key'));
    assert.match(k, /^[0-9a-f]{64}$/);
  } finally { fs.rmSync(blocker, { force: true }); }
});

test('readWebKey returns null when the file is missing', () => {
  assert.equal(readWebKey(path.join(os.tmpdir(), `nope-${crypto.randomUUID()}`)), null);
});

test('injectKey puts the meta tag in <head>, or in front when there is no head', () => {
  assert.equal(injectKey('<html><head><title>x</title></head></html>', 'k'),
    '<html><head><title>x</title><meta name="collab-key" content="k"></head></html>');
  assert.equal(injectKey('<p>x</p>', 'k'), '<meta name="collab-key" content="k"><p>x</p>');
});
