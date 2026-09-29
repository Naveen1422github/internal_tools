import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate as migrateProd, migrateTo } from '../src/db.js';
import { addEntry } from '../src/ops/add.js';
import { supersede } from '../src/ops/supersede.js';
import { newUlid } from '../src/ulid.js';

const migrate = (db: Database.Database) => migrateProd(db, { includeStaged: true });

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'collab-0006-'));
  const db = new Database(join(dir, 'collab.db'));
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const fts = (db: Database.Database) =>
  db.exec(`INSERT INTO entries_fts(entries_fts, rank) VALUES('integrity-check', 1)`);

// A realistic 0005 DB: modules, refs in every legacy link format, a supersede.
function seed0005(db: Database.Database) {
  migrateTo(db, '0005', { includeStaged: true });
  db.prepare(`INSERT INTO modules (slug, name, hub) VALUES ('m1', 'M1', NULL)`).run();
  db.prepare(`INSERT INTO tasks (id, title) VALUES ('T-001', 'task')`).run();
  const a = addEntry(db, { type: 'decision', title: 'alpha', summary: 's', module: 'm1', task_id: 'T-001' }).id;
  const b = addEntry(db, { type: 'gotcha', title: 'beta', summary: 's', modules: ['m1', 'm2'],
    refs: [{ ref_type: 'entry', ref_value: `E-${a}` }, { ref_type: 'entry', ref_value: `#${a}` },
           { ref_type: 'file', ref_value: 'x.ts' }] }).id;
  const c = addEntry(db, { type: 'handoff', title: 'gamma', summary: 's' }).id;
  supersede(db, { ids: [a], by: b });
  return { a, b, c };
}

const snapshot = (db: Database.Database) => ({
  entries: db.prepare(`SELECT ulid, id, type, kind, title, summary, description, status, agent, module, task_id,
    tokens_estimate, rollup_of_task, deprecated, created_at, updated_at, category, superseded_by, author,
    superseded_by_ulid FROM entries ORDER BY ulid`).all(),
  refs: db.prepare(`SELECT entry_ulid, ref_type, ref_value, target_ulid FROM refs ORDER BY 1, 2, 3`).all(),
  modules: db.prepare(`SELECT entry_ulid, module, is_primary FROM entry_modules ORDER BY 1, 2`).all(),
  tasks: db.prepare(`SELECT * FROM tasks ORDER BY id`).all(),
  moduleRows: db.prepare(`SELECT slug, name, hub, status FROM modules ORDER BY slug`).all(),
});

test('rebuild keeps every row, key and link', () => {
  const { db, cleanup } = tempDb();
  try {
    seed0005(db);
    const before = snapshot(db);
    migrate(db);
    assert.deepEqual(snapshot(db), before);
    assert.ok(db.prepare(`SELECT 1 FROM schema_migrations WHERE version = '0006_ulid_contract'`).get());
    fts(db);
  } finally { cleanup(); }
});

test('entries.ulid is the primary key; id is a nullable, non-unique label', () => {
  const { db, cleanup } = tempDb();
  try {
    seed0005(db); migrate(db);
    const pk = db.prepare(`SELECT name FROM pragma_table_info('entries') WHERE pk = 1`).all();
    assert.deepEqual(pk, [{ name: 'ulid' }]);
    const ins = db.prepare(`INSERT INTO entries (ulid, id, type, kind, title, summary) VALUES (?, ?, 'handoff', 'signal', 't', 's')`);
    ins.run(newUlid(), null);
    ins.run(newUlid(), 7);
    ins.run(newUlid(), 7);
    assert.equal((db.prepare(`SELECT COUNT(*) c FROM entries WHERE id = 7`).get() as any).c, 2);
    fts(db);
  } finally { cleanup(); }
});

test('counter is seeded from max(sqlite_sequence, max(id)) so deleted numbers are never reused', () => {
  const { db, cleanup } = tempDb();
  try {
    const { c } = seed0005(db);
    db.prepare(`DELETE FROM entries WHERE id = ?`).run(c); // 0005: hard delete; seq stays at c
    migrate(db);
    const v = (db.prepare(`SELECT value FROM local_counters WHERE name = 'entry_number'`).get() as any).value;
    assert.equal(v, c);
    fts(db);
  } finally { cleanup(); }
});

