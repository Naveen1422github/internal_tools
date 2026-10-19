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
