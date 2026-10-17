// file: courier/test/rnr-s1-acceptance.test.ts
// RnR S1 acceptance (plan Task 9): two laptops (N, R) and an office, end to
// end, then a regression run on a COPY of real data. N joins first, so the
// office makes N its admin and R a member (ledger ruling 1).
import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import {
  addEntryAsync, createTeamProject, findProject, readAccessCache, requestJson, postOfficeTargetFromDb,
  migrate, migrateTo, enableSync, setSyncValue, SYNC_KEYS, latestMigration, hasCrrTables, loadCrsqlite, doctor,
  SchemaMismatchError,
} from '@collab-mcp/core';
import { setModuleShared, addMember, openStore, closeStore, fetchDeliveries } from '@collab-mcp/post-office';
import { tempDir, startOffice, joinedDb, openWriter, closeWriter, until } from './world.js';
import { Courier } from '../src/engine.js';

const note = (title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'decision' as const, title, summary: `${title} summary`, ...extra });
const titlesIn = (db: DB, code: string) =>
  (db.prepare(`SELECT title FROM entries WHERE series = ? AND deleted_at IS NULL ORDER BY id`).all(code) as Array<{ title: string }>).map((r) => r.title);
const hasTitle = (db: DB, title: string) => !!db.prepare(`SELECT 1 FROM entries WHERE title = ?`).get(title);

