import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startTestServer, seedEntry } from './helpers/server.mjs';

// One server per file: server.js is imported once per process and
// tools/collab.ts binds its DB when it loads, so a second startTestServer here
// would silently reuse the first DB. The 0005 twin of this file differs only
// in `level`. Tests run in file order and share the DB; each uses its own
// titles and module slugs.
const level = '0005';
let srv;
before(async () => { srv = await startTestServer({ level }); });
after(() => srv.close());

const post = (p, body) => fetch(srv.baseUrl + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (p) => fetch(srv.baseUrl + p).then((r) => r.json());
const ftsIntact = (db) => db.prepare(`INSERT INTO entries_fts(entries_fts, rank) VALUES('integrity-check', 1)`).run();

{
  test(`REST entry lifecycle [${level}]`, async () => {
    const { db } = srv;
    db.prepare(`INSERT INTO modules (slug, name) VALUES ('m1', 'M1'), ('m2', 'M2')`).run();

    const a = await seedEntry(db, { title: 'platypus anchor', module: 'm1' });
    const created = await post('/api/collab/entry/upsert', { type: 'decision', title: 'platypus new', summary: 's', module: 'm1', refs: [{ ref_type: 'entry', ref_value: `E-${a}` }] });
    assert.equal(created.ok, true);
    assert.equal(created.id, a + 1, 'E-number continues');

    const entry = await get(`/api/collab/entry?id=${created.id}`);
    assert.deepEqual(entry.modules, ['m1']);
    assert.deepEqual(entry.refs, [{ ref_type: 'entry', ref_value: `E-${a}` }]);

    await post('/api/collab/entry/upsert', { id: created.id, type: 'decision', title: 'platypus edited', summary: 's', module: 'm2', refs: [] });
    const edited = await get(`/api/collab/entry?id=${created.id}`);
    assert.equal(edited.title, 'platypus edited');
    assert.deepEqual(edited.modules, ['m2']);
    assert.deepEqual(edited.refs, []);

    const found = (await get('/api/collab/search?q=platypus&kind=any')).results.map((r) => r.id).sort();
    assert.deepEqual(found, [a, created.id].sort());

    assert.equal((await post('/api/collab/entry/reassign-module', { ids: [a], module: 'm2' })).updated, 1);
    assert.equal((await post('/api/collab/entry/supersede', { ids: [a], by: created.id })).ok, true);

    await post('/api/collab/entry/delete', { id: created.id });
    const after = (await get('/api/collab/search?q=platypus&kind=any')).results.map((r) => r.id);
    assert.ok(!after.includes(created.id), 'deleted entry hidden from search');
    const stats = await get('/api/collab/stats');
    assert.ok(!stats.recent.some((r) => r.id === created.id), 'deleted entry hidden from stats');

    const doc = await post('/api/collab/doctor', {});
    assert.equal(doc.ok, true, JSON.stringify(doc.checks.filter((c) => c.severity !== 'ok')));
    ftsIntact(db);
  });

  // F11: module card + export return E-numbers (not rowids) and hide deleted
  // entries. A raw hard delete of a throwaway entry (legal per D5a) makes rowid
  // and id diverge at 0006, so a rowid-as-id regression cannot pass silently.
  test(`REST module card and export use E-numbers and hide deleted entries [${level}]`, async () => {
    const { db } = srv;
    db.prepare(`INSERT INTO modules (slug, name) VALUES ('card', 'Card')`).run();
    const throwaway = await seedEntry(db, { title: 'wombat throwaway' });
    db.prepare('DELETE FROM entries WHERE id = ?').run(throwaway);

    const d1 = (await post('/api/collab/entry/upsert', { type: 'decision', title: 'wombat decision', summary: 's', module: 'card', refs: [{ ref_type: 'file', ref_value: 'src/wombat.ts' }] })).id;
    const g1 = await seedEntry(db, { type: 'gotcha', title: 'wombat gotcha', module: 'card' });
    const h1 = await seedEntry(db, { type: 'handoff', category: 'Activity', title: 'wombat handoff', module: 'card' });
    const gone = await seedEntry(db, { type: 'decision', title: 'wombat deleted', module: 'card' });
    if (level === '0006') {
      const row = db.prepare('SELECT rowid AS r, id FROM entries WHERE id = ?').get(d1);
      assert.notEqual(row.r, row.id, 'fixture: rowid must differ from the E-number');
    }
    assert.equal((await post('/api/collab/entry/delete', { id: gone })).ok, true);

    const card = await get('/api/collab/module-card?slug=card');
    assert.deepEqual(card.recent_decisions.map((r) => r.id), [d1]);
    assert.equal(card.recent_decisions[0].title, 'wombat decision');
    assert.deepEqual(card.top_gotchas.map((r) => r.id), [g1]);
    assert.deepEqual(card.recent_handoffs.map((r) => r.id), [h1]);

    const exp = await get('/api/collab/export?format=json&module=card');
    assert.deepEqual(exp.entries.map((e) => e.id).sort((x, y) => x - y), [d1, g1, h1].sort((x, y) => x - y));
    const e1 = exp.entries.find((e) => e.id === d1);
    assert.equal(e1.title, 'wombat decision');
    assert.deepEqual(e1.modules, ['card']);
    assert.deepEqual(e1.refs, [{ ref_type: 'file', ref_value: 'src/wombat.ts' }]);

    const all = await get('/api/collab/export?format=json');
    assert.ok(!all.entries.some((e) => e.id === gone || e.title === 'wombat deleted'), 'deleted entry hidden from export');

    const md = await fetch(srv.baseUrl + '/api/collab/export?format=markdown&module=card').then((r) => r.text());
    assert.ok(md.includes(`## E-${String(d1).padStart(5, '0')} — wombat decision`));
    assert.ok(!md.includes('wombat deleted'));

    // D5b: the deleted entry is still readable by its number at 0006.
    if (level === '0006') {
      const tomb = await get(`/api/collab/entry?id=${gone}`);
      assert.equal(tomb.title, 'wombat deleted');
      assert.ok(tomb.deleted_at, 'tombstone keeps deleted_at');
    }
    ftsIntact(db);
  });

  // F11: reassign promotes an existing secondary membership (the old
  // ON CONFLICT(entry_id, module) path, whose PK is gone at 0006) and skips
  // deleted entries.
  test(`REST reassign-module promotes a secondary membership [${level}]`, async () => {
    const { db } = srv;
    db.prepare(`INSERT INTO modules (slug, name) VALUES ('src', 'Src'), ('dst', 'Dst')`).run();
    const e = await seedEntry(db, { title: 'quokka member', module: 'src' });
    // Make e a SECONDARY member of dst through the REST edit path.
    await post('/api/collab/entry/upsert', { id: e, type: 'decision', title: 'quokka member', summary: 'S', module: 'src', modules: ['dst'] });
    const gone = await seedEntry(db, { title: 'quokka deleted', module: 'src' });
    await post('/api/collab/entry/delete', { id: gone });

    const r = await post('/api/collab/entry/reassign-module', { ids: [e, gone], module: 'dst' });
    assert.equal(r.ok, true);
    assert.equal(r.updated, 1, 'deleted entry is not reassigned');

    const links = db.prepare(`SELECT module, is_primary FROM entry_modules
      WHERE entry_ulid = (SELECT ulid FROM entries WHERE id = ?) ORDER BY module`).all(e);
    assert.deepEqual(links.map((l) => ({ ...l })), [{ module: 'dst', is_primary: 1 }]);
    assert.equal(db.prepare('SELECT module FROM entries WHERE id = ?').get(e).module, 'dst');
    assert.deepEqual((await get(`/api/collab/entry?id=${e}`)).modules, ['dst']);
    ftsIntact(db);
  });
}
