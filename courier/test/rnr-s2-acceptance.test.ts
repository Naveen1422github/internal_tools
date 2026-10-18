// file: courier/test/rnr-s2-acceptance.test.ts
// RnR S2 acceptance (plan Task 9): two laptops (N the owner, R the teammate)
// and an office, end to end, then a regression run on COPIES of real data.
import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import {
  addEntryAsync, updateEntry, supersede, createProject, newUlid, listRefused, copyRefused, readAccessCache, getEntryByUlid,
  setAllocator, setAllocationRetry, setDefaultActor, AccessDeniedError, unsentSharedCount,
  migrate, latestMigration, hasCrrTables, loadCrsqlite, doctor, type RawChange,
} from '@collab-mcp/core';
import { registerProject, setProjectMember, setOfficeRole, setModuleShared, openStore, closeStore } from '@collab-mcp/post-office';
// classify is not in the package index; the test reads it from the built dist.
import { classify } from '../../post-office/dist/classify.js';
import { tempDir, startOffice, joinedDb, openWriter, closeWriter } from './world.js';
import { Courier } from '../src/engine.js';

const note = (title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'decision' as const, title, summary: `${title} summary`, ...extra });
const titleOf = (db: DB, ulid: string) =>
  (db.prepare(`SELECT title FROM entries WHERE ulid = ?`).get(ulid) as { title: string } | undefined)?.title;
const idOf = (db: DB, ulid: string) =>
  (db.prepare(`SELECT id FROM entries WHERE ulid = ?`).get(ulid) as { id: number | null } | undefined)?.id;
const hasTitle = (db: DB, title: string) => !!db.prepare(`SELECT 1 FROM entries WHERE title = ?`).get(title);
const reqs = (o: { requests: Array<{ route: string; device: string }> }, device: string, route: string) =>
  o.requests.filter((q) => q.device === device && q.route === route).length;

