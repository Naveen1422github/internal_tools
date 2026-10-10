// file: core/test/add-project.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { migrate } from '../src/db.js';
import { addEntryAsync } from '../src/ops/add.js';
import { setAllocator } from '../src/sync/allocator.js';
import { createProject, ProjectNotFoundError } from '../src/projects.js';

const note = (title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'decision' as const, title, summary: 's', ...extra });

test('a note written into a solo project is numbered SH-1, SH-2 and carries the project', async () => {
  const t = freshDb();
  try {
    migrate(t.db);
    const p = createProject(t.db, { name: 'supporthub', code: 'SH' });
    const a = await addEntryAsync(t.db, note('one', { project: 'SH' }));
    assert.equal(a.series, 'SH');
    assert.equal(a.id, 1);
    assert.deepEqual(a.project, { code: 'SH', name: 'supporthub', mode: 'solo' });
    const row = t.db.prepare(`SELECT series, project_ulid FROM entries WHERE id = 1 AND series = 'SH'`).get() as any;
    assert.deepEqual(row, { series: 'SH', project_ulid: p.ulid });
    const b = await addEntryAsync(t.db, note('two', { project: p.ulid }));
    assert.equal(`${b.series}-${b.id}`, 'SH-2');
    const e = await addEntryAsync(t.db, note('plain'));
    assert.equal(e.series, 'E');
    assert.equal(e.project, null);
    assert.equal(e.id, 1, 'the E series counts on its own');
  } finally { t.cleanup(); }
});

test('an unknown project is refused, listing the known codes', async () => {
  const t = freshDb();
  try {
    migrate(t.db);
    createProject(t.db, { name: 'supporthub', code: 'SH' });
    createProject(t.db, { name: 'naveen', code: 'NV' });
    await assert.rejects(addEntryAsync(t.db, note('x', { project: 'ZZ' })), (e: Error) =>
      e instanceof ProjectNotFoundError && /NV/.test(e.message) && /SH/.test(e.message));
    assert.equal((t.db.prepare('SELECT COUNT(*) c FROM entries').get() as any).c, 0);
  } finally { t.cleanup(); }
});

test('sync-enabled notebook, office unreachable: a project note saves with no allocator call; an E note goes pending (stage C, E-820)', async () => {
  const t = freshDb({ shared: true });
  let calls = 0;
  setAllocator({ allocate: async () => { calls++; throw new Error('office down'); } });
  try {
    migrate(t.db);
    createProject(t.db, { name: 'supporthub', code: 'SH' });
    const a = await addEntryAsync(t.db, note('solo note', { project: 'SH', module: 'portfolio' }));
    assert.equal(`${a.series}-${a.id}`, 'SH-1');
    assert.equal(calls, 0, 'no network call while saving a solo note');
    const e = await addEntryAsync(t.db, note('E note', { module: 'portfolio' }));
    assert.equal(e.pending, true);
    assert.ok(calls >= 1, 'the E note went through the allocator as today');
    assert.equal((t.db.prepare(`SELECT COUNT(*) c FROM entries WHERE title = 'E note' AND id IS NULL`).get() as any).c, 1);
  } finally { setAllocator(null); t.cleanup(); }
});

test('the sync bar never counts a solo-project note as waiting to send', async () => {
  const t = freshDb({ shared: true });
  setAllocator({ allocate: async () => 41 });
  try {
    migrate(t.db);
    const { unsentSharedCount } = await import('../src/sync/overview.js');
    const { setSyncValue } = await import('../src/sync/state.js');
    setSyncValue(t.db, 'shared_modules', JSON.stringify(['portfolio']));
    createProject(t.db, { name: 'supporthub', code: 'SH' });
    await addEntryAsync(t.db, note('solo note', { project: 'SH', module: 'portfolio' }));
    assert.equal(unsentSharedCount(t.db), 0);
    await addEntryAsync(t.db, note('E note', { module: 'portfolio' }));
    assert.ok(unsentSharedCount(t.db) > 0);
  } finally { setAllocator(null); t.cleanup(); }
});
