// file: core/test/project-left.test.ts
// Stage B2 (spec P11): a team project this laptop left keeps its notes, read-only
// and marked "left team". It is never sent and never numbered again.
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb, dbVersion } from './helpers/sync.js';
import { migrate, migrateTo, latestMigration } from '../src/db.js';
import { addEntry } from '../src/ops/add.js';
import { createProject, findProject, markProjectLeft, isLeftProject } from '../src/projects.js';
import { setSyncValue } from '../src/sync/state.js';
import { SYNC_KEYS } from '../src/sync/http-allocator.js';
import { readOwnChanges } from '../src/sync/changes.js';
import { sendContext, sendVerdictOf, SHARED_KEY, type NotePlace } from '../src/sync/send-filter.js';
import { unsentSharedCount, pendingCounts } from '../src/sync/overview.js';
import { hasProjectLeft } from '../src/schema.js';

const note = (title: string, extra: Record<string, unknown> = {}) => ({ type: 'decision' as const, title, summary: 's', ...extra });
let n = 0;
const assigned = (id: number) => ({ ulid: `01K${String(++n).padStart(23, '0')}`, id });
const teamRow = (db: any, code: string, fp = 'fp') =>
  db.prepare(`INSERT INTO projects (ulid, name, code, mode, team) VALUES (?, ?, ?, 'team', ?)`).run(`01JPR0JECT${code.padEnd(16, '0')}`, `team ${code}`, code, fp);

test('fresh notebook: latest = 0012, projects.left_at exists and is NULL by default', () => {
  const t = freshDb();
  try {
    migrate(t.db);
    assert.equal(latestMigration(t.db), '0012_access_cache');
    assert.equal(hasProjectLeft(t.db), true);
    const p = createProject(t.db, { name: 'mine', code: 'P1' });
    assert.equal(p.left_at, null);
  } finally { t.cleanup(); }
});

test('a shared 0009 notebook with projects migrates to 0010 without any tracked change', () => {
  const t = freshDb({ shared: true });
  try {
    migrateTo(t.db, '0009');
    assert.equal(hasProjectLeft(t.db), false);
    createProject(t.db, { name: 'mine', code: 'P1' });
    addEntry(t.db, note('solo', { project: 'P1' }));
    assert.equal(findProject(t.db, 'P1')!.left_at, null, 'reads work on a 0009 file');
    const v0 = dbVersion(t.db);
    migrate(t.db);
    assert.equal(latestMigration(t.db), '0012_access_cache');
    assert.equal(dbVersion(t.db), v0, 'no tracked change (projects is local)');
    assert.equal(findProject(t.db, 'P1')!.left_at, null);
  } finally { t.cleanup(); }
});

test('markProjectLeft: only a team project; idempotent', () => {
  const t = freshDb();
  try {
    migrate(t.db);
    createProject(t.db, { name: 'mine', code: 'P1' });
    assert.throws(() => markProjectLeft(t.db, 'P1'), /only a team project/);
    teamRow(t.db, 'SH');
    const a = markProjectLeft(t.db, 'SH');
    assert.ok(a.left_at);
    assert.equal(isLeftProject(a), true);
    const b = markProjectLeft(t.db, 'sh');
    assert.equal(b.left_at, a.left_at);
    assert.throws(() => markProjectLeft(t.db, 'XX'), /no project "XX"/);
  } finally { t.cleanup(); }
});

test('a left team project is never sent, never waiting, never counted pending', () => {
  const t = freshDb({ shared: true });
  try {
    migrate(t.db);
    setSyncValue(t.db, SHARED_KEY, JSON.stringify([]));
    setSyncValue(t.db, SYNC_KEYS.fingerprint, 'fp');
    teamRow(t.db, 'SH');
    teamRow(t.db, 'NV');
    const numbered = addEntry(t.db, note('sh numbered', { project: 'SH', assigned: assigned(1) })).ulid;
    const pending = addEntry(t.db, note('sh pending', { project: 'SH' })).ulid;
    addEntry(t.db, note('nv numbered', { project: 'NV', assigned: assigned(1) }));
    const before = unsentSharedCount(t.db);
    assert.equal(pendingCounts(t.db).find((r) => r.series === 'SH')?.n, 1);
    markProjectLeft(t.db, 'SH');
    const ctx = sendContext(t.db);
    const memo = new Map<string, NotePlace>();
    for (const w of readOwnChanges(t.db, 0)) {
      const { ulid, verdict } = sendVerdictOf(t.db, w, ctx, memo);
      if (ulid === numbered || ulid === pending) assert.equal(verdict, 'skip', `${w.table}.${w.cid}`);
    }
    assert.ok(unsentSharedCount(t.db) < before, 'the left notes no longer count as unsent');
    assert.equal(pendingCounts(t.db).find((r) => r.series === 'SH'), undefined, 'a left pending note will never be numbered: not counted');
  } finally { t.cleanup(); }
});

// ---- read-only notes of a left team (Task 3) ----
import { updateEntry, updateEntryRefs } from '../src/ops/update.js';
import { editEntry, reassignModule } from '../src/ops/edit.js';
import { initModule } from '../src/ops/module.js';
import { supersede } from '../src/ops/supersede.js';
import { deleteEntry } from '../src/ops/delete.js';
import { createTask, transitionTask } from '../src/ops/task.js';
import { getEntryByRef } from '../src/ops/get.js';
import { doctor } from '../src/ops/doctor.js';
import { planCopy, applyCopy } from '../src/ops/copy.js';
import { ReadOnlyNoteError } from '../src/projects.js';

