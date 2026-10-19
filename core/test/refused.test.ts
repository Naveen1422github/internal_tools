// file: core/test/refused.test.ts
// RnR S2 R6: local (never synced) refused_changes (0013) + recover/discard (rule 5).
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { migrate, latestMigration, type DB } from '../src/db.js';
import { SYNCED_TABLES } from '../src/sync/enable.js';
import { recordRefusal, listRefused, isRefusedNote, copyRefused, discardRefused, describeRefused, RefusedNotFoundError, TeamTargetError } from '../src/access/refused.js';
import { addEntry } from '../src/ops/add.js';
import { createProject, ProjectNotFoundError } from '../src/projects.js';
import type { WireChange } from '../src/sync/changes.js';

// A cell of entries row `ulid` (pk packed the way cr-sqlite does).
function cell(db: DB, ulid: string, cid: string, val: string | null, col_version = 1): WireChange {
  const pk = (db.prepare(`SELECT crsql_pack_columns(?) AS p`).get(ulid) as { p: Buffer }).p;
  return { table: 'entries', pk: pk.toString('base64'), cid, val, col_version, db_version: 1, site_id: 'AA==', cl: 1, seq: 0 };
}

function setup() {
  const t = freshDb({ shared: true }); // cell pks need the cr-sqlite functions
  migrate(t.db);
  const note = addEntry(t.db, { type: 'decision', title: 'Local title', summary: 'Local summary', project: 'none' });
  return { t, note };
}
const count = (db: DB, table: string, col: string, u: string) =>
  (db.prepare(`SELECT count(*) n FROM ${table} WHERE ${col} = ?`).get(u) as { n: number }).n;

test('0013 is local and latest', () => {
  const t = freshDb();
  try {
    migrate(t.db);
    assert.equal(latestMigration(t.db), '0013_refused_changes');
    assert.ok(!SYNCED_TABLES.includes('refused_changes' as never));
  } finally { t.cleanup(); }
});

test('recordRefusal dedupes a refused new note and updates the reason', () => {
  const { t, note } = setup();
  try {
    const a = recordRefusal(t.db, { noteUlid: note.ulid, projectUlid: null, kind: 'new', key: 'note.create', reason: 'first', cells: [] });
    const b = recordRefusal(t.db, { noteUlid: note.ulid, projectUlid: null, kind: 'new', key: 'note.create', reason: 'second', cells: [] });
    assert.equal(a, b);
    const rows = listRefused(t.db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, 'second');
    assert.ok(isRefusedNote(t.db, note.ulid));
    assert.ok(!isRefusedNote(t.db, 'nope'));
  } finally { t.cleanup(); }
});

test('copyRefused of an edit builds the note from the refused cells into a solo project', async () => {
  const { t, note } = setup();
  try {
    createProject(t.db, { name: 'Solo Box', code: 'SB' });
    const id = recordRefusal(t.db, { noteUlid: note.ulid, projectUlid: null, kind: 'edit', key: 'note.edit', reason: 'no',
      cells: [cell(t.db, note.ulid, 'title', 'Refused title'), cell(t.db, note.ulid, 'description', 'Refused body')] });
    const res = await copyRefused(t.db, id, 'SB');
    assert.equal(res.series, 'SB');
    const row = t.db.prepare(`SELECT title, summary, description FROM entries WHERE series = 'SB' AND id = ?`).get(res.id) as
      { title: string; summary: string; description: string };
    assert.equal(row.title, 'Refused title');
    assert.equal(row.description, 'Refused body');
    assert.equal(row.summary, 'Local summary');
    assert.equal(listRefused(t.db).length, 0);
    assert.equal(count(t.db, 'entries', 'ulid', note.ulid), 1); // an edit keeps the local note
  } finally { t.cleanup(); }
});

test('copyRefused to a team project is refused in plain words', async () => {
  const { t, note } = setup();
  try {
    createProject(t.db, { name: 'Team Box', code: 'TB' });
    t.db.prepare(`UPDATE projects SET mode = 'team' WHERE code = 'TB'`).run();
    const id = recordRefusal(t.db, { noteUlid: note.ulid, projectUlid: null, kind: 'edit', key: null, reason: 'no', cells: [] });
    await assert.rejects(() => copyRefused(t.db, id, 'TB'), /solo project/);
    assert.equal(listRefused(t.db).length, 1);
  } finally { t.cleanup(); }
});