test('RnR S1 acceptance: office roles, a private project, invite, refusal, removal, legacy E, old laptop', async () => {
  const t = tempDir('collab-rnr-s1-');
  const office = await startOffice(t.dir, 0);
  setModuleShared(office.store, 'team', true);
  const jn = await joinedDb(office, t.dir, 'n'), jr = await joinedDb(office, t.dir, 'r');
  const wn = openWriter(jn.path), wr = openWriter(jr.path);
  const cn = new Courier({ dbPath: jn.path, watch: false, retryMs: 60_000 });
  const cr = new Courier({ dbPath: jr.path, watch: false, retryMs: 60_000 });
  let oldW: DB | null = null, oldC: Courier | null = null;
  try {
    // 1. The office seeds N as Office admin and R as Office member.
    const accN = (await requestJson(cn.target, 'GET', '/v1/access')).body;
    const accR = (await requestJson(cr.target, 'GET', '/v1/access')).body;
    assert.equal(accN.office.role, 'Office admin');
    assert.equal(accR.office.role, 'Office member');
    await cn.syncNow(); await cr.syncNow();
    assert.equal(readAccessCache(wn).get('office')?.role, 'Office admin');
    assert.equal(readAccessCache(wr).get('office')?.role, 'Office member');

    // 2. R creates RK: only R sees it (R7a).
    const rk = await createTeamProject(wr, { name: 'R keeps', code: 'RK' });
    await cr.syncNow();
    for (const title of ['rk one', 'rk two']) await addEntryAsync(wr, note(title, { project: 'RK' }));
    await cr.pushNow();
    await cn.syncNow();
    assert.equal(findProject(wn, 'RK'), null, 'N does not see RK');
    assert.deepEqual(titlesIn(wn, 'RK'), [], 'no RK note reached N');
    const projN = (await requestJson(cn.target, 'GET', '/v1/projects')).body.projects as Array<{ code: string }>;
    assert.ok(!projN.some((p) => p.code === 'RK'), 'the office does not list RK to N');
    assert.equal(readAccessCache(wr).get(rk.ulid)?.role, 'Owner');

    // 3. R invites N as Reader: N receives RK's history (R14).
    assert.equal((await requestJson(cr.target, 'PUT' as 'POST', `/v1/projects/${rk.ulid}/members/${jn.device}`, { role: 'Reader' })).status, 200);
    await cn.syncNow();
    assert.deepEqual(titlesIn(wn, 'RK'), ['rk one', 'rk two']);
    assert.equal(readAccessCache(wn).get(rk.ulid)?.role, 'Reader');

    // 4. N (Reader) tries `team set` on R: refused, naming role.manage.
    const refused = await requestJson(cn.target, 'PUT' as 'POST', `/v1/projects/${rk.ulid}/members/${jr.device}`, { role: 'Reader' });
    assert.equal(refused.status, 403);
    assert.match(String(refused.body?.error), /^You need "[^"]+" \(role\.manage\) in RK to do this$/);
    const members = (await requestJson(cr.target, 'GET', `/v1/projects/${rk.ulid}/members`)).body.members as Array<{ device_id: string; role: string }>;
    assert.equal(members.find((m) => m.device_id === jr.device)?.role, 'Owner', 'R is still Owner');

    // 5. R removes N: N's RK is read-only and receives nothing new (R15).
    assert.equal((await requestJson(cr.target, 'DELETE', `/v1/projects/${rk.ulid}/members/${jn.device}`)).status, 200);
    await cn.syncNow();
    assert.ok(findProject(wn, 'RK')!.left_at, 'RK is marked left on N');
    assert.equal(readAccessCache(wn).has(rk.ulid), false);
    await assert.rejects(addEntryAsync(wn, note('N writes RK', { project: 'RK' })), /read-only|left/);
    await addEntryAsync(wr, note('rk after removal', { project: 'RK' }));
    await cr.pushNow();
    await cn.syncNow();
    assert.deepEqual(titlesIn(wn, 'RK'), ['rk one', 'rk two'], 'N keeps the history, gets nothing new');
    assert.equal(hasTitle(wn, 'rk after removal'), false);

    // 6. Legacy E notes in a shared module still reach both ways (rule 2).
    await addEntryAsync(wn, note('legacy from N', { module: 'team' }));
    await addEntryAsync(wr, note('legacy from R', { module: 'team' }));
    await cn.pushNow(); await cr.pushNow();
    await cn.syncNow(); await cr.syncNow();
    assert.ok(hasTitle(wr, 'legacy from N'), 'N -> R');
    assert.ok(hasTitle(wn, 'legacy from R'), 'R -> N (N is out of RK, still gets E)');

    // 7. A laptop pinned at 0011: 409 schema, needs-update, nothing delivered (Review Focus 4).
    mkdirSync(join(t.dir, 'old'), { recursive: true });
    const oldPath = join(t.dir, 'old', 'collab.db');
    const raw = new Database(oldPath);
    let oldDevice = '';
    try {
      migrateTo(raw, '0011_project_modules');
      assert.equal(latestMigration(raw), '0011_project_modules');
      enableSync(raw);
      const { deviceId, secret } = addMember(office.store, 'old');
      oldDevice = deviceId;
      const j = await requestJson({ url: office.url, fingerprint: office.fingerprint }, 'POST', '/v1/join', { device: deviceId, secret });
      assert.equal(j.status, 200, 'joining is not schema-gated');
      setSyncValue(raw, SYNC_KEYS.url, office.url);
      setSyncValue(raw, SYNC_KEYS.fingerprint, office.fingerprint);
      setSyncValue(raw, SYNC_KEYS.device, deviceId);
      setSyncValue(raw, SYNC_KEYS.key, j.body.key);
    } finally { closeWriter(raw); }
    oldW = openWriter(oldPath);
    await addEntryAsync(oldW, note('from the old laptop', { module: 'team' }));
    const target = postOfficeTargetFromDb(oldW)!;
    assert.equal(target.schema, '0011_project_modules');
    await assert.rejects(requestJson(target, 'GET', '/v1/access'), (e: unknown) => {
      assert.ok(e instanceof SchemaMismatchError, String(e));
      assert.match((e as Error).message, /0011_project_modules/);
      return true;
    });
    oldC = new Courier({ dbPath: oldPath, watch: false, retryMs: 60_000 });
    await oldC.syncNow().catch(() => {});
    assert.equal(oldC.status.state, 'needs-update');
    assert.equal(latestMigration(oldW), '0011_project_modules', 'the courier never upgraded the laptop');
    assert.equal(hasTitle(oldW, 'legacy from N'), false, 'nothing delivered to the old laptop');
    assert.equal(hasTitle(oldW, 'rk one'), false);
    const fromOld = (office.store.prepare(`SELECT COUNT(*) n FROM po_deliveries WHERE origin = ?`).get(oldDevice) as { n: number }).n;
    assert.equal(fromOld, 0, 'nothing accepted from the old laptop');
    await cn.syncNow();
    assert.equal(hasTitle(wn, 'from the old laptop'), false);
  } finally {
    await cn.stop(); await cr.stop(); if (oldC) await oldC.stop();
    closeWriter(wn); closeWriter(wr); if (oldW) closeWriter(oldW);
    await office.close();
    t.cleanup();
  }
});

