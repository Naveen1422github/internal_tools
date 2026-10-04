// file: core/test/sync-http.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { generateSelfSignedCert, fingerprintOfPem, normalizeFingerprint } from '../src/sync/cert.js';
import { formatJoinCode, parseJoinCode } from '../src/sync/joincode.js';
import { requestJson, openEventStream } from '../src/sync/http.js';
import { PinMismatchError, AccessRevokedError } from '../src/sync/errors.js';
import { stubServer } from './helpers/https-stub.js';

test('a self-signed certificate: parseable, fingerprint = sha256 of the DER', () => {
  const c = generateSelfSignedCert();
  assert.match(c.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprintOfPem(c.certPem), c.fingerprint);
  assert.match(c.keyPem, /BEGIN PRIVATE KEY/);
  assert.equal(normalizeFingerprint('AB:cd:01'), 'abcd01');
});

test('join codes round-trip and reject garbage', () => {
  const code = formatJoinCode({ url: 'https://10.0.0.2:7443', fingerprint: 'AA:'.repeat(31) + 'AA', device: 'd-1', secret: 's3cret' });
  assert.match(code, /^collab1-[A-Za-z0-9_-]+$/);
  assert.deepEqual(parseJoinCode(`  ${code}\n`), { url: 'https://10.0.0.2:7443', fingerprint: 'aa'.repeat(32), device: 'd-1', secret: 's3cret' });
  assert.throws(() => parseJoinCode('hello'), /not a collab join code/);
  assert.throws(() => parseJoinCode('collab1-!!!!'), /damaged|incomplete/);
  assert.throws(() => parseJoinCode('collab1-' + Buffer.from('{"u":"http://x"}').toString('base64url')), /incomplete/);
});

test('requestJson talks JSON and sends the device key', async () => {
  const s = await stubServer((req, res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ auth: req.headers.authorization, got: JSON.parse(body) }));
  });
  try {
    const r = await requestJson({ url: s.url, fingerprint: s.fingerprint, auth: { device: 'd-1', key: 'k' } }, 'POST', '/v1/echo', { a: 1 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { auth: 'Bearer d-1:k', got: { a: 1 } });
  } finally { await s.close(); }
});

test('a wrong pin: refused before a single request byte is sent', async () => {
  const s = await stubServer((_q, res) => res.end('{}'));
  try {
    await assert.rejects(requestJson({ url: s.url, fingerprint: 'ab'.repeat(32), auth: { device: 'd', key: 'secret' } }, 'GET', '/v1/status'), PinMismatchError);
    assert.deepEqual(s.seen, []);
  } finally { await s.close(); }
});

test('401 means revoked', async () => {
  const s = await stubServer((_q, res) => { res.writeHead(401); res.end('{"error":"no"}'); });
  try {
    await assert.rejects(requestJson({ url: s.url, fingerprint: s.fingerprint }, 'GET', '/v1/status'), AccessRevokedError);
  } finally { await s.close(); }
});

test('only https:// post office URLs are accepted', async () => {
  await assert.rejects(requestJson({ url: 'http://127.0.0.1:1', fingerprint: 'ab'.repeat(32) }, 'GET', '/'), /https/);
});

test('the SSE reader delivers named events and skips comments', async () => {
  const s = await stubServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': hello\n\nevent: changes\ndata: {"last_seq":3}\n\n: ping\n\n');
    setTimeout(() => res.end('event: modules\ndata: {}\n\n'), 20);
  });
  try {
    const got: Array<[string, string]> = [];
    const closed = await new Promise<Error | undefined>((resolve) => {
      openEventStream({ url: s.url, fingerprint: s.fingerprint }, '/v1/events', {
        event: (name, data) => got.push([name, data]),
        close: (err) => resolve(err),
      });
    });
    assert.deepEqual(got, [['changes', '{"last_seq":3}'], ['modules', '{}']]);
    assert.match(String(closed?.message), /ended/);
  } finally { await s.close(); }
});
