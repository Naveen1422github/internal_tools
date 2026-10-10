// file: core/test/ulid-ref.test.ts
// Stage C, spec P6: a pending note (no number yet) is reachable and linkable by its ULID.
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { migrate } from '../src/db.js';
import { addEntry } from '../src/ops/add.js';
import { getEntryByRef, getEntryByUlid, resolveNoteKey } from '../src/ops/get.js';
import { updateEntry, updateEntryRefs } from '../src/ops/update.js';
import { supersede } from '../src/ops/supersede.js';
import { setAllocator } from '../src/sync/allocator.js';

const note = (title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'decision' as const, title, summary: 's', ...extra });

function sharedWithPending() {
  const t = freshDb({ shared: true });
  migrate(t.db);
  // Two numbered E notes, then one pending (the synchronous path never has a number on a shared notebook).
  const e1 = addEntry(t.db, note('one', { assigned: { ulid: '01J00000000000000000000001', id: 1 } }));
  const e2 = addEntry(t.db, note('two', { assigned: { ulid: '01J00000000000000000000002', id: 2 } }));
  const p = addEntry(t.db, note('pending one'));
  assert.equal(p.pending, true);
  return { ...t, e1, e2, p };
}

test('resolveNoteKey: a ULID reaches the note, pending or not; number forms as before', () => {
  const t = sharedWithPending();
  try {
    assert.deepEqual(resolveNoteKey(t.db, t.p.ulid), { id: null, ulid: t.p.ulid });
    assert.deepEqual(resolveNoteKey(t.db, ` ${t.p.ulid} `), { id: null, ulid: t.p.ulid });
    assert.deepEqual(resolveNoteKey(t.db, t.e1.ulid), { id: 1, ulid: t.e1.ulid });
    assert.deepEqual(resolveNoteKey(t.db, 2), { id: 2, ulid: t.e2.ulid });
    assert.deepEqual(resolveNoteKey(t.db, 'E-00002'), { id: 2, ulid: t.e2.ulid });
    assert.equal(resolveNoteKey(t.db, '01J0000000000000000000000Z'), null, 'unknown ULID');
    assert.equal(resolveNoteKey(t.db, 'nonsense'), null);
  } finally { t.cleanup(); }
});

test('a ref to a ULID gets target_ulid at once', () => {
  const t = sharedWithPending();
  try {
    const r = addEntry(t.db, note('links the pending one', { refs: [{ ref_type: 'entry', ref_value: t.p.ulid }] }));
    const row = t.db.prepare(`SELECT target_ulid FROM refs WHERE entry_ulid = ?`).get(r.ulid) as any;
    assert.equal(row.target_ulid, t.p.ulid);
    // A ULID-shaped value of no note stays unresolved (the trigger can't parse it either).
    const r2 = addEntry(t.db, note('dangling', { refs: [{ ref_type: 'entry', ref_value: '01J0000000000000000000000Z' }] }));
    assert.equal((t.db.prepare(`SELECT target_ulid FROM refs WHERE entry_ulid = ?`).get(r2.ulid) as any).target_ulid, null);
    // Through updateEntryRefs too, addressed by ULID.
    updateEntryRefs(t.db, { ulid: t.p.ulid, add: [{ ref_type: 'entry', ref_value: t.e1.ulid }] });
    const full = getEntryByUlid(t.db, t.p.ulid)!;
    assert.equal(full.refs.find((x) => x.ref_type === 'entry')?.target?.id, 1);
  } finally { t.cleanup(); }
});

test('edit and supersede by ULID; once numbered, the link shows the number', () => {
  const t = sharedWithPending();
  try {
    const u = updateEntry(t.db, { ulid: t.p.ulid, summary: 'edited while pending' });
    assert.equal(u.id, null);
    assert.equal(getEntryByUlid(t.db, t.p.ulid)!.summary, 'edited while pending');
    // The pending note supersedes E-1 ("Supersedes E-NNN" right after saving).
    supersede(t.db, { ids: [1], by: { ulid: t.p.ulid } });
    assert.equal(getEntryByRef(t.db, { series: 'E', id: 1 })!.superseded_target?.ulid, t.p.ulid);
    assert.equal(getEntryByRef(t.db, { series: 'E', id: 1 })!.superseded_target?.id, null);
    // The courier numbers it later: the link now shows its number.
    t.db.prepare(`UPDATE entries SET id = 3 WHERE ulid = ?`).run(t.p.ulid);
    assert.equal(getEntryByRef(t.db, { series: 'E', id: 1 })!.superseded_target?.id, 3);
    // And a pending note can itself be superseded by ULID.
    const q = addEntry(t.db, note('another pending'));
    supersede(t.db, { ids: [{ ulid: q.ulid }], by: 2 });
    assert.equal(getEntryByUlid(t.db, q.ulid)!.deprecated, 1);
    assert.throws(() => supersede(t.db, { ids: [{ ulid: '01J0000000000000000000000Z' }], by: 2 }), /do not exist/);
    assert.throws(() => updateEntry(t.db, { ulid: '01J0000000000000000000000Z', title: 'x' }), /no entry found/);
  } finally { setAllocator(null); t.cleanup(); }
});
