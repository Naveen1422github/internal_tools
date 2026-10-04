// SPIKE inventory part 2 (docs/superpowers/plans/2026-10-05-collab-join-spikes.md):
// on a RECEIVING laptop, is refs.target_ulid the replicated value or recomputed
// by trg_refs_fill_target_ulid from ref_value? Evidence for J17.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  addEntryAsync, setAllocator, readOwnChanges, applyChanges, decodeChange, reindexFts, ownerOf,
} from '@collab-mcp/core';
import { tempStore, laptop } from './helpers.js';
import { acceptChanges, fetchDeliveries } from '../src/deliveries.js';
import type { Store } from '../src/store.js';

function machine(dev: string) {
  const h = laptop();
  let recv = 0;
  return {
    ...h,
    push: (s: Store) => acceptChanges(s, dev, readOwnChanges(h.db, 0)),
    pull(s: Store) {
      for (;;) {
        const r = fetchDeliveries(s, dev, recv, 1000);
        if (r.changes.length) h.db.transaction(() => reindexFts(h.db, applyChanges(h.db, r.changes.map(decodeChange)).entryUlids))();
        recv = r.lastSeq;
        if (!r.more) break;
      }
    },
  };
}
const refsOf = (db: any, ulid: string) =>
  db.prepare(`SELECT ref_value, target_ulid FROM refs WHERE entry_ulid = ? AND ref_type = 'entry' ORDER BY ref_value`).all(ulid);

test('refs: target_ulid travels as a column value; the receiver never re-resolves it from the number', async () => {
  const s = tempStore();
  const L1 = machine('d-1'), L2 = machine('d-2');
  const numbers = [5, 5, 7]; // L2's own note and L1's target both get number 5
  setAllocator({ allocate: async () => numbers.shift()! });
  try {
    // L2 first holds ANOTHER note numbered 5, made earlier so its ULID is lower: a re-resolve by number would pick it.
    const clash = await addEntryAsync(L2.db, { type: 'decision', title: 'clash', summary: 's', module: 'm' });
    const clashUlid = ownerOf(L2.db, clash.id)!.ulid as string;
    await new Promise((r) => setTimeout(r, 5));
    const target = await addEntryAsync(L1.db, { type: 'decision', title: 'target', summary: 's', module: 'm' });
    const targetUlid = ownerOf(L1.db, target.id)!.ulid as string;
    const src = await addEntryAsync(L1.db, {
      type: 'decision', title: 'source', summary: 's', module: 'm',
      refs: [{ ref_type: 'entry', ref_value: `E-${target.id}` }, { ref_type: 'entry', ref_value: 'E-99999' }],
    });
    const srcUlid = ownerOf(L1.db, src.id)!.ulid as string;
    const onL1 = refsOf(L1.db, srcUlid);
    assert.deepEqual(onL1, [{ ref_value: 'E-5', target_ulid: targetUlid }, { ref_value: 'E-99999', target_ulid: null }]);
    // target_ulid is an own, tracked cell of each refs row (the trigger's fill included).
    const cells = (L1.db.prepare(`SELECT val FROM crsql_changes WHERE "table" = 'refs' AND cid = 'target_ulid' AND site_id = crsql_site_id()`).all() as any[]).map((r) => r.val);
    assert.deepEqual(cells.sort(), [null, targetUlid].sort());

    assert.ok(clashUlid < targetUlid);
    L1.push(s.store); L2.pull(s.store);
    assert.deepEqual(refsOf(L2.db, srcUlid), onL1, 'L2 holds exactly L1\'s target_ulid values (no re-resolve, E-643)');
    assert.deepEqual(refsOf(s.store, srcUlid), onL1, 'so does the office');
    // What a by-number reader would get on L2: the clash note, not the target.
    assert.equal((L2.db.prepare(`SELECT ulid FROM entries WHERE id = 5 ORDER BY ulid LIMIT 1`).get() as any).ulid, clashUlid);
  } finally { setAllocator(null); L1.cleanup(); L2.cleanup(); s.cleanup(); }
});
