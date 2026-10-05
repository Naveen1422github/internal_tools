import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { dbAt } from './helpers/levels.js';
import { migrateTo } from '../src/db.js';
import { addEntry } from '../src/ops/add.js';
import { supersede } from '../src/ops/supersede.js';
import { doctor } from '../src/ops/doctor.js';
import { newUlid } from '../src/ulid.js';

// J17 (piece 2 stage A): doctor checks links and superseded_by by ULID on 0005+ files.
const check = (db: any, name: string) => doctor(db).checks.find((c) => c.name === name)!;
const add = (db: any, title: string, refs: any[] = []) => addEntry(db, { type: 'decision', title, summary: 's', refs } as any).id;
const ulidOf = (db: any, id: number) => (db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(id) as any).ulid as string;
const ownerUlid = (db: any, title: string) => (db.prepare(`SELECT ulid FROM entries WHERE title = ?`).get(title) as any).ulid as string;

function twin(db: any, ulid: string, title: string): void {
  const cols = (db.prepare(`SELECT name FROM pragma_table_info('entries')`).all() as { name: string }[])
    .map((c) => c.name).filter((c) => c !== 'ulid' && c !== 'title');
  db.prepare(`INSERT INTO entries (ulid, title, ${cols.join(', ')}) SELECT ?, ?, ${cols.join(', ')} FROM entries WHERE ulid = ?`)
    .run(newUlid(Date.now() + 60_000), title, ulid);
}

test('(a) a link to an existing note whose E-number another note also uses is not an orphan', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    const b = add(db, 'b');
    twin(db, ulidOf(db, b), 'b twin');
    add(db, 'a', [{ ref_type: 'entry', ref_value: `E-${b}` }]);
    assert.equal(check(db, 'data.orphan_refs.entry').severity, 'ok');
  } finally { cleanup(); }
});

test('(b) a link whose target_ulid names no row is an orphan', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    const b = add(db, 'b');
    add(db, 'a');
    // ref_value names an existing number; only the ULID shows the link is broken.
    db.prepare(`INSERT INTO refs (entry_ulid, ref_type, ref_value, target_ulid) VALUES (?, 'entry', ?, ?)`)
      .run(ownerUlid(db, 'a'), `E-${b}`, newUlid());
    const c = check(db, 'data.orphan_refs.entry');
    assert.equal(c.severity, 'warn');
    assert.deepEqual(c.items, [`E-00002 -> E-${b}`]);
  } finally { cleanup(); }
});

test('(c) a link with no target_ulid is unresolved, not an orphan (no double count)', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    add(db, 'a', [{ ref_type: 'entry', ref_value: 'E-99999' }]);
    assert.equal(check(db, 'data.orphan_refs.entry').severity, 'ok');
    const u = check(db, 'data.unresolved_entry_refs');
    assert.equal(u.severity, 'warn');
    assert.match(String(u.items![0]), /E-99999/);
  } finally { cleanup(); }
});

test('(d) superseded_by_ulid naming no row is dangling', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    const old = add(db, 'old');
    const by = add(db, 'by');
    supersede(db, { ids: [old], by });
    assert.equal(check(db, 'data.dangling_superseded').severity, 'ok');
    db.prepare(`UPDATE entries SET superseded_by_ulid = ? WHERE id = ?`).run(newUlid(), old);
    const c = check(db, 'data.dangling_superseded');
    assert.equal(c.severity, 'warn');
    assert.deepEqual(c.items, [`E-00001 -> E-00002`]);
  } finally { cleanup(); }
});

test('(e) a pre-0005 file keeps the number-based checks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collab-0004-'));
  const db = new Database(join(dir, 'collab.db'));
  try {
    migrateTo(db, '0004');
    const a = add(db, 'a');
    add(db, 'b', [{ ref_type: 'entry', ref_value: `E-${a}` }]);
    assert.equal(check(db, 'data.orphan_refs.entry').severity, 'ok');
    add(db, 'c', [{ ref_type: 'entry', ref_value: 'E-99999' }]);
    const c = check(db, 'data.orphan_refs.entry');
    assert.equal(c.severity, 'warn');
    assert.match(String(c.items![0]), /-> E-99999/);
    db.prepare(`UPDATE entries SET superseded_by = 77777 WHERE id = ?`).run(a);
    const d = check(db, 'data.dangling_superseded');
    assert.equal(d.severity, 'warn');
    assert.deepEqual(d.items, [`E-00001 -> E-77777`]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
