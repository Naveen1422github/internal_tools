// file: core/test/doctor-projects.test.ts
// Stage B1: doctor checks duplicates by (series, id) and explains every project state.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb } from './helpers/sync.js';
import { migrate } from '../src/db.js';
import { addEntry } from '../src/ops/add.js';
import { createProject } from '../src/projects.js';
import { doctor } from '../src/ops/doctor.js';

function world() {
  const t = freshDb();
  migrate(t.db);
  const root = mkdtempSync(join(tmpdir(), 'collab-doctor-projects-'));
  const opts = { cwd: root, env: {} as NodeJS.ProcessEnv };
  const check = (name: string) => doctor(t.db, opts).checks.find((c) => c.name === name)!;
  return { ...t, root, check, done: () => { t.cleanup(); rmSync(root, { recursive: true, force: true }); } };
}
const note = (db: any, title: string, extra: Record<string, unknown> = {}) =>
  addEntry(db, { type: 'decision', title, summary: 's', ...extra } as any);

test('E-1 and SH-1 are not duplicates; two E-1 still are', () => {
  const w = world();
  try {
    createProject(w.db, { name: 'supporthub', code: 'SH' });
    note(w.db, 'e'); note(w.db, 'sh', { project: 'SH' });
    assert.equal(w.check('data.duplicate_entry_ids').severity, 'ok');
    const u = (w.db.prepare(`SELECT ulid FROM entries WHERE series = 'E' AND id = 1`).get() as any).ulid;
    const cols = (w.db.prepare(`SELECT name FROM pragma_table_info('entries')`).all() as any[]).map((c) => c.name).filter((c) => c !== 'ulid');
    w.db.prepare(`INSERT INTO entries (ulid, ${cols.join(', ')}) SELECT ?, ${cols.join(', ')} FROM entries WHERE ulid = ?`)
      .run('01Z00000000000000000000001', u);
    const dup = w.check('data.duplicate_entry_ids');
    assert.equal(dup.severity, 'warn');
    assert.deepEqual(dup.items, ['E-00001 x2']);
  } finally { w.done(); }
});

test('projects.current: none, a known project, and a .collab naming an unknown one', () => {
  const w = world();
  try {
    assert.equal(w.check('projects.current').severity, 'ok');
    assert.match(w.check('projects.current').detail, /none/);
    const p = createProject(w.db, { name: 'supporthub', code: 'SH' });
    writeFileSync(join(w.root, '.collab'), `notebook = x\nproject = ${p.ulid}\n`);
    const ok = w.check('projects.current');
    assert.equal(ok.severity, 'ok');
    assert.match(ok.detail, /SH supporthub \(solo\)/);
    writeFileSync(join(w.root, '.collab'), `notebook = x\nproject = 01ARZ3NDEKTSV4RRFFQ69G5FAV\n`);
    const bad = w.check('projects.current');
    assert.equal(bad.severity, 'error');
    assert.ok(bad.detail.includes(join(w.root, '.collab')), bad.detail);
    assert.match(bad.detail, /collab project list/);
  } finally { w.done(); }
});

test('projects.orphan_notes: a note whose project_ulid names no project', () => {
  const w = world();
  try {
    createProject(w.db, { name: 'supporthub', code: 'SH' });
    note(w.db, 'sh', { project: 'SH' });
    assert.equal(w.check('projects.orphan_notes').severity, 'ok');
    w.db.prepare(`DELETE FROM projects`).run();
    const c = w.check('projects.orphan_notes');
    assert.equal(c.severity, 'error');
    assert.deepEqual(c.items, ['SH-1']);
  } finally { w.done(); }
});

test('projects.series_mismatch: a note whose series is not its project\'s code', () => {
  const w = world();
  try {
    createProject(w.db, { name: 'supporthub', code: 'SH' });
    note(w.db, 'sh', { project: 'SH' });
    assert.equal(w.check('projects.series_mismatch').severity, 'ok');
    w.db.prepare(`UPDATE entries SET series = 'NV' WHERE title = 'sh'`).run();
    const c = w.check('projects.series_mismatch');
    assert.equal(c.severity, 'error');
    assert.deepEqual(c.items, ['NV-1 (project SH)']);
  } finally { w.done(); }
});