// ---- regression on a copy of real data (Task 9 step 2) ----
// The snapshots are read-only copies of this machine's real notebook and
// office store, taken by the controller; the real files are never opened.
// Local to one machine: the test SKIPS when they are absent. Point
// COLLAB_REAL_SNAPSHOT_DIR at a folder holding notebook.db + store.db to run it.
const SNAPSHOT_DIR = process.env.COLLAB_REAL_SNAPSHOT_DIR
  ?? 'C:\\Users\\NAVEEN~1\\AppData\\Local\\Temp\\claude\\C--Users-NaveenPrajapati-Downloads-dev-frontend2\\d7e2e6fc-a5ff-42fc-9cea-d2a363fee028\\scratchpad\\real-snapshot';
const SNAP_NOTEBOOK = join(SNAPSHOT_DIR, 'notebook.db'), SNAP_STORE = join(SNAPSHOT_DIR, 'store.db');
const haveSnapshot = existsSync(SNAP_NOTEBOOK) && existsSync(SNAP_STORE);

const ENTRY_COLS = `ulid, series, id, title, summary, description, project_ulid, updated_at`;
const entriesOf = (db: DB) => db.prepare(`SELECT ${ENTRY_COLS} FROM entries ORDER BY ulid`).all();
/** Opened the way getDb opens a notebook: cr-sqlite loaded when it shares. */
function openNotebook(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  if (hasCrrTables(db)) loadCrsqlite(db);
  return db;
}
const errorChecks = (db: DB, cwd: string) =>
  new Set(doctor(db, { cwd, env: {} }).checks.filter((c) => c.severity === 'error').map((c) => c.name));
const identity = (site: string, dbv: number, ch: number, tbl: string, pk: string, cid: string) => `${site}|${dbv}|${ch}|${tbl}|${pk}|${cid}`;

