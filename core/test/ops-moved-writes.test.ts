import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { addEntry } from '../src/ops/add.js';
import { initModule } from '../src/ops/module.js';
import { editEntry, reassignModule, EntryNotFoundError } from '../src/ops/edit.js';
import { upsertModule, deleteModule } from '../src/ops/module.js';

test('editEntry rewrites fields + links and records a revision', () => {
  const t = freshDb();
  try {
    initModule(t.db, { slug: 'a' }); initModule(t.db, { slug: 'b' });
    const { id } = addEntry(t.db, { type: 'decision', title: 't1', summary: 's1', module: 'a' });
    const r = editEntry(t.db, { id, type: 'gotcha', title: 't2', summary: 's2', description: 'd2', agent: 'User',
      modules: ['b', 'a'], category: undefined, task_id: null, refs: [{ ref_type: 'url', ref_value: 'https://x' }] });
    assert.strictEqual(r.id, id);
    const e = t.db.prepare('SELECT type, title, module FROM entries WHERE id = ?').get(id) as any;
    assert.deepStrictEqual(e, { type: 'gotcha', title: 't2', module: 'b' });
    const revs = (t.db.prepare('SELECT count(*) c FROM entry_revisions').get() as any).c;
    assert.ok(revs >= 1, 'edit recorded a revision');
  } finally { t.cleanup(); }
});

test('editEntry: unknown id throws EntryNotFoundError; bad input throws before writing', () => {
  const t = freshDb();
  try {
    assert.throws(() => editEntry(t.db, { id: 999, type: 'decision', title: 't', summary: 's' }), EntryNotFoundError);
    const { id } = addEntry(t.db, { type: 'decision', title: 't', summary: 's' });
    assert.throws(() => editEntry(t.db, { id, type: 'decision', title: 't', summary: 'x'.repeat(201) }));
    assert.strictEqual((t.db.prepare('SELECT summary FROM entries WHERE id = ?').get(id) as any).summary, 's');
  } finally { t.cleanup(); }
});

test('reassignModule moves the primary module; unknown target throws', () => {
  const t = freshDb();
  try {
    initModule(t.db, { slug: 'a' }); initModule(t.db, { slug: 'b' });
    const { id } = addEntry(t.db, { type: 'decision', title: 't', summary: 's', module: 'a' });
    assert.deepStrictEqual(reassignModule(t.db, [id, id, 4242], 'b'), { updated: 1 });
    assert.strictEqual((t.db.prepare('SELECT module FROM entries WHERE id = ?').get(id) as any).module, 'b');
    assert.throws(() => reassignModule(t.db, [id], 'nope'), /target module 'nope' does not exist/);
  } finally { t.cleanup(); }
});

test('upsertModule inserts then updates; deleteModule refuses a module in use', () => {
  const t = freshDb();
  try {
    upsertModule(t.db, { slug: 'm', name: 'M' });
    upsertModule(t.db, { slug: 'm', name: 'M2', status: 'deprecated' });
    assert.deepStrictEqual(t.db.prepare('SELECT name, status FROM modules WHERE slug = ?').get('m'), { name: 'M2', status: 'deprecated' });
    assert.throws(() => upsertModule(t.db, { slug: 'Bad_Slug' }), /invalid slug/);
    addEntry(t.db, { type: 'decision', title: 't', summary: 's', module: 'm' });
    assert.deepStrictEqual(deleteModule(t.db, 'm'), { deleted: false, entry_count: 1, task_count: 0 });
    upsertModule(t.db, { slug: 'empty' });
    assert.deepStrictEqual(deleteModule(t.db, 'empty'), { deleted: true });
  } finally { t.cleanup(); }
});
