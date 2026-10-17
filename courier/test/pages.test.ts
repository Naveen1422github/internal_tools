// R3 fix round 1: one note's entries cells never span two requests (the office
// holds a note until it has the note's project cell).
import { test } from 'node:test';
import assert from 'node:assert';
import { addEntryAsync, newUlid, setAllocator, setAllocationRetry, type WireChange } from '@collab-mcp/core';
import { registerProject } from '@collab-mcp/post-office';
import { pagesOf, Courier } from '../src/engine.js';
import { tempDir, startOffice, joinedDb, openWriter, closeWriter } from './world.js';

const cell = (table: string, note: string, cid: string): WireChange =>
  ({ table, pk: note, cid, val: null, col_version: 1, db_version: 1, site_id: 's', cl: 1, seq: 0 } as unknown as WireChange);
const noteOf = (w: WireChange) => (w.table === 'entries' ? String(w.pk) : null);

test('pages: a note\'s entries cells ride with its first one; order and every change kept', () => {
  const batch: WireChange[] = [];
  for (const n of ['n1', 'n2', 'n3']) {
    for (const c of ['title', 'summary', 'series']) batch.push(cell('entries', n, c));
    batch.push(cell('refs', n, 'target_ulid'));
  }
  // Cells written later (another db_version), after other notes' cells.
  batch.push(cell('entries', 'n1', 'project_ulid'), cell('entries', 'n2', 'project_ulid'), cell('refs', 'n3', 'x'));
  const pages = pagesOf(batch, noteOf, 5);
  assert.deepEqual(pages.flat().length, batch.length, 'nothing lost or doubled');
  for (const n of ['n1', 'n2', 'n3']) {
    const where = new Set(pages.flatMap((p, i) => (p.some((w) => w.table === 'entries' && w.pk === n) ? [i] : [])));
    assert.equal(where.size, 1, `${n}'s entries cells are in one request`);
  }
  // Non-entries changes keep the page size; only a note's own cells can push a page over it.
  for (const p of pages) assert.ok(p.filter((w) => w.table !== 'entries').length <= 5);
  // Within a page, the original order is kept.
  for (const p of pages) {
    const idx = p.map((w) => batch.indexOf(w));
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
  }
});

test('pages: a batch under the size is one request, unchanged', () => {
  const batch = [cell('entries', 'n1', 'title'), cell('modules', 'm', 'name'), cell('entries', 'n1', 'project_ulid')];
  assert.deepEqual(pagesOf(batch, noteOf, 2000), [batch]);
  assert.deepEqual(pagesOf([], noteOf, 2000), []);
});

test('a team note pushed in tiny requests never reaches a non-member', async () => {
  const t = tempDir('collab-pages-');
  const office = await startOffice(t.dir, 0);
  const ja = await joinedDb(office, t.dir, 'a'), jx = await joinedDb(office, t.dir, 'x');
  const wa = openWriter(ja.path), wx = openWriter(jx.path);
  const ca = new Courier({ dbPath: ja.path, watch: false, retryMs: 60_000, batchSize: 3 });
  const cx = new Courier({ dbPath: jx.path, watch: false, retryMs: 60_000, batchSize: 3 });
  setAllocationRetry({ delaysMs: [0, 0], timeoutMs: 1500 });
  try {
    const a = (office.store.prepare(`SELECT device_id FROM po_members ORDER BY rowid LIMIT 1`).get() as { device_id: string }).device_id;
    registerProject(office.store, { ulid: newUlid(), name: 'Secret', code: 'SC' }, a); // x is not added (R7a)
    await ca.syncNow(); await cx.syncNow();
    const r = await addEntryAsync(wa, { type: 'decision', title: 'SECRET', summary: 's', description: 'd', project: 'SC', refs: [{ ref_type: 'file', ref_value: 'x.ts' }] });
    await ca.pushNow();
    assert.equal((office.store.prepare(`SELECT title FROM entries WHERE ulid = ?`).get(r.ulid) as { title: string }).title, 'SECRET', 'the office has it');
    await cx.syncNow();
    assert.equal(wx.prepare(`SELECT 1 FROM entries WHERE ulid = ?`).get(r.ulid), undefined, 'x has no row of it');
    assert.equal(wx.prepare(`SELECT 1 FROM refs WHERE entry_ulid = ?`).get(r.ulid), undefined);
  } finally {
    setAllocator(null); setAllocationRetry(null);
    await ca.stop(); await cx.stop();
    closeWriter(wa); closeWriter(wx);
    await office.close();
    t.cleanup();
  }
});
