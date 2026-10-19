// UI parity Task 3 / brief rule 4: a solo-only notebook manages its projects
// from the web with zero office calls (counted at node:http and node:tls, the
// only ways core reaches an office).
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import tls from 'node:tls';
import { startTestServer } from './helpers/server.mjs';

let srv: any;
before(async () => {
  srv = await startTestServer();
  const { initModule } = await import('@collab-mcp/core');
  initModule(srv.db, { slug: 'notes-mod' });
});
after(() => srv.close());

const post = async (route: string, body: unknown) => {
  const r = await fetch(`${srv.baseUrl}${route}`, { method: 'POST', body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test('list, create, rename, bind and unbind with zero office calls; team create says to connect first', async () => {
  const calls = { http: 0, tls: 0 };
  const realRequest = http.request, realConnect = tls.connect;
  (http as any).request = (...a: any[]) => { calls.http++; return (realRequest as any)(...a); };
  (tls as any).connect = (...a: any[]) => { calls.tls++; return (realConnect as any)(...a); };
  try {
    assert.equal((await post('/api/projects/create', { name: 'Solo Box', code: 'SO' })).status, 200);
    assert.equal((await post('/api/projects/rename', { code: 'SO', name: 'Solo Crate' })).status, 200);
    assert.equal((await post('/api/projects/bind', { module: 'notes-mod', code: 'SO' })).status, 200);
    assert.equal((await post('/api/projects/unbind', { module: 'notes-mod' })).status, 200);
    const list = await fetch(`${srv.baseUrl}/api/projects`);
    const body = await list.json();
    assert.deepEqual(body.projects.map((p: any) => [p.code, p.name, p.mode]), [['SO', 'Solo Crate', 'solo']]);
    assert.equal(body.office_url, null);
    const team = await post('/api/projects/create', { name: 'Team', code: 'TT', team: true });
    assert.deepEqual([team.status, team.body], [409, { error: "This notebook isn't connected to a post office." }]);
    const promote = await post('/api/projects/promote', { code: 'SO' });
    assert.deepEqual([promote.status, promote.body], [409, { error: "This notebook isn't connected to a post office." }]);
  } finally {
    (http as any).request = realRequest;
    (tls as any).connect = realConnect;
  }
  assert.deepEqual(calls, { http: 0, tls: 0 }, 'nothing left this process for an office');
});

// UI parity Task 7a: copy notes into a project, the same plan -> ask -> copy as `collab copy`.
test('copy: the plan lists what collab copy lists; apply copies exactly that list; a changed list is refused', async () => {
  const core = await import('@collab-mcp/core');
  core.createProject(srv.db, { name: 'Target', code: 'TG' });
  const a = core.addEntry(srv.db, { type: 'decision', title: 'first', summary: 's', module: 'notes-mod', project: 'none' });
  core.addEntry(srv.db, { type: 'gotcha', title: 'second', summary: 's', module: 'notes-mod', project: 'none' });
  const args = { from: 'module:notes-mod', to: 'TG' };
  const plan = await post('/api/projects/copy/plan', args);
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.deepEqual(plan.body.lines, core.copyPlanLines(core.planCopy(srv.db, args)));
  assert.deepEqual(plan.body.items.map((i: any) => i.title), ['first', 'second']);
  assert.equal(plan.body.target.code, 'TG');
  const expect = plan.body.items.map((i: any) => i.ulid);

  // Someone adds a note before the copy is confirmed: nothing is copied.
  const late = core.addEntry(srv.db, { type: 'decision', title: 'late', summary: 's', module: 'notes-mod', project: 'none' });
  const changed = await post('/api/projects/copy/apply', { ...args, expect });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, 'The notes changed since the list was shown; nothing was copied. Check the list again.');
  assert.equal(srv.db.prepare(`SELECT COUNT(*) c FROM entries WHERE series = 'TG'`).get().c, 0);
  core.deleteEntry(srv.db, late.id!);

  const done = await post('/api/projects/copy/apply', { ...args, expect });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.copied.length, 2);
  assert.match(done.body.lines[0], /^Copied 2 notes from module notes-mod \(E notes\) into TG \(Target, solo\):$/);
  assert.equal(srv.db.prepare(`SELECT COUNT(*) c FROM entries WHERE series = 'TG'`).get().c, 2);
  // The original is unchanged apart from its copied_to link.
  assert.equal(core.getEntryByUlid(srv.db, a.ulid).title, 'first');

  const again = await post('/api/projects/copy/plan', args);
  assert.deepEqual([again.body.items.length, again.body.skipped.length], [0, 2], 'already copied');
  const bad = await post('/api/projects/copy/plan', { from: 'module:notes-mod', to: 'TG', since: 'yesterday' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /^--since "yesterday" is not a date/);
  const noExpect = await post('/api/projects/copy/apply', args);
  assert.deepEqual([noExpect.status, noExpect.body], [400, { error: 'Check the list first.' }]);
});
