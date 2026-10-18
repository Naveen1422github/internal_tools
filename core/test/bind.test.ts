// file: core/test/bind.test.ts
// Module -> project binding (0011): a note's project follows its primary module.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, dbVersion } from './helpers/sync.js';
import { migrate, migrateTo, latestMigration } from '../src/db.js';
import { addEntry, addEntryAsync } from '../src/ops/add.js';
import { initModule } from '../src/ops/module.js';
import { bindModule, unbindModule, listBindings, boundProjectFor, bindChangeLine } from '../src/ops/bind.js';
import { createProject, markProjectLeft, ReadOnlyNoteError } from '../src/projects.js';
import { SYNCED_TABLES } from '../src/sync/enable.js';
import { hasProjectModules } from '../src/schema.js';

const note = (title: string, extra: Record<string, unknown> = {}) => ({ type: 'decision' as const, title, summary: 's', ...extra });

function world() {
  const t = freshDb();
  migrate(t.db);
  initModule(t.db, { slug: 'jarvis' });
  initModule(t.db, { slug: 'portfolio' });
  const folder = mkdtempSync(join(tmpdir(), 'collab-bind-'));
  return { ...t, folder, done: () => { t.cleanup(); rmSync(folder, { recursive: true, force: true }); } };
}

/** Run fn with the process "in" a folder whose .collab names `projectUlid`. */
async function inFolder<T>(folder: string, projectUlid: string, fn: () => Promise<T>): Promise<T> {
  writeFileSync(join(folder, '.collab'), `notebook = x\nproject = ${projectUlid}\n`);
  const saved = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = folder;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved; }
}

const teamRow = (db: any) =>
  db.prepare(`INSERT INTO projects (ulid, name, code, mode, team) VALUES ('01JTEAM', 'team', 'TM', 'team', 'fp')`).run();

test('bind, list, rebind and unbind report what changed', () => {
  const w = world();
  try {
    createProject(w.db, { name: 'Jarvis', code: 'JV' });
    createProject(w.db, { name: 'Other', code: 'OT' });
    assert.deepEqual(bindModule(w.db, 'jarvis', 'jv'), { module: 'jarvis', from: null, to: 'JV' });
    assert.equal(boundProjectFor(w.db, 'jarvis')!.code, 'JV');
    assert.equal(boundProjectFor(w.db, 'portfolio'), null);
    assert.deepEqual(bindModule(w.db, 'jarvis', 'OT'), { module: 'jarvis', from: 'JV', to: 'OT' });
    assert.deepEqual(listBindings(w.db).map((b) => [b.module, b.project_code]), [['jarvis', 'OT']]);
    assert.match(bindChangeLine({ module: 'jarvis', from: 'JV', to: 'OT' }), /was bound to JV; now bound to OT/);
    assert.deepEqual(unbindModule(w.db, 'jarvis'), { module: 'jarvis', from: 'OT', to: null });
    assert.deepEqual(listBindings(w.db), []);
    assert.deepEqual(unbindModule(w.db, 'jarvis'), { module: 'jarvis', from: null, to: null });
  } finally { w.done(); }
});

test('bind refuses an unknown module, an unknown project and a left team', () => {
  const w = world();
  try {
    createProject(w.db, { name: 'Jarvis', code: 'JV' });
    assert.throws(() => bindModule(w.db, 'nope', 'JV'), /no module "nope".*Known: jarvis, portfolio/);
    assert.throws(() => bindModule(w.db, 'jarvis', 'ZZ'), /no project "ZZ"/);
    teamRow(w.db);
    markProjectLeft(w.db, 'TM');
    assert.throws(() => bindModule(w.db, 'jarvis', 'TM'), ReadOnlyNoteError);
    assert.deepEqual(listBindings(w.db), []);
  } finally { w.done(); }
});

