import { test } from 'node:test';
import assert from 'node:assert';
import { requestJson, openEventStream, newUlid } from '@collab-mcp/core';
import { office } from './office.js';
import { setOfficeRole } from '../src/access.js';

const mkProject = (code: string) => ({ ulid: newUlid(), name: `Proj ${code}`, code });

test('GET /v1/access returns the caller role, keys and pending replays', async () => {
  const o = await office();
  try {
    const n = await o.join('N');
    const r = await o.join('R');
    const p = mkProject('ACC');
    assert.equal((await requestJson(o.target(n), 'POST', '/v1/projects', p)).status, 200);
    assert.equal((await requestJson(o.target(n), 'PUT', `/v1/projects/${p.ulid}/members/${r.device}`, { role: 'Reader' })).status, 200);
    const a = await requestJson(o.target(r), 'GET', '/v1/access');
    assert.equal(a.status, 200);
    assert.equal(a.body.office.role, 'Office member');
    assert.ok(a.body.office.keys.includes('office.project.create'));
    assert.equal(a.body.projects.length, 1);
    assert.equal(a.body.projects[0].code, 'ACC');
    assert.equal(a.body.projects[0].role, 'Reader');
    assert.ok(a.body.projects[0].keys.includes('note.view'));
    assert.deepEqual(a.body.projects[0].ai, {});
    assert.deepEqual(a.body.replays.map((x: any) => x.project_ulid), [p.ulid]);
    const na = await requestJson(o.target(n), 'GET', '/v1/access');
    assert.equal(na.body.office.role, 'Office admin');
    assert.equal(na.body.projects[0].role, 'Owner');
  } finally { await o.stop(); }
});

test('GET /v1/projects hides projects the caller is not in', async () => {
  const o = await office();
  try {
    const n = await o.join('N');
    const r = await o.join('R');
    const p = mkProject('HID');
    await requestJson(o.target(n), 'POST', '/v1/projects', p);
    assert.equal((await requestJson(o.target(n), 'GET', '/v1/projects')).body.projects.length, 1);
    assert.equal((await requestJson(o.target(r), 'GET', '/v1/projects')).body.projects.length, 0);
    const m = await requestJson(o.target(r), 'GET', `/v1/projects/${p.ulid}/members`);
    assert.equal(m.status, 404);
  } finally { await o.stop(); }
});

test('POST /v1/projects without office.project.create -> 403 naming the key', async () => {
  const o = await office();
  try {
    await o.join('N');
    const r = await o.join('R');
    o.store.prepare(`INSERT INTO po_office_roles (ulid, name, keys, is_starter) VALUES (?, 'Nothing', '[]', 0)`).run(newUlid());
    setOfficeRole(o.store, null, r.device, 'Nothing');
    const res = await requestJson(o.target(r), 'POST', '/v1/projects', mkProject('NOP'));
    assert.equal(res.status, 403);
    assert.match(res.body.error, /office\.project\.create/);
    assert.match(res.body.error, /in this office/);
    const mod = await requestJson(o.target(r), 'POST', '/v1/modules', { slug: 'abc', shared: true });
    assert.equal(mod.status, 403);
    assert.match(mod.body.error, /office\.module\.share/);
  } finally { await o.stop(); }
});