test('regression: a copy of the real notebook and office store opens unchanged with the new build', { skip: !haveSnapshot && `no snapshot at ${SNAPSHOT_DIR}` }, (tc) => {
  const t = tempDir('collab-rnr-real-');
  try {
    const nb = join(t.dir, 'notebook.db'), st = join(t.dir, 'store.db');
    copyFileSync(SNAP_NOTEBOOK, nb);
    copyFileSync(SNAP_STORE, st);

    // Notebook: baseline (as copied), then the new build's migrate.
    let beforeEntries: unknown[] = [], baselineErrors = new Set<string>();
    let db = openNotebook(nb);
    try {
      beforeEntries = entriesOf(db);
      assert.ok(beforeEntries.length > 0);
      baselineErrors = errorChecks(db, t.dir);
      migrate(db);
      assert.equal(latestMigration(db), '0012_access_cache');
    } finally { closeWriter(db); }
    db = openNotebook(nb);
    try {
      assert.deepEqual(entriesOf(db), beforeEntries, 'every notebook entries row unchanged');
      const after = errorChecks(db, t.dir);
      const fresh = [...after].filter((n) => !baselineErrors.has(n));
      assert.deepEqual(fresh, [], 'doctor reports no new errors');
      tc.diagnostic(`notebook: ${beforeEntries.length} entries unchanged; doctor errors before [${[...baselineErrors]}] after [${[...after]}]`);
    } finally { closeWriter(db); }

    // Office store: read the pre-upgrade state with a plain handle first.
    const pre = new Database(st, { readonly: true });
    const preEntries = entriesOf(pre);
    const preRows = pre.prepare(`SELECT origin, tbl, pk, cid, db_version, site_id, ch_seq FROM po_deliveries ORDER BY seq`).all() as Array<{
      origin: string; tbl: string; pk: Buffer; cid: string; db_version: number; site_id: Buffer; ch_seq: number;
    }>;
    const live = (pre.prepare(`SELECT device_id FROM po_members WHERE revoked_at IS NULL ORDER BY joined_at IS NULL, joined_at, created_at, rowid`).all() as Array<{ device_id: string }>).map((r) => r.device_id);
    const revoked = (pre.prepare(`SELECT device_id FROM po_members WHERE revoked_at IS NOT NULL`).all() as Array<{ device_id: string }>).map((r) => r.device_id);
    const projects = (pre.prepare(`SELECT ulid FROM po_projects`).all() as Array<{ ulid: string }>).map((r) => r.ulid);
    pre.close();
    assert.ok(live.length > 0 && preRows.length > 0);

    const store = openStore(st); // seeds access (R11) and stamps the deliveries (R3)
    try {
      assert.deepEqual(entriesOf(store), preEntries, 'every office entries row unchanged');
      tc.diagnostic(`store: ${preEntries.length} entries unchanged; ${live.length} live, ${revoked.length} revoked members; ${projects.length} project(s)`);
      // R11: earliest-joined live member is Office admin, the rest Office members; all Owners of every project.
      const officeRole = (d: string) => (store.prepare(
        `SELECT r.name FROM po_office_members x JOIN po_office_roles r ON r.ulid = x.role_ulid WHERE x.device_id = ?`,
      ).get(d) as { name: string } | undefined)?.name;
      const projectRole = (p: string, d: string) => (store.prepare(
        `SELECT r.name FROM po_project_members x JOIN po_roles r ON r.ulid = x.role_ulid WHERE x.project_ulid = ? AND x.device_id = ?`,
      ).get(p, d) as { name: string } | undefined)?.name;
      live.forEach((d, i) => assert.equal(officeRole(d), i === 0 ? 'Office admin' : 'Office member', d));
      for (const p of projects) for (const d of live) assert.equal(projectRole(p, d), 'Owner', `${d} in ${p}`);
      for (const d of revoked) {
        assert.equal(officeRole(d), undefined, `revoked ${d} has no office role`);
        for (const p of projects) assert.equal(projectRole(p, d), undefined, `revoked ${d} has no role in ${p}`);
      }
      // Every pre-upgrade delivery is still there, none held.
      const postIds = new Set((store.prepare(`SELECT tbl, pk, cid, db_version, site_id, ch_seq FROM po_deliveries`).all() as typeof preRows)
        .map((r) => identity(r.site_id.toString('base64'), r.db_version, r.ch_seq, r.tbl, r.pk.toString('base64'), r.cid)));
      for (const r of preRows) assert.ok(postIds.has(identity(r.site_id.toString('base64'), r.db_version, r.ch_seq, r.tbl, r.pk.toString('base64'), r.cid)));
      assert.equal((store.prepare(`SELECT COUNT(*) n FROM po_deliveries WHERE project_ulid = '?'`).get() as { n: number }).n, 0, 'nothing held');
      // ... and reaches every current member (all but its own).
      for (const d of live) {
        const want = new Set(preRows.filter((r) => r.origin !== d)
          .map((r) => identity(r.site_id.toString('base64'), r.db_version, r.ch_seq, r.tbl, r.pk.toString('base64'), r.cid)));
        const got = new Set<string>();
        let after = 0;
        for (;;) {
          const f = fetchDeliveries(store, d, after, 5000);
          for (const c of f.changes) got.add(identity(c.site_id, c.db_version, c.seq, c.table, c.pk, c.cid));
          after = f.lastSeq;
          if (!f.more) break;
        }
        const missing = [...want].filter((x) => !got.has(x));
        assert.equal(missing.length, 0, `${d} misses ${missing.length} of ${want.size} pre-upgrade deliveries`);
        assert.equal(got.size, want.size, `${d} receives exactly the pre-upgrade deliveries`);
        tc.diagnostic(`store: member ${d} receives ${got.size} of ${preRows.length} pre-upgrade deliveries (the rest are its own)`);
      }
    } finally { closeStore(store); }
  } finally { t.cleanup(); }
});
