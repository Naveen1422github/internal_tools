import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, migrate, closeDb, type DB } from '../src/db.js';
import { addEntry } from '../src/ops/add.js';
import { deleteEntry } from '../src/ops/delete.js';
import { supersede } from '../src/ops/supersede.js';
import { getEntry, getEntryByUlid, getEntryByRef } from '../src/ops/get.js';
import { ownerOf, ownerOfRef, nextEntryNumber } from '../src/entry-write.js';
import { newUlid } from '../src/ulid.js';
import { dbAt } from './helpers/levels.js';
import Database from 'better-sqlite3';
import { migrateTo } from '../src/db.js';

// J17 (piece 2 stage A): getEntry follows a link by the target's ULID, never by its number.
function withNotebook(fn: (db: DB) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'collab-get-links-'));
  try {
    const db = getDb(join(dir, 'collab.db'), { create: true });
    migrate(db, { includeStaged: true });
    fn(db);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

function note(db: DB, title: string, refs: any[] = []): { id: number; ulid: string } {
  const { id } = addEntry(db, { type: 'decision', title, summary: 's', refs } as any);
  const { ulid } = db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(id) as { ulid: string };
  return { id, ulid };
}

/** A second row with the same E-number as `ulid`'s note and a higher ULID (no UNIQUE on id today). */
function twin(db: DB, ulid: string, title: string): string {
  const cols = (db.prepare(`SELECT name FROM pragma_table_info('entries')`).all() as { name: string }[])
    .map((c) => c.name).filter((c) => c !== 'ulid' && c !== 'title');
  const twinUlid = newUlid(Date.now() + 60_000);
  db.prepare(`INSERT INTO entries (ulid, title, ${cols.join(', ')}) SELECT ?, ?, ${cols.join(', ')} FROM entries WHERE ulid = ?`)
    .run(twinUlid, title, ulid);
  return twinUlid;
}

test('a link to a note carries its target, found by ULID', () => {
  withNotebook((db) => {
    const b = note(db, 'target B');
    const a = note(db, 'linker A', [{ ref_type: 'entry', ref_value: 'E-' + b.id }]);
    assert.deepEqual(getEntry(db, a.id)!.refs[0].target,
      { ulid: b.ulid, id: b.id, title: 'target B', deleted: false, present: true });
  });
});

test('two notes share an E-number: the link reaches the one its ULID names', () => {
  withNotebook((db) => {
    const b = note(db, 'first B');
    const t = twin(db, b.ulid, 'twin B');
    assert.ok(t > b.ulid);
    const a = note(db, 'linker A');
    db.prepare(`INSERT INTO refs (entry_ulid, entry_id, ref_type, ref_value, target_ulid) VALUES (?, ?, 'entry', ?, ?)`)
      .run(a.ulid, a.id, 'E-' + b.id, t);
    const target = getEntry(db, a.id)!.refs[0].target!;
    assert.equal(target.ulid, t);
    assert.equal(target.title, 'twin B');
  });
});

test('a link to a tombstoned note still resolves, marked deleted', () => {
  withNotebook((db) => {
    const b = note(db, 'gone B');
    const a = note(db, 'linker A', [{ ref_type: 'entry', ref_value: String(b.id) }]);
    deleteEntry(db, b.id);
    const target = getEntry(db, a.id)!.refs[0].target!;
    assert.equal(target.deleted, true);
    assert.equal(target.present, true);
    assert.equal(target.ulid, b.ulid);
  });
});

test('a link whose target is not on this laptop: present false, no number', () => {
  withNotebook((db) => {
    const a = note(db, 'linker A');
    const missing = newUlid();
    db.prepare(`INSERT INTO refs (entry_ulid, entry_id, ref_type, ref_value, target_ulid) VALUES (?, ?, 'entry', 'E-00999', ?)`)
      .run(a.ulid, a.id, missing);
    assert.deepEqual(getEntry(db, a.id)!.refs[0].target,
      { ulid: missing, id: null, title: null, deleted: false, present: false });
  });
});

test('superseded_target comes from superseded_by_ulid', () => {
  withNotebook((db) => {
    const old = note(db, 'old');
    const b = note(db, 'new B');
    supersede(db, { ids: [old.id], by: b.id });
    assert.deepEqual(getEntry(db, old.id)!.superseded_target,
      { ulid: b.ulid, id: b.id, title: 'new B', deleted: false, present: true });
    assert.equal(getEntry(db, b.id)!.superseded_target, null);
  });
});

test('getEntryByUlid returns the same note as getEntry', () => {
  withNotebook((db) => {
    const b = note(db, 'B', [{ ref_type: 'file', ref_value: 'b.ts' }]);
    assert.deepEqual(getEntryByUlid(db, b.ulid), getEntry(db, b.id));
    assert.equal(getEntryByUlid(db, newUlid()), null);
  });
});

test('a url ref has no target', () => {
  withNotebook((db) => {
    const a = note(db, 'A', [{ ref_type: 'url', ref_value: 'https://example.com' }]);
    assert.equal(getEntry(db, a.id)!.refs[0].target ?? null, null);
  });
});

test('a 0005 notebook (no deleted_at) resolves links too, never deleted', () => {
  const { db, cleanup } = dbAt('0005');
  try {
    const b = note(db as any, 'target B');
    const a = note(db as any, 'linker A', [{ ref_type: 'entry', ref_value: '#' + b.id }]);
    assert.deepEqual(getEntry(db as any, a.id)!.refs[0].target,
      { ulid: b.ulid, id: b.id, title: 'target B', deleted: false, present: true });
  } finally { cleanup(); }
});

test('a pre-0005 notebook (no ULIDs): getEntry still works by number, links carry no target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collab-0004-'));
  const db = new Database(join(dir, 'collab.db'));
  try {
    migrateTo(db, '0004');
    const b = addEntry(db as any, { type: 'decision', title: 'B', summary: 's', module: undefined } as any).id;
    const a = addEntry(db as any, { type: 'decision', title: 'A', summary: 's',
      refs: [{ ref_type: 'entry', ref_value: String(b) }] } as any).id;
    const full = getEntry(db as any, a)!;
    assert.deepEqual(full.refs, [{ ref_type: 'entry', ref_value: String(b) }]);
    assert.equal(full.superseded_target, undefined);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// Stage B1: bare numbers mean the E series; a project note is reached only with its series.
function seriesNote(db: DB, ulid: string, id: number, series: string, title: string): void {
  db.prepare(`INSERT INTO entries (ulid, id, series, type, kind, title, summary, category)
              VALUES (?, ?, ?, 'decision', 'signal', ?, 's', 'Reference')`).run(ulid, id, series, title);
}

test('E-1 and SH-1 (lower ulid): a bare 1 reaches E-1; {SH,1} reaches SH-1', () => {
  withNotebook((db) => {
    seriesNote(db, '01B00000000000000000000001', 1, 'E', 'E one');
    seriesNote(db, '01A00000000000000000000001', 1, 'SH', 'SH one');
    assert.equal(ownerOf(db, 1)!.ulid, '01B00000000000000000000001');
    assert.equal(getEntry(db, 1)!.title, 'E one');
    assert.equal(ownerOfRef(db, { series: 'SH', id: 1 })!.ulid, '01A00000000000000000000001');
    assert.equal(getEntryByRef(db, { series: 'SH', id: 1 })!.title, 'SH one');
    assert.equal(getEntryByRef(db, { series: 'E', id: 1 })!.title, 'E one');
    assert.equal(ownerOfRef(db, { series: 'NV', id: 1 }), null);
    assert.equal(getEntryByRef(db, { series: 'NV', id: 1 }), null);
  });
});

test('nextEntryNumber counts per series; a hard-deleted project number is never handed out again', () => {
  withNotebook((db) => {
    seriesNote(db, '01B00000000000000000000005', 5, 'E', 'E five');
    seriesNote(db, '01A00000000000000000000009', 9, 'SH', 'SH nine');
    assert.equal(nextEntryNumber(db), 6);
    assert.equal(nextEntryNumber(db, 'SH'), 10);
    seriesNote(db, '01A00000000000000000000010', 10, 'SH', 'SH ten');
    db.prepare(`DELETE FROM entries WHERE ulid = '01A00000000000000000000010'`).run();
    assert.equal(nextEntryNumber(db, 'SH'), 11);
    assert.ok(db.prepare(`SELECT 1 FROM local_counters WHERE name = 'series:SH'`).get());
  });
});

test('a pre-0009 notebook: ownerOf behaves as before; only series E resolves by ref', () => {
  const { db, cleanup } = dbAt('0007');
  try {
    const b = note(db as any, 'B');
    assert.equal(ownerOf(db as any, b.id)!.ulid, b.ulid);
    assert.equal(ownerOfRef(db as any, { series: 'E', id: b.id })!.ulid, b.ulid);
    assert.equal(ownerOfRef(db as any, { series: 'SH', id: b.id }), null);
    assert.equal(getEntryByRef(db as any, { series: 'E', id: b.id })!.ulid, b.ulid);
  } finally { cleanup(); }
});
