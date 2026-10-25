// Local-first Task 5: once the office adopted E, it judges and numbers E like a team
// project (E roles, note.create at allocate, po_note_owners for pre-adoption owners),
// and module sharing closes (POST /v1/modules -> 410). Before adoption: today's.
import { test } from 'node:test';
import assert from 'node:assert';
import type Database from 'better-sqlite3';
import {
  addEntryAsync, updateEntry, updateEntryRefs, archive, setAllocator, readOwnChanges, applyChanges, decodeChange,
  newUlid, requestJson, E_PROJECT_ULID,
} from '@collab-mcp/core';
import { tempStore, laptop } from './helpers.js';
import { office } from './office.js';
import { acceptChanges, fetchDeliveries } from '../src/deliveries.js';
import { allocate, StoreError, type Store } from '../src/store.js';
import { setProjectMember, assignNewMemberOfficeRole } from '../src/access.js';
import { adoptE } from '../src/e-adopt.js';

type DB = Database.Database;
const dbv = (db: DB) => (db.prepare(`SELECT crsql_db_version() v`).get() as { v: number }).v;
function member(store: Store, id: string): void {
  store.prepare(`INSERT INTO po_members (device_id, name, joined_at) VALUES (?, ?, datetime('now'))`).run(id, id);
  assignNewMemberOfficeRole(store, id);
}
function device(store: Store, id: string) {
  const l = laptop();
  let sent = 0, got = 0;
  return {
    id, db: l.db,
    push() { const ch = readOwnChanges(l.db, sent); sent = dbv(l.db); return acceptChanges(store, id, ch); },
    pull() {
      const r = fetchDeliveries(store, id, got, 5000);
      l.db.transaction(() => applyChanges(l.db, r.changes.map(decodeChange)))();
      got = r.lastSeq;
    },
    cleanup: l.cleanup,
  };
}
/** owner (adopts E, Owner), c (Contributor in E once adopted), x (in no project). The office numbers every E note. */
function world() {
  const { store, cleanup } = tempStore();
  setAllocator({ allocate: async (u, series) => allocate(store, u, null, series) });
  for (const d of ['owner', 'c', 'x']) member(store, d);
  const devs = ['owner', 'c', 'x'].map((d) => device(store, d));
  const [O, C, X] = devs;
  const note = async (on: ReturnType<typeof device>, title: string) =>
    (await addEntryAsync(on.db, { type: 'decision', title, summary: `${title} s`, module: 'm', refs: [{ ref_type: 'file', ref_value: `${title}.ts` }] })).ulid;
  const adopt = () => {
    adoptE(store, { name: 'emp1st', ownerDevice: 'owner' });
    setProjectMember(store, null, E_PROJECT_ULID, 'c', 'Contributor');
  };
  return { store, O, C, X, note, adopt, done: () => { setAllocator(null); for (const d of devs) d.cleanup(); cleanup(); } };
}
const refusedRows = (s: Store, u: string) => s.prepare(`SELECT device_id, key, reason FROM po_refused_notes WHERE ulid = ?`).all(u);
const NEED_CREATE = /^You need "Create notes" \(note\.create\) in E to do this$/;

test('allocate E: today anyone is numbered; after adoption a non-member is refused (403 + refusal row), a member is numbered', () => {
  const w = world();
  try {
    const before = newUlid();
    const n1 = allocate(w.store, before, 'x');
    assert.ok(n1 > 0, 'before adoption: numbered, no check (today)');
    assert.deepEqual(refusedRows(w.store, before), []);

    w.adopt();
    const u = newUlid();
    assert.throws(() => allocate(w.store, u, 'x'), (e: unknown) => e instanceof StoreError && e.status === 403 && NEED_CREATE.test(e.message));
    assert.deepEqual(refusedRows(w.store, u), [{ device_id: 'x', key: 'note.create', reason: 'You need "Create notes" (note.create) in E to do this' }]);
    assert.equal(allocate(w.store, before, 'x'), n1, 'E-713: a number already given is returned, whoever asks');
    const m = allocate(w.store, newUlid(), 'c');
    assert.equal(m, n1 + 1, 'a member with note.create is numbered from po_meta.counter');
    assert.equal((w.store.prepare(`SELECT COUNT(*) n FROM po_series_counters WHERE series = 'E'`).get() as { n: number }).n, 0);
    assert.equal(allocate(w.store, newUlid(), null), m + 1, 'the office CLI stays unguarded');

    // Granted later, with nothing of the note held: the refusal is lifted (as for team projects).
    setProjectMember(w.store, null, E_PROJECT_ULID, 'x', 'Contributor');
    assert.ok(allocate(w.store, u, 'x') > 0);
    assert.deepEqual(refusedRows(w.store, u), []);
  } finally { w.done(); }
});