test('FTS own copy survives a NULL->text edit (E-684)', () => {
  const { db, cleanup } = tempDb();
  try {
    const { c } = seed0005(db); migrate(db);
    db.prepare(`UPDATE entries SET description = 'zebracorn' WHERE id = ?`).run(c); // description was NULL
    fts(db);
    const hit = db.prepare(`SELECT e.id FROM entries_fts JOIN entries e ON e.ulid = entries_fts.ulid WHERE entries_fts MATCH 'zebracorn'`).all();
    assert.deepEqual(hit, [{ id: c }]);
  } finally { cleanup(); }
});

// Fix round 1: the FTS triggers find the row via the indexed ulid column
// (MATCH ulid:"...") and then compare ulid exactly. A hard delete and an edit
// must each touch exactly that entry's FTS row.
test("FTS delete/update triggers target exactly the entry's own row", () => {
  const { db, cleanup } = tempDb();
  try {
    const { a, b, c } = seed0005(db); migrate(db);
    const ftsCount = () => (db.prepare(`SELECT COUNT(*) n FROM entries_fts`).get() as any).n;
    const ulidOf = (id: number) => (db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(id) as any).ulid;
    const n0 = ftsCount();
    db.prepare(`UPDATE entries SET title = 'renamed' WHERE id = ?`).run(b);
    assert.equal(ftsCount(), n0);
    assert.deepEqual(db.prepare(`SELECT title FROM entries_fts WHERE ulid = ?`).all(ulidOf(b)), [{ title: 'renamed' }]);
    const gone = ulidOf(c);
    db.prepare(`DELETE FROM entries WHERE id = ?`).run(c);
    assert.equal(ftsCount(), n0 - 1);
    assert.deepEqual(db.prepare(`SELECT ulid FROM entries_fts WHERE ulid = ?`).all(gone), []);
    assert.deepEqual(db.prepare(`SELECT title FROM entries_fts WHERE ulid = ?`).all(ulidOf(a)), [{ title: 'alpha' }]);
    fts(db);
  } finally { cleanup(); }
});

test('entries.ulid is immutable', () => {
  const { db, cleanup } = tempDb();
  try {
    const { a } = seed0005(db); migrate(db);
    assert.throws(() => db.prepare(`UPDATE entries SET ulid = ? WHERE id = ?`).run(newUlid(), a), /immutable/);
    fts(db);
  } finally { cleanup(); }
});

test('preflight rejects duplicate and malformed ulids and changes nothing', () => {
  const { db, cleanup } = tempDb();
  try {
    const { a, b, c } = seed0005(db);
    const ulidA = (db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(a) as any).ulid;
    db.prepare(`UPDATE entries SET ulid = ? WHERE id = ?`).run(ulidA, b);        // duplicate
    db.prepare(`UPDATE entries SET ulid = 'not-a-ulid' WHERE id = ?`).run(c);   // malformed
    const before = db.prepare(`SELECT id, ulid, author FROM entries ORDER BY id`).all();
    const E = (n: number) => `E-${String(n).padStart(5, '0')}`; // PreflightError pads like doctor
    assert.throws(() => migrate(db), (e: any) =>
      e.name === 'PreflightError' &&
      e.problems.some((p: string) => p.includes(E(a)) && p.includes(E(b))) &&
      e.problems.some((p: string) => p.includes(E(c)) && p.includes('not-a-ulid')));
    assert.equal(db.prepare(`SELECT 1 FROM schema_migrations WHERE version = '0006_ulid_contract'`).get(), undefined);
    assert.deepEqual(db.prepare(`SELECT id, ulid, author FROM entries ORDER BY id`).all(), before);
    fts(db);
  } finally { cleanup(); }
});

