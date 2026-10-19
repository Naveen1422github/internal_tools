// RnR S3 Task 4: /api/team/* asks the post office as this laptop and keeps its
// wording (Review Focus 4). One office-backed web server for the whole file
// (the server is a singleton); every test restores what it changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { startTeamServer } from './helpers/team-server.mjs';
import { until } from '../courier/test/world.ts';
import { Courier } from '../courier/src/engine.ts';

let srv: any;
let core: any;
let po: any;
let tm: { ulid: string };
before(async () => {
  srv = await startTeamServer();
  core = await import('@collab-mcp/core');
  po = await import('@collab-mcp/post-office');
  // a (Office admin, the web's notebook) creates TM, as `collab project create --team` does: a is its Owner.
  tm = await core.createTeamProject(srv.db, { name: 'Team One', code: 'TM' });
});
after(() => srv.close());

const syncValue = (k: string) => srv.db.prepare(`SELECT value FROM sync_state WHERE key = ?`).get(k)?.value;
const setSync = (k: string, v: string) => srv.db.prepare(`UPDATE sync_state SET value = ? WHERE key = ?`).run(v, k);
/** a, straight to the office (no web server in the path). */
const direct = (method: string, path: string, body?: unknown) => core.requestJson(core.postOfficeTargetFromDb(srv.db), method, path, body);
/** OT: a project b owns, where a is only a Reader (set up on the office machine). */
function readerProject(code = 'OT') {
  const p = po.registerProject(srv.office.store, { ulid: core.newUlid(), name: `Other ${code}`, code, seed: 0 }, srv.b.device);
  po.setProjectMember(srv.office.store, null, p.ulid, srv.a.device, 'Reader');
  return p;
}

test('overview: a solo-only notebook answers connected:false and never calls an office', async () => {
  const url = syncValue(core.SYNC_KEYS.url);
  srv.db.prepare(`DELETE FROM sync_state WHERE key = ?`).run(core.SYNC_KEYS.url);
  try {
    const seen = srv.office.requests.length;
    const r = await srv.api('/api/team/overview');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { connected: false });
    const set = await srv.api('/api/team/member/set', { scope: 'project', project: tm.ulid, device: srv.b.device, role: 'Reader' });
    assert.equal(set.status, 409);
    assert.deepEqual(set.body, { error: "This notebook isn't connected to a post office." });
    assert.equal(srv.office.requests.length, seen, 'no request reached the office');
  } finally {
    srv.db.prepare(`INSERT INTO sync_state (key, value) VALUES (?, ?)`).run(core.SYNC_KEYS.url, url);
  }
});

test('overview lists the team projects this device belongs to with its keys, and its office role', async () => {
  const ot = readerProject('OV');
  const r = await srv.api('/api/team/overview');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.connected, true);
  assert.deepEqual(r.body.me, { device_id: srv.a.device });
  assert.equal(r.body.office.role, 'Office admin');
  assert.ok(r.body.office.keys.includes('office.role.manage'));
  const mine = r.body.projects.find((p: any) => p.ulid === tm.ulid);
  assert.equal(mine.code, 'TM');
  assert.equal(mine.name, 'Team One', 'the name comes from this notebook');
  assert.equal(mine.role, 'Owner');
  assert.ok(mine.keys.includes('role.manage'));
  assert.deepEqual(Object.keys(mine).sort(), ['code', 'keys', 'name', 'role', 'ulid']);
  const other = r.body.projects.find((p: any) => p.ulid === ot.ulid);
  assert.deepEqual({ role: other.role, keys: other.keys, name: other.name }, { role: 'Reader', keys: ['note.view'], name: null },
    'a project not yet pulled into this notebook has no name');
});

test('member/set as a Reader -> 403 with the office\'s exact sentence (not 500, not "forbidden")', async () => {
  const ot = readerProject();
  const body = { role: 'Reader' };
  const office = await direct('PUT', `/v1/projects/${ot.ulid}/members/${srv.b.device}`, body);
  assert.equal(office.status, 403);
  const r = await srv.api('/api/team/member/set', { scope: 'project', project: ot.ulid, device: srv.b.device, ...body });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { error: office.body.error });
  assert.match(r.body.error, /^You need ".+" \(.+\) in OT to do this$/);
  assert.notEqual(r.body.error, 'forbidden');
  const rm = await srv.api('/api/team/member/remove', { project: ot.ulid, device: srv.b.device });
  assert.equal(rm.status, 403);
  assert.match(rm.body.error, /^You need ".+" \(.+\) in OT to do this$/);
});

