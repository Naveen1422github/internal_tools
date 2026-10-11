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

test('fresh notebook: latest = 0010, projects.left_at exists and is NULL by default', () => {
  const t = freshDb();
  try {
    migrate(t.db);
    assert.equal(latestMigration(t.db), '0010_project_left');
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
    assert.equal(latestMigration(t.db), '0010_project_left');
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
