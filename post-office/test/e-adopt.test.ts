// Local-first Task 4: the office adopts E. E notes keep project_ulid NULL in their own rows;
// only their DELIVERY stamp becomes E_PROJECT_ULID, so they reach E's members only.
import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { addEntryAsync, updateEntry, initModule, setAllocator, readOwnChanges, applyChanges, decodeChange, encodeChange, newUlid, requestJson, E_PROJECT_ULID, type WireChange } from '@collab-mcp/core';
import { tempStore, tempDir, laptop } from './helpers.js';
import { office } from './office.js';
import { acceptChanges, fetchDeliveries, fetchReplay, lastSeq } from '../src/deliveries.js';
import { registerProject, allocate, openStore, closeStore, type Store } from '../src/store.js';
import { setProjectMember, assignNewMemberOfficeRole } from '../src/access.js';
import { adoptE, isEAdoptedOffice } from '../src/e-adopt.js';
import { runCli } from '../src/cli.js';

const TABLES = ['entries', 'refs', 'entry_modules', 'entry_revisions'];

function member(store: Store, id: string): void {
  store.prepare(`INSERT INTO po_members (device_id, name, joined_at) VALUES (?, ?, datetime('now'))`).run(id, id);
  assignNewMemberOfficeRole(store, id);
}
let n = 0;
async function note(db: Database.Database, title: string, project?: { store: Store; ulid: string; code: string }): Promise<string> {
  setAllocator({ allocate: async () => ++n });
  const r = await addEntryAsync(db, {
    type: 'decision', title, summary: `${title} s`, description: `${title} body`, module: 'm',
    refs: [{ ref_type: 'file', ref_value: `${title}.ts` }],
  });
  if (project) {
    db.prepare(`UPDATE entries SET series = ?, id = ? WHERE ulid = ?`).run(project.code, allocate(project.store, r.ulid, null, project.code), r.ulid);
    db.prepare(`UPDATE entries SET project_ulid = ? WHERE ulid = ?`).run(project.ulid, r.ulid);
  }
  updateEntry(db, { ulid: r.ulid, description: `${title} body, edited` }); // entry_revisions rows
  return r.ulid;
}
const version = (db: Database.Database) => (db.prepare(`SELECT crsql_db_version() v`).get() as { v: number }).v;
/** The entry a delivered change belongs to, resolved in the office. null = modules. */
function ownerOf(db: Store, w: WireChange): string | null {
  const c = decodeChange(w);
  if (c.table === 'modules') return null;
  const k = (db.prepare(`SELECT cell FROM crsql_unpack_columns(?)`).get(c.pk) as { cell: string }).cell;
  if (c.table !== 'entry_revisions') return k;
  return (db.prepare(`SELECT entry_ulid FROM entry_revisions WHERE rev_id = ?`).get(k) as { entry_ulid: string }).entry_ulid;
}
const tablesOf = (ws: WireChange[], s: Store, u: string) => new Set(ws.filter((w) => ownerOf(s, w) === u).map((w) => decodeChange(w).table));
const fetchAll = (s: Store, d: string, after = 0) => fetchDeliveries(s, d, after, 5000);
const count = (s: Store, where: string) => (s.prepare(`SELECT COUNT(*) n FROM po_deliveries WHERE ${where}`).get() as { n: number }).n;