test('the office\'s 404 and 409 pass through: a project you are not in, the last Owner', async () => {
  const theirs = po.registerProject(srv.office.store, { ulid: core.newUlid(), name: 'Not mine', code: 'NM', seed: 0 }, srv.b.device);
  const r = await srv.api(`/api/team/project?ulid=${theirs.ulid}`);
  assert.deepEqual([r.status, r.body], [404, { error: 'no such team project' }], 'a 404 that is not "no such endpoint" is not 501');
  const last = await srv.api('/api/team/member/set', { scope: 'project', project: tm.ulid, device: srv.a.device, role: 'Reader' });
  assert.equal(last.status, 409);
  const office = await direct('PUT', `/v1/projects/${tm.ulid}/members/${srv.a.device}`, { role: 'Reader' });
  assert.deepEqual(last.body, { error: office.body.error });
});

test('role/create then project shows the role; a role key edit is visible on the next project read', async () => {
  const made = await srv.api('/api/team/role/create', { scope: 'project', project: tm.ulid, name: 'Reviewer', keys: ['note.view'] });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.role.ulid;
  const read = async () => (await srv.api(`/api/team/project?ulid=${tm.ulid}`)).body.roles.find((x: any) => x.ulid === id);
  assert.deepEqual((await read()).keys, ['note.view']);
  assert.equal((await read()).is_starter, false);
  const up = await srv.api('/api/team/role/update', { scope: 'project', project: tm.ulid, role: id, name: 'Senior reviewer', keys: ['note.view', 'note.create'] });
  assert.deepEqual([up.status, up.body], [200, { ok: true }]);
  const after = await read();
  assert.equal(after.name, 'Senior reviewer');
  assert.deepEqual([...after.keys].sort(), ['note.create', 'note.view']);
  const clash = await srv.api('/api/team/role/create', { scope: 'project', project: tm.ulid, name: 'owner', keys: [] });
  assert.equal(clash.status >= 400 && clash.status < 500, true);
  assert.equal(typeof clash.body.error, 'string');
  const del = await srv.api('/api/team/role/delete', { scope: 'project', project: tm.ulid, role: id });
  assert.deepEqual([del.status, del.body], [200, { ok: true }]);
  assert.equal(await read(), undefined);
});

test('office scope: role/create, assign with member/set, list with GET /api/team/office, delete once unheld', async () => {
  const made = await srv.api('/api/team/role/create', { scope: 'office', name: 'Project maker', keys: ['office.project.create'] });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const set = await srv.api('/api/team/member/set', { scope: 'office', device: srv.b.device, role: 'Project maker' });
  assert.deepEqual([set.status, set.body], [200, { ok: true }]);
  const list = await srv.api('/api/team/office');
  assert.equal(list.status, 200);
  assert.equal(list.body.members.find((m: any) => m.device_id === srv.b.device).role, 'Project maker');
  assert.ok(list.body.roles.some((x: any) => x.name === 'Office admin' && x.locked === 'all'));
  const held = await srv.api('/api/team/role/delete', { scope: 'office', role: made.body.role.ulid });
  assert.equal(held.status, 409, JSON.stringify(held.body));
  await srv.api('/api/team/member/set', { scope: 'office', device: srv.b.device, role: 'Office member' });
  const del = await srv.api('/api/team/role/delete', { scope: 'office', role: made.body.role.ulid });
  assert.deepEqual([del.status, del.body], [200, { ok: true }]);
});

test('built-in roles by their ULID: Office member\'s keys change; Owner and Office admin get the office\'s 409', async () => {
  const office = (await srv.api('/api/team/office')).body.roles;
  const member = office.find((x: any) => x.name === 'Office member');
  const admin = office.find((x: any) => x.name === 'Office admin');
  const owner = (await srv.api(`/api/team/project?ulid=${tm.ulid}`)).body.roles.find((x: any) => x.name === 'Owner');
  const up = await srv.api('/api/team/role/update', { scope: 'office', role: member.ulid, keys: ['office.project.create', 'office.module.share'] });
  try {
    assert.deepEqual([up.status, up.body], [200, { ok: true }]);
    const now = (await srv.api('/api/team/office')).body.roles.find((x: any) => x.ulid === member.ulid);
    assert.deepEqual([...now.keys].sort(), ['office.module.share', 'office.project.create']);
  } finally {
    await srv.api('/api/team/role/update', { scope: 'office', role: member.ulid, keys: member.keys });
  }
  const rename = await srv.api('/api/team/role/update', { scope: 'project', project: tm.ulid, role: owner.ulid, name: 'Boss' });
  const officeRename = await direct('PUT', `/v1/projects/${tm.ulid}/roles/${owner.ulid}`, { name: 'Boss' });
  assert.equal(rename.status, 409);
  assert.deepEqual(rename.body, { error: officeRename.body.error });
  const del = await srv.api('/api/team/role/delete', { scope: 'office', role: admin.ulid });
  assert.equal(del.status, 409);
  assert.match(del.body.error, /Office admin/);
});