test('PUT member by a Reader -> 403 "member.invite"; by an Owner -> 200 and an access event is rung', async () => {
  const o = await office();
  try {
    const n = await o.join('N');
    const r = await o.join('R');
    const x = await o.join('X');
    const p = mkProject('MEM');
    await requestJson(o.target(n), 'POST', '/v1/projects', p);
    await requestJson(o.target(n), 'PUT', `/v1/projects/${p.ulid}/members/${r.device}`, { role: 'Reader' });
    const bad = await requestJson(o.target(r), 'PUT', `/v1/projects/${p.ulid}/members/${x.device}`, { role: 'Reader' });
    assert.equal(bad.status, 403);
    assert.match(bad.body.error, /member\.invite/);

    const events: string[] = [];
    const stream = openEventStream(o.target(x), '/v1/events', { event: (name) => events.push(name), close: () => {} });
    const end = Date.now() + 3000;
    while (!events.includes('ready') && Date.now() < end) await new Promise((q) => setTimeout(q, 10));
    const ok = await requestJson(o.target(n), 'PUT', `/v1/projects/${p.ulid}/members/${x.device}`, { role: 'Reader' });
    assert.equal(ok.status, 200);
    while (!events.includes('access') && Date.now() < end) await new Promise((q) => setTimeout(q, 10));
    assert.ok(events.includes('access'));
    const list = await requestJson(o.target(n), 'GET', `/v1/projects/${p.ulid}/members`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.members.map((m: any) => [m.name, m.role]).sort(), [['N', 'Owner'], ['R', 'Reader'], ['X', 'Reader']]);
    assert.ok(list.body.roles.some((ro: any) => ro.name === 'Owner' && ro.keys.includes('member.invite') && ro.ulid));
    const del = await requestJson(o.target(n), 'DELETE', `/v1/projects/${p.ulid}/members/${x.device}`);
    assert.equal(del.status, 200);
    stream.close();
  } finally { await o.stop(); }
});

test('POST /v1/office/members returns a secret that /v1/join redeems', async () => {
  const o = await office();
  try {
    const n = await o.join('N');
    const r = await o.join('R');
    const denied = await requestJson(o.target(r), 'POST', '/v1/office/members', { name: 'Z' });
    // Office member may not add members
    assert.equal(denied.status, 403);
    assert.match(denied.body.error, /office\.member\.add/);
    const add = await requestJson(o.target(n), 'POST', '/v1/office/members', { name: 'Z' });
    assert.equal(add.status, 200);
    const j = await requestJson({ url: o.po.url, fingerprint: o.cert.fingerprint }, 'POST', '/v1/join', { device: add.body.device_id, secret: add.body.secret });
    assert.equal(j.status, 200);
    const role = await requestJson(o.target(n), 'PUT', `/v1/office/members/${add.body.device_id}`, { role: 'Office admin' });
    assert.equal(role.status, 200);
    const noRole = await requestJson(o.target(r), 'PUT', `/v1/office/members/${add.body.device_id}`, { role: 'Office member' });
    assert.equal(noRole.status, 403);
    assert.match(noRole.body.error, /office\.role\.manage/);
    const rev = await requestJson(o.target(r), 'DELETE', `/v1/office/members/${add.body.device_id}`);
    assert.equal(rev.status, 403);
    assert.match(rev.body.error, /office\.member\.revoke/);
    assert.equal((await requestJson(o.target(n), 'DELETE', `/v1/office/members/${add.body.device_id}`)).status, 200);
  } finally { await o.stop(); }
});