test('adoptE: a non-E member gets no E rows (old or new) but keeps TT; members and replay get E (Review Focus 3)', async () => {
  const { store, cleanup } = tempStore();
  const lo = laptop(), lg = laptop();
  try {
    for (const d of ['owner', 'abhishek', 'gaurav']) member(store, d);
    const TT = registerProject(store, { ulid: newUlid(), name: 'Project TT', code: 'TT' }, 'owner').ulid;
    setProjectMember(store, null, TT, 'abhishek', 'Editor');
    store.prepare(`DELETE FROM po_replays`).run(); // stamping, not replay: abhishek counts as replayed

    initModule(lo.db, { slug: 'm', name: 'M' });
    const eOld = await note(lo.db, 'e-old');
    const ttOld = await note(lo.db, 'tt-old', { store, ulid: TT, code: 'TT' });
    acceptChanges(store, 'owner', readOwnChanges(lo.db, 0));

    // Before adoption: exactly today's behaviour (E goes to everyone).
    assert.equal(isEAdoptedOffice(store), false);
    const before = fetchAll(store, 'abhishek');
    assert.ok(before.changes.some((w) => ownerOf(store, w) === eOld), 'before adoption abhishek gets E (today)');
    const eRows = count(store, `project_ulid IS NULL AND tbl IN ('entries','refs','entry_modules','entry_revisions')`);
    const modulesRows = count(store, `tbl = 'modules'`);
    assert.ok(eRows > 0 && modulesRows > 0);
    const held = count(store, `project_ulid = '?'`);
    const ttRows = count(store, `project_ulid = '${TT}'`);

    const { restamped } = adoptE(store, { name: 'emp1st', ownerDevice: 'owner' });
    assert.equal(restamped, eRows, 'every E row of the 4 tables is restamped');
    assert.equal(isEAdoptedOffice(store), true);
    assert.equal(count(store, `project_ulid = '${E_PROJECT_ULID}'`), eRows);
    assert.equal(count(store, `tbl = 'modules' AND project_ulid IS NULL`), modulesRows, 'modules rows stay NULL');
    assert.equal(count(store, `project_ulid = '?'`), held, "'?' rows untouched");
    assert.equal(count(store, `project_ulid = '${TT}'`), ttRows, 'TT rows untouched');
    assert.equal((store.prepare(`SELECT project_ulid FROM entries WHERE ulid = ?`).get(eOld) as { project_ulid: string | null }).project_ulid, null, 'the note itself keeps project_ulid NULL');
    assert.deepEqual(store.prepare(`SELECT code, name FROM po_projects WHERE ulid = ?`).get(E_PROJECT_ULID), { code: 'E', name: 'emp1st' });
    assert.equal((store.prepare(`SELECT COUNT(*) n FROM po_series_counters WHERE series = 'E'`).get() as { n: number }).n, 0, 'E keeps po_meta.counter');

    // After adoption: an edit of the old E note (a held note: final stamp path), a new E note, a new TT note.
    const v = version(lo.db);
    updateEntry(lo.db, { ulid: eOld, description: 'e-old edited after adoption' });
    const eNew = await note(lo.db, 'e-new');
    const ttNew = await note(lo.db, 'tt-new', { store, ulid: TT, code: 'TT' });
    acceptChanges(store, 'owner', readOwnChanges(lo.db, v));
    assert.equal(count(store, `tbl IN ('entries','refs','entry_modules','entry_revisions') AND project_ulid IS NULL`), 0, 'no NULL note row after adoption');

    const a = fetchAll(store, 'abhishek');
    const aOwners = new Set(a.changes.map((w) => ownerOf(store, w)));
    assert.ok(!aOwners.has(eOld), 'abhishek gets nothing of the old E note');
    assert.ok(!aOwners.has(eNew), 'abhishek gets nothing of the new E note');
    assert.ok(aOwners.has(ttOld) && aOwners.has(ttNew), 'abhishek keeps receiving TT');
    for (const t of TABLES) assert.ok(tablesOf(a.changes, store, ttNew).has(t), `abhishek gets TT's ${t} rows`);
    assert.ok(a.changes.some((w) => decodeChange(w).table === 'modules'), 'modules rows still reach everyone');
    assert.equal(a.lastSeq, lastSeq(store), 'the bookmark passes the E rows');

    // Gaurav joins E: the whole E history arrives by replay.
    setProjectMember(store, null, E_PROJECT_ULID, 'gaurav', 'Editor');
    const rep = fetchReplay(store, 'gaurav', E_PROJECT_ULID, 0, 5000);
    for (const t of TABLES) {
      assert.ok(tablesOf(rep.changes, store, eOld).has(t), `replay has the old E note's ${t} rows`);
      assert.ok(tablesOf(rep.changes, store, eNew).has(t), `replay has the new E note's ${t} rows`);
    }
    assert.ok(!rep.changes.some((w) => ownerOf(store, w) === ttOld), 'replay is E only');
    assert.equal(fetchReplay(store, 'gaurav', E_PROJECT_ULID, rep.last_seq, 5000).done, true);

    // Owner gets new E rows written by another member.
    initModule(lg.db, { slug: 'm', name: 'M' });
    const eG = await note(lg.db, 'e-gaurav');
    const top = lastSeq(store);
    acceptChanges(store, 'gaurav', readOwnChanges(lg.db, 0));
    const o = fetchAll(store, 'owner', top);
    for (const t of TABLES) assert.ok(tablesOf(o.changes, store, eG).has(t), `owner gets gaurav's E ${t} rows`);
    assert.ok(!fetchAll(store, 'abhishek', top).changes.some((w) => ownerOf(store, w) === eG), 'abhishek does not');

    assert.throws(() => adoptE(store, { name: 'emp1st', ownerDevice: 'owner' }), /already/);
  } finally { setAllocator(null); lo.cleanup(); lg.cleanup(); cleanup(); }
});

