// file: core/test/adopt-e.test.ts
// Task 7: the laptop adopts E (adoptELocal). One transaction; refusals write nothing.
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb, dbVersion } from './helpers/sync.js';
import { migrate } from '../src/db.js';
import { addEntry } from '../src/ops/add.js';
import { initModule } from '../src/ops/module.js';
import { listBindings, bindModule } from '../src/ops/bind.js';
import { findProject, createProject } from '../src/projects.js';
import { getSyncValue, setSyncValue } from '../src/sync/state.js';
import { SYNC_KEYS } from '../src/sync/http-allocator.js';
import { SHARED_KEY, SENT_KEY } from '../src/sync/send-filter.js';
import { writeAccessCache, readAccessCache, type AccessPayload } from '../src/access/cache.js';
import { E_ADOPTED_KEY, E_PROJECT_ULID, NEVER_SEND_KEY, DEFAULT_PROJECT_KEY, isEAdopted, neverSend, cachedEAccess } from '../src/e-project.js';
import { adoptELocal } from '../src/ops/adopt-e.js';

const note = (title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'decision' as const, title, summary: 's', ...extra });
let n = 0;
const assigned = (id: number) => ({ ulid: `01K${String(++n).padStart(23, '0')}`, id });

const access = (eProject?: { adopted: boolean; member: boolean }): AccessPayload =>
  ({ office: null, projects: [], replays: [], ...(eProject ? { eProject } : {}) });

/**
 * A: shared module (sent already); B: backfilled but no longer listed; C: unshared module;
 * D: no module; T: tombstoned, unshared module. infra is the runbook's extra module.
 */
function world() {
  const t = freshDb({ shared: true });
  migrate(t.db);
  for (const slug of ['custom-reports', 'old-shared', 'qa-system', 'infra']) initModule(t.db, { slug });
  setSyncValue(t.db, SYNC_KEYS.fingerprint, 'fp');
  const a = addEntry(t.db, note('A', { module: 'custom-reports', assigned: assigned(1) })).ulid;
  const b = addEntry(t.db, note('B', { module: 'old-shared', assigned: assigned(2) })).ulid;
  const c = addEntry(t.db, note('C', { module: 'qa-system', assigned: assigned(3) })).ulid;
  const d = addEntry(t.db, note('D', { assigned: assigned(4) })).ulid;
  const tomb = addEntry(t.db, note('T', { module: 'qa-system', assigned: assigned(5) })).ulid;
  t.db.prepare(`UPDATE entries SET deleted_at = datetime('now') WHERE ulid = ?`).run(tomb);
  setSyncValue(t.db, SHARED_KEY, JSON.stringify(['custom-reports', 'not-here']));
  setSyncValue(t.db, 'backfilled_modules', JSON.stringify(['custom-reports', 'old-shared']));
  setSyncValue(t.db, SENT_KEY, String(dbVersion(t.db))); // everything acknowledged
  return { ...t, u: { a, b, c, d, tomb } };
}

const snapshot = (db: any) => ({
  state: db.prepare(`SELECT key, value FROM sync_state ORDER BY key`).all(),
  projects: db.prepare(`SELECT ulid, code FROM projects ORDER BY ulid`).all(),
  bindings: db.prepare(`SELECT module, project_ulid FROM project_modules ORDER BY module`).all(),
});

