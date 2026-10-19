// UI parity Task 3: /api/projects/* call the same core operations as `collab
// project`; office refusals keep the office's wording. One office-backed web
// server for the whole file (the server is a singleton).
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startTeamServer } from './helpers/team-server.mjs';

let srv: any;
let core: any;
let po: any;
before(async () => {
  srv = await startTeamServer();
  core = await import('@collab-mcp/core');
  po = await import('@collab-mcp/post-office');
  core.initModule(srv.db, { slug: 'billing' });
});
after(() => srv.close());

const row = async (code: string) => (await srv.api('/api/projects')).body.projects.find((p: any) => p.code === code);

test('list: every project with its mode, notes and bound modules; solo rows carry their highest number', async () => {
  core.createProject(srv.db, { name: 'Navi', code: 'NV' });
  core.addEntry(srv.db, { type: 'decision', title: 'n1', summary: 's', project: 'NV' });
  core.bindModule(srv.db, 'billing', 'NV');
  const r = await srv.api('/api/projects');
  assert.equal(r.status, 200);
  const nv = r.body.projects.find((p: any) => p.code === 'NV');
  assert.deepEqual({ name: nv.name, mode: nv.mode, notes: nv.notes, modules: nv.modules, highest: nv.highest },
    { name: 'Navi', mode: 'solo', notes: 1, modules: ['billing'], highest: 1 });
  assert.equal('current' in nv, false, 'the web server has no folder, so no "current" project');
  assert.ok(r.body.modules.includes('billing'));
  assert.equal(r.body.office_url, core.getSyncValue(srv.db, core.SYNC_KEYS.url));
  core.unbindModule(srv.db, 'billing');
});

test('create solo and team; the team project is registered at the office with a as its Owner', async () => {
  const solo = await srv.api('/api/projects/create', { name: 'Scratch', code: 'sc', team: false });
  assert.equal(solo.status, 200, JSON.stringify(solo.body));
  assert.deepEqual([solo.body.project.code, solo.body.project.mode], ['SC', 'solo']);
  assert.deepEqual(solo.body.lines, core.projectCreatedLines(srv.db, core.findProject(srv.db, 'SC')));
  const team = await srv.api('/api/projects/create', { name: 'Support hub', code: 'SH', team: true });
  assert.equal(team.status, 200, JSON.stringify(team.body));
  assert.equal(team.body.project.mode, 'team');
  const role = srv.office.store.prepare(
    `SELECT r.name FROM po_project_members x JOIN po_roles r ON r.ulid = x.role_ulid WHERE x.project_ulid = ? AND x.device_id = ?`,
  ).get(team.body.project.ulid, srv.a.device);
  assert.equal(role.name, 'Owner');
  const clash = await srv.api('/api/projects/create', { name: 'scratch', code: 'ZZ', team: false });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /^this notebook already has a project named "Scratch" \(SC\)/);
  const bad = await srv.api('/api/projects/create', { name: '', code: 'QQ' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'a project needs a name');
});

