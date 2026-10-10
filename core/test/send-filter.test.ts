// file: core/test/send-filter.test.ts
// Stage C: ONE rule decides what the courier sends and what the status counts
// as unsent (spec rule 5 / P7). "hold" = not sent now, still waiting.
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { migrate } from '../src/db.js';
import { addEntry } from '../src/ops/add.js';
import { initModule } from '../src/ops/module.js';
import { createProject } from '../src/projects.js';
import { setSyncValue } from '../src/sync/state.js';
import { SYNC_KEYS } from '../src/sync/http-allocator.js';
import { readOwnChanges } from '../src/sync/changes.js';
import { sendContext, sendVerdictOf, SHARED_KEY, type NotePlace, type SendVerdict } from '../src/sync/send-filter.js';
import { unsentSharedCount } from '../src/sync/overview.js';

const note = (title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'decision' as const, title, summary: 's', ...extra });
let n = 0;
const assigned = (id: number) => ({ ulid: `01J${String(++n).padStart(23, '0')}`, id });

function world() {
  const t = freshDb({ shared: true });
  migrate(t.db);
  setSyncValue(t.db, SHARED_KEY, JSON.stringify(['portfolio']));
  setSyncValue(t.db, SYNC_KEYS.fingerprint, 'fp');
  initModule(t.db, { slug: 'portfolio' });
  initModule(t.db, { slug: 'private' });
  createProject(t.db, { name: 'mine', code: 'P1' });
  const team = (code: string, teamFp: string) =>
    t.db.prepare(`INSERT INTO projects (ulid, name, code, mode, team) VALUES (?, ?, ?, 'team', ?)`).run(`01JPR0JECT${code.padEnd(16, '0')}`, `team ${code}`, code, teamFp);
  team('SH', 'fp');
  team('ZZ', 'other');
  team('UK', 'fp');
  const u = {
    solo: addEntry(t.db, note('solo in portfolio', { project: 'P1', module: 'portfolio' })).ulid,
    shNumbered: addEntry(t.db, note('sh numbered', { project: 'SH', assigned: assigned(1) })).ulid,
    shPending: addEntry(t.db, note('sh pending', { project: 'SH' })).ulid,
    zz: addEntry(t.db, note('other office', { project: 'ZZ', assigned: assigned(1) })).ulid,
    unknown: addEntry(t.db, note('project not known here', { project: 'UK', assigned: assigned(1) })).ulid,
    ePendingShared: addEntry(t.db, note('e pending portfolio', { module: 'portfolio' })).ulid,
    eNumberedShared: addEntry(t.db, note('e numbered portfolio', { module: 'portfolio', assigned: assigned(1) })).ulid,
    ePrivate: addEntry(t.db, note('e private', { module: 'private', assigned: assigned(2) })).ulid,
    deletedPending: addEntry(t.db, note('deleted while pending', { module: 'portfolio' })).ulid,
  };
  t.db.prepare(`UPDATE entries SET deleted_at = datetime('now') WHERE ulid = ?`).run(u.deletedPending);
  // UK's row goes away locally (e.g. a team project this laptop has not learned yet).
  t.db.prepare(`DELETE FROM projects WHERE code = 'UK'`).run();
  return { ...t, u };
}

function verdicts(db: any) {
  const ctx = sendContext(db);
  const memo = new Map<string, NotePlace>();
  const byUlid = new Map<string, Set<SendVerdict>>();
  const byModule = new Map<string, Set<SendVerdict>>();
  const all: SendVerdict[] = [];
  for (const w of readOwnChanges(db, 0)) {
    const { ulid, verdict, place } = sendVerdictOf(db, w, ctx, memo);
    all.push(verdict);
    if (w.table === 'modules') {
      const s = byModule.get(place.module!) ?? new Set(); s.add(verdict); byModule.set(place.module!, s);
    } else if (ulid) {
      const s = byUlid.get(ulid) ?? new Set(); s.add(verdict); byUlid.set(ulid, s);
    }
  }
  return { byUlid, byModule, all };
}

test('one verdict per note, by project, office, pending state and module', () => {
  const t = world();
  try {
    const v = verdicts(t.db);
    const one = (u: string) => [...(v.byUlid.get(u) ?? [])];
    assert.deepEqual(one(t.u.solo), ['skip'], 'solo note, even in a shared module');
    assert.deepEqual(one(t.u.shNumbered), ['send']);
    assert.deepEqual(one(t.u.shPending), ['hold'], 'a team note is never sent while pending');
    assert.deepEqual(one(t.u.zz), ['skip'], 'a team of another office');
    assert.deepEqual(one(t.u.unknown), ['hold'], 'a project this laptop has not learned yet');
    assert.deepEqual(one(t.u.ePendingShared), ['hold']);
    assert.deepEqual(one(t.u.eNumberedShared), ['send']);
    assert.deepEqual(one(t.u.ePrivate), ['skip']);
    assert.deepEqual(one(t.u.deletedPending), ['skip'], 'deleted before it ever left this laptop');
    assert.deepEqual([...(v.byModule.get('portfolio') ?? [])], ['send']);
    assert.deepEqual([...(v.byModule.get('private') ?? [])], ['skip']);
  } finally { t.cleanup(); }
});

test('the unsent count is the send + hold verdicts (holds are waiting)', () => {
  const t = world();
  try {
    const v = verdicts(t.db);
    const expected = v.all.filter((x) => x !== 'skip').length;
    assert.ok(expected > 0);
    assert.equal(unsentSharedCount(t.db), expected);
  } finally { t.cleanup(); }
});

test('team notes count as unsent even with no shared module', () => {
  const t = world();
  try {
    setSyncValue(t.db, SHARED_KEY, '[]');
    const v = verdicts(t.db);
    assert.deepEqual([...(v.byUlid.get(t.u.shNumbered) ?? [])], ['send']);
    assert.equal(unsentSharedCount(t.db), v.all.filter((x) => x !== 'skip').length);
    assert.ok(unsentSharedCount(t.db) > 0);
  } finally { t.cleanup(); }
});

test('a change of a note that no longer exists here is skipped, never held', () => {
  const t = world();
  try {
    t.db.prepare(`DELETE FROM entries WHERE ulid = ?`).run(t.u.shPending);
    const v = verdicts(t.db);
    for (const x of v.byUlid.get(t.u.shPending) ?? []) assert.equal(x, 'skip');
  } finally { t.cleanup(); }
});
