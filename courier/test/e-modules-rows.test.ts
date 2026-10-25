// file: courier/test/e-modules-rows.test.ts
// Task 2 fix I1: once E is adopted, a modules row goes only with a sent note that references it.
import { test } from 'node:test';
import assert from 'node:assert';
import { addEntryAsync, initModule, setSyncValue, E_ADOPTED_KEY, NEVER_SEND_KEY } from '@collab-mcp/core';
import { tempDir, startOffice, joinedDb, openWriter, closeWriter } from './world.js';
import { Courier } from '../src/engine.js';

const note = (title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'decision' as const, title, summary: 's', ...extra });

test('adopted: modules rows travel with sent notes only (new note, never-send note, tag-only change)', async () => {
  const t = tempDir();
  const office = await startOffice(t.dir, 0);
  let w: ReturnType<typeof openWriter> | null = null;
  let c: Courier | null = null;
  try {
    const j = await joinedDb(office, t.dir, 'a');
    w = openWriter(j.path);
    c = new Courier({ dbPath: j.path, watch: false, retryMs: 60_000 });
    for (const slug of ['modx', 'mody', 'modz']) initModule(w, { slug });
    const x = await addEntryAsync(w, note('in X', { module: 'modx' }));
    const y = await addEntryAsync(w, note('in Y, private', { module: 'mody' }));
    setSyncValue(w, E_ADOPTED_KEY, '1');
    setSyncValue(w, NEVER_SEND_KEY, JSON.stringify([y.ulid]));
    // The new note X is created after adoption so it is sent whole.
    const x2 = await addEntryAsync(w, note('new in X', { module: 'modx', project: 'E' })); // Task 3: no project on an adopted laptop = the private default
    await c.syncNow();
    const mods = () => (office.store.prepare(`SELECT slug FROM modules`).all() as Array<{ slug: string }>).map((r) => r.slug);
    assert.ok(office.store.prepare(`SELECT 1 FROM entries WHERE ulid = ?`).get(x2.ulid), 'the new E note reached the office');
    assert.ok(mods().includes('modx'), 'X modules row sent');
    assert.ok(!mods().includes('mody'), 'Y (never-send) modules row not sent');
    assert.ok(!mods().includes('modz'));
    // A tag-only change: add module Z to the sent note (entry_modules row only, no entries cell).
    w.prepare(`INSERT INTO entry_modules (entry_ulid, entry_id, module, is_primary) VALUES (?, (SELECT id FROM entries WHERE ulid = ?), 'modz', 0)`).run(x2.ulid, x2.ulid);
    await c.pushNow();
    assert.ok(mods().includes('modz'), 'Z modules row sent with the tag-only change');
    assert.ok(!mods().includes('mody'));
    void x;
  } finally {
    await c?.stop();
    if (w) closeWriter(w);
    await office.close();
    t.cleanup();
  }
});
