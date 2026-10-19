// RnR S3 acceptance, scenario 8 (plan Task 10): a solo-only notebook sees no
// team screens and never calls an office. Its own file because the web server
// is a singleton bound to one notebook. Core talks to an office only through
// node:http's request over a node:tls socket, so both are counted here.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import tls from 'node:tls';
import { startTestServer } from './helpers/server.mjs';

let srv: any;
before(async () => {
  srv = await startTestServer();
  const { createProject } = await import('@collab-mcp/core');
  createProject(srv.db, { name: 'Solo Box', code: 'SO' });
});
after(() => srv.close());

test('8. solo-only notebook: /api/team/overview -> connected:false, with zero office calls', async () => {
  const { postOfficeTargetFromDb, listProjects } = await import('@collab-mcp/core');
  assert.equal(postOfficeTargetFromDb(srv.db), null, 'no post office configured');
  assert.ok(listProjects(srv.db).every((p: any) => p.mode !== 'team'), 'solo projects only');
  const calls = { http: 0, tls: 0 };
  const realRequest = http.request, realConnect = tls.connect;
  (http as any).request = (...a: any[]) => { calls.http++; return (realRequest as any)(...a); };
  (tls as any).connect = (...a: any[]) => { calls.tls++; return (realConnect as any)(...a); };
  try {
    const r = await fetch(`${srv.baseUrl}/api/team/overview`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { connected: false });
    const set = await fetch(`${srv.baseUrl}/api/team/member/set`, {
      method: 'POST', body: JSON.stringify({ scope: 'office', device: 'someone', role: 'Office member' }),
    });
    assert.equal(set.status, 409);
    assert.deepEqual(await set.json(), { error: "This notebook isn't connected to a post office." });
  } finally {
    (http as any).request = realRequest;
    (tls as any).connect = realConnect;
  }
  assert.deepEqual(calls, { http: 0, tls: 0 }, 'nothing left this process for an office');
});

test('control: the same counters do see core calling an office', async () => {
  const { requestJson } = await import('@collab-mcp/core');
  const calls = { http: 0, tls: 0 };
  const realRequest = http.request, realConnect = tls.connect;
  (http as any).request = (...a: any[]) => { calls.http++; return (realRequest as any)(...a); };
  (tls as any).connect = (...a: any[]) => { calls.tls++; return (realConnect as any)(...a); };
  try {
    await requestJson({ url: 'https://127.0.0.1:1', fingerprint: 'AA'.repeat(32) }, 'GET', '/v1/access').catch(() => {});
  } finally {
    (http as any).request = realRequest;
    (tls as any).connect = realConnect;
  }
  assert.ok(calls.http + calls.tls > 0, JSON.stringify(calls));
});