test('refused before the office adopted E: nothing written', () => {
  const t = world();
  try {
    for (const p of [undefined, { adopted: false, member: false }]) {
      writeAccessCache(t.db, access(p));
      const before = snapshot(t.db);
      assert.throws(() => adoptELocal(t.db, {}), /the post office hasn't adopted E yet: run collab office adopt-e there first/);
      assert.deepEqual(snapshot(t.db), before);
      assert.equal(isEAdopted(t.db), false);
    }
  } finally { t.cleanup(); }
});

test('refused with unsent changes, naming the count', () => {
  const t = world();
  try {
    writeAccessCache(t.db, access({ adopted: true, member: true }));
    addEntry(t.db, note('new in shared', { module: 'custom-reports', assigned: assigned(9) }));
    const before = snapshot(t.db);
    assert.throws(() => adoptELocal(t.db, {}), /sync first: \d+ change\(s\) not yet sent/);
    assert.deepEqual(snapshot(t.db), before);
  } finally { t.cleanup(); }
});

test('member: never-send = unshared, module-less and tombstoned E notes; binds shared + extra; then "already adopted"', () => {
  const t = world();
  try {
    writeAccessCache(t.db, access({ adopted: true, member: true }));
    const r = adoptELocal(t.db, { extraModules: ['infra'] });
    assert.equal(r.member, true);
    assert.deepEqual(r.bound, ['custom-reports', 'infra', 'not-here'], 'every shared slug, even one with no modules row here');
    assert.equal(r.default, 'PS');
    assert.deepEqual([...neverSend(t.db)].sort(), [t.u.c, t.u.d, t.u.tomb].sort());
    assert.equal(r.neverSend, 3);
    assert.equal(isEAdopted(t.db), true);
    assert.equal(getSyncValue(t.db, DEFAULT_PROJECT_KEY), 'PS');
    assert.ok(findProject(t.db, 'PS'));
    assert.deepEqual(listBindings(t.db).map((b) => [b.module, b.project_ulid]), [['custom-reports', E_PROJECT_ULID], ['infra', E_PROJECT_ULID], ['not-here', E_PROJECT_ULID]]);
    assert.throws(() => adoptELocal(t.db, {}), /already adopted/);
  } finally { t.cleanup(); }
});

test('an unknown --also module refuses the whole adoption', () => {
  const t = world();
  try {
    writeAccessCache(t.db, access({ adopted: true, member: true }));
    const before = snapshot(t.db);
    assert.throws(() => adoptELocal(t.db, { extraModules: ['nope'] }), /no module "nope"/);
    assert.deepEqual(snapshot(t.db), before);
  } finally { t.cleanup(); }
});

test('non-member: never-send = every E note, nothing bound; the named default is used', () => {
  const t = world();
  try {
    createProject(t.db, { name: 'Mine', code: 'MINE' });
    writeAccessCache(t.db, access({ adopted: true, member: false }));
    const r = adoptELocal(t.db, { defaultProject: 'MINE', extraModules: ['infra'] });
    assert.equal(r.member, false);
    assert.deepEqual(r.bound, []);
    assert.equal(r.default, 'MINE');
    assert.deepEqual([...neverSend(t.db)].sort(), Object.values(t.u).sort());
    assert.deepEqual(listBindings(t.db), []);
    assert.equal(findProject(t.db, 'PS'), null, 'no PS made when a default is named');
  } finally { t.cleanup(); }
});

test('the access cache keeps eProject and never caches E as a project', () => {
  const t = world();
  try {
    writeAccessCache(t.db, {
      office: null, replays: [], eProject: { adopted: true, member: true },
      projects: [{ ulid: E_PROJECT_ULID, code: 'E', role: 'Owner', keys: ['note.view'], ai: {} }],
    });
    assert.deepEqual(cachedEAccess(t.db), { adopted: true, member: true });
    assert.equal(readAccessCache(t.db).has(E_PROJECT_ULID), false);
    assert.equal(t.db.prepare(`SELECT 1 FROM projects WHERE code = 'E'`).get(), undefined);
    writeAccessCache(t.db, access()); // an older office: no eProject
    assert.deepEqual(cachedEAccess(t.db), { adopted: false, member: false });
    void E_ADOPTED_KEY; void NEVER_SEND_KEY;
  } finally { t.cleanup(); }
});

test('a shared module bound to a private project keeps its binding; --also rebinds explicitly', () => {
  const t = world();
  try {
    createProject(t.db, { name: 'Mine', code: 'MINE' });
    bindModule(t.db, 'custom-reports', 'MINE');
    bindModule(t.db, 'qa-system', 'MINE');
    writeAccessCache(t.db, access({ adopted: true, member: true }));
    const r = adoptELocal(t.db, { extraModules: ['qa-system'] });
    assert.deepEqual(r.bound, ['not-here', 'qa-system']);
    const b = Object.fromEntries(listBindings(t.db).map((x) => [x.module, x.project_code]));
    assert.deepEqual(b, { 'custom-reports': 'MINE', 'not-here': 'E', 'qa-system': 'E' });
  } finally { t.cleanup(); }
});
