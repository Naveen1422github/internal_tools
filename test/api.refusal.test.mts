// RnR S2 (R8): a role refusal is a 403 with the plain message, not a 500.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startTestServer } from './helpers/server.mjs';

let srv: any;
before(async () => { srv = await startTestServer(); });
after(() => srv.close());

test('editing a note in a team project where you are a Reader answers 403 { error: <message> }', async () => {
  const { createProject, addEntry, writeAccessCache } = await import('@collab-mcp/core');
  createProject(srv.db, { name: 'Team Box', code: 'TB' });
  const { id } = addEntry(srv.db, { type: 'decision', title: 'Mine', summary: 's', project: 'TB' });
  const ulid = srv.db.prepare(`SELECT ulid FROM entries WHERE series = 'TB' AND id = ?`).get(id).ulid;
  // The project is now a team project and this laptop only reads there.
  const p = srv.db.prepare(`SELECT ulid FROM projects WHERE code = 'TB'`).get();
  srv.db.prepare(`UPDATE projects SET mode = 'team', team = 'fp' WHERE code = 'TB'`).run();
  writeAccessCache(srv.db, { office: null, projects: [{ ulid: p.ulid, code: 'TB', role: 'Reader', keys: ['note.view'], ai: {} }], replays: [] });
  const res = await fetch(`${srv.baseUrl}/api/collab/entry/upsert`, {
    method: 'POST', body: JSON.stringify({ id: `TB-${id}`, type: 'decision', title: 'Changed', summary: 's' }),
  });
  const body: any = await res.json();
  assert.equal(res.status, 403, JSON.stringify(body));
  assert.match(body.error, /^You need "Edit own notes" \(note\.edit\.own\) in TB to do this$/);
  assert.equal(srv.db.prepare(`SELECT title FROM entries WHERE ulid = ?`).get(ulid).title, 'Mine');
});

test('upserting a shared module as an Office member answers 403 naming module.edit in this office (R-31)', async () => {
  const { initModule, writeAccessCache, setSyncValue, STARTER_OFFICE_ROLES } = await import('@collab-mcp/core');
  initModule(srv.db, { slug: 'shared-mod', name: 'Shared' });
  setSyncValue(srv.db, 'shared_modules', JSON.stringify(['shared-mod']));
  const member = STARTER_OFFICE_ROLES.find((r: any) => r.name === 'Office member')!;
  writeAccessCache(srv.db, { office: { role: member.name, keys: member.keys }, projects: [], replays: [] });
  const res = await fetch(`${srv.baseUrl}/api/collab/module/upsert`, { method: 'POST', body: JSON.stringify({ slug: 'shared-mod', name: 'Renamed' }) });
  const body: any = await res.json();
  assert.equal(res.status, 403, JSON.stringify(body));
  assert.equal(body.error, 'You need "Edit modules" (module.edit) in this office to do this');
  assert.equal(srv.db.prepare(`SELECT name FROM modules WHERE slug = 'shared-mod'`).get().name, 'Shared');
  const solo = await fetch(`${srv.baseUrl}/api/collab/module/upsert`, { method: 'POST', body: JSON.stringify({ slug: 'local-mod', name: 'Local' }) });
  assert.equal(solo.status, 200, 'an unshared module is never sent: no check');
});