test('discardRefused of a new note removes the local note and its rows', () => {
  const { t, note } = setup();
  try {
    const id = recordRefusal(t.db, { noteUlid: note.ulid, projectUlid: null, kind: 'new', key: null, reason: 'no', cells: [] });
    discardRefused(t.db, id);
    assert.equal(listRefused(t.db).length, 0);
    for (const [tb, col] of [['entries', 'ulid'], ['refs', 'entry_ulid'], ['entry_modules', 'entry_ulid'], ['entry_revisions', 'entry_ulid']]) {
      assert.equal(count(t.db, tb, col, note.ulid), 0, tb);
    }
  } finally { t.cleanup(); }
});

test('discardRefused of an edit keeps the local note', () => {
  const { t, note } = setup();
  try {
    const id = recordRefusal(t.db, { noteUlid: note.ulid, projectUlid: null, kind: 'edit', key: null, reason: 'no', cells: [] });
    discardRefused(t.db, id);
    assert.equal(count(t.db, 'entries', 'ulid', note.ulid), 1);
  } finally { t.cleanup(); }
});

test('copyRefused of a new note keeps its refs, modules, category and status; the original is gone', async () => {
  const { t } = setup();
  try {
    createProject(t.db, { name: 'Solo Box', code: 'SB' });
    const n = addEntry(t.db, { type: 'decision', title: 'Keep me', summary: 's', project: 'none', status: 'draft', module: 'alpha', modules: ['beta'],
      refs: [{ ref_type: 'file', ref_value: 'a/b.ts' }] });
    const id = recordRefusal(t.db, { noteUlid: n.ulid, projectUlid: null, kind: 'new', key: null, reason: 'no', cells: [] });
    const res = await copyRefused(t.db, id, 'SB');
    const row = t.db.prepare(`SELECT ulid, module, status, category FROM entries WHERE series = 'SB' AND id = ?`).get(res.id) as
      { ulid: string; module: string; status: string; category: string };
    assert.equal(row.module, 'alpha');
    assert.equal(row.status, 'draft');
    const mods = (t.db.prepare(`SELECT module FROM entry_modules WHERE entry_ulid = ? ORDER BY module`).all(row.ulid) as Array<{ module: string }>).map((m) => m.module);
    assert.deepEqual(mods, ['alpha', 'beta']);
    assert.equal(count(t.db, 'refs', 'entry_ulid', row.ulid), 1);
    assert.equal(count(t.db, 'entries', 'ulid', n.ulid), 0);
  } finally { t.cleanup(); }
});

test('copyRefused applies a cleared description, the latest version, and ignores other notes cells', async () => {
  const { t } = setup();
  try {
    createProject(t.db, { name: 'Solo Box', code: 'SB' });
    const n = addEntry(t.db, { type: 'decision', title: 'T', summary: 's', description: 'old body', project: 'none' });
    const other = addEntry(t.db, { type: 'decision', title: 'Other', summary: 's', project: 'none' });
    const id = recordRefusal(t.db, { noteUlid: n.ulid, projectUlid: null, kind: 'edit', key: null, reason: 'no', cells: [
      cell(t.db, n.ulid, 'title', 'Newest', 3), cell(t.db, n.ulid, 'title', 'Older', 2),
      cell(t.db, n.ulid, 'description', null, 2), cell(t.db, other.ulid, 'title', 'WRONG NOTE', 9)] });
    const res = await copyRefused(t.db, id, 'SB');
    const row = t.db.prepare(`SELECT title, description FROM entries WHERE series = 'SB' AND id = ?`).get(res.id) as { title: string; description: string | null };
    assert.equal(row.title, 'Newest');
    assert.equal(row.description, null);
  } finally { t.cleanup(); }
});