test('RnR S2 acceptance: roles enforced by the office, refusals kept, MCP guard, legacy E untouched, no ghost notes', async () => {
  const t = tempDir('collab-rnr-s2-');
  const office = await startOffice(t.dir, 0);
  setModuleShared(office.store, 'team', true);
  setModuleShared(office.store, 'docs', true);
  const jn = await joinedDb(office, t.dir, 'n'), jr = await joinedDb(office, t.dir, 'r');
  const wn = openWriter(jn.path), wr = openWriter(jr.path);
  const cn = new Courier({ dbPath: jn.path, watch: false, retryMs: 60_000 });
  const cr = new Courier({ dbPath: jr.path, watch: false, retryMs: 60_000 });
  setAllocationRetry({ delaysMs: [0, 0], timeoutMs: 1500 });
  try {
    const sh = registerProject(office.store, { ulid: newUlid(), name: 'Support hub', code: 'SH', seed: 0 }, jn.device);
    await cn.syncNow();

    // 1. N (Owner) makes R a Contributor of SH.
    setProjectMember(office.store, jn.device, sh.ulid, jr.device, 'Contributor');
    await cr.syncNow();
    assert.equal(readAccessCache(wr).get(sh.ulid)?.role, 'Contributor');
    const nNote = (await addEntryAsync(wn, note('N original', { project: 'SH' }))).ulid;
    await cn.pushNow(); await cr.syncNow();
    assert.equal(titleOf(wr, nNote), 'N original', 'R sees N\'s note');

    // 2. R creates a note: accepted, N receives it.
    const rNote = (await addEntryAsync(wr, note('R first', { project: 'SH' }))).ulid;
    await cr.syncNow(); await cn.syncNow();
    assert.equal(titleOf(wn, rNote), 'R first', 'N received R\'s note');
    assert.notEqual(idOf(wr, rNote), null, 'R\'s note was numbered');
    assert.equal(listRefused(wr).length, 0, 'nothing refused so far');

    // 3. R edits N's note offline 3 times, reconnects: refused naming note.edit.any, reverted, listed, copyable.
    await office.down();
    for (const title of ['R edit 1', 'R edit 2', 'R edits N\'s note']) wr.prepare(`UPDATE entries SET title = ? WHERE ulid = ?`).run(title, nNote);
    await office.up();
    await cr.syncNow();
    const edits = listRefused(wr).filter((r) => r.kind === 'edit');
    // Three edits can leave more than one transaction (an older updated_at cell keeps its own); each is its own row.
    // R-27: one row per refused laptop transaction per note, so 3 offline edits may leave up to 3 rows.
    assert.ok(edits.length >= 1 && edits.length <= 3, `1 to 3 refused rows, got ${edits.length}`);
    for (const e of edits) {
      assert.equal(e.note_ulid, nNote);
      assert.equal(e.key, 'note.edit.any');
      assert.match(e.reason, /note\.edit\.any/);
    }
    const typed = edits.find((e) => e.cells.some((c) => c.table === 'entries' && c.cid === 'title'))!;
    assert.ok(typed, 'one refused row holds the typed title');
    assert.equal(titleOf(office.store as never, nNote), 'N original', 'the office kept N\'s text');
    await cr.pullNow();
    assert.equal(titleOf(wr, nNote), 'N original', 'R is reverted');
    await cn.syncNow();
    assert.equal(titleOf(wn, nNote), 'N original', 'N never saw R\'s edits');
    createProject(wr, { name: 'R solo', code: 'RS' });
    const copied = await copyRefused(wr, typed.ulid, 'RS');
    assert.equal(copied.series, 'RS');
    const copy = wr.prepare(`SELECT title FROM entries WHERE series = 'RS' AND id = ?`).get(copied.id) as { title: string };
    assert.equal(copy.title, "R edits N's note", 'the copy carries the typed text');
    assert.equal(listRefused(wr).filter((r) => r.ulid === typed.ulid).length, 0, 'the copied refusal is dropped');

    // 4. R edits its own note: accepted.
    updateEntry(wr, { ulid: rNote, title: 'R first, edited' });
    await cr.pushNow(); await cn.pullNow();
    assert.equal(titleOf(office.store as never, rNote), 'R first, edited');
    assert.equal(titleOf(wn, rNote), 'R first, edited', 'N received the edit');

    // 6. (before 5 changes the role) R tries supersede through the MCP path: refused by can(), no network call.
    setDefaultActor('ai');
    try {
      const calls = office.requests.length;
      assert.throws(() => supersede(wr, { ids: [{ ulid: nNote }], by: { ulid: rNote } }), (e: unknown) => {
        assert.ok(e instanceof AccessDeniedError, String(e));
        assert.equal((e as AccessDeniedError).key, 'note.supersede');
        return true;
      });
      assert.equal(office.requests.length, calls, 'no request reached the office');
    } finally { setDefaultActor('human'); }

    // 5. N removes R's note.create while R is offline. R writes offline, reconnects: refused at numbering, never retried, listed.
    await office.down();
    const offline = (await addEntryAsync(wr, note('R written offline', { project: 'SH' }))).ulid;
    assert.equal(idOf(wr, offline), null, 'pending');
    setProjectMember(office.store, jn.device, sh.ulid, jr.device, 'Reader');
    await office.up();
    const allocs = () => reqs(office, jr.device, 'POST /v1/allocate');
    const before = allocs();
    await cr.numberPendingNow();
    assert.equal(allocs() - before, 1, 'asked once');
    await cr.syncNow();
    await cr.numberPendingNow();
    assert.equal(allocs() - before, 1, 'never retried');
    const created = listRefused(wr).filter((r) => r.kind === 'new');
    assert.equal(created.length, 1, 'listed');
    assert.equal(created[0].note_ulid, offline);
    assert.equal(created[0].key, 'note.create');
    assert.equal(office.store.prepare(`SELECT 1 FROM entries WHERE ulid = ?`).get(offline), undefined, 'never sent');
    assert.equal(unsentSharedCount(wr), 0, 'not counted as waiting');

    // 7. An E note and a legacy shared-module note from R still reach N unchecked (even as a Reader of SH).
    const e1 = (await addEntryAsync(wr, note('E from R', { module: 'docs' }))).ulid;
    const e2 = (await addEntryAsync(wr, note('legacy from R', { module: 'team' }))).ulid;
    await cr.syncNow(); await cn.syncNow();
    assert.equal(titleOf(wn, e2), 'legacy from R', 'shared-module note reached N');
    assert.equal(titleOf(wn, e1), 'E from R', 'the E note in a shared module reached N');
    assert.equal(idOf(wn, e1), idOf(wr, e1), 'with the same number');
    assert.equal(listRefused(wr).filter((r) => r.note_ulid === e1 || r.note_ulid === e2).length, 0, 'E notes are never refused');

    // 8. Grant-then-edit race: no id-NULL ghost note on R.
    const sh2 = registerProject(office.store, { ulid: newUlid(), name: 'Second', code: 'S2', seed: 0 }, jn.device);
    await cn.syncNow();
    const old = (await addEntryAsync(wn, note('old one', { project: 'S2' }))).ulid;
    await cn.pushNow();
    await cr.syncNow(); // R's bookmark passes the history while it is not a member
    const nullBefore = (wr.prepare(`SELECT COUNT(*) c FROM entries WHERE id IS NULL`).get() as { c: number }).c;
    setProjectMember(office.store, jn.device, sh2.ulid, jr.device, 'Reader');
    wn.prepare(`UPDATE entries SET title = 'old one, edited' WHERE ulid = ?`).run(old);
    await cn.pushNow();
    await cr.pullNow(); // a stream pull, before the replay has run
    const ghosts = () => (wr.prepare(`SELECT COUNT(*) c FROM entries WHERE id IS NULL`).get() as { c: number }).c;
    assert.equal(ghosts(), nullBefore, 'no ghost after the early pull');
    await cr.syncNow();
    assert.equal(ghosts(), nullBefore, 'no ghost after the sync');
    assert.equal(getEntryByUlid(wr, old)?.title, 'old one, edited');
  } finally {
    setAllocator(null); setAllocationRetry(null); setDefaultActor('human');
    await cn.stop(); await cr.stop();
    closeWriter(wn); closeWriter(wr);
    await office.close();
    t.cleanup();
  }
});