test('precedence: explicit project > binding > folder > E; "none" beats the binding', async () => {
  const w = world();
  try {
    createProject(w.db, { name: 'Jarvis', code: 'JV' });
    const fo = createProject(w.db, { name: 'Folder', code: 'FO' });
    createProject(w.db, { name: 'Explicit', code: 'EX' });
    bindModule(w.db, 'jarvis', 'JV');
    await inFolder(w.folder, fo.ulid, async () => {
      assert.equal((await addEntryAsync(w.db, note('bound beats folder', { module: 'jarvis' }))).series, 'JV');
      assert.equal((await addEntryAsync(w.db, note('explicit beats binding', { module: 'jarvis', project: 'EX' }))).series, 'EX');
      assert.equal((await addEntryAsync(w.db, note('none beats binding', { module: 'jarvis', project: 'none' }))).series, 'E');
      assert.equal((await addEntryAsync(w.db, note('unbound module: folder', { module: 'portfolio' }))).series, 'FO');
      assert.equal((await addEntryAsync(w.db, note('no module: folder'))).series, 'FO');
      const sec = await addEntryAsync(w.db, note('secondary module ignored', { module: 'portfolio', modules: ['jarvis'] }));
      assert.equal(sec.series, 'FO');
    });
    assert.equal((await addEntryAsync(w.db, note('unbound, no folder'))).series, 'E');
    assert.equal(addEntry(w.db, note('sync addEntry follows binding', { module: 'jarvis' })).series, 'JV');
    assert.equal(addEntry(w.db, note('sync addEntry unbound', { module: 'portfolio' })).series, 'E');
  } finally { w.done(); }
});

test('a binding to a project that was later left fails loudly, never falls back', async () => {
  const w = world();
  try {
    teamRow(w.db);
    bindModule(w.db, 'jarvis', 'TM');
    markProjectLeft(w.db, 'TM');
    const fo = createProject(w.db, { name: 'Folder', code: 'FO' });
    await inFolder(w.folder, fo.ulid, async () => {
      await assert.rejects(addEntryAsync(w.db, note('x', { module: 'jarvis' })), ReadOnlyNoteError);
      assert.throws(() => addEntry(w.db, note('y', { module: 'jarvis' })), ReadOnlyNoteError);
      assert.equal((await addEntryAsync(w.db, note('explicit still works', { module: 'jarvis', project: 'FO' }))).series, 'FO');
    });
  } finally { w.done(); }
});

test('project_modules is local: not a CRR, not synced, no tracked change on a shared notebook', () => {
  assert.ok(!(SYNCED_TABLES as readonly string[]).includes('project_modules'));
  const t = freshDb({ shared: true });
  try {
    migrate(t.db);
    initModule(t.db, { slug: 'jarvis' });
    createProject(t.db, { name: 'Jarvis', code: 'JV' });
    const v0 = dbVersion(t.db);
    bindModule(t.db, 'jarvis', 'JV');
    unbindModule(t.db, 'jarvis');
    bindModule(t.db, 'jarvis', 'JV');
    assert.equal(dbVersion(t.db), v0, 'binding writes no tracked change');
    assert.equal((t.db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name = 'project_modules__crsql_clock'`).get() as any).n, 0);
    const leaked = t.db.prepare(`SELECT COUNT(*) n FROM crsql_changes WHERE "table" = 'project_modules'`).get() as { n: number };
    assert.equal(leaked.n, 0);
  } finally { t.cleanup(); }
});

test('migration 0010 -> 0011 keeps every note; latest = 0011', () => {
  const t = freshDb();
  try {
    migrateTo(t.db, '0010');
    assert.equal(hasProjectModules(t.db), false);
    createProject(t.db, { name: 'Jarvis', code: 'JV' });
    initModule(t.db, { slug: 'jarvis' });
    addEntry(t.db, note('one', { project: 'JV' }));
    addEntry(t.db, note('two'));
    assert.deepEqual(listBindings(t.db), []);
    assert.throws(() => bindModule(t.db, 'jarvis', 'JV'), /needs migration 0011/);
    migrate(t.db);
    assert.equal(latestMigration(t.db), '0013_refused_changes');
    assert.equal((t.db.prepare(`SELECT COUNT(*) n FROM entries`).get() as any).n, 2);
    assert.equal(bindModule(t.db, 'jarvis', 'JV').to, 'JV');
  } finally { t.cleanup(); }
});
