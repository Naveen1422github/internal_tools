// file: core/test/current-project.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb } from './helpers/sync.js';
import { migrate, findCollabFile } from '../src/db.js';
import { addEntryAsync } from '../src/ops/add.js';
import { createProject, currentProject, ProjectNotFoundError } from '../src/projects.js';

function world() {
  const t = freshDb();
  migrate(t.db);
  const root = mkdtempSync(join(tmpdir(), 'collab-current-'));
  return { ...t, root, done: () => { t.cleanup(); rmSync(root, { recursive: true, force: true }); } };
}
const env = (extra: Record<string, string> = {}) => ({ ...extra }) as NodeJS.ProcessEnv;

test('.collab with notebook and project -> currentProject returns it', () => {
  const w = world();
  try {
    const p = createProject(w.db, { name: 'supporthub', code: 'SH' });
    writeFileSync(join(w.root, '.collab'), `notebook = x\nproject = ${p.ulid}  # SH supporthub\n`);
    mkdirSync(join(w.root, 'sub'));
    assert.deepEqual(findCollabFile(join(w.root, 'sub')), { file: join(w.root, '.collab'), name: 'x', project: p.ulid });
    assert.equal(currentProject(w.db, { cwd: join(w.root, 'sub'), env: env() })!.ulid, p.ulid);
  } finally { w.done(); }
});

test('.collab with only a notebook line -> no current project (today\'s behaviour)', () => {
  const w = world();
  try {
    writeFileSync(join(w.root, '.collab'), 'notebook = x\n');
    assert.equal(findCollabFile(w.root)!.project, null);
    assert.equal(currentProject(w.db, { cwd: w.root, env: env() }), null);
  } finally { w.done(); }
});

test('no .collab at all -> no current project', () => {
  const w = world();
  try { assert.equal(currentProject(w.db, { cwd: w.root, env: env() }), null); } finally { w.done(); }
});

test('.collab names a project that is not in this notebook -> error naming the file and collab project list', () => {
  const w = world();
  try {
    writeFileSync(join(w.root, '.collab'), 'notebook = x\nproject = 01ARZ3NDEKTSV4RRFFQ69G5FAV\n');
    assert.throws(() => currentProject(w.db, { cwd: w.root, env: env() }), (e: Error) =>
      e instanceof ProjectNotFoundError && e.message.includes(join(w.root, '.collab')) && e.message.includes('collab project list'));
  } finally { w.done(); }
});

test('CLAUDE_PROJECT_DIR wins over the working folder', () => {
  const w = world();
  try {
    const p = createProject(w.db, { name: 'supporthub', code: 'SH' });
    const proj = join(w.root, 'proj'); const elsewhere = join(w.root, 'elsewhere');
    mkdirSync(proj); mkdirSync(elsewhere);
    writeFileSync(join(proj, '.collab'), `notebook = x\nproject = ${p.ulid}\n`);
    assert.equal(currentProject(w.db, { cwd: elsewhere, env: env() }), null);
    assert.equal(currentProject(w.db, { cwd: elsewhere, env: env({ CLAUDE_PROJECT_DIR: proj }) })!.code, 'SH');
  } finally { w.done(); }
});

test('a .collab with only project = and no notebook = keeps today\'s error text', () => {
  const w = world();
  try {
    writeFileSync(join(w.root, '.collab'), 'project = 01ARZ3NDEKTSV4RRFFQ69G5FAV\n');
    assert.throws(() => findCollabFile(w.root), /has no "notebook = <name>" line/);
  } finally { w.done(); }
});

test('addEntryAsync defaults to the current project; project "none" writes an E note', async () => {
  const w = world();
  const saved = { cwd: process.cwd(), cpd: process.env.CLAUDE_PROJECT_DIR };
  try {
    const p = createProject(w.db, { name: 'supporthub', code: 'SH' });
    writeFileSync(join(w.root, '.collab'), `notebook = x\nproject = ${p.ulid}\n`);
    delete process.env.CLAUDE_PROJECT_DIR;
    process.chdir(w.root);
    const a = await addEntryAsync(w.db, { type: 'decision', title: 'here', summary: 's' });
    assert.equal(`${a.series}-${a.id}`, 'SH-1');
    const b = await addEntryAsync(w.db, { type: 'decision', title: 'escape', summary: 's', project: 'none' });
    assert.equal(b.series, 'E');
    assert.equal(b.project, null);
  } finally {
    process.chdir(saved.cwd);
    if (saved.cpd === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved.cpd;
    w.done();
  }
});

test('a project cannot take the reserved code NONE', () => {
  const w = world();
  try { assert.throws(() => createProject(w.db, { name: 'n', code: 'none' }), /reserved/); } finally { w.done(); }
});
