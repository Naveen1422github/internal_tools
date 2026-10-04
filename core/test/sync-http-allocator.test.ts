// file: core/test/sync-http-allocator.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { stubServer } from './helpers/https-stub.js';
import { addEntryAsync } from '../src/ops/add.js';
import { setAllocator, setAllocationRetry, PostOfficeUnreachableError } from '../src/sync/allocator.js';
import { setSyncValue } from '../src/sync/state.js';
import { SYNC_KEYS, httpAllocatorFromDb } from '../src/sync/http-allocator.js';

function configure(db: any, url: string, fingerprint: string) {
  setSyncValue(db, SYNC_KEYS.url, url);
  setSyncValue(db, SYNC_KEYS.fingerprint, fingerprint);
  setSyncValue(db, SYNC_KEYS.device, 'd-test');
  setSyncValue(db, SYNC_KEYS.key, 'k-test');
}

test('a shared DB configured with a post office gets its numbers over HTTPS', async () => {
  const auths: string[] = [];
  const s = await stubServer((req, res, body) => {
    auths.push(String(req.headers.authorization));
    assert.match(JSON.parse(body).ulid, /^[0-9A-Z]{26}$/);
    res.end(JSON.stringify({ id: 42 }));
  });
  const { db, cleanup } = freshDb({ shared: true });
  try {
    setAllocator(null);
    configure(db, s.url, s.fingerprint);
    assert.equal((await addEntryAsync(db, { type: 'decision', title: 't', summary: 's' })).id, 42);
    assert.deepEqual(auths, ['Bearer d-test:k-test']);
  } finally { await s.close(); cleanup(); }
});

test('the connection drops after the post office assigned: the retry gets the same number', async () => {
  const byUlid = new Map<string, number>();
  const ulids: string[] = [];
  let n = 0;
  const s = await stubServer((req, res, body) => {
    const { ulid } = JSON.parse(body);
    ulids.push(ulid);
    if (!byUlid.has(ulid)) byUlid.set(ulid, ++n);
    if (ulids.length === 1) { req.socket.destroy(); return; } // assigned, answer lost
    res.end(JSON.stringify({ id: byUlid.get(ulid) }));
  });
  const { db, cleanup } = freshDb({ shared: true });
  try {
    setAllocator(null);
    setAllocationRetry({ delaysMs: [0, 0] });
    configure(db, s.url, s.fingerprint);
    assert.equal((await addEntryAsync(db, { type: 'decision', title: 't', summary: 's' })).id, 1);
    assert.equal(ulids.length, 2);
    assert.equal(ulids[0], ulids[1]);
    assert.equal(n, 1);
  } finally { setAllocationRetry(null); await s.close(); cleanup(); }
});

test('401: refused at once, not retried, nothing written', async () => {
  const s = await stubServer((_q, res) => { res.writeHead(401); res.end('{}'); });
  const { db, cleanup } = freshDb({ shared: true });
  try {
    setAllocator(null);
    configure(db, s.url, s.fingerprint);
    await assert.rejects(addEntryAsync(db, { type: 'decision', title: 't', summary: 's' }), (e: any) => e instanceof PostOfficeUnreachableError && /revoked/.test(e.message));
    assert.equal(s.seen.length, 1);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM entries').get() as { c: number }).c, 0);
  } finally { await s.close(); cleanup(); }
});

test('httpAllocatorFromDb: null until configured, cached per DB, rebuilt on change', () => {
  const { db, cleanup } = freshDb({ shared: true });
  try {
    assert.equal(httpAllocatorFromDb(db), null);
    configure(db, 'https://127.0.0.1:1', 'ab'.repeat(32));
    const a = httpAllocatorFromDb(db);
    assert.ok(a);
    assert.equal(httpAllocatorFromDb(db), a);
    setSyncValue(db, SYNC_KEYS.url, 'https://127.0.0.1:2');
    assert.notEqual(httpAllocatorFromDb(db), a);
  } finally { cleanup(); }
});
