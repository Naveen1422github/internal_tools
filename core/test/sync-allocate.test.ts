// file: core/test/sync-allocate.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { addEntry, addEntryAsync, type AddEntryArgs } from '../src/ops/add.js';
import { updateEntry } from '../src/ops/update.js';
import { enableSync } from '../src/sync/enable.js';
import { isCrsqliteLoaded, CrsqliteMissingError } from '../src/sync/extension.js';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setAllocator, setAllocationRetry, PostOfficeUnreachableError, type Allocator } from '../src/sync/allocator.js';

/** An in-memory post office counter, idempotent by ulid (what Task 7 builds for real). */
function fakeOffice(seed = 0, behave?: (ulid: string, call: number) => 'answer' | 'drop-after-assign' | 'hang' | 'fail' | 'refuse') {
  const byUlid = new Map<string, number>();
  const calls: string[] = [];
  let counter = seed;
  const allocator: Allocator = {
    allocate(ulid) {
      calls.push(ulid);
      const mode = behave ? behave(ulid, calls.length) : 'answer';
      if (mode === 'hang') return new Promise<number>(() => {});
      if (mode === 'fail') return Promise.reject(new Error('ECONNREFUSED'));
      if (mode === 'refuse') return Promise.reject(Object.assign(new Error('access revoked'), { retriable: false }));
      let id = byUlid.get(ulid);
      if (id === undefined) { id = ++counter; byUlid.set(ulid, id); }
      return mode === 'drop-after-assign' ? Promise.reject(new Error('socket hang up')) : Promise.resolve(id);
    },
  };
  return { allocator, calls, counter: () => counter };
}

const ok: AddEntryArgs = { type: 'decision', title: 't', summary: 's', module: 'm' };
const count = (db: any) => (db.prepare('SELECT COUNT(*) c FROM entries').get() as { c: number }).c;
const BAD: Array<[AddEntryArgs, RegExp]> = [
  [{ ...ok, title: ' ' }, /title is required/],
  [{ ...ok, summary: '' }, /summary is required/],
  [{ ...ok, summary: 'x'.repeat(201) }, /summary exceeds 200/],
  [{ ...ok, type: 'bogus' as any }, /invalid type/],
  [{ ...ok, type: 'rollup' }, /system-generated/],
  [{ ...ok, category: 'Nope' as any }, /invalid category/],
  [{ ...ok, agent: 'Bob' as any }, /invalid agent/],
  [{ ...ok, status: 'resolved' as any }, /invalid status/],
  [{ ...ok, refs: [{ ref_type: 'nope' as any, ref_value: 'x' }] }, /invalid ref_type/],
  [{ ...ok, refs: [{ ref_type: 'file', ref_value: '' }] }, /ref_value/],
];

test('invalid input is refused before a number is asked for', async () => {
  const { db, cleanup } = freshDb({ shared: true });
  const po = fakeOffice();
  try {
    setAllocator(po.allocator);
    for (const [args, msg] of BAD) await assert.rejects(addEntryAsync(db, args), msg);
    assert.equal(po.calls.length, 0, 'no number was consumed');
    assert.equal(count(db), 0);
  } finally { setAllocator(null); cleanup(); }
});

test('sharing off: the same checks, the same messages', async () => {
  const { db, cleanup } = freshDb();
  try { for (const [args, msg] of BAD) await assert.rejects(addEntryAsync(db, args), msg); } finally { cleanup(); }
});

test('1000 saves with 50 invalid: the allocated numbers have no gaps', async () => {
  const { db, cleanup } = freshDb({ shared: true });
  const po = fakeOffice(700);
  try {
    setAllocator(po.allocator);
    const ids: number[] = [];
    let refused = 0;
    for (let i = 0; i < 1000; i++) {
      if (i % 20 === 7) {
        const [args, msg] = BAD[(i / 20 | 0) % BAD.length];
        await assert.rejects(addEntryAsync(db, args), msg);
        refused++;
      } else {
        ids.push((await addEntryAsync(db, { ...ok, title: `n${i}` })).id);
      }
    }
    assert.equal(refused, 50);
    assert.equal(po.calls.length, 950);
    assert.deepEqual([...ids].sort((x, y) => x - y), Array.from({ length: 950 }, (_, k) => 701 + k));
    assert.equal(count(db), 950);
  } finally { setAllocator(null); cleanup(); }
});

