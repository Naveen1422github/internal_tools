// file: post-office/test/merge-resolve.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import {
  addEntryAsync, setAllocator, updateEntry, editEntry, resolveNeedsMerge, readOwnChanges, applyChanges, decodeChange, reindexFts,
  getMergeView, resolveWithText, currentHeads, VersionsChangedError, NeedsMergeError,
} from '@collab-mcp/core';
import { tempStore, laptop } from './helpers.js';
import { acceptChanges, fetchDeliveries } from '../src/deliveries.js';
import type { Store } from '../src/store.js';

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

/** A note whose title was edited to 'A' on one machine and 'B' on the other: flagged, two versions. Returns machine a's DB. */
async function flagged() {
  const s = tempStore();
  const a = machine('d-a'), b = machine('d-b');
  setAllocator({ allocate: async () => 10 });
  const { id } = await addEntryAsync(a.db, { type: 'decision', title: 't', summary: 's', description: 'x', module: 'm' });
  a.push(s.store); b.pull(s.store);
  updateEntry(a.db, { id, title: 'A' });
  updateEntry(b.db, { id, title: 'B' });
  a.push(s.store); b.push(s.store); a.pull(s.store);
  assert.equal((a.db.prepare('SELECT needs_merge FROM entries WHERE id = ?').get(id) as any).needs_merge, 1);
  return { db: a.db, id, cleanup: () => { setAllocator(null); a.cleanup(); b.cleanup(); s.cleanup(); } };
}

test('getMergeView lists every version with author and time', async () => {
  const f = await flagged();
  try {
    const v = getMergeView(f.db, f.id);
    assert.equal(v.heads.length, 2);
    assert.deepEqual(v.heads.map((h) => h.title).sort(), ['A', 'B']);
    assert.ok(v.heads.every((h) => typeof h.created_at === 'string' && 'author' in h));
  } finally { f.cleanup(); }
});

test('resolveWithText with the versions you saw: text saved, flag cleared, all versions folded in', async () => {
  const f = await flagged();
  try {
    const heads = getMergeView(f.db, f.id).heads.map((h) => h.rev_id);
    resolveWithText(f.db, { id: f.id, expectedHeads: heads, title: 'A and B', summary: 's', description: null });
    const row = f.db.prepare('SELECT title, needs_merge, ulid FROM entries WHERE id = ?').get(f.id) as any;
    assert.equal(row.title, 'A and B');
    assert.equal(row.needs_merge, 0);
    assert.equal(currentHeads(f.db, row.ulid).length, 1, 'one version again');
  } finally { f.cleanup(); }
});

test('a changed set of versions is refused and nothing is written', async () => {
  const f = await flagged();
  try {
    const before = f.db.prepare('SELECT title, needs_merge FROM entries WHERE id = ?').get(f.id);
    assert.throws(() => resolveWithText(f.db, { id: f.id, expectedHeads: ['not-a-real-rev'], title: 'X', summary: 's', description: null }), VersionsChangedError);
    assert.throws(() => resolveNeedsMerge(f.db, f.id, ['not-a-real-rev']), VersionsChangedError);
    const heads = getMergeView(f.db, f.id).heads.map((h) => h.rev_id);
    assert.throws(() => resolveWithText(f.db, { id: f.id, expectedHeads: heads.slice(0, 1), title: 'X', summary: 's', description: null }), VersionsChangedError, 'seeing only one of two versions is not enough');
    assert.deepEqual(f.db.prepare('SELECT title, needs_merge FROM entries WHERE id = ?').get(f.id), before);
  } finally { f.cleanup(); }
});

test('resolveNeedsMerge with the versions you saw keeps the current text and clears the flag', async () => {
  const f = await flagged();
  try {
    const heads = getMergeView(f.db, f.id).heads.map((h) => h.rev_id);
    const title = (f.db.prepare('SELECT title FROM entries WHERE id = ?').get(f.id) as any).title;
    resolveNeedsMerge(f.db, f.id, heads);
    const row = f.db.prepare('SELECT title, needs_merge FROM entries WHERE id = ?').get(f.id) as any;
    assert.deepEqual([row.title, row.needs_merge], [title, 0]);
  } finally { f.cleanup(); }
});

test('V9: an ordinary edit of a flagged note is refused with the merge link', async () => {
  const f = await flagged();
  try {
    const msg = new RegExp(`E-${String(f.id).padStart(5, '0')} needs a merge first: open /merge/${f.id} in the collab web UI`);
    assert.throws(() => updateEntry(f.db, { id: f.id, summary: 'sneaky' }), (e: any) => e instanceof NeedsMergeError && msg.test(e.message));
    assert.throws(() => editEntry(f.db, { id: f.id, type: 'decision', title: 'C', summary: 's', module: 'm' } as any), (e: any) => e instanceof NeedsMergeError && msg.test(e.message));
  } finally { f.cleanup(); }
});

test('getMergeView on a note that is not flagged throws a clear error', async () => {
  const f = await flagged();
  try {
    const heads = getMergeView(f.db, f.id).heads.map((h) => h.rev_id);
    resolveNeedsMerge(f.db, f.id, heads);
    assert.throws(() => getMergeView(f.db, f.id), /is not waiting for a merge/);
  } finally { f.cleanup(); }
});