test('promote: the next number continues after the highest used; the office keeps it', async () => {
  core.createProject(srv.db, { name: 'Promo', code: 'PR' });
  for (let i = 0; i < 3; i++) core.addEntry(srv.db, { type: 'decision', title: `p${i}`, summary: 's', project: 'PR' });
  assert.equal((await row('PR')).highest, 3);
  const r = await srv.api('/api/projects/promote', { code: 'PR' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.project.mode, 'team');
  assert.equal(r.body.next, 'PR-4');
  assert.ok(srv.office.store.prepare(`SELECT 1 FROM po_projects WHERE code = 'PR'`).get());
  const again = await srv.api('/api/projects/promote', { code: 'PR' });
  assert.deepEqual([again.status, again.body.already, 'next' in again.body], [200, true, false], 'already team: no made-up number');
  const nf = await srv.api('/api/projects/promote', { code: 'NOPE' });
  assert.equal(nf.status, 404);
});

test('bad input: a non-boolean team flag and non-text fields are 400s, never a quiet solo project', async () => {
  const t = await srv.api('/api/projects/create', { name: 'Quiet', code: 'QT', team: 'true' });
  assert.deepEqual([t.status, t.body], [400, { error: '"team" must be true or false.' }]);
  assert.equal(core.findProject(srv.db, 'QT'), null);
  const n = await srv.api('/api/projects/create', { name: 7, code: 'QT' });
  assert.deepEqual([n.status, n.body], [400, { error: 'Give the project a name.' }]);
  const r = await srv.api('/api/projects/rename', { code: 'SC' });
  assert.deepEqual([r.status, r.body], [400, { error: 'Give the project a name.' }]);
});

test('rename: solo locally; team at the office (D1); unknown code -> 404', async () => {
  const s = await srv.api('/api/projects/rename', { code: 'SC', name: 'Scratchpad' });
  assert.deepEqual([s.status, s.body.project.name], [200, 'Scratchpad']);
  const t = await srv.api('/api/projects/rename', { code: 'SH', name: 'Support desk' });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const sh = core.findProject(srv.db, 'SH');
  assert.equal(srv.office.store.prepare(`SELECT name FROM po_projects WHERE ulid = ?`).get(sh.ulid).name, 'Support desk');
  const nf = await srv.api('/api/projects/rename', { code: 'NOPE', name: 'x' });
  assert.equal(nf.status, 404);
  assert.match(nf.body.error, /^no project "NOPE" in this notebook/);
});

test('bind and unbind answer core\'s sentence', async () => {
  const b = await srv.api('/api/projects/bind', { module: 'billing', code: 'SC' });
  assert.deepEqual([b.status, b.body.line], [200, core.bindChangeLine({ module: 'billing', from: null, to: 'SC' })]);
  const u = await srv.api('/api/projects/unbind', { module: 'billing' });
  assert.deepEqual([u.status, u.body.line], [200, 'Module billing is no longer bound to SC.']);
  const nm = await srv.api('/api/projects/bind', { module: 'nope', code: 'SC' });
  assert.equal(nm.status, 400);
  assert.match(nm.body.error, /^no module "nope" in this notebook/);
});

test('an office refusal keeps the office\'s sentence: no office.project.create', async () => {
  po.createOfficeRole(srv.office.store, null, { name: 'Viewer', keys: [] });
  po.setOfficeRole(srv.office.store, null, srv.b.device, 'Office admin');
  po.setOfficeRole(srv.office.store, null, srv.a.device, 'Viewer');
  try {
    const r = await srv.api('/api/projects/create', { name: 'Denied', code: 'DN', team: true });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { error: 'You need "Create projects" (office.project.create) in this office to do this' });
    assert.equal(core.findProject(srv.db, 'DN'), null);
  } finally {
    po.setOfficeRole(srv.office.store, null, srv.a.device, 'Office admin');
  }
});

test('copy into a team project where a is only a Reader: refused at the plan step, with the standard sentence', async () => {
  const p = po.registerProject(srv.office.store, { ulid: core.newUlid(), name: 'Readers only', code: 'RO', seed: 0 }, srv.b.device);
  po.setProjectMember(srv.office.store, null, p.ulid, srv.a.device, 'Reader');
  core.upsertTeamProjectFromOffice(srv.db, p, core.getSyncValue(srv.db, core.SYNC_KEYS.fingerprint));
  const access = await core.requestJson(core.postOfficeTargetFromDb(srv.db), 'GET', '/v1/access');
  core.writeAccessCache(srv.db, access.body);
  core.addEntry(srv.db, { type: 'decision', title: 'mine', summary: 's', project: 'SC' });
  const r = await srv.api('/api/projects/copy/plan', { from: 'project:SC', to: 'RO' });
  assert.deepEqual([r.status, r.body], [403, { error: 'You need "Create notes" (note.create) in RO to do this' }]);
});

// Last: the office stays down.
test('office down: team create -> 503 plain message; solo create, rename and bind still work', async () => {
  await srv.office.down();
  const t = await srv.api('/api/projects/create', { name: 'Later', code: 'LT', team: true });
  assert.deepEqual([t.status, t.body], [503, { error: "The post office can't be reached right now." }]);
  const tr = await srv.api('/api/projects/rename', { code: 'SH', name: 'Offline name' });
  assert.equal(tr.status, 503);
  const s = await srv.api('/api/projects/create', { name: 'Offline', code: 'OF', team: false });
  assert.equal(s.status, 200);
  assert.equal((await srv.api('/api/projects/rename', { code: 'OF', name: 'Offline two' })).status, 200);
  assert.equal((await srv.api('/api/projects/bind', { module: 'billing', code: 'OF' })).status, 200);
  assert.equal((await srv.api('/api/projects')).status, 200);
});