test('copyRefused keeps the refs the refused cells added (R-32b), once, and only this note\'s', async () => {
  const { t } = setup();
  try {
    createProject(t.db, { name: 'Solo Box', code: 'SB' });
    const n = addEntry(t.db, { type: 'decision', title: 'T', summary: 's', project: 'none', refs: [{ ref_type: 'file', ref_value: 'kept.ts' }] });
    const other = addEntry(t.db, { type: 'decision', title: 'Other', summary: 's', project: 'none' });
    const ref = (u: string, type: string, value: string, cid: string, cl = 1): WireChange => {
      const pk = (t.db.prepare(`SELECT crsql_pack_columns(?, ?, ?) AS p`).get(u, type, value) as { p: Buffer }).p;
      return { table: 'refs', pk: pk.toString('base64'), cid, val: null, col_version: 1, db_version: 1, site_id: 'AA==', cl, seq: 0 };
    };
    // The refused edit added two refs (the laptop's copy was reverted since), plus a cell of a ref
    // the note still has, a removed ref (even cl) and another note's ref.
    const id = recordRefusal(t.db, { noteUlid: n.ulid, projectUlid: null, kind: 'edit', key: 'note.edit.any', reason: 'no', cells: [
      cell(t.db, n.ulid, 'title', 'T, edited', 2),
      ref(n.ulid, 'file', 'added.ts', '-1'), ref(n.ulid, 'file', 'added.ts', 'created_at'),
      ref(n.ulid, 'task', 'T-9', '-1'), ref(n.ulid, 'file', 'kept.ts', '-1'),
      ref(n.ulid, 'file', 'removed.ts', '-1', 2), ref(other.ulid, 'file', 'not-mine.ts', '-1')] });
    const res = await copyRefused(t.db, id, 'SB');
    const u = (t.db.prepare(`SELECT ulid FROM entries WHERE series = 'SB' AND id = ?`).get(res.id) as { ulid: string }).ulid;
    const refs = (t.db.prepare(`SELECT ref_type, ref_value FROM refs WHERE entry_ulid = ? ORDER BY ref_type, ref_value`).all(u) as Array<{ ref_type: string; ref_value: string }>)
      .map((r) => `${r.ref_type}:${r.ref_value}`);
    assert.deepEqual(refs, ['file:added.ts', 'file:kept.ts', 'task:T-9']);
  } finally { t.cleanup(); }
});

test('describeRefused: the note\'s number, else its title, else "-"; the project code, else "-"', () => {
  const { t, note } = setup();
  try {
    createProject(t.db, { name: 'Solo Box', code: 'SB' });
    const sb = (t.db.prepare(`SELECT ulid FROM projects WHERE code = 'SB'`).get() as { ulid: string }).ulid;
    const n = addEntry(t.db, { type: 'decision', title: 'In SB', summary: 's', project: 'SB' });
    assert.deepEqual(describeRefused(t.db, { note_ulid: n.ulid, project_ulid: sb }), { note: `SB-${n.id}`, project_code: 'SB' });
    t.db.prepare(`UPDATE entries SET id = NULL WHERE ulid = ?`).run(n.ulid);
    assert.deepEqual(describeRefused(t.db, { note_ulid: n.ulid, project_ulid: null }), { note: 'In SB', project_code: '-' });
    assert.deepEqual(describeRefused(t.db, { note_ulid: null, project_ulid: '01JZZZZZZZZZZZZZZZZZZZZZZZ' }), { note: '-', project_code: '-' });
    assert.deepEqual(describeRefused(t.db, { note_ulid: '01JZZZZZZZZZZZZZZZZZZZZZZZ', project_ulid: null }), { note: '-', project_code: '-' });
    assert.ok(note.ulid);
  } finally { t.cleanup(); }
});

test('refused errors carry a class each, with the same words', async () => {
  const { t, note } = setup();
  try {
    createProject(t.db, { name: 'Team Box', code: 'TB' });
    t.db.prepare(`UPDATE projects SET mode = 'team', team = 'fp' WHERE code = 'TB'`).run();
    const id = recordRefusal(t.db, { noteUlid: note.ulid, projectUlid: null, kind: 'edit', key: null, reason: 'no', cells: [] });
    assert.throws(() => discardRefused(t.db, 'nope'), (e: unknown) => e instanceof RefusedNotFoundError && (e as Error).message === '[collab] no refused change "nope" on this laptop.');
    await assert.rejects(copyRefused(t.db, 'nope', 'TB'), RefusedNotFoundError);
    await assert.rejects(copyRefused(t.db, id, 'TB'), (e: unknown) => e instanceof TeamTargetError && /^\[collab\] TB is a team project\. Copy this note into a solo project instead/.test((e as Error).message));
    await assert.rejects(copyRefused(t.db, id, 'ZZ'), ProjectNotFoundError);
  } finally { t.cleanup(); }
});
