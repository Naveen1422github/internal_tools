import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveDbPath, findCollabFile, NoNotebookError, UnknownNotebookError, describeResolution } from '../src/db.js';
import { addNotebook } from '../src/notebooks.js';

function world() {
  const root = mkdtempSync(join(tmpdir(), 'collab-choice-'));
  const data = join(root, 'data');
  const proj = join(root, 'frontend2');
  const nested = join(proj, 'ingxt-supportHub', 'server');
  mkdirSync(nested, { recursive: true });
  addNotebook('emp1st', join(root, 'emp1st.db'), data);
  addNotebook('supporthub', join(root, 'sh.db'), data);
  return { root, data, proj, nested, done: () => rmSync(root, { recursive: true, force: true }) };
}
const env = (o: Record<string, string> = {}) => ({ ...o }) as NodeJS.ProcessEnv;

test('explicit argument beats everything', () => {
  const w = world();
  try {
    const r = resolveDbPath('/x.db', { cwd: w.proj, env: env({ COLLAB_DB_PATH: '/e.db', COLLAB_NOTEBOOK: 'emp1st' }), dataDir: w.data });
    assert.equal(r.source, 'argument');
    assert.equal(r.path, '/x.db');
  } finally { w.done(); }
});

test('--notebook (COLLAB_NOTEBOOK) beats COLLAB_DB_PATH; unknown name is an error, not a fall-through', () => {
  const w = world();
  try {
    const r = resolveDbPath(undefined, { cwd: w.proj, env: env({ COLLAB_NOTEBOOK: 'supporthub', COLLAB_DB_PATH: '/e.db' }), dataDir: w.data });
    assert.deepEqual([r.source, r.name, r.path], ['notebook-flag', 'supporthub', resolve(w.root, 'sh.db')]);
    assert.throws(() => resolveDbPath(undefined, { cwd: w.proj, env: env({ COLLAB_NOTEBOOK: 'nope' }), dataDir: w.data }),
      (e: any) => e instanceof UnknownNotebookError && e.known.join() === 'emp1st,supporthub');
  } finally { w.done(); }
});

test('nearest .collab wins over a parent one', () => {
  const w = world();
  try {
    writeFileSync(join(w.proj, '.collab'), 'notebook = emp1st\n');
    writeFileSync(join(w.proj, 'ingxt-supportHub', '.collab'), '# team notes\nnotebook = supporthub\n');
    const inner = resolveDbPath(undefined, { cwd: w.nested, env: env(), dataDir: w.data });
    assert.deepEqual([inner.source, inner.name], ['collab-file', 'supporthub']);
    assert.equal(inner.collabFile, join(w.proj, 'ingxt-supportHub', '.collab'));
    const outer = resolveDbPath(undefined, { cwd: w.proj, env: env(), dataDir: w.data });
    assert.equal(outer.name, 'emp1st');
    assert.match(describeResolution(inner), /^supporthub \(from \.collab in .*ingxt-supportHub\)$/);
  } finally { w.done(); }
});

test('a .collab naming an unknown notebook is an error with the known names', () => {
  const w = world();
  try {
    writeFileSync(join(w.proj, '.collab'), 'notebook = typo\n');
    assert.throws(() => resolveDbPath(undefined, { cwd: w.proj, env: env(), dataDir: w.data }), /typo.*emp1st, supporthub/s);
  } finally { w.done(); }
});

test('COLLAB_DB_PATH wins over .collab but a disagreement is reported as a clash', () => {
  const w = world();
  try {
    writeFileSync(join(w.proj, '.collab'), 'notebook = supporthub\n');
    const r = resolveDbPath(undefined, { cwd: w.proj, env: env({ COLLAB_DB_PATH: join(w.root, 'emp1st.db') }), dataDir: w.data });
    assert.equal(r.source, 'COLLAB_DB_PATH');
    assert.equal(r.name, 'emp1st');
    assert.deepEqual(r.clash && [r.clash.collabName, r.clash.collabPath], ['supporthub', resolve(w.root, 'sh.db')]);
    const agree = resolveDbPath(undefined, { cwd: w.proj, env: env({ COLLAB_DB_PATH: join(w.root, 'sh.db') }), dataDir: w.data });
    assert.equal(agree.clash, null);
  } finally { w.done(); }
});

test('./collab.db only when it exists; then the default; then a clear error', () => {
  const w = world();
  try {
    const d = resolveDbPath(undefined, { cwd: w.proj, env: env(), dataDir: w.data });
    assert.deepEqual([d.source, d.name], ['default', 'emp1st']);
    writeFileSync(join(w.proj, 'collab.db'), '');
    const c = resolveDbPath(undefined, { cwd: w.proj, env: env(), dataDir: w.data });
    assert.deepEqual([c.source, c.path], ['cwd-existing', join(w.proj, 'collab.db')]);
    const empty = join(w.root, 'empty-data');
    assert.throws(() => resolveDbPath(undefined, { cwd: w.nested, env: env(), dataDir: empty }),
      (e: any) => e instanceof NoNotebookError && /collab notebook/.test(e.message));
    const cr = resolveDbPath(undefined, { cwd: w.nested, env: env(), dataDir: empty, allowCreate: true });
    assert.deepEqual([cr.source, cr.path], ['cwd-create', join(w.nested, 'collab.db')]);
  } finally { w.done(); }
});

test('an invalid config.json does not block COLLAB_DB_PATH', () => {
  const w = world();
  try {
    writeFileSync(join(w.data, 'config.json'), '{ broken');
    const r = resolveDbPath(undefined, { cwd: w.proj, env: env({ COLLAB_DB_PATH: '/e.db' }), dataDir: w.data });
    assert.deepEqual([r.source, r.path, r.name], ['COLLAB_DB_PATH', '/e.db', null]);
  } finally { w.done(); }
});

test('findCollabFile walks up to the filesystem root and returns null when none', () => {
  const w = world();
  try {
    assert.equal(findCollabFile(w.nested), null);
    writeFileSync(join(w.root, '.collab'), 'notebook=emp1st');
    assert.deepEqual(findCollabFile(w.nested), { file: join(w.root, '.collab'), name: 'emp1st', project: null });
  } finally { w.done(); }
});