test('bad input is a 400 with a plain message, before any office call', async () => {
  const seen = srv.office.requests.length;
  const cases: Array<[string, any, RegExp]> = [
    ['/api/team/member/set', { scope: 'team', device: 'x', role: 'Reader' }, /scope must be "project" or "office"/],
    ['/api/team/member/set', { scope: 'project', project: 'TM', device: 'x', role: 'Reader' }, /project must be the ULID/],
    ['/api/team/member/set', { scope: 'office', role: 'Reader' }, /device must be/],
    ['/api/team/member/set', { scope: 'office', device: 'x', role: ' ' }, /role must be the name/],
    ['/api/team/member/remove', { device: 'x' }, /project must be the ULID/],
    ['/api/team/role/create', { scope: 'office', name: 'X', keys: 'office.project.create' }, /keys must be a list/],
    ['/api/team/role/create', { scope: 'office', keys: [] }, /name must be text/],
    ['/api/team/role/update', { scope: 'office', role: 'Office admin', name: 'X' }, /role must be the ULID/],
    ['/api/team/role/update', { scope: 'office', role: core.newUlid() }, /nothing to change/],
    ['/api/team/role/delete', { scope: 'project', project: tm.ulid }, /role must be the ULID/],
  ];
  for (const [route, body, msg] of cases) {
    const r = await srv.api(route, body);
    assert.equal(r.status, 400, `${route} ${JSON.stringify(body)}`);
    assert.match(r.body.error, msg);
  }
  const q = await srv.api('/api/team/project?ulid=TM');
  assert.equal(q.status, 400);
  assert.equal(srv.office.requests.length, seen);
});

test('an older office (404 no such endpoint) -> 501 "needs updating"', async () => {
  srv.office.hooks.accessStatus = () => 404;
  try {
    const r = await srv.api('/api/team/overview');
    assert.deepEqual([r.status, r.body], [501, { error: 'The post office needs updating before roles can be managed here.' }]);
  } finally { delete srv.office.hooks.accessStatus; }
});

test('a revoked key -> 403 plain message; a schema mismatch -> 409 with its message', async () => {
  const key = syncValue(core.SYNC_KEYS.key);
  setSync(core.SYNC_KEYS.key, 'not-the-key');
  try {
    const r = await srv.api(`/api/team/project?ulid=${tm.ulid}`);
    assert.deepEqual([r.status, r.body], [403, { error: "This laptop's access to the post office was revoked." }]);
  } finally { setSync(core.SYNC_KEYS.key, key); }
  srv.db.prepare(`INSERT INTO schema_migrations (version) VALUES ('9999_test_only')`).run();
  try {
    const r = await srv.api('/api/team/office');
    assert.equal(r.status, 409);
    assert.match(r.body.error, /^update this laptop: the post office is on \S+, this notes DB is on 9999_test_only$/);
  } finally { srv.db.prepare(`DELETE FROM schema_migrations WHERE version = '9999_test_only'`).run(); }
  assert.equal((await srv.api('/api/team/office')).status, 200, 'restored');
});

test('after member/set, the second laptop\'s courier refreshes access on the access event', async () => {
  const courier = new Courier({ dbPath: srv.b.path, watch: false, retryMs: 60_000 });
  const reader = new Database(srv.b.path, { readonly: true });
  try {
    courier.start();
    await until(() => courier.status.state === 'connected', 5000, "b's courier to connect");
    await courier.whenIdle(); // the ready-event sync is done: what follows is the access event's work
    const roleOf = () => core.readAccessCache(reader).get(tm.ulid)?.role;
    assert.equal(roleOf(), undefined, 'b is not in TM yet');
    const r = await srv.api('/api/team/member/set', { scope: 'project', project: tm.ulid, device: srv.b.device, role: 'Reader' });
    assert.deepEqual([r.status, r.body], [200, { ok: true }]);
    await until(() => roleOf() === 'Reader', 5000, "b's access cache to show Reader in TM");
    await srv.api('/api/team/member/set', { scope: 'project', project: tm.ulid, device: srv.b.device, role: 'Contributor' });
    await until(() => roleOf() === 'Contributor', 5000, "b's access cache to show Contributor in TM");
  } finally {
    await courier.stop();
    reader.close();
  }
});

// Last: the office stays down.
test('office down -> 503 plain message', async () => {
  await srv.office.down();
  for (const route of ['/api/team/overview', `/api/team/project?ulid=${tm.ulid}`]) {
    const r = await srv.api(route);
    assert.deepEqual([r.status, r.body], [503, { error: "The post office can't be reached right now." }], route);
  }
  const set = await srv.api('/api/team/member/set', { scope: 'office', device: srv.b.device, role: 'Office member' });
  assert.equal(set.status, 503);
});