test('non-members get the same 404 for existing and missing projects; nothing is rung or leaked', async () => {
  const o = await office();
  try {
    const n = await o.join('N');
    const r = await o.join('R');
    const x = await o.join('X');
    const p = mkProject('SEC');
    await requestJson(o.target(n), 'POST', '/v1/projects', p);
    const events: Array<[string, string]> = [];
    const stream = openEventStream(o.target(x), '/v1/events', { event: (name, d) => events.push([name, d]), close: () => {} });
    const end = Date.now() + 3000;
    while (!events.some(([e]) => e === 'ready') && Date.now() < end) await new Promise((q) => setTimeout(q, 10));
    const missing = newUlid();
    for (const [method, path, body] of [
      ['GET', 'members', undefined], ['PUT', `members/${x.device}`, { role: 'Reader' }], ['DELETE', `members/${x.device}`, undefined],
      ['DELETE', `members/${n.device}`, undefined],
    ] as const) {
      const a = await requestJson(o.target(r), method, `/v1/projects/${p.ulid}/${path}`, body);
      const b = await requestJson(o.target(r), method, `/v1/projects/${missing}/${path}`, body);
      assert.equal(a.status, 404, `${method} ${path}`);
      assert.deepEqual(a.body, { error: 'no such team project' });
      assert.deepEqual(b.body, a.body);
    }
    // a member lacking the key still gets the named 403; the no-op DELETE is gated too
    await requestJson(o.target(n), 'PUT', `/v1/projects/${p.ulid}/members/${r.device}`, { role: 'Reader' });
    const noop = await requestJson(o.target(r), 'DELETE', `/v1/projects/${p.ulid}/members/${x.device}`);
    assert.equal(noop.status, 403);
    assert.match(noop.body.error, /member\.revoke/);
    // no-op by an Owner: 200 but no ring; real change rings with an empty payload
    const before = events.filter(([e]) => e === 'access').length;
    assert.equal((await requestJson(o.target(n), 'DELETE', `/v1/projects/${p.ulid}/members/${x.device}`)).status, 200);
    assert.equal((await requestJson(o.target(n), 'PUT', `/v1/projects/${p.ulid}/members/${r.device}`, { role: 'Reader' })).status, 200);
    await new Promise((q) => setTimeout(q, 150));
    assert.equal(events.filter(([e]) => e === 'access').length, before, 'no-ops ring nothing');
    await requestJson(o.target(n), 'PUT', `/v1/projects/${p.ulid}/members/${r.device}`, { role: 'Editor' });
    while (events.filter(([e]) => e === 'access').length === before && Date.now() < end + 3000) await new Promise((q) => setTimeout(q, 10));
    const rung = events.filter(([e]) => e === 'access');
    assert.equal(rung.length, before + 1);
    assert.equal(rung[rung.length - 1][1], '{}');
    stream.close();
  } finally { await o.stop(); }
});

test('GET /v1/projects lists a project for a member of any role', async () => {
  const o = await office();
  try {
    const n = await o.join('N');
    const r = await o.join('R');
    const p = mkProject('ANY');
    await requestJson(o.target(n), 'POST', '/v1/projects', p);
    o.store.prepare(`INSERT INTO po_roles (ulid, project_ulid, name, keys, is_starter) VALUES (?, ?, 'Nothing', '[]', 0)`).run(newUlid(), p.ulid);
    await requestJson(o.target(n), 'PUT', `/v1/projects/${p.ulid}/members/${r.device}`, { role: 'Nothing' });
    assert.equal((await requestJson(o.target(r), 'GET', '/v1/projects')).body.projects.length, 1);
    assert.equal((await requestJson(o.target(r), 'GET', `/v1/projects/${p.ulid}/members`)).status, 200);
  } finally { await o.stop(); }
});

test('malformed percent-encoding is a 400', async () => {
  const o = await office();
  try {
    const n = await o.join('N');
    assert.equal((await requestJson(o.target(n), 'GET', '/v1/projects/%zz/members')).status, 400);
    assert.equal((await requestJson(o.target(n), 'DELETE', '/v1/office/members/%zz')).status, 400);
  } finally { await o.stop(); }
});

test('DELETE /v1/office/members revokes exactly that device, even if another member is named like it', async () => {
  const o = await office();
  try {
    const n = await o.join('N');
    const victim = await o.join('V');
    const trick = await o.join(victim.device); // named like V's device id
    assert.equal((await requestJson(o.target(n), 'DELETE', `/v1/office/members/${trick.device}`)).status, 200);
    const rows = o.store.prepare(`SELECT device_id, revoked_at FROM po_members`).all() as Array<{ device_id: string; revoked_at: string | null }>;
    assert.ok(rows.find((x) => x.device_id === trick.device)!.revoked_at);
    assert.equal(rows.find((x) => x.device_id === victim.device)!.revoked_at, null);
  } finally { await o.stop(); }
});
