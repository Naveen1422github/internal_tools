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
    assert.equal(m.status, 403);
    assert.match(m.body.error, /note\.view/);
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
