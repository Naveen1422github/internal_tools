// file: post-office/test/deliveries.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { addEntryAsync, setAllocator, readOwnChanges, applyChanges, decodeChange } from '@collab-mcp/core';
import { tempStore, laptop } from './helpers.js';
import { acceptChanges, fetchDeliveries, lastSeq } from '../src/deliveries.js';

test('accepted changes land in the store in order; a resend is a no-op', async () => {
  const { store, cleanup } = tempStore();
  const a = laptop();
  try {
    setAllocator({ allocate: async () => 1 });
    await addEntryAsync(a.db, { type: 'decision', title: 'hello', summary: 's', module: 'm' });
    const sent = readOwnChanges(a.db, 0);
    const r1 = acceptChanges(store, 'd-a', sent);
    assert.equal(r1.accepted, sent.length);
    assert.equal(r1.duplicates, 0);
    assert.equal(r1.lastSeq, sent.length);
    assert.equal((store.prepare(`SELECT title FROM entries WHERE id = 1`).get() as { title: string }).title, 'hello');
    const r2 = acceptChanges(store, 'd-a', sent);
    assert.deepEqual([r2.accepted, r2.duplicates, r2.lastSeq], [0, sent.length, sent.length]);
  } finally { setAllocator(null); a.cleanup(); cleanup(); }
});

test('fetch: everything after the bookmark except the caller\'s own; the bookmark is recorded', async () => {
  const { store, cleanup } = tempStore();
  const a = laptop(), b = laptop();
  try {
    store.prepare(`INSERT INTO po_members (device_id, name, joined_at) VALUES ('d-b', 'b', datetime('now'))`).run();
    setAllocator({ allocate: async () => 2 });
    await addEntryAsync(a.db, { type: 'decision', title: 'for b', summary: 's', module: 'm' });
    acceptChanges(store, 'd-a', readOwnChanges(a.db, 0));
    assert.deepEqual(fetchDeliveries(store, 'd-a', 0, 100).changes, [], 'never your own changes back');
    const page = fetchDeliveries(store, 'd-b', 0, 5);
    assert.equal(page.changes.length, 5);
    assert.equal(page.more, true);
    const rest = fetchDeliveries(store, 'd-b', page.lastSeq, 1000);
    assert.equal(rest.more, false);
    b.db.transaction(() => applyChanges(b.db, [...page.changes, ...rest.changes].map(decodeChange)))();
    assert.equal((b.db.prepare(`SELECT title FROM entries WHERE id = 2`).get() as { title: string }).title, 'for b');
    fetchDeliveries(store, 'd-b', rest.lastSeq, 1000);
    assert.equal((store.prepare(`SELECT receive_bookmark r FROM po_members WHERE device_id = 'd-b'`).get() as { r: number }).r, lastSeq(store));
  } finally { setAllocator(null); a.cleanup(); b.cleanup(); cleanup(); }
});

test('a batch with an unshared table is refused whole', async () => {
  const { store, cleanup } = tempStore();
  const a = laptop();
  try {
    setAllocator({ allocate: async () => 3 });
    await addEntryAsync(a.db, { type: 'decision', title: 't', summary: 's', module: 'm' });
    const sent = readOwnChanges(a.db, 0);
    assert.throws(() => acceptChanges(store, 'd-a', [...sent, { ...sent[0], table: 'tasks' }]), /not shared/);
    assert.equal(lastSeq(store), 0);
    assert.throws(() => acceptChanges(store, 'd-a', [{ junk: 1 } as any]), /malformed/);
  } finally { setAllocator(null); a.cleanup(); cleanup(); }
});

test('rows the store\'s own migrations created are never delivered', () => {
  const { store, cleanup } = tempStore();
  try {
    assert.equal(lastSeq(store), 0);
    assert.deepEqual(fetchDeliveries(store, 'd-x', 0, 100).changes, []);
  } finally { cleanup(); }
});