test('after adoption a non-member refused E edit is undone for that sender only (fix round 1, ruling a)', async () => {
  const { store, cleanup } = tempStore();
  const lo = laptop(), la = laptop();
  try {
    for (const d of ['owner', 'abhishek', 'carol']) member(store, d); // owner = Office admin; the others Office member
    const TT = registerProject(store, { ulid: newUlid(), name: 'Project TT', code: 'TT' }, 'owner').ulid;
    setProjectMember(store, null, TT, 'abhishek', 'Editor');
    store.prepare(`DELETE FROM po_replays`).run();
    initModule(lo.db, { slug: 'm', name: 'M' });
    const eOld = await note(lo.db, 'e-old');
    acceptChanges(store, 'owner', readOwnChanges(lo.db, 0));
    // Abhishek holds the old E note (delivered to everyone before adoption).
    const got = fetchAll(store, 'abhishek');
    applyChanges(la.db, got.changes.map(decodeChange));
    fetchAll(store, 'abhishek', got.lastSeq); // the next pull acknowledges it (receive_bookmark)
    const officeId = (la.db.prepare(`SELECT id FROM entries WHERE ulid = ?`).get(eOld) as { id: number }).id;

    adoptE(store, { name: 'emp1st', ownerDevice: 'owner' });
    const top = lastSeq(store);
    const v = version(la.db);
    la.db.prepare(`UPDATE entries SET id = 99999 WHERE ulid = ?`).run(eOld); // numbers are the office's: refused (NUMBER)
    const r = acceptChanges(store, 'abhishek', readOwnChanges(la.db, v));
    assert.ok(r.refused.length > 0, 'the renumbering is refused');
    assert.ok(count(store, `seq > ${top} AND project_ulid = '${E_PROJECT_ULID}'`) > 0, 'the write-back is stamped E');

    const a = fetchAll(store, 'abhishek', top);
    assert.ok(a.changes.some((w) => ownerOf(store, w) === eOld), 'the sender receives the undo of its own refused change');
    applyChanges(la.db, a.changes.map(decodeChange));
    assert.equal((la.db.prepare(`SELECT id FROM entries WHERE ulid = ?`).get(eOld) as { id: number }).id, officeId, 'and its laptop reverts');
    assert.ok(!fetchAll(store, 'carol', top).changes.some((w) => ownerOf(store, w) === eOld), 'another non-member gets nothing of it');
    assert.ok(fetchAll(store, 'owner', top).changes.some((w) => ownerOf(store, w) === eOld), 'E members still get the write-back');
  } finally { setAllocator(null); lo.cleanup(); la.cleanup(); cleanup(); }
});

test('fix round 2: a forged change to a note the sender never received gets no rows back (TT and E)', async () => {
  const { store, cleanup } = tempStore();
  const lo = laptop(), lc = laptop(), ld = laptop();
  try {
    for (const d of ['owner', 'carol']) member(store, d);
    const TT = registerProject(store, { ulid: newUlid(), name: 'Project TT', code: 'TT' }, 'owner').ulid;
    initModule(lo.db, { slug: 'm', name: 'M' });
    const eOld = await note(lo.db, 'e-old');
    const tt = await note(lo.db, 'tt-secret', { store, ulid: TT, code: 'TT' });
    const all = readOwnChanges(lo.db, 0);
    acceptChanges(store, 'owner', all);
    adoptE(store, { name: 'emp1st', ownerDevice: 'owner' });
    member(store, 'dave'); // joined after adoption: never received E
    // Both forgers get the cells out of band (the worst case: they know more than the ULID).
    for (const l of [lc, ld]) applyChanges(l.db, all.map(decodeChange));
    const top = lastSeq(store);

    // carol (not in TT) edits the TT note: refused (note.edit.any in TT).
    let v = version(lc.db);
    lc.db.prepare(`UPDATE entries SET title = 'forged' WHERE ulid = ?`).run(tt);
    assert.ok(acceptChanges(store, 'carol', readOwnChanges(lc.db, v)).refused.length > 0);
    // dave (not in E, never received it) renumbers the E note: refused (NUMBER).
    v = version(ld.db);
    ld.db.prepare(`UPDATE entries SET id = 99999 WHERE ulid = ?`).run(eOld);
    assert.ok(acceptChanges(store, 'dave', readOwnChanges(ld.db, v)).refused.length > 0);

    assert.equal(count(store, `origin LIKE 'post-office>%'`), 0, 'no write-back is addressed to an unproven sender');
    assert.ok(!fetchAll(store, 'carol', top).changes.some((w) => ownerOf(store, w) === tt), 'carol gets nothing of the TT note');
    assert.ok(!fetchAll(store, 'dave', top).changes.some((w) => ownerOf(store, w) === eOld), 'dave gets nothing of the E note');
    assert.ok(fetchAll(store, 'owner', top).changes.some((w) => ownerOf(store, w) === tt), 'members still get the write-back');
  } finally { setAllocator(null); lo.cleanup(); lc.cleanup(); ld.cleanup(); cleanup(); }
});

