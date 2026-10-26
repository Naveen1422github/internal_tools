// file: core/test/send-filter-e.test.ts
// Task 2: never-send first, and E as a team project, in THE send rule.
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
import { unsentSharedCount, readSyncOverview } from '../src/sync/overview.js';
import { E_ACCESS_KEY, E_ADOPTED_KEY, NEVER_SEND_KEY } from '../src/e-project.js';

const note = (title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'decision' as const, title, summary: 's', ...extra });
let n = 0;
const assigned = (id: number) => ({ ulid: `01J${String(++n).padStart(23, '0')}`, id });

function world(adopted: boolean) {
  const t = freshDb({ shared: true });
  migrate(t.db);
  initModule(t.db, { slug: 'custom-reports' });
  initModule(t.db, { slug: 'qa-system' });
  setSyncValue(t.db, SYNC_KEYS.fingerprint, 'fp');
  createProject(t.db, { name: 'collab', code: 'COLLAB' });
  const a = addEntry(t.db, note('A', { module: 'custom-reports', assigned: assigned(1) })).ulid;
  const b = addEntry(t.db, note('B', { module: 'qa-system', assigned: assigned(2) })).ulid;
  const c = addEntry(t.db, note('C', { assigned: assigned(3) })).ulid;
  const copy = addEntry(t.db, note('copy of A', { project: 'COLLAB', module: 'custom-reports' })).ulid;
  t.db.prepare(`INSERT INTO refs (entry_ulid, entry_id, ref_type, ref_value, target_ulid) VALUES (?, (SELECT id FROM entries WHERE ulid = ?), 'entry', 'copied_to:COLLAB-1', ?)`).run(a, a, copy);
  if (adopted) {
    setSyncValue(t.db, E_ADOPTED_KEY, '1');
    setSyncValue(t.db, E_ACCESS_KEY, JSON.stringify({ adopted: true, member: true }));
    setSyncValue(t.db, NEVER_SEND_KEY, JSON.stringify([b, c]));
  } else {
    setSyncValue(t.db, SHARED_KEY, JSON.stringify(['custom-reports']));
  }
  return { ...t, u: { a, b, c, copy } };
}

function verdicts(db: any, sentModules?: Set<string>) {
  const ctx = sendContext(db);
  if (sentModules) for (const m of sentModules) (ctx as any).sentModules.add(m);
  const memo = new Map<string, NotePlace>();
  const byUlid = new Map<string, Set<SendVerdict>>();
  const byTable = new Map<string, Set<SendVerdict>>();
  const byModule = new Map<string, Set<SendVerdict>>();
  const add = (m: Map<string, Set<SendVerdict>>, k: string, v: SendVerdict) => { const s = m.get(k) ?? new Set(); s.add(v); m.set(k, s); };
  for (const w of readOwnChanges(db, 0)) {
    const { ulid, verdict, place } = sendVerdictOf(db, w, ctx, memo);
    if (w.table === 'modules') add(byModule, place.module!, verdict);
    else if (ulid) { add(byUlid, ulid, verdict); add(byTable, `${ulid}:${w.table}`, verdict); }
  }
  return { byUlid, byTable, byModule };
}
const one = (m: Map<string, Set<SendVerdict>>, k: string) => [...(m.get(k) ?? [])];

test('adopted: never-send skips every row of the note; the rest sends', () => {
  const t = world(true);
  try {
    const v = verdicts(t.db);
    assert.deepEqual(one(v.byTable, `${t.u.a}:entries`), ['send'], 'A sends (E is a team project)');
    assert.deepEqual(one(v.byUlid, t.u.b), ['skip']);
    assert.deepEqual(one(v.byUlid, t.u.c), ['skip']);
    assert.ok(v.byTable.has(`${t.u.b}:entry_modules`), 'B has entry_modules rows');
    // a module edit does not unhide a never-send note
    t.db.prepare(`UPDATE entries SET module = 'custom-reports' WHERE ulid = ?`).run(t.u.b);
    const v2 = verdicts(t.db);
    assert.deepEqual(one(v2.byUlid, t.u.b), ['skip']);
    // the COLLAB copy (solo project) and A's copied_to ref
    assert.deepEqual(one(v2.byUlid, t.u.copy), ['skip']);
    assert.deepEqual(one(v2.byTable, `${t.u.a}:refs`), ['skip']);
  } finally { t.cleanup(); }
});