test('a Contributor editing someone else\'s E note: accepted today, refused (note.edit.any) after adoption; own E notes stay editable', async () => {
  const w = world();
  try {
    const theirs = await w.note(w.O, "owner's note");
    assert.equal(w.O.push().refused.length, 0);
    w.C.pull();

    updateEntry(w.C.db, { ulid: theirs, description: 'edited by c before adoption' });
    assert.deepEqual(w.C.push().refused, [], 'before adoption E is not judged (today)');

    w.adopt();
    updateEntry(w.C.db, { ulid: theirs, description: 'edited by c after adoption' });
    const res = w.C.push();
    assert.ok(res.refused.length > 0);
    assert.ok(res.refused.every((r) => r.key === 'note.edit.any' && r.ulid === theirs
      && r.reason === 'You need "Edit any note" (note.edit.any) in E to do this'), JSON.stringify(res.refused));

    const mine = await w.note(w.C, "c's note");
    assert.deepEqual(w.C.push().refused, [], 'note.create in E');
    updateEntry(w.C.db, { ulid: mine, description: 'own edit' });
    assert.deepEqual(w.C.push().refused, [], 'note.edit.own in E');
  } finally { w.done(); }
});

test('the owner (po_note_owners) of an E-261-shaped rollup keeps editing it after adoption as a Contributor', async () => {
  const w = world();
  try {
    const originals: string[] = [];
    for (const t of ['h1', 'h2', 'h3']) {
      originals.push((await addEntryAsync(w.C.db, { type: 'changelog', title: t, summary: `${t} s`, module: 'custom-reports' })).ulid);
    }
    // E-261's shape: type rollup, series E, no project, entry refs to its originals, which it deprecates.
    const r = archive(w.C.db, { older_than: '2999-01-01', module: 'custom-reports', dry_run: false });
    assert.equal(r.created_entries.length, 1);
    const roll = (w.C.db.prepare(`SELECT ulid FROM entries WHERE type = 'rollup'`).get() as { ulid: string }).ulid;
    w.C.db.prepare(`UPDATE entries SET id = ? WHERE ulid = ?`).run(allocate(w.store, roll, null), roll);
    const row = w.C.db.prepare(`SELECT series, project_ulid FROM entries WHERE ulid = ?`).get(roll);
    assert.deepEqual({ ...(row as object) }, { series: 'E', project_ulid: null });
    assert.equal((w.C.db.prepare(`SELECT COUNT(*) n FROM refs WHERE entry_ulid = ? AND ref_type = 'entry'`).get(roll) as { n: number }).n, 3);
    assert.deepEqual(w.C.push().refused, []);

    // Before adoption: edits are not judged (today).
    updateEntry(w.C.db, { ulid: roll, description: 'rollup, edited before adoption' });
    assert.deepEqual(w.C.push().refused, []);

    w.adopt(); // c is a Contributor: note.edit.own, not note.edit.any
    updateEntry(w.C.db, { ulid: roll, description: 'rollup, edited after adoption' });
    updateEntryRefs(w.C.db, { ulid: roll, add: [{ ref_type: 'file', ref_value: 'rollup.md' }] });
    assert.deepEqual(w.C.push().refused, [], 'its pre-adoption owner edits it under note.edit.own');
    w.O.pull();
    assert.equal((w.O.db.prepare(`SELECT description FROM entries WHERE ulid = ?`).get(roll) as { description: string }).description, 'rollup, edited after adoption');
  } finally { w.done(); }
});

test('POST /v1/modules: today it shares; after adoption 410 with the bind hint; GET keeps answering', async () => {
  const o = await office();
  try {
    const a = await o.join('a');
    const ok = await requestJson(o.target(a), 'POST', '/v1/modules', { slug: 'sync', shared: true });
    assert.deepEqual([ok.status, ok.body.shared], [200, ['sync']], 'before adoption: today');

    adoptE(o.store, { name: 'emp1st', ownerDevice: a.device });
    const gone = await requestJson(o.target(a), 'POST', '/v1/modules', { slug: 'other', shared: true });
    assert.deepEqual([gone.status, gone.body], [410, { error: 'modules follow their project now: collab project bind <module> <CODE>' }]);
    const get = await requestJson(o.target(a), 'GET', '/v1/modules');
    assert.deepEqual([get.status, get.body.shared], [200, ['sync']]);
  } finally { await o.stop(); }
});
