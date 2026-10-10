// file: core/test/pending-save.test.ts
// Stage C (E-820): saving never waits on the post office. A team note or a
// shared-E note that can't get its number in one quick try is saved pending
// (id NULL) and the courier numbers it later, with the same ulid (E-713).
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { migrate } from '../src/db.js';
import { addEntry, addEntryAsync } from '../src/ops/add.js';
import { searchEntries } from '../src/ops/search.js';
import { setAllocator, setAllocationRetry, type Allocator } from '../src/sync/allocator.js';
import { createProject } from '../src/projects.js';
import { newUlid } from '../src/ulid.js';

const note = (title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'decision' as const, title, summary: 's', ...extra });

function sharedNotebook() {
  const t = freshDb({ shared: true });
  migrate(t.db);
  return t;
}
function teamProject(db: any, code = 'SH', name = 'Support hub') {
  const ulid = newUlid();
  db.prepare(`INSERT INTO projects (ulid, name, code, mode, team) VALUES (?, ?, ?, 'team', 'fp')`).run(ulid, name, code);
  return ulid;
}
const down: Allocator = { allocate: async () => { throw new Error('ECONNREFUSED 127.0.0.1:7443'); } };

test('office down, E note: saved pending, findable, with the reason', async () => {
  const t = sharedNotebook();
  try {
    setAllocator(down);
    const r = await addEntryAsync(t.db, note('pending e', { module: 'portfolio' }));
    assert.equal(r.id, null);
    assert.equal(r.pending, true);
    assert.equal(r.series, 'E');
    assert.match(r.pendingReason ?? '', /ECONNREFUSED/);
    const row = t.db.prepare(`SELECT id, ulid FROM entries WHERE title = 'pending e'`).get() as any;
    assert.equal(row.id, null);
    assert.equal(row.ulid, r.ulid);
    const found = searchEntries(t.db, { query: 'pending', kind: 'any', include_deprecated: false, limit: 10 });
    assert.ok(found.results.some((e: any) => e.title === 'pending e'), 'FTS finds the pending note');
  } finally { setAllocator(null); t.cleanup(); }
});

test('office down, team note: saved pending, never numbered locally (rule 4)', async () => {
  const t = sharedNotebook();
  try {
    teamProject(t.db);
    setAllocator(down);
    const r = await addEntryAsync(t.db, note('team pending', { project: 'SH' }));
    assert.deepEqual([r.id, r.pending, r.series], [null, true, 'SH']);
    assert.equal(t.db.prepare(`SELECT 1 FROM local_counters WHERE name = 'series:SH'`).get(), undefined);
    const row = t.db.prepare(`SELECT id, series, project_ulid FROM entries WHERE ulid = ?`).get(r.ulid) as any;
    assert.equal(row.id, null);
    assert.equal(row.series, 'SH');
  } finally { setAllocator(null); t.cleanup(); }
});

test('office up, team note: numbered by the office in its series', async () => {
  const t = sharedNotebook();
  try {
    teamProject(t.db);
    const seen: Array<[string, string]> = [];
    setAllocator({ allocate: async (u, s) => { seen.push([u, s]); return 5; } });
    const r = await addEntryAsync(t.db, note('team up', { project: 'SH' }));
    assert.deepEqual([r.id, r.pending, r.series], [5, false, 'SH']);
    assert.equal(seen.length, 1);
    assert.equal(seen[0][1], 'SH');
    assert.equal(seen[0][0], r.ulid);
  } finally { setAllocator(null); t.cleanup(); }
});

test('solo note, sharing on, office down: no allocator call, numbered P1-1', async () => {
  const t = sharedNotebook();
  let calls = 0;
  try {
    createProject(t.db, { name: 'mine', code: 'P1' });
    setAllocator({ allocate: async () => { calls++; throw new Error('down'); } });
    const r = await addEntryAsync(t.db, note('solo', { project: 'P1', module: 'portfolio' }));
    assert.equal(`${r.series}-${r.id}`, 'P1-1');
    assert.equal(r.pending, false);
    assert.equal(calls, 0);
  } finally { setAllocator(null); t.cleanup(); }
});

test('one try only: a save never retries; the courier does', async () => {
  const t = sharedNotebook();
  let calls = 0;
  try {
    setAllocationRetry({ delaysMs: [0, 0] }); // the general policy must not leak into saves
    setAllocator({ allocate: async () => { calls++; if (calls === 1) throw new Error('blip'); return 9; } });
    const r = await addEntryAsync(t.db, note('once'));
    assert.equal(calls, 1);
    assert.equal(r.pending, true);
    assert.equal(r.id, null);
  } finally { setAllocator(null); setAllocationRetry(null); t.cleanup(); }
});

test('synchronous addEntry on a shared notebook saves an E note pending instead of throwing', () => {
  const t = sharedNotebook();
  try {
    const r = addEntry(t.db, note('sync path'));
    assert.deepEqual([r.id, r.pending, r.series], [null, true, 'E']);
    assert.equal((t.db.prepare(`SELECT id FROM entries WHERE ulid = ?`).get(r.ulid) as any).id, null);
  } finally { t.cleanup(); }
});

test('no post office configured: pending with that reason', async () => {
  const t = sharedNotebook();
  try {
    setAllocator(null);
    const r = await addEntryAsync(t.db, note('nowhere'));
    assert.equal(r.pending, true);
    assert.match(r.pendingReason ?? '', /no post office connection/);
  } finally { t.cleanup(); }
});
