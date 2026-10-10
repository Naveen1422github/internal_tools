// file: post-office/test/allocator-e2e.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import {
  addEntryAsync, setAllocator, setAllocationRetry, setSyncValue, SYNC_KEYS, allocateWithRetry, httpAllocatorFromDb,
  type AddEntryArgs,
} from '@collab-mcp/core';
import { laptop } from './helpers.js';
import { office } from './office.js';
import { allocate, nextNumber, revokeMember } from '../src/store.js';

const ok: AddEntryArgs = { type: 'decision', title: 't', summary: 's', module: 'm' };
const bad: AddEntryArgs[] = [
  { ...ok, title: '' }, { ...ok, type: 'nope' as any }, { ...ok, summary: 'x'.repeat(201) }, { ...ok, agent: 'Zed' as any },
  { ...ok, refs: [{ ref_type: 'bogus' as any, ref_value: 'v' }] },
];
function configure(db: any, url: string, fingerprint: string, m: { device: string; key: string }) {
  setSyncValue(db, SYNC_KEYS.url, url);
  setSyncValue(db, SYNC_KEYS.fingerprint, fingerprint);
  setSyncValue(db, SYNC_KEYS.device, m.device);
  setSyncValue(db, SYNC_KEYS.key, m.key);
}

// Stage C (E-820): the save asks once and goes pending; the courier's retry
// (allocateWithRetry, same ulid) gets the number the office already gave.
test('E-713 over HTTPS: the answer is dropped after allocation, the retry gets the same number', async () => {
  let drops = 1;
  const o = await office(500, { testHooks: { dropAllocateAnswer: () => drops-- > 0 } });
  const lap = laptop();
  try {
    setAllocator(null);
    setAllocationRetry({ delaysMs: [0, 0] });
    configure(lap.db, o.po.url, o.cert.fingerprint, await o.join('b'));
    const r = await addEntryAsync(lap.db, ok);
    assert.equal(r.pending, true);
    assert.equal(await allocateWithRetry(httpAllocatorFromDb(lap.db)!, r.ulid), 501);
    assert.equal(nextNumber(o.store), 502, 'the counter moved once');
    assert.equal((await addEntryAsync(lap.db, ok)).id, 502);
  } finally { setAllocationRetry(null); lap.cleanup(); await o.stop(); }
});

test('1000 saves with 50 invalid against the real store: no gaps', async () => {
  const o = await office(1200);
  const lap = laptop();
  try {
    setAllocator({ allocate: async (u) => allocate(o.store, u, 'd-local') });
    const ids: number[] = [];
    for (let i = 0; i < 1000; i++) {
      if (i % 20 === 3) await assert.rejects(addEntryAsync(lap.db, bad[i % bad.length]));
      else ids.push((await addEntryAsync(lap.db, { ...ok, title: `n${i}` })).id);
    }
    assert.deepEqual(ids.sort((a, b) => a - b), Array.from({ length: 950 }, (_, k) => 1201 + k));
  } finally { setAllocator(null); lap.cleanup(); await o.stop(); }
});

test('100 saves with 5 invalid over HTTPS: no gaps', async () => {
  const o = await office(0);
  const lap = laptop();
  try {
    setAllocator(null);
    configure(lap.db, o.po.url, o.cert.fingerprint, await o.join('b'));
    const ids: number[] = [];
    for (let i = 0; i < 100; i++) {
      if (i % 20 === 9) await assert.rejects(addEntryAsync(lap.db, bad[(i / 20) | 0]));
      else ids.push((await addEntryAsync(lap.db, { ...ok, title: `n${i}` })).id);
    }
    assert.deepEqual(ids, Array.from({ length: 95 }, (_, k) => 1 + k));
  } finally { lap.cleanup(); await o.stop(); }
});

test('revoked: answered at once, saved pending; post office down: saved pending, the reason says why (E-820)', async () => {
  const o = await office(0);
  const lap = laptop();
  const pending = () => (lap.db.prepare('SELECT COUNT(*) c FROM entries WHERE id IS NULL').get() as { c: number }).c;
  try {
    setAllocator(null);
    configure(lap.db, o.po.url, o.cert.fingerprint, await o.join('b'));
    revokeMember(o.store, 'b');
    const t0 = Date.now();
    const revoked = await addEntryAsync(lap.db, ok);
    assert.equal(revoked.pending, true);
    assert.match(revoked.pendingReason ?? '', /revoked/);
    assert.ok(Date.now() - t0 < 1000, 'no retries on 401');
    await o.po.close();
    setAllocationRetry({ delaysMs: [0, 0] });
    const down = await addEntryAsync(lap.db, ok);
    assert.equal(down.pending, true);
    assert.ok(down.pendingReason, 'says why');
    assert.equal(pending(), 2);
  } finally { setAllocationRetry(null); lap.cleanup(); await o.stop().catch(() => {}); }
});
