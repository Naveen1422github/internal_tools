// file: post-office/test/merge.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import {
  addEntryAsync, setAllocator, updateEntry, resolveNeedsMerge, readOwnChanges, applyChanges, decodeChange,
  reindexFts, revisionsOf, headsOf,
} from '@collab-mcp/core';
import { tempStore, laptop } from './helpers.js';
import { acceptChanges, fetchDeliveries } from '../src/deliveries.js';
import { mergeText } from '../src/merge.js';
import type { Store } from '../src/store.js';

/** A simulated machine: push = send all own changes (resends are no-ops); pull = fetch + apply after its bookmark. */
function machine(dev: string) {
  const h = laptop();
  let recv = 0;
  return {
    ...h, dev,
    push: (store: Store) => acceptChanges(store, dev, readOwnChanges(h.db, 0)),
    pull: (store: Store) => {
      for (;;) {
        const r = fetchDeliveries(store, dev, recv, 1000);
        if (r.changes.length) h.db.transaction(() => reindexFts(h.db, applyChanges(h.db, r.changes.map(decodeChange)).entryUlids))();
        recv = r.lastSeq;
        if (!r.more) break;
      }
    },
  };
}
const row = (db: any, id: number) => db.prepare('SELECT ulid, title, description, status, needs_merge FROM entries WHERE id = ?').get(id) as any;

async function forkedPair(description: string) {
  const s = tempStore();
  const a = machine('d-a'), b = machine('d-b');
  setAllocator({ allocate: async () => 10 });
  const { id } = await addEntryAsync(a.db, { type: 'decision', title: 't', summary: 's', description, module: 'm' });
  a.push(s.store); b.pull(s.store);
  return { s, a, b, id, done: () => { setAllocator(null); a.cleanup(); b.cleanup(); s.cleanup(); } };
}

test('mergeText: one side, both same, clean lines, conflicts', () => {
  assert.deepEqual(mergeText('x', 'x', 'y', false), { ok: true, value: 'y' });
  assert.deepEqual(mergeText('x', 'z', 'z', false), { ok: true, value: 'z' });
  assert.deepEqual(mergeText('x', 'y', 'z', false), { ok: false });
  assert.deepEqual(mergeText('p1\n\np2', 'P1\n\np2', 'p1\n\nP2', true), { ok: true, value: 'P1\n\nP2' });
  assert.deepEqual(mergeText('p1\n\np2', 'X\n\np2', 'Y\n\np2', true), { ok: false });
});

test('edits to different paragraphs on two machines: merged, and the merge reaches both', async () => {
  const { s, a, b, id, done } = await forkedPair('p1\n\np2');
  try {
    updateEntry(a.db, { id, description: 'P1 from a\n\np2' });
    updateEntry(b.db, { id, description: 'p1\n\nP2 from b' });
    a.push(s.store);
    const r = b.push(s.store);
    assert.equal(r.officeWrote, true, 'the office wrote a merged revision');
    assert.equal(row(s.store, id).description, 'P1 from a\n\nP2 from b');
    a.pull(s.store); b.pull(s.store);
    for (const db of [a.db, b.db, s.store]) {
      assert.equal(row(db, id).description, 'P1 from a\n\nP2 from b');
      assert.equal(row(db, id).needs_merge, 0);
      assert.equal(headsOf(revisionsOf(db, row(db, id).ulid)).length, 1);
    }
  } finally { done(); }
});

test('edits to the same line: needs_merge everywhere, both texts kept as revisions; a person resolves it', async () => {
  const { s, a, b, id, done } = await forkedPair('line one\n\nline two');
  try {
    updateEntry(a.db, { id, description: 'line ONE (a)\n\nline two' });
    updateEntry(b.db, { id, description: 'line ONE (b)\n\nline two' });
    a.push(s.store); b.push(s.store);
    a.pull(s.store); b.pull(s.store);
    for (const db of [a.db, b.db, s.store]) assert.equal(row(db, id).needs_merge, 1);
    const texts = revisionsOf(s.store, row(s.store, id).ulid).map((r) => r.description);
    assert.ok(texts.includes('line ONE (a)\n\nline two') && texts.includes('line ONE (b)\n\nline two'), 'nothing is lost');
    updateEntry(a.db, { id, description: 'line ONE (both)\n\nline two' });
    a.push(s.store); b.pull(s.store);
    for (const db of [a.db, b.db, s.store]) {
      assert.equal(row(db, id).needs_merge, 0);
      assert.equal(row(db, id).description, 'line ONE (both)\n\nline two');
      assert.equal(headsOf(revisionsOf(db, row(db, id).ulid)).length, 1);
    }
  } finally { done(); }
});

test('resolveNeedsMerge keeps the current text and clears the flag', async () => {
  const { s, a, b, id, done } = await forkedPair('x');
  try {
    updateEntry(a.db, { id, title: 'A' });
    updateEntry(b.db, { id, title: 'B' });
    a.push(s.store); b.push(s.store); a.pull(s.store);
    assert.equal(row(a.db, id).needs_merge, 1);
    resolveNeedsMerge(a.db, id);
    a.push(s.store);
    assert.equal(row(s.store, id).needs_merge, 0);
    assert.throws(() => resolveNeedsMerge(a.db, id), /not waiting/);
  } finally { done(); }
});

test('status changed differently on two machines: needs_merge', async () => {
  const { s, a, b, id, done } = await forkedPair('x');
  try {
    a.db.prepare(`UPDATE entries SET status = 'resolved' WHERE id = ?`).run(id);
    b.db.prepare(`UPDATE entries SET status = 'deprecated' WHERE id = ?`).run(id);
    a.push(s.store); b.push(s.store);
    assert.equal(row(s.store, id).needs_merge, 1);
  } finally { done(); }
});

test('edits one after the other are not a conflict', async () => {
  const { s, a, b, id, done } = await forkedPair('x');
  try {
    updateEntry(a.db, { id, description: 'y' });
    a.db.prepare(`UPDATE entries SET status = 'resolved' WHERE id = ?`).run(id);
    a.push(s.store); b.pull(s.store);
    updateEntry(b.db, { id, description: 'z' });
    b.db.prepare(`UPDATE entries SET status = 'active' WHERE id = ?`).run(id);
    const r = b.push(s.store);
    assert.equal(r.officeWrote, false);
    assert.deepEqual([row(s.store, id).description, row(s.store, id).status, row(s.store, id).needs_merge], ['z', 'active', 0]);
  } finally { done(); }
});
