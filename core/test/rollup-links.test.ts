import { test } from 'node:test';
import assert from 'node:assert';
import { dbAt } from './helpers/levels.js';
import { addEntry } from '../src/ops/add.js';
import { rollup, archive } from '../src/ops/rollup.js';

// J17 (piece 2 stage A): rollup and archive link their originals by ULID
// themselves. The fill trigger is dropped so only the writer can set target_ulid.

function linksOf(db: any, newId: number): Array<{ ref_value: string; target_ulid: string | null }> {
  return db.prepare(
    `SELECT r.ref_value, r.target_ulid FROM refs r JOIN entries e ON e.ulid = r.entry_ulid
      WHERE e.id = ? AND r.ref_type = 'entry' ORDER BY r.ref_value`,
  ).all(newId);
}
const ulidOf = (db: any, id: number) => (db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(id) as any).ulid as string;

test('rollup links each original by its ULID (writer, not trigger)', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    db.prepare(`DROP TRIGGER IF EXISTS trg_refs_fill_target_ulid`).run();
    db.prepare(`INSERT INTO tasks (id, title) VALUES ('T-010', 't')`).run();
    const ids = [1, 2].map((i) => addEntry(db as any, { type: 'decision', title: `orig ${i}`, summary: 's', task_id: 'T-010' } as any).id);
    const res = rollup(db as any, { task_id: 'T-010' });
    const newId = res.created_entries[0].id;
    const links = linksOf(db, newId);
    assert.equal(links.length, 2);
    for (const id of ids) {
      const l = links.find((x) => x.ref_value === String(id))!;
      assert.equal(l.target_ulid, ulidOf(db, id), `link to ${id}`);
    }
  } finally { cleanup(); }
});

test('archive links each original by its ULID (writer, not trigger)', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    db.prepare(`DROP TRIGGER IF EXISTS trg_refs_fill_target_ulid`).run();
    db.prepare(`INSERT INTO modules (slug, name) VALUES ('m1', 'M1')`).run();
    const ids = [1, 2].map((i) => addEntry(db as any, { type: 'handoff', title: `old ${i}`, summary: 's', module: 'm1' } as any).id);
    db.prepare(`UPDATE entries SET created_at = '2020-01-01 00:00:00', category = 'Activity'`).run();
    const res = archive(db as any, { older_than: '30d', dry_run: false });
    const newId = res.created_entries[0].id;
    const links = linksOf(db, newId);
    assert.equal(links.length, 2);
    for (const id of ids) {
      const l = links.find((x) => x.ref_value === String(id))!;
      assert.equal(l.target_ulid, ulidOf(db, id), `link to ${id}`);
    }
  } finally { cleanup(); }
});
