import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate as migrateProd, migrateTo } from '../src/db.js';
import { parseEntryRef } from '../src/ulid.js';

// Tests exercise the staged 0005; production callers never pass includeStaged.
const migrate = (db: Database.Database) => migrateProd(db, { includeStaged: true });

const __dirname = dirname(fileURLToPath(import.meta.url));
// Mirrors db.ts's MIGRATIONS_DIR/STAGED_DIR resolution (core/test is a sibling
// of core/src, so the relative depth to mcp/migrations is the same).
const MIGRATIONS_DIR = join(__dirname, '../../mcp/migrations');
const STAGED_DIR = join(MIGRATIONS_DIR, 'staged');

export function tempDb(): { db: Database.Database; dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'collab-0005-'));
  const path = join(dir, 'collab.db');
  return { db: new Database(path), dir, path };
}

test('migrate backs up an existing DB before applying pending migrations', () => {
  const { db, dir } = tempDb();
  try {
    migrateTo(db, '0004');   // a pre-0005 DB...
    db.prepare(`INSERT INTO entries (type, kind, title, summary) VALUES ('decision', 'signal', 't', 's')`).run();
    migrate(db);             // ...upgraded: must snapshot first
    const baks = readdirSync(dir).filter((f) => f.startsWith('collab.db.bak-0005_ulid_expand-'));
    assert.equal(baks.length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate does not back up a brand-new empty DB', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    assert.equal(readdirSync(dir).filter((f) => f.includes('.bak-')).length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plain migrate() never applies staged migrations', () => {
  const { db, dir } = tempDb();
  try {
    migrateProd(db);
    const staged = db.prepare(`SELECT version FROM schema_migrations WHERE version LIKE '0005%'`).all();
    assert.deepEqual(staged, []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate is idempotent', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    assert.deepEqual(migrate(db), []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate refuses a version that exists in both migrations/ and staged/', () => {
  const { db, dir } = tempDb();
  const dupName = '0999_dup_probe.sql';
  const corePath = join(MIGRATIONS_DIR, dupName);
  const stagedPath = join(STAGED_DIR, dupName);
  const stagedDirExisted = existsSync(STAGED_DIR);
  try {
    if (!stagedDirExisted) mkdirSync(STAGED_DIR, { recursive: true });
    writeFileSync(corePath, 'SELECT 1;\n');
    writeFileSync(stagedPath, 'SELECT 1;\n');

    assert.throws(() => migrate(db), /0999_dup_probe/);
    const rows = db.prepare(`SELECT version FROM schema_migrations`).all();
    assert.deepEqual(rows, []);

    // Plain migrate() never scans staged/, so the same duplicate is invisible to it.
    assert.doesNotThrow(() => migrateProd(db));
  } finally {
    rmSync(corePath, { force: true });
    rmSync(stagedPath, { force: true });
    if (!stagedDirExisted) rmSync(STAGED_DIR, { recursive: true, force: true });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function insertEntry(db: Database.Database, id: number, ulid: string | null, title = 't' + id) {
  db.prepare(`INSERT INTO entries (id, type, kind, title, summary, ulid) VALUES (?, 'decision', 'signal', ?, 's', ?)`)
    .run(id, title, ulid);
}

test('0005 adds the new columns and table', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    const cols = (t: string) => db.prepare(`SELECT name FROM pragma_table_info(?)`).all(t).map((r: any) => r.name);
    for (const c of ['ulid', 'author', 'superseded_by_ulid']) assert.ok(cols('entries').includes(c), c);
    for (const c of ['entry_ulid', 'target_ulid']) assert.ok(cols('refs').includes(c), c);
    assert.ok(cols('entry_modules').includes('entry_ulid'));
    assert.ok(cols('modules').includes('hub'));
    assert.ok(cols('entry_revisions').includes('parent_rev_id'));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('no UNIQUE index on any new column (cr-sqlite rule)', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    const uniques = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND sql LIKE '%UNIQUE%'`).all();
    assert.deepEqual(uniques, []);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('refs trigger fills entry_ulid and target_ulid for every legacy link format', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    insertEntry(db, 1, 'U1');
    insertEntry(db, 214, 'U214');
    insertEntry(db, 116, 'U116');
    const values = ['214', 'E-214', 'E-00214', 'e-214', 'E214', '#116', ' 214 ', 'T-011', 'abc', '0', '999'];
    const ins = db.prepare(`INSERT INTO refs (entry_id, ref_type, ref_value) VALUES (1, 'entry', ?)`);
    for (const v of values) ins.run(v);
    const rows = db.prepare(`SELECT ref_value, entry_ulid, target_ulid FROM refs WHERE entry_id = 1`).all() as any[];
    for (const r of rows) {
      assert.equal(r.entry_ulid, 'U1');
      // Parity: the SQL parser must agree with parseEntryRef on every input (Review Focus #2).
      const id = parseEntryRef(r.ref_value);
      const want = id === 214 ? 'U214' : id === 116 ? 'U116' : null;
      assert.equal(r.target_ulid, want, `ref_value=${JSON.stringify(r.ref_value)}`);
    }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('non-entry refs get entry_ulid but never target_ulid', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    insertEntry(db, 1, 'U1');
    db.prepare(`INSERT INTO refs (entry_id, ref_type, ref_value) VALUES (1, 'file', '214')`).run();
    const r = db.prepare(`SELECT entry_ulid, target_ulid FROM refs`).get() as any;
    assert.deepEqual(r, { entry_ulid: 'U1', target_ulid: null });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('entry_modules trigger fills entry_ulid', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    insertEntry(db, 1, 'U1');
    db.prepare(`INSERT INTO entry_modules (entry_id, module, is_primary) VALUES (1, 'demo', 1)`).run();
    assert.equal((db.prepare(`SELECT entry_ulid FROM entry_modules`).get() as any).entry_ulid, 'U1');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('setting superseded_by fills superseded_by_ulid', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    insertEntry(db, 1, 'U1');
    insertEntry(db, 2, 'U2');
    db.prepare(`UPDATE entries SET superseded_by = 2, deprecated = 1 WHERE id = 1`).run();
    assert.equal((db.prepare(`SELECT superseded_by_ulid FROM entries WHERE id = 1`).get() as any).superseded_by_ulid, 'U2');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('updated_at trigger ignores bookkeeping columns but fires on content columns (D6)', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    db.prepare(
      `INSERT INTO entries (type, kind, title, summary, updated_at) VALUES ('decision', 'signal', 't1', 's', '2020-01-01 00:00:00')`,
    ).run();
    const id = (db.prepare(`SELECT id FROM entries WHERE title = 't1'`).get() as any).id;

    db.prepare(`UPDATE entries SET ulid = 'X' WHERE id = ?`).run(id);
    let row = db.prepare(`SELECT updated_at FROM entries WHERE id = ?`).get(id) as any;
    assert.equal(row.updated_at, '2020-01-01 00:00:00');

    db.prepare(`UPDATE entries SET title = 't2' WHERE id = ?`).run(id);
    row = db.prepare(`SELECT updated_at FROM entries WHERE id = ?`).get(id) as any;
    assert.notEqual(row.updated_at, '2020-01-01 00:00:00');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
