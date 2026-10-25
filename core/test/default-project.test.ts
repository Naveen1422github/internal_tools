// file: core/test/default-project.test.ts
// Where a note with no project goes (local-first Task 3): the private default, never E by accident.
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { migrate } from '../src/db.js';
import { addEntry, addEntryAsync, noteDestination } from '../src/ops/add.js';
import { setAllocator } from '../src/sync/allocator.js';
import { setSyncValue } from '../src/sync/state.js';
import { createProject, findProject } from '../src/projects.js';
import { getDefaultProject, setDefaultProject, ensureDefaultProject } from '../src/ops/default-project.js';

function world(adopted = true) {
  const t = freshDb();
  migrate(t.db);
  if (adopted) { setSyncValue(t.db, 'enabled', '1'); setSyncValue(t.db, 'e_project', '1'); }
  return t;
}
const note = { type: 'decision' as const, title: 't', summary: 's' };

test('default: adopted + sync, no binding/folder, office down: a PS note with a number, not pending', async () => {
  const { db, cleanup } = world();
  setAllocator({ allocate: async () => { throw new Error('office down'); } });
  try {
    const r = await addEntryAsync(db, note);
    assert.equal(r.series, 'PS');
    assert.equal(r.pending, false);
    assert.equal(typeof r.id, 'number');
  } finally { setAllocator(null); cleanup(); }
});

test('default: sync enabled but E not adopted: a no-project note is still E and pending (as today)', async () => {
  const { db, cleanup } = world(false);
  setSyncValue(db, 'enabled', '1');
  setAllocator({ allocate: async () => { throw new Error('office down'); } });
  try {
    const r = await addEntryAsync(db, note);
    assert.equal(r.series, 'E');
    assert.equal(r.pending, true);
  } finally { setAllocator(null); cleanup(); }
});

test('default: never-joined notebook: still E with a local number', async () => {
  const { db, cleanup } = world(false);
  const r = await addEntryAsync(db, note);
  assert.equal(r.series, 'E');
  assert.equal(typeof r.id, 'number');
  assert.equal(getDefaultProject(db), null);
  cleanup();
});

test('default: setDefaultProject refuses E and a team project', () => {
  const { db, cleanup } = world();
  const msg = /the default must be a project that isn't shared/;
  assert.throws(() => setDefaultProject(db, 'E'), msg);
  const p = createProject(db, { name: 'Team', code: 'TM' });
  db.prepare(`UPDATE projects SET mode='team' WHERE ulid=?`).run(p.ulid);
  assert.throws(() => setDefaultProject(db, 'TM'), msg);
  cleanup();
});

test('default: setDefaultProject stores a private project; getDefaultProject reads it; new notes use it', () => {
  const { db, cleanup } = world();
  createProject(db, { name: 'Mine', code: 'MN' });
  assert.equal(setDefaultProject(db, 'mn').code, 'MN');
  assert.equal(getDefaultProject(db)?.code, 'MN');
  assert.equal(addEntry(db, note).series, 'MN');
  cleanup();
});

test('default: ensureDefaultProject creates PS "Personal" once, then reuses it', () => {
  const { db, cleanup } = world();
  const a = ensureDefaultProject(db);
  assert.equal(a.code, 'PS'); assert.equal(a.name, 'Personal'); assert.equal(a.mode, 'solo');
  assert.equal(ensureDefaultProject(db).ulid, a.ulid);
  cleanup();
});

test('default: an existing private PS is used, not recreated', () => {
  const { db, cleanup } = world();
  const ps = createProject(db, { name: 'My stuff', code: 'PS' });
  assert.equal(ensureDefaultProject(db).ulid, ps.ulid);
  cleanup();
});

test('default: PS that is a team project: nothing created, a clear error', () => {
  const { db, cleanup } = world();
  const p = createProject(db, { name: 'Shared', code: 'PS' });
  db.prepare(`UPDATE projects SET mode='team' WHERE ulid=?`).run(p.ulid);
  assert.throws(() => ensureDefaultProject(db), /collab project default <CODE>/);
  assert.equal(db.prepare(`SELECT count(*) c FROM projects`).get().c, 1);
  cleanup();
});

test('default: noteDestination says why "default", writes nothing when PS does not exist yet', () => {
  const { db, cleanup } = world();
  const d = noteDestination(db, {}, { folder: false });
  assert.equal(d.why, 'default');
  assert.equal(d.line, 'It goes into PS (Personal): no project was named for it, and PS is private.');
  assert.equal(findProject(db, 'PS'), null);
  cleanup();
});

test('default: noteDestination before adoption is unchanged (none)', () => {
  const { db, cleanup } = world(false);
  assert.equal(noteDestination(db, {}, { folder: false }).why, 'none');
  cleanup();
});

test('default: defaultProjectLine is honest before and after adoption', async () => {
  const { defaultProjectLine } = await import('../src/ops/default-project.js');
  const a = world(false);
  const mn = createProject(a.db, { name: 'Mine', code: 'MN' });
  assert.match(defaultProjectLine(a.db, mn, true), /MN \(Mine\) is saved as your default\. Until emp1st \(E\) is shared, notes with no project still go to E\./);
  assert.doesNotMatch(defaultProjectLine(a.db, mn, true), /now go to/);
  a.cleanup();
  const b = world(true);
  const m2 = createProject(b.db, { name: 'Mine', code: 'MN' });
  assert.equal(defaultProjectLine(b.db, m2, true), 'New notes with no project now go to MN (Mine).');
  assert.equal(defaultProjectLine(b.db, m2, false), 'New notes with no project go to MN (Mine).');
  b.cleanup();
});