// F15 (Review Focus #3): a refs / entry_modules row whose owning entry is gone.
// 0005's cascade triggers normally remove these, so they only exist when an
// entry was deleted by a path that bypassed them. Two shapes: the owner key is
// NULL (never resolved), or it is set to a ulid no entry has (stale). The pre-flight must list the
// orphans and roll back its own repairs (here: a NULL ulid it would have
// assigned, and a NULL author it would have stamped), leaving the DB unchanged.
test('preflight rejects a ref / module row whose owning entry is gone and changes nothing', () => {
  const { db, cleanup } = tempDb();
  try {
    seed0005(db);
    // A straggler the pre-flight WOULD repair, to prove the repair rolls back.
    db.prepare(`INSERT INTO entries (type, kind, title, summary, created_at, author) VALUES ('handoff', 'signal', 'odd', 's', 'garbage', NULL)`).run();
    // Orphans: owner E-00999 never existed, so the 0005 fill triggers leave entry_ulid NULL.
    db.prepare(`INSERT INTO refs (entry_id, ref_type, ref_value) VALUES (999, 'file', 'orphan.ts')`).run();
    db.prepare(`INSERT INTO entry_modules (entry_id, module, is_primary) VALUES (999, 'm1', 1)`).run();
    // Stale orphans: owner key set, but no entry has that ulid (E-00998 was hard-deleted
    // by a path that skipped the cascade).
    const stale = newUlid();
    db.prepare(`INSERT INTO refs (entry_id, entry_ulid, ref_type, ref_value) VALUES (998, ?, 'file', 'stale.ts')`).run(stale);
    db.prepare(`INSERT INTO entry_modules (entry_id, entry_ulid, module, is_primary) VALUES (998, ?, 'm2', 1)`).run(stale);
    const all = () => ({
      entries: db.prepare(`SELECT id, ulid, author, superseded_by_ulid, updated_at FROM entries ORDER BY id`).all(),
      refs: db.prepare(`SELECT entry_id, entry_ulid, ref_type, ref_value, target_ulid FROM refs ORDER BY 1, 3, 4`).all(),
      modules: db.prepare(`SELECT entry_id, entry_ulid, module, is_primary FROM entry_modules ORDER BY 1, 3`).all(),
      migrations: db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all(),
      pk: db.prepare(`SELECT name FROM pragma_table_info('entries') WHERE pk = 1`).all(),
    });
    const before = all();
    assert.equal((db.prepare(`SELECT COUNT(*) c FROM entries WHERE ulid IS NULL`).get() as any).c, 1);
    assert.throws(() => migrate(db), (e: any) =>
      e.name === 'PreflightError' &&
      e.problems.some((p: string) => p.startsWith('refs row') && p.includes('E-00999') && p.includes('orphan.ts')) &&
      e.problems.some((p: string) => p.startsWith('entry_modules row') && p.includes('E-00999') && p.includes('m1')) &&
      e.problems.some((p: string) => p.startsWith('refs row') && p.includes('E-00998') && p.includes('stale.ts') && p.includes(stale)) &&
      e.problems.some((p: string) => p.startsWith('entry_modules row') && p.includes('E-00998') && p.includes('m2') && p.includes(stale)));
    assert.deepEqual(all(), before);
    assert.equal(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'local_counters'`).get(), undefined);
    fts(db);
  } finally { cleanup(); }
});

test('preflight assigns a ulid to a row the backfill skipped (unparseable created_at)', () => {
  const { db, cleanup } = tempDb();
  try {
    seed0005(db);
    db.prepare(`INSERT INTO entries (type, kind, title, summary, created_at) VALUES ('handoff', 'signal', 'odd', 's', 'garbage')`).run();
    migrate(db);
    const row = db.prepare(`SELECT ulid FROM entries WHERE title = 'odd'`).get() as any;
    assert.match(row.ulid, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    fts(db);
  } finally { cleanup(); }
});

test('a 0004 DB with rows migrates straight through 0005 and 0006', () => {
  const { db, cleanup } = tempDb();
  try {
    migrateTo(db, '0004');
    const one = db.prepare(`INSERT INTO entries (type, kind, title, summary) VALUES ('decision', 'signal', 'old', 's')`).run().lastInsertRowid;
    const two = db.prepare(`INSERT INTO entries (type, kind, title, summary) VALUES ('handoff', 'signal', 'old2', 's')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO refs (entry_id, ref_type, ref_value) VALUES (?, 'entry', ?)`).run(two, `E-${one}`);
    db.prepare(`INSERT INTO entry_modules (entry_id, module, is_primary) VALUES (?, 'm1', 1)`).run(two);
    migrate(db);
    assert.ok(db.prepare(`SELECT 1 FROM schema_migrations WHERE version = '0006_ulid_contract'`).get());
    assert.equal((db.prepare(`SELECT COUNT(*) c FROM entries WHERE ulid IS NULL`).get() as any).c, 0);
    const link = db.prepare(`SELECT target_ulid FROM refs WHERE ref_type = 'entry'`).get() as any;
    const oneUlid = (db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(one) as any).ulid;
    assert.equal(link.target_ulid, oneUlid);
    assert.equal((db.prepare(`SELECT COUNT(*) c FROM entry_modules`).get() as any).c, 1);
    fts(db);
  } finally { cleanup(); }
});

test('perf at 10k entries: edit < 100 ms, search < 100 ms (E-674)', () => {
  const { db, cleanup } = tempDb();
  try {
    migrateTo(db, '0006', { includeStaged: true });
    const words = ['sync', 'relay', 'ulid', 'merge', 'tombstone', 'module', 'hub', 'search', 'index', 'report'];
    const txt = (n: number, k: number) => Array.from({ length: n }, (_, i) => words[(i * 7 + k) % words.length]).join(' ');
    const ins = db.prepare(`INSERT INTO entries (ulid, id, type, kind, title, summary, description) VALUES (?, ?, 'session-note', 'log', ?, ?, ?)`);
    db.transaction(() => { for (let i = 1; i <= 10000; i++) ins.run(newUlid(), i, `perf ${txt(6, i)}`, txt(20, i), txt(200, i)); })();
    const target = (db.prepare(`SELECT ulid FROM entries WHERE id = 5000`).get() as any).ulid;
    const edit = db.prepare(`UPDATE entries SET description = description || ' x' WHERE ulid = ?`);
    let t = process.hrtime.bigint();
    for (let k = 0; k < 10; k++) edit.run(target);
    const editMs = Number(process.hrtime.bigint() - t) / 10 / 1e6;
    // Search shape for Task 5 (controller ruling, fix round 1): rank inside FTS
    // first with a bounded over-fetch (2x the page, to absorb tombstone/deprecated
    // filtering), THEN join entries. Joining all matches before the LIMIT reads
    // every matching row twice (~250 ms here, since this query matches all 10k).
    const q = db.prepare(`SELECT e.id
      FROM (SELECT ulid, rank FROM entries_fts WHERE entries_fts MATCH ? ORDER BY rank LIMIT ?) f
      JOIN entries e ON e.ulid = f.ulid
      WHERE e.deprecated = 0 AND e.deleted_at IS NULL
      ORDER BY f.rank LIMIT ?`);
    assert.equal(q.all('relay* AND merge*', 20, 10).length, 10);
    t = process.hrtime.bigint();
    for (let k = 0; k < 10; k++) q.all('relay* AND merge*', 20, 10);
    const searchMs = Number(process.hrtime.bigint() - t) / 10 / 1e6;
    assert.ok(editMs < 100, `edit took ${editMs.toFixed(1)} ms`);
    assert.ok(searchMs < 100, `search took ${searchMs.toFixed(1)} ms`);
    fts(db);
  } finally { cleanup(); }
});

test('plain migrate() never applies staged 0006', () => {
  const { db, cleanup } = tempDb();
  try {
    migrateProd(db);
    assert.equal(db.prepare(`SELECT 1 FROM schema_migrations WHERE version = '0006_ulid_contract'`).get(), undefined);
  } finally { cleanup(); }
});
