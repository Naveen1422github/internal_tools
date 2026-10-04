// file: post-office/test/allocator-e2e.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import {
  addEntryAsync, setAllocator, setAllocationRetry, setSyncValue, SYNC_KEYS, PostOfficeUnreachableError,
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

test('E-713 over HTTPS: the answer is dropped after allocation, the retry gets the same number', async () => {
  let drops = 1;
  const o = await office(500, { testHooks: { dropAllocateAnswer: () => drops-- > 0 } });
  const lap = laptop();
  try {
    setAllocator(null);
    setAllocationRetry({ delaysMs: [0, 0] });
    configure(lap.db, o.po.url, o.cert.fingerprint, await o.join('b'));
    assert.equal((await addEntryAsync(lap.db, ok)).id, 501);
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

test('revoked: refused at once, nothing written; post office down: refused, names the post office', async () => {
  const o = await office(0);
  const lap = laptop();
  const count = () => (lap.db.prepare('SELECT COUNT(*) c FROM entries').get() as { c: number }).c;
  try {
    setAllocator(null);
    configure(lap.db, o.po.url, o.cert.fingerprint, await o.join('b'));
    revokeMember(o.store, 'b');
    const t0 = Date.now();
    await assert.rejects(addEntryAsync(lap.db, ok), (e: any) => e instanceof PostOfficeUnreachableError && /revoked/.test(e.message));
    assert.ok(Date.now() - t0 < 1000, 'no retries on 401');
    await o.po.close();
    setAllocationRetry({ delaysMs: [0, 0] });
    await assert.rejects(addEntryAsync(lap.db, ok), /post office/);
    assert.equal(count(), 0);
  } finally { setAllocationRetry(null); lap.cleanup(); await o.stop().catch(() => {}); }
});