test('adopted: a pending E note holds', () => {
  const t = world(true);
  try {
    const p = addEntry(t.db, note('pending E', { module: 'custom-reports', project: 'E' })).ulid;
    assert.deepEqual(one(verdicts(t.db).byUlid, p), ['hold']);
  } finally { t.cleanup(); }
});

test('adopted: an office that has not adopted E holds E rows; never-send still skips', () => {
  const t = world(true);
  try {
    setSyncValue(t.db, E_ACCESS_KEY, JSON.stringify({ adopted: false, member: false }));
    const v = verdicts(t.db, new Set(['custom-reports']));
    assert.deepEqual(one(v.byUlid, t.u.a), ['hold'], 'E note waits, never sent to an old office');
    assert.deepEqual(one(v.byUlid, t.u.b), ['skip']);
    assert.deepEqual(one(v.byModule, 'custom-reports'), ['hold']);
  } finally { t.cleanup(); }
});

test('adopted: a corrupt never_send list holds every E row (fails closed, nothing skipped for good)', () => {
  const t = world(true);
  try {
    setSyncValue(t.db, NEVER_SEND_KEY, 'not json');
    const v = verdicts(t.db, new Set(['custom-reports', 'qa-system']));
    for (const u of [t.u.a, t.u.b, t.u.c]) assert.deepEqual(one(v.byUlid, u), ['hold'], 'no E note sends while the list is unreadable');
    assert.deepEqual(one(v.byModule, 'qa-system'), ['hold']);
    assert.deepEqual(one(v.byUlid, t.u.copy), ['skip'], 'a private-project note is unaffected');
  } finally { t.cleanup(); }
});

test('adopted: modules rows send only when a sent note references the slug', () => {
  const t = world(true);
  try {
    const none = verdicts(t.db);
    assert.deepEqual(one(none.byModule, 'qa-system'), ['skip']);
    assert.deepEqual(one(none.byModule, 'custom-reports'), ['skip'], 'no sent note in the batch yet');
    const v = verdicts(t.db, new Set(['custom-reports']));
    assert.deepEqual(one(v.byModule, 'custom-reports'), ['send']);
    assert.deepEqual(one(v.byModule, 'qa-system'), ['skip']);
    // modules rows are never counted as unsent notes
    let notes = 0;
    const ctx = sendContext(t.db); const memo = new Map<string, NotePlace>();
    for (const w of readOwnChanges(t.db, 0)) if (w.table !== 'modules' && sendVerdictOf(t.db, w, ctx, memo).verdict !== 'skip') notes++;
    assert.equal(unsentSharedCount(t.db), notes);
  } finally { t.cleanup(); }
});

test('not adopted: exactly the pre-change verdicts', () => {
  const t = world(false);
  try {
    const v = verdicts(t.db);
    assert.deepEqual(one(v.byTable, `${t.u.a}:entries`), ['send'], 'shared module');
    assert.deepEqual(one(v.byUlid, t.u.b), ['skip'], 'unshared module');
    assert.deepEqual(one(v.byUlid, t.u.c), ['skip'], 'no module');
    assert.deepEqual(one(v.byUlid, t.u.copy), ['skip']);
    assert.deepEqual(one(v.byModule, 'custom-reports'), ['send'], 'today: modules row follows shared');
    assert.deepEqual(one(v.byModule, 'qa-system'), ['skip']);
  } finally { t.cleanup(); }
});

test('privateKept counts only live never-send notes', () => {
  const t = world(true);
  try {
    const o = (): any => readSyncOverview(t.db, { courierDir: t.path + '.none' });
    assert.equal(o().privateKept, 2);
    t.db.prepare(`UPDATE entries SET deleted_at = datetime('now') WHERE ulid = ?`).run(t.u.c);
    assert.equal(o().privateKept, 1);
    setSyncValue(t.db, NEVER_SEND_KEY, JSON.stringify([t.u.b, '01JNOSUCHNOTE00000000000000']));
    assert.equal(o().privateKept, 1, 'unknown ulids are not live notes');
  } finally { t.cleanup(); }
});