function leftWorld() {
  const t = freshDb();
  migrate(t.db);
  teamRow(t.db, 'SH');
  const a = addEntry(t.db, note('sh one', { project: 'SH', assigned: assigned(1) }));
  const b = addEntry(t.db, note('sh two', { project: 'SH', assigned: assigned(2) }));
  addEntry(t.db, note('sh pending', { project: 'SH', pending: true } as any));
  const e = addEntry(t.db, note('e one'));
  return { ...t, a, b, e };
}
const FIX = /SH-1 is a note of SH \(team SH\), a team you left: it is read-only\. To edit it, copy it into a solo project: collab copy --from SH --to <solo code>/;

test('every write path refuses a note of a left team, with the fix; delete still works', () => {
  const t = leftWorld();
  try {
    const task = createTask(t.db, { title: 't' }).id;
    t.db.prepare(`UPDATE entries SET type = 'handoff', task_id = ? WHERE ulid = ?`).run(task, t.a.ulid);
    markProjectLeft(t.db, 'SH');
    const snap = () => t.db.prepare(`SELECT * FROM entries WHERE ulid = ?`).get(t.a.ulid);
    const refs = () => t.db.prepare(`SELECT * FROM refs WHERE entry_ulid = ?`).all(t.a.ulid);
    const before = snap(), beforeRefs = refs();
    const refuses = (fn: () => unknown) => assert.throws(fn, (e: Error) => e instanceof ReadOnlyNoteError && FIX.test(e.message));
    refuses(() => updateEntry(t.db, { id: 1, series: 'SH', title: 'x' }));
    refuses(() => updateEntryRefs(t.db, { id: 1, series: 'SH', add: [{ ref_type: 'file', ref_value: 'a.ts' }] }));
    refuses(() => editEntry(t.db, { id: 1, series: 'SH', type: 'decision', title: 'x', summary: 's' }));
    refuses(() => supersede(t.db, { ids: [{ series: 'SH', id: 1 }], by: 1 }));
    refuses(() => supersede(t.db, { ids: [1], by: { series: 'SH', id: 1 } }));
    initModule(t.db, { slug: 'elsewhere' });
    refuses(() => reassignModule(t.db, [1, { series: 'SH', id: 1 }], 'elsewhere'));
    assert.equal((t.db.prepare(`SELECT module FROM entries WHERE ulid = ?`).get(t.e.ulid) as any).module, null, 'the whole batch is refused');
    assert.throws(() => addEntry(t.db, note('new', { project: 'SH' })), (e: Error) => e instanceof ReadOnlyNoteError && /SH \(team SH\) is a team you left/.test(e.message));
    for (const s of ['assigned', 'in-progress', 'review', 'done'] as const) transitionTask(t.db, task, s);
    assert.deepEqual(snap(), before, 'the left note is unchanged (task done cascade included)');
    assert.deepEqual(refs(), beforeRefs);
    deleteEntry(t.db, 2, 'SH');
    assert.ok((t.db.prepare(`SELECT deleted_at FROM entries WHERE ulid = ?`).get(t.b.ulid) as any).deleted_at, 'delete works');
  } finally { t.cleanup(); }
});

test('copying a left note into a solo project makes it editable; get marks left notes and copied_to links', async () => {
  const t = leftWorld();
  try {
    markProjectLeft(t.db, 'SH');
    createProject(t.db, { name: 'mine', code: 'P1' });
    await applyCopy(t.db, planCopy(t.db, { from: 'SH', to: 'P1' }));
    assert.equal(updateEntry(t.db, { id: 1, series: 'P1', title: 'mine now' }).id, 1);
    const sh1 = getEntryByRef(t.db, { series: 'SH', id: 1 })!;
    assert.equal(sh1.left_team, true);
    const link = sh1.refs.find((r) => r.copied_to)!;
    assert.ok(link, 'the copied_to link is marked');
    assert.equal(link.target?.series, 'P1');
    assert.equal(link.target?.id, 1);
    assert.equal('left_team' in getEntryByRef(t.db, { series: 'P1', id: 1 })!, false, 'only left notes carry the mark');
    assert.equal('left_team' in getEntryByRef(t.db, { series: 'E', id: 1 })!, false);
  } finally { t.cleanup(); }
});

test('doctor: projects.left explains a left team; it is not "another post office"', () => {
  const t = leftWorld();
  try {
    const opts = { cwd: t.path + '-nowhere', env: {} as NodeJS.ProcessEnv };
    const check = (name: string) => doctor(t.db, opts).checks.find((c) => c.name === name)!;
    assert.equal(check('projects.left').severity, 'ok');
    assert.equal(check('projects.left').detail, 'no team you left');
    markProjectLeft(t.db, 'SH');
    const left = check('projects.left');
    assert.equal(left.severity, 'warn');
    assert.equal(left.detail, 'SH (team SH): you left this team; its 3 notes are read-only (1 never got a number). To edit them, copy them into a solo project: collab copy --from SH --to <solo code>');
    assert.ok(!(check('projects.team_office').items ?? []).includes('SH'), 'a left project is not an office problem');
  } finally { t.cleanup(); }
});
