// file: courier/test/e-modules-rows.test.ts
// Task 2 fix I1: once E is adopted, a modules row goes only with a sent note that references it.
import { test } from 'node:test';
import assert from 'node:assert';
import { addEntryAsync, initModule, upsertModule, setSyncValue, getSyncValue, isEAdopted, E_ADOPTED_KEY, NEVER_SEND_KEY, E_PROJECT_ULID, SENT_MODULES_KEY } from '@collab-mcp/core';
import { adoptE, setProjectMember } from '@collab-mcp/post-office';
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

test('Task 9 ruling: a member without module.edit creates a module with its note, then never sends edits to a row the office holds', async () => {
  const t = tempDir();
  const office = await startOffice(t.dir, 0);
  const ws: Array<ReturnType<typeof openWriter>> = [];
  const cs: Courier[] = [];
  try {
    const open = async (name: string, batchSize?: number) => {
      const j = await joinedDb(office, t.dir, name);
      const w = openWriter(j.path); ws.push(w);
      const c = new Courier({ dbPath: j.path, watch: false, retryMs: 60_000, ...(batchSize ? { batchSize } : {}) }); cs.push(c);
      return { w, c, device: j.device };
    };
    const a = await open('a'); // first to join: Office admin
    const b = await open('b', 5); // Office member; small pages: a new module's row must share its note's page
    adoptE(office.store, { name: 'emp1st', ownerDevice: a.device });
    setProjectMember(office.store, null, E_PROJECT_ULID, b.device, 'Editor');
    for (let i = 0; i < 2; i++) for (const l of [a, b]) await l.c.syncNow();
    assert.equal(isEAdopted(b.w), true);
    const summary = (slug: string) => (office.store.prepare(`SELECT summary FROM modules WHERE slug = ?`).get(slug) as { summary: string | null } | undefined)?.summary;
    const refused = () => (b.w.prepare(`SELECT COUNT(*) n FROM refused_changes`).get() as { n: number }).n;

    // A module the admin made, received by b by pull.
    initModule(a.w, { slug: 'from-a' });
    await addEntryAsync(a.w, note('a in from-a', { module: 'from-a', project: 'E' }));
    await a.c.syncNow(); await b.c.syncNow();
    assert.ok(b.w.prepare(`SELECT 1 FROM modules WHERE slug = 'from-a'`).get(), 'b received the module');

    // b's own new module travels with its first E note and is accepted.
    initModule(b.w, { slug: 'from-b' });
    await addEntryAsync(b.w, note('b in from-b', { module: 'from-b', project: 'E' }));
    await b.c.syncNow();
    assert.ok(office.store.prepare(`SELECT 1 FROM modules WHERE slug = 'from-b'`).get(), 'the creation reached the office');
    assert.equal(refused(), 0);
    assert.deepEqual(JSON.parse(getSyncValue(b.w, SENT_MODULES_KEY) ?? '[]'), ['from-b']);

    // Edits to both rows (office-held) with a new note in each: the notes go, the modules cells stay here.
    upsertModule(b.w, { slug: 'from-a', summary: 'b edits a' });
    upsertModule(b.w, { slug: 'from-b', summary: 'b edits b' });
    await addEntryAsync(b.w, note('b in from-a', { module: 'from-a', project: 'E' }));
    await addEntryAsync(b.w, note('b again in from-b', { module: 'from-b', project: 'E' }));
    await b.c.syncNow();
    assert.ok(office.store.prepare(`SELECT 1 FROM entries WHERE title = 'b in from-a'`).get(), 'the notes are sent');
    assert.ok(office.store.prepare(`SELECT 1 FROM entries WHERE title = 'b again in from-b'`).get());
    assert.notEqual(summary('from-a'), 'b edits a', 'never sent');
    assert.notEqual(summary('from-b'), 'b edits b', 'never sent');
    assert.equal(refused(), 0, 'nothing sent just to be refused');
    assert.equal((b.w.prepare(`SELECT summary FROM modules WHERE slug = 'from-b'`).get() as { summary: string }).summary, 'b edits b', 'kept local');

    // Fix round 2 (M4): a tag-only change carries a new module (the tag and the row share a page).
    initModule(b.w, { slug: 'tag-b' });
    const own = (b.w.prepare(`SELECT ulid FROM entries WHERE title = 'b in from-b'`).get() as { ulid: string }).ulid;
    b.w.prepare(`INSERT INTO entry_modules (entry_ulid, entry_id, module, is_primary) VALUES (?, (SELECT id FROM entries WHERE ulid = ?), 'tag-b', 0)`).run(own, own);
    await b.c.syncNow();
    assert.ok(office.store.prepare(`SELECT 1 FROM modules WHERE slug = 'tag-b'`).get(), 'the tag carried the new module');
    assert.equal(refused(), 0);

    // The admin (module.edit) still sends its edits.
    upsertModule(a.w, { slug: 'from-a', summary: 'a edits a' });
    await addEntryAsync(a.w, note('a again in from-a', { module: 'from-a', project: 'E' }));
    await a.c.syncNow();
    assert.equal(summary('from-a'), 'a edits a');
  } finally {
    for (const c of cs) await c.stop();
    for (const w of ws) closeWriter(w);
    await office.close();
    t.cleanup();
  }
});
