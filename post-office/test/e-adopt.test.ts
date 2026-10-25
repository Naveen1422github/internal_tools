// Local-first Task 4: the office adopts E. E notes keep project_ulid NULL in their own rows;
// only their DELIVERY stamp becomes E_PROJECT_ULID, so they reach E's members only.
import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { addEntryAsync, updateEntry, initModule, setAllocator, readOwnChanges, decodeChange, newUlid, requestJson, E_PROJECT_ULID, type WireChange } from '@collab-mcp/core';
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
