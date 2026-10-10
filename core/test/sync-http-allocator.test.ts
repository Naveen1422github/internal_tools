// file: core/test/sync-http-allocator.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { stubServer } from './helpers/https-stub.js';
import { addEntryAsync } from '../src/ops/add.js';
import { setAllocator, setAllocationRetry, allocateWithRetry } from '../src/sync/allocator.js';
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
    const b = JSON.parse(body);
    assert.match(b.ulid, /^[0-9A-Z]{26}$/);
    assert.equal(b.series, 'E');
    res.end(JSON.stringify({ id: 42, series: b.series }));
  });
  const { db, cleanup } = freshDb({ shared: true });
  try {
    setAllocator(null);
    configure(db, s.url, s.fingerprint);
    assert.equal((await addEntryAsync(db, { type: 'decision', title: 't', summary: 's' })).id, 42);
    assert.deepEqual(auths, ['Bearer d-test:k-test']);
  } finally { await s.close(); cleanup(); }
});

test('the connection drops after the post office assigned: the save goes pending, the retry gets the same number', async () => {
  const byUlid = new Map<string, number>();
  const ulids: string[] = [];
  let n = 0;
  const s = await stubServer((req, res, body) => {
    const { ulid, series } = JSON.parse(body);
    ulids.push(ulid);
    if (!byUlid.has(ulid)) byUlid.set(ulid, ++n);
    if (ulids.length === 1) { req.socket.destroy(); return; } // assigned, answer lost
    res.end(JSON.stringify({ id: byUlid.get(ulid), series }));
  });
  const { db, cleanup } = freshDb({ shared: true });
  try {
    setAllocator(null);
    setAllocationRetry({ delaysMs: [0, 0] });
    configure(db, s.url, s.fingerprint);
    // Stage C (E-820): a save asks once; without an answer it is saved pending.
    const r = await addEntryAsync(db, { type: 'decision', title: 't', summary: 's' });
    assert.equal(r.pending, true);
    assert.equal(ulids.length, 1);
    // The courier asks again with the SAME ulid and gets the number already given (E-713).
    assert.equal(await allocateWithRetry(httpAllocatorFromDb(db)!, r.ulid), 1);
    assert.equal(ulids.length, 2);
    assert.equal(ulids[0], ulids[1]);
    assert.equal(n, 1);
  } finally { setAllocationRetry(null); await s.close(); cleanup(); }
});

test('401: not retried; the note is saved pending and says why (E-820: saving is never refused)', async () => {
  const s = await stubServer((_q, res) => { res.writeHead(401); res.end('{}'); });
  const { db, cleanup } = freshDb({ shared: true });
  try {
    setAllocator(null);
    configure(db, s.url, s.fingerprint);
    const r = await addEntryAsync(db, { type: 'decision', title: 't', summary: 's' });
    assert.equal(r.pending, true);
    assert.match(r.pendingReason ?? '', /revoked/);
    assert.equal(s.seen.length, 1);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM entries WHERE id IS NULL').get() as { c: number }).c, 1);
  } finally { await s.close(); cleanup(); }
});

test('an answer in another series (or none: an older office) is refused, never stored', async () => {
  const replies: unknown[] = [{ id: 3 }, { id: 3, series: 'E' }, { id: 3, series: 'SH' }];
  const s = await stubServer((_q, res) => { res.end(JSON.stringify(replies.shift())); });
  const { db, cleanup } = freshDb({ shared: true });
  try {
    configure(db, s.url, s.fingerprint);
    const a = httpAllocatorFromDb(db)!;
    for (let i = 0; i < 2; i++) {
      await assert.rejects(a.allocate('01J0000000000000000000000A', 'SH'),
        (e: any) => e.retriable === false && /update the post office/.test(e.message));
    }
    assert.equal(await a.allocate('01J0000000000000000000000A', 'SH'), 3);
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
