import { test } from 'node:test';
import assert from 'node:assert';
import { testAtEachLevel, dbAt, assertFtsIntact } from './helpers/levels.js';
import { addEntry } from '../src/ops/add.js';
import { initModule } from '../src/ops/module.js';
import { supersede } from '../src/ops/supersede.js';
import { deleteEntry } from '../src/ops/delete.js';
import { setModuleHub, getHubStatus, resolveLive } from '../src/ops/hub.js';
import { newUlid } from '../src/ulid.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateTo } from '../src/db.js';
import { getModule } from '../src/ops/module.js';
import { doctor } from '../src/ops/doctor.js';

const M = 'demo-topic';
const note = (db: any, type: any, title: string, refs: string[] = []) =>
  addEntry(db, { type, title, summary: 's', module: M, refs: refs.map((r) => ({ ref_type: 'entry' as const, ref_value: r })) }).id;
const ulidOf = (db: any, id: number) => (db.prepare('SELECT ulid FROM entries WHERE id = ?').get(id) as { ulid: string }).ulid;

testAtEachLevel('no hub set -> state unset, no coverage', (db) => {
  initModule(db, { slug: M });
  note(db, 'decision', 'd1');
  const s = getHubStatus(db, M);
  assert.equal(s.state, 'unset');
  assert.equal(s.coverage, null);
});

testAtEachLevel('direct and 2-hop links count; 3-hop and unlinked do not', (db) => {
  initModule(db, { slug: M });
  const deep = note(db, 'gotcha', 'three hops away');
  const mid2 = note(db, 'decision', 'two hops', [String(deep)]);
  const mid1 = note(db, 'decision', 'one hop', [String(mid2)]);
  const lonely = note(db, 'proposal', 'nobody links me');
  note(db, 'handoff', 'handoffs are never flagged');
  const hub = note(db, 'decision', 'main map', [String(mid1)]);
  setModuleHub(db, { slug: M, id: hub });
  const c = getHubStatus(db, M).coverage!;
  assert.equal(c.linked_count, 2); // mid1, mid2
  assert.deepEqual(c.unlinked.map((u) => u.id).sort(), [deep, lonely].sort());
  assert.equal(c.unlinked_count, 2);
  assertFtsIntact(db);
});

testAtEachLevel('link to a replaced note follows to the replacement', (db) => {
  initModule(db, { slug: M });
  const oldN = note(db, 'decision', 'old');
  const newN = note(db, 'decision', 'new');
  const hub = note(db, 'decision', 'main', [String(oldN)]);
  supersede(db, { ids: [oldN], by: newN });
  setModuleHub(db, { slug: M, id: hub });
  const c = getHubStatus(db, M).coverage!;
  assert.equal(c.unlinked_count, 0, JSON.stringify(c.unlinked));
  assert.equal(c.expired.length, 0);
});

testAtEachLevel('link to a retired note expires: not counted, reported, not deleted', (db) => {
  initModule(db, { slug: M });
  const gone = note(db, 'decision', 'retired');
  const hub = note(db, 'decision', 'main', [String(gone)]);
  db.prepare('UPDATE entries SET deprecated = 1 WHERE id = ?').run(gone);
  setModuleHub(db, { slug: M, id: hub });
  const c = getHubStatus(db, M).coverage!;
  assert.deepEqual(c.expired.map((e) => e.to_id), [gone]);
  assert.equal(c.linked_count, 0);
  const refCount = (db.prepare(`SELECT COUNT(*) c FROM refs WHERE ref_type='entry' AND ref_value = ?`).get(String(gone)) as { c: number }).c;
  assert.equal(refCount, 1, 'expiry must never delete the ref');
});

testAtEachLevel('hub superseded -> replacement becomes the main note', (db) => {
  initModule(db, { slug: M });
  const d = note(db, 'decision', 'only new map links me');
  const hubOld = note(db, 'decision', 'old map');
  const hubNew = note(db, 'decision', 'new map', [String(d)]);
  setModuleHub(db, { slug: M, id: hubOld });
  supersede(db, { ids: [hubOld], by: hubNew });
  const s = getHubStatus(db, M);
  assert.equal(s.state, 'ok');
  assert.equal(s.coverage!.hub.id, hubNew);
  assert.equal(s.coverage!.hub.followed, true);
  assert.equal(s.coverage!.unlinked_count, 0);
});

testAtEachLevel('hub retired with no replacement -> state retired', (db) => {
  initModule(db, { slug: M });
  const hub = note(db, 'decision', 'map');
  setModuleHub(db, { slug: M, id: hub });
  db.prepare('UPDATE entries SET deprecated = 1 WHERE id = ?').run(hub);
  assert.equal(getHubStatus(db, M).state, 'retired');
});

testAtEachLevel('supersede cycle does not loop', (db) => {
  initModule(db, { slug: M });
  const a = note(db, 'decision', 'a');
  const b = note(db, 'decision', 'b');
  db.prepare('UPDATE entries SET deprecated = 1, superseded_by_ulid = ? WHERE id = ?').run(ulidOf(db, b), a);
  db.prepare('UPDATE entries SET deprecated = 1, superseded_by_ulid = ? WHERE id = ?').run(ulidOf(db, a), b);
  assert.equal(resolveLive(db, ulidOf(db, a)), null);
});