// ---- regression on COPIES of real data (Task 9 step 2) ----
// Local to one machine. Point COLLAB_REAL_COPY_DIR at a folder holding plain
// copies named notebook.db and store.db (with any -wal/-shm); the test opens
// only those. It SKIPS when they are absent. The real files are never opened.
const COPY_DIR = process.env.COLLAB_REAL_COPY_DIR ?? '';
const norm = (p: string) => resolve(p).split(String.fromCharCode(92)).join('/').toLowerCase();
const realOffice = norm(join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'collab', 'post-office'));
const unsafeCopyDir = !!COPY_DIR && (norm(COPY_DIR).startsWith(realOffice) || /\/internal-tools\/mcp(\/|$)/.test(norm(COPY_DIR)));
const haveCopies = !!COPY_DIR && existsSync(join(COPY_DIR, 'notebook.db')) && existsSync(join(COPY_DIR, 'store.db'));
const ENTRY_COLS = `ulid, series, id, title, summary, description, project_ulid, updated_at`;
const entriesOf = (db: DB) => db.prepare(`SELECT ${ENTRY_COLS} FROM entries ORDER BY ulid`).all();
function openNotebook(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  if (hasCrrTables(db)) loadCrsqlite(db);
  return db;
}
const errorChecks = (db: DB, cwd: string) =>
  new Set(doctor(db, { cwd, env: {} }).checks.filter((c) => c.severity === 'error').map((c) => c.name));