test('fix round 2: a refused delete/re-insert by a proven holder is never answered with the whole row', async () => {
  const { store, cleanup } = tempStore();
  const lo = laptop(), la = laptop();
  try {
    for (const d of ['owner', 'abhishek']) member(store, d);
    initModule(lo.db, { slug: 'm', name: 'M' });
    const eOld = await note(lo.db, 'e-old');
    acceptChanges(store, 'owner', readOwnChanges(lo.db, 0));
    const got = fetchAll(store, 'abhishek');
    applyChanges(la.db, got.changes.map(decodeChange));
    fetchAll(store, 'abhishek', got.lastSeq);
    adoptE(store, { name: 'emp1st', ownerDevice: 'owner' });
    // An E member edits the note after adoption: abhishek must not learn the new value.
    const vo = version(lo.db);
    updateEntry(lo.db, { ulid: eOld, summary: 'post-adoption secret' });
    acceptChanges(store, 'owner', readOwnChanges(lo.db, vo));
    const top = lastSeq(store);
    const v = version(la.db);
    la.db.pragma('foreign_keys = OFF');
    la.db.prepare(`DELETE FROM entries WHERE ulid = ?`).run(eOld); // a hard delete: refused
    const r = acceptChanges(store, 'abhishek', readOwnChanges(la.db, v));
    assert.ok(r.refused.length > 0, 'notes are never hard-deleted');
    const a = fetchAll(store, 'abhishek', top);
    assert.ok(!a.changes.some((w) => ownerOf(store, w) === eOld), 'no row of the note: the whole-row rewrite follows its stamp (E)');
    assert.ok(!a.changes.some((w) => String(decodeChange(w).val ?? '').includes('post-adoption secret')));
  } finally { setAllocator(null); lo.cleanup(); la.cleanup(); cleanup(); }
});

test('fix round 3: a forged high col_version never returns a value an E member wrote after adoption', async () => {
  const { store, cleanup } = tempStore();
  const lo = laptop(), la = laptop();
  try {
    for (const d of ['owner', 'abhishek']) member(store, d);
    initModule(lo.db, { slug: 'm', name: 'M' });
    const N = await note(lo.db, 'old title');
    acceptChanges(store, 'owner', readOwnChanges(lo.db, 0));
    const got = fetchAll(store, 'abhishek');
    applyChanges(la.db, got.changes.map(decodeChange));
    fetchAll(store, 'abhishek', got.lastSeq); // acknowledged before adoption
    const oldId = (la.db.prepare(`SELECT id FROM entries WHERE ulid = ?`).get(N) as { id: number }).id;
    adoptE(store, { name: 'emp1st', ownerDevice: 'owner' });
    const vo = version(lo.db);
    updateEntry(lo.db, { ulid: N, title: 'new title after adoption' });
    acceptChanges(store, 'owner', readOwnChanges(lo.db, vo));
    const top = lastSeq(store);

    // One group: a forged title at a huge col_version + a renumbering (refused: NUMBER refuses the group).
    const v = version(la.db);
    la.db.transaction(() => {
      la.db.prepare(`UPDATE entries SET title = 'forged', id = 99999 WHERE ulid = ?`).run(N);
    })();
    const forged = readOwnChanges(la.db, v).map(decodeChange).map((c) => (c.table === 'entries' && c.cid === 'title' ? { ...c, col_version: 1_000_000 } : c)).map(encodeChange);
    assert.ok(acceptChanges(store, 'abhishek', forged).refused.length > 0);

    const a = fetchAll(store, 'abhishek', top).changes.map(decodeChange).filter((c) => c.table === 'entries');
    assert.ok(!a.some((c) => String(c.val ?? '').includes('new title after adoption')), 'no row carries the E member’s new title');
    assert.ok(!a.some((c) => c.cid === 'title'), 'the title undo follows its stamp (E)');
    assert.ok(a.some((c) => c.cid === 'id' && c.val === oldId), 'the untouched id cell still undoes for him');
    assert.ok(fetchAll(store, 'owner', top).changes.map(decodeChange).some((c) => c.cid === 'title'), 'E members get the title undo');
  } finally { setAllocator(null); lo.cleanup(); la.cleanup(); cleanup(); }
});