testAtEachLevel('setModuleHub guards', (db) => {
  initModule(db, { slug: M });
  initModule(db, { slug: 'other-topic' });
  const elsewhere = addEntry(db, { type: 'decision', title: 'x', summary: 's', module: 'other-topic' }).id;
  assert.throws(() => setModuleHub(db, { slug: 'no-such-topic', id: elsewhere }), /not found/);
  assert.throws(() => setModuleHub(db, { slug: M, id: elsewhere }), /not in module/);
  assert.throws(() => setModuleHub(db, { slug: M, id: 99999 }), /no entry/);
  const hub = note(db, 'decision', 'map');
  assert.equal(setModuleHub(db, { slug: M, id: hub }).hub!.id, hub);
  assert.equal(setModuleHub(db, { slug: M, id: null }).hub, null);
  assert.equal(getHubStatus(db, M).state, 'unset');
});

test('duplicate E-number: only the ULID the ref resolved to counts [0006]', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    initModule(db, { slug: M });
    const target = note(db, 'decision', 'real target');
    const hub = note(db, 'decision', 'map', [String(target)]);
    // A synced twin with the same E-number, different ULID, same module.
    const twin = newUlid();
    db.prepare(`INSERT INTO entries (ulid, id, type, kind, title, summary, module, category) VALUES (?, ?, 'gotcha', 'signal', 'twin', 's', ?, 'Reference')`).run(twin, target, M);
    db.prepare(`INSERT INTO entry_modules (entry_ulid, entry_id, module, is_primary) VALUES (?, ?, ?, 1)`).run(twin, target, M);
    setModuleHub(db, { slug: M, id: hub });
    const c = getHubStatus(db, M).coverage!;
    assert.equal(c.linked_count, 1);
    assert.deepEqual(c.unlinked.map((u) => u.title), ['twin']);
    assertFtsIntact(db);
  } finally { cleanup(); }
});

testAtEachLevel('unlinked list is capped and newest first', (db) => {
  initModule(db, { slug: M });
  const ids = [1, 2, 3, 4, 5, 6, 7].map((n) => note(db, 'gotcha', `g${n}`));
  const hub = note(db, 'decision', 'map');
  setModuleHub(db, { slug: M, id: hub });
  const c = getHubStatus(db, M, 5).coverage!;
  assert.equal(c.unlinked_count, 7);
  assert.equal(c.unlinked.length, 5);
  assert.equal(c.unlinked[0].id, ids[6]);
});

test('pre-0005 DB reports unset and never touches ULID columns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collab-0004-'));
  const db = new Database(join(dir, 'collab.db'));
  try {
    migrateTo(db, '0004');
    initModule(db, { slug: M });
    assert.deepEqual(getHubStatus(db, M), { state: 'unset', coverage: null });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

testAtEachLevel('module card carries hub status', (db) => {
  initModule(db, { slug: M });
  assert.equal(getModule(db, M).hub.state, 'unset');
  const g = note(db, 'gotcha', 'unlinked gotcha');
  const hub = note(db, 'decision', 'map');
  setModuleHub(db, { slug: M, id: hub });
  const card = getModule(db, M);
  assert.equal(card.hub.state, 'ok');
  assert.deepEqual(card.hub.coverage!.unlinked, []);
  assert.deepEqual(card.hub.coverage!.unlinked_on_card, [g]);
  assert.equal(card.hub.coverage!.unlinked_count, 1);
  assert.deepEqual(getModule(db, 'no-such-topic').hub, { state: 'unset', coverage: null });
});

testAtEachLevel('card drops the Index list once a main note is set', (db) => {
  initModule(db, { slug: M });
  const ix = addEntry(db, { type: 'decision', title: 'ix', summary: 's', module: M, category: 'Index' }).id;
  assert.deepEqual(getModule(db, M).indexes.map((i) => i.id), [ix]);
  setModuleHub(db, { slug: M, id: ix });
  assert.deepEqual(getModule(db, M).indexes, []);
});

testAtEachLevel('card lists at most 3 unlinked notes that are not already on the card', (db) => {
  initModule(db, { slug: M });
  const hub = note(db, 'decision', 'map');
  const props = [1, 2, 3, 4].map((n) => note(db, 'proposal', `p${n}`));
  setModuleHub(db, { slug: M, id: hub });
  const c = getModule(db, M).hub.coverage!;
  assert.equal(c.unlinked_count, 4);
  assert.equal(c.unlinked.length, 3);
  assert.deepEqual(c.unlinked_on_card, []);
  assert.ok(c.unlinked.every((u) => props.includes(u.id)));
});

const chk = (db: any, n: string) => doctor(db).checks.find((c) => c.name === n)!;

testAtEachLevel('doctor reports missing main notes, unlinked and expired links', (db) => {
  initModule(db, { slug: M });
  initModule(db, { slug: 'quiet-topic' }); // no important notes -> never "missing"
  note(db, 'decision', 'd');
  assert.deepEqual(chk(db, 'hub.missing').items, [M]);
  const gone = note(db, 'gotcha', 'retired');
  const hub = note(db, 'decision', 'map', [String(gone)]);
  db.prepare('UPDATE entries SET deprecated = 1 WHERE id = ?').run(gone);
  setModuleHub(db, { slug: M, id: hub });
  assert.equal(chk(db, 'hub.missing').severity, 'ok');
  assert.equal(chk(db, 'hub.unlinked').severity, 'warn');
  assert.match(String(chk(db, 'hub.unlinked').items![0]), new RegExp(`^${M}: 1 `));
  assert.match(String(chk(db, 'hub.expired_links').items![0]), /-> E-\d{5}/);
  assert.equal(doctor(db).ok, true, 'hub checks never fail the doctor');
});

test('doctor ignores tombstoned notes when deciding a main note is missing [0006]', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    initModule(db, { slug: M });
    const only = note(db, 'decision', 'deleted later');
    deleteEntry(db, only);
    assert.equal(chk(db, 'hub.missing').severity, 'ok');
    assertFtsIntact(db);
  } finally { cleanup(); }
});