test('regression: copies of the real notebook and office store open unchanged; a replay of the last 2000 deliveries refuses nothing', { skip: !haveCopies && !unsafeCopyDir && 'set COLLAB_REAL_COPY_DIR to a folder of copies' }, (tc) => {
  assert.ok(!unsafeCopyDir, `COLLAB_REAL_COPY_DIR (${COPY_DIR}) is inside the real office folder or an internal-tools/mcp folder: refusing to open or migrate real files; point it at plain copies`);
  const t = tempDir('collab-rnr-s2-real-');
  try {
    // Notebook: work on a second copy so the untouched one gives the doctor baseline.
    const nb = join(COPY_DIR, 'notebook.db');
    let base = openNotebook(nb), baselineErrors: Set<string>, beforeEntries: unknown[];
    try { baselineErrors = errorChecks(base, t.dir); beforeEntries = entriesOf(base); } finally { closeWriter(base); }
    assert.ok(beforeEntries.length > 0);
    let db = openNotebook(nb);
    try { migrate(db); assert.equal(latestMigration(db), '0013_refused_changes'); } finally { closeWriter(db); }
    db = openNotebook(nb);
    try {
      assert.deepEqual(entriesOf(db), beforeEntries, 'every notebook entries row unchanged');
      const after = errorChecks(db, t.dir);
      const fresh = [...after].filter((n) => !baselineErrors.has(n));
      assert.deepEqual(fresh, [], 'doctor reports no new errors');
      tc.diagnostic(`notebook: ${beforeEntries.length} entries unchanged; doctor errors before [${[...baselineErrors]}] after [${[...after]}]; refused_changes rows ${(db.prepare('SELECT COUNT(*) c FROM refused_changes').get() as { c: number }).c}`);
    } finally { closeWriter(db); }

    // Office store: open (seeds access, R11: every live member Owner), then replay the last 2000 deliveries.
    const pre = new Database(join(COPY_DIR, 'store.db'), { readonly: true });
    const preEntries = entriesOf(pre);
    pre.close();
    const store = openStore(join(COPY_DIR, 'store.db'));
    try {
      assert.deepEqual(entriesOf(store), preEntries, 'every office entries row unchanged');
      const rows = store.prepare(`SELECT * FROM (SELECT * FROM po_deliveries ORDER BY seq DESC LIMIT 2000) ORDER BY seq`).all() as Array<{
        origin: string; tbl: string; pk: Buffer; cid: string; val: unknown; col_version: number; db_version: number; site_id: Buffer; cl: number; ch_seq: number;
      }>;
      assert.ok(rows.length > 0);
      // One laptop transaction (origin + site + db_version) per classify call: a push
      // holds each cell once, whereas the log holds every version of a cell over time.
      const byGroup = new Map<string, { origin: string; raws: RawChange[] }>();
      for (const r of rows) {
        const k = `${r.origin}|${r.site_id.toString('hex')}|${r.db_version}`;
        const g = byGroup.get(k) ?? { origin: r.origin, raws: [] };
        g.raws.push({ table: r.tbl, pk: r.pk, cid: r.cid, val: r.val, col_version: r.col_version, db_version: r.db_version, site_id: r.site_id, cl: r.cl, seq: r.ch_seq } as RawChange);
        byGroup.set(k, g);
      }
      const byOrigin = new Set([...byGroup.values()].map((g) => g.origin));
      const replay = () => {
        let groups = 0;
        const why: string[] = [];
        for (const { origin, raws } of byGroup.values()) {
          const v = classify(store, origin, raws);
          for (const [, r] of v.groups) { groups++; if (r) why.push(`${origin}: ${r.key ?? 'structural'}: ${r.reason}`); }
        }
        return { groups, why };
      };
      // As seeded by R11: every live member Owner of every project; the earliest is Office admin, the rest Office members.
      const seeded = replay();
      // "Everyone Owner": also make every live member an Office admin, then nothing may be refused.
      const live = (store.prepare(`SELECT device_id FROM po_members WHERE revoked_at IS NULL`).all() as Array<{ device_id: string }>).map((r) => r.device_id);
      for (const d of live) setOfficeRole(store, null, d, 'Office admin');
      const all = replay();
      tc.diagnostic(`store: ${preEntries.length} entries unchanged; replayed ${rows.length} deliveries from ${byOrigin.size} origin(s) = ${all.groups} groups; refused ${seeded.why.length} as seeded (${[...new Set(seeded.why)].join(' | ')}), ${all.why.length} with every member Office admin`);
      assert.deepEqual(all.why, [], 'the replay refuses nothing');
    } finally { closeStore(store); }
  } finally { t.cleanup(); }
});