test('adoptE is one transaction: a bad owner leaves nothing behind', () => {
  const { store, cleanup } = tempStore();
  try {
    member(store, 'owner');
    store.prepare(`INSERT INTO po_deliveries (origin, tbl, pk, cid, val, col_version, db_version, site_id, cl, ch_seq, project_ulid)
                   VALUES ('owner', 'entries', X'0101', 'title', 'x', 1, 1, X'00112233445566778899aabbccddeeff', 1, 0, NULL)`).run();
    assert.throws(() => adoptE(store, { name: 'emp1st', ownerDevice: 'nobody' }), /member/);
    assert.equal(isEAdoptedOffice(store), false);
    assert.equal(store.prepare(`SELECT 1 FROM po_projects WHERE ulid = ?`).get(E_PROJECT_ULID), undefined);
    assert.equal(count(store, `project_ulid IS NULL`), 1);
    // That row's note can't be resolved (a deleted E note's history): it was NULL = no project, so it becomes E.
    assert.equal(adoptE(store, { name: 'emp1st', ownerDevice: 'owner' }).restamped, 1);
    assert.equal(count(store, `project_ulid = '${E_PROJECT_ULID}'`), 1);
  } finally { cleanup(); }
});

test('GET /v1/access reports eProject {adopted, member} per device', async () => {
  const o = await office();
  try {
    const own = await o.join('Owner'), ab = await o.join('Abhishek');
    const b0 = await requestJson(o.target(ab), 'GET', '/v1/access');
    assert.deepEqual(b0.body.eProject, { adopted: false, member: false });
    adoptE(o.store, { name: 'emp1st', ownerDevice: own.device });
    assert.deepEqual((await requestJson(o.target(own), 'GET', '/v1/access')).body.eProject, { adopted: true, member: true });
    assert.deepEqual((await requestJson(o.target(ab), 'GET', '/v1/access')).body.eProject, { adopted: true, member: false });
  } finally { await o.stop(); }
});

test('GET /v1/projects never lists E, before or after adoption (older laptops would crash on code E)', async () => {
  const o = await office();
  try {
    const own = await o.join('Owner');
    const tt = { ulid: newUlid(), name: 'Project TT', code: 'TT' };
    assert.equal((await requestJson(o.target(own), 'POST', '/v1/projects', tt)).status, 200);
    const codes = async () => ((await requestJson(o.target(own), 'GET', '/v1/projects')).body.projects as Array<{ code: string; ulid: string }>);
    assert.deepEqual((await codes()).map((p) => p.code), ['TT']);
    adoptE(o.store, { name: 'emp1st', ownerDevice: own.device });
    const after = await codes();
    assert.deepEqual(after.map((p) => p.code), ['TT'], 'still TT, never E');
    assert.ok(!after.some((p) => p.ulid === E_PROJECT_ULID));
    assert.deepEqual((await requestJson(o.target(own), 'GET', '/v1/access')).body.eProject, { adopted: true, member: true }, 'E is learned through /v1/access');
  } finally { await o.stop(); }
});

test('CLI adopt-e --owner <member> prints the count and how to add members', async () => {
  const t = tempDir();
  try {
    const data = join(t.dir, 'office');
    const io = () => { const out: string[] = [], err: string[] = []; return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }; };
    await runCli(['init', '--data', data, '--seed-max-id', '0', '--url', 'https://10.0.0.9:7443'], io().io);
    assert.equal((await runCli(['add-member', 'main', '--data', data], io().io)).code, 0);
    const bad = io();
    assert.equal((await runCli(['adopt-e', '--data', data], bad.io)).code, 1);
    assert.match(bad.err.join('\n'), /--owner/);
    const c = io();
    assert.equal((await runCli(['adopt-e', '--owner', 'main', '--data', data], c.io)).code, 0, c.err.join('\n'));
    assert.match(c.out.join('\n'), /restamped 0/);
    assert.ok(c.out.includes('add members: collab team set <member> E <role>'));
    const s = openStore(join(data, 'store.db'));
    try { assert.deepEqual(s.prepare(`SELECT name FROM po_projects WHERE ulid = ?`).get(E_PROJECT_ULID), { name: 'emp1st' }); } finally { closeStore(s); }
    const again = io();
    assert.equal((await runCli(['adopt-e', '--owner', 'main', '--data', data], again.io)).code, 1);
  } finally { t.cleanup(); }
});
