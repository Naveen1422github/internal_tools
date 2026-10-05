// file: courier/test/project-never-sent.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { addEntryAsync, createProject } from '@collab-mcp/core';
import { setModuleShared } from '@collab-mcp/post-office';
import { tempDir, startOffice, joinedDb, openWriter, closeWriter } from './world.js';
import { Courier } from '../src/engine.js';

test('a solo-project note tagged with a shared module is never sent; the E note is', async () => {
  const t = tempDir();
  const office = await startOffice(t.dir, 0);
  let w: ReturnType<typeof openWriter> | null = null;
  let c: Courier | null = null;
  try {
    setModuleShared(office.store, 'portfolio', true);
    const j = await joinedDb(office, t.dir, 'a');
    w = openWriter(j.path);
    c = new Courier({ dbPath: j.path, watch: false, retryMs: 60_000 });
    createProject(w, { name: 'supporthub', code: 'SH' });
    await addEntryAsync(w, { type: 'decision', title: 'E note', summary: 's', module: 'portfolio' });
    const sh = await addEntryAsync(w, { type: 'decision', title: 'SH note', summary: 's', module: 'portfolio', project: 'SH',
      refs: [{ ref_type: 'file', ref_value: 'a.ts' }] });
    assert.equal(sh.series, 'SH');
    const shUlid = (w.prepare(`SELECT ulid FROM entries WHERE title = 'SH note'`).get() as { ulid: string }).ulid;
    await c.syncNow();
    // An edit later must not leak it either.
    w.prepare(`UPDATE entries SET summary = 'edited' WHERE ulid = ?`).run(shUlid);
    await c.pushNow();
    assert.ok(office.store.prepare(`SELECT 1 FROM entries WHERE title = 'E note'`).get(), 'the E note reached the office');
    assert.equal(office.store.prepare(`SELECT 1 FROM entries WHERE ulid = ?`).get(shUlid), undefined);
    const leaked = office.store.prepare(`SELECT COUNT(*) n FROM po_deliveries WHERE instr(pk, CAST(? AS BLOB)) > 0`).get(shUlid) as { n: number };
    assert.equal(leaked.n, 0, 'no change keyed by the SH note reached the office');
  } finally {
    await c?.stop();
    if (w) closeWriter(w);
    await office.close();
    t.cleanup();
  }
});