test('an answer lost after the post office assigned: the retry reuses the ulid and gets the same number', async () => {
  const { db, cleanup } = freshDb({ shared: true });
  const po = fakeOffice(0, (_u, call) => (call === 1 ? 'drop-after-assign' : 'answer'));
  try {
    setAllocator(po.allocator);
    setAllocationRetry({ delaysMs: [0, 0] });
    const r = await addEntryAsync(db, ok);
    assert.equal(r.id, 1);
    assert.equal(po.calls.length, 2);
    assert.equal(po.calls[0], po.calls[1], 'one ulid for every try');
    assert.equal(po.counter(), 1, 'the counter moved once');
    assert.equal((db.prepare('SELECT ulid FROM entries WHERE id = 1').get() as { ulid: string }).ulid, po.calls[0]);
  } finally { setAllocator(null); setAllocationRetry(null); cleanup(); }
});

test('an unanswered request times out and is retried with the same ulid', async () => {
  const { db, cleanup } = freshDb({ shared: true });
  const po = fakeOffice(0, (_u, call) => (call === 1 ? 'hang' : 'answer'));
  try {
    setAllocator(po.allocator);
    setAllocationRetry({ timeoutMs: 50, delaysMs: [0, 0] });
    assert.equal((await addEntryAsync(db, ok)).id, 1);
    assert.equal(po.calls[0], po.calls[1]);
  } finally { setAllocator(null); setAllocationRetry(null); cleanup(); }
});

test('three failures: refused, nothing written, one ulid used for all three tries', async () => {
  const { db, cleanup } = freshDb({ shared: true });
  const po = fakeOffice(0, () => 'fail');
  try {
    setAllocator(po.allocator);
    setAllocationRetry({ delaysMs: [0, 0] });
    await assert.rejects(addEntryAsync(db, ok), PostOfficeUnreachableError);
    assert.equal(po.calls.length, 3);
    assert.equal(new Set(po.calls).size, 1);
    assert.equal(count(db), 0);
  } finally { setAllocator(null); setAllocationRetry(null); cleanup(); }
});

test('a non-retriable refusal (revoked key) is not retried', async () => {
  const { db, cleanup } = freshDb({ shared: true });
  const po = fakeOffice(0, () => 'refuse');
  try {
    setAllocator(po.allocator);
    await assert.rejects(addEntryAsync(db, ok), /access revoked/);
    assert.equal(po.calls.length, 1);
  } finally { setAllocator(null); cleanup(); }
});

// Go-live bug (E-739 #2): a connection opened BEFORE `sync setup` has no cr-sqlite.
// It used to take a number from the post office and only then fail on the insert,
// burning that number. Writers now load the extension themselves, before asking.
test('a connection opened before sharing was switched on loads cr-sqlite itself; no number is wasted', async () => {
  const t = freshDb();
  const other = new Database(t.path);
  const po = fakeOffice();
  try {
    enableSync(other);
    assert.equal(isCrsqliteLoaded(t.db), false, 'the old connection starts without the extension');
    setAllocator(po.allocator);
    const r = await addEntryAsync(t.db, ok);
    assert.equal(r.id, 1);
    assert.equal(po.calls.length, 1);
    assert.equal(count(t.db), 1);
  } finally {
    setAllocator(null);
    try { other.prepare('SELECT crsql_finalize()').get(); } catch { /* closing anyway */ }
    other.close();
    t.cleanup();
  }
});

test('the extension missing on disk: refused BEFORE a number is asked for', async () => {
  const t = freshDb();
  const other = new Database(t.path);
  const po = fakeOffice();
  const saved = process.env.COLLAB_CRSQLITE_PATH;
  try {
    enableSync(other);
    process.env.COLLAB_CRSQLITE_PATH = join(tmpdir(), 'no-such-crsqlite');
    setAllocator(po.allocator);
    await assert.rejects(addEntryAsync(t.db, ok), CrsqliteMissingError);
    assert.equal(po.calls.length, 0, 'no number was consumed');
    assert.equal(count(other), 0);
  } finally {
    if (saved === undefined) delete process.env.COLLAB_CRSQLITE_PATH; else process.env.COLLAB_CRSQLITE_PATH = saved;
    setAllocator(null);
    try { other.prepare('SELECT crsql_finalize()').get(); } catch { /* closing anyway */ }
    other.close();
    t.cleanup();
  }
});

test('an edit through a connection opened before sharing was switched on works', () => {
  const t = freshDb();
  const other = new Database(t.path);
  try {
    const { id } = addEntry(t.db, ok);
    enableSync(other);
    updateEntry(t.db, { id, summary: 'edited after sharing was switched on' });
    const row = other.prepare('SELECT summary FROM entries WHERE id = ?').get(id) as { summary: string };
    assert.equal(row.summary, 'edited after sharing was switched on');
  } finally {
    try { other.prepare('SELECT crsql_finalize()').get(); } catch { /* closing anyway */ }
    other.close();
    t.cleanup();
  }
});
