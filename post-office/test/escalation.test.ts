// file: post-office/test/escalation.test.ts
// RnR S3 Review Focus 0: every escalation path is refused at the post office
// itself. Raw HTTPS to the office as the lower-ranked device; no web server.
// S3-14 (no escalation), S3-15 (self-role), S3-1 (rank). Tasks 2-3 add the role paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestJson, newUlid } from '@collab-mcp/core';
import { office } from './office.js';
import { setOfficeRole, setProjectMember } from '../src/access.js';

type O = Awaited<ReturnType<typeof office>>;
const projectRole = (o: O, p: string, name: string, keys: string[]) =>
  o.store.prepare(`INSERT INTO po_roles (ulid, project_ulid, name, keys, is_starter) VALUES (?, ?, ?, ?, 0)`).run(newUlid(), p, name, JSON.stringify(keys));
const officeRole = (o: O, name: string, keys: string[]) =>
  o.store.prepare(`INSERT INTO po_office_roles (ulid, name, keys, is_starter) VALUES (?, ?, ?, 0)`).run(newUlid(), name, JSON.stringify(keys));
const roleIn = (o: O, p: string, d: string) =>
  (o.store.prepare(`SELECT r.name FROM po_project_members x JOIN po_roles r ON r.ulid = x.role_ulid WHERE x.project_ulid = ? AND x.device_id = ?`)
    .get(p, d) as { name: string } | undefined)?.name;
const officeRoleOf = (o: O, d: string) =>
  (o.store.prepare(`SELECT r.name FROM po_office_members x JOIN po_office_roles r ON r.ulid = x.role_ulid WHERE x.device_id = ?`).get(d) as { name: string }).name;

/** N (Office admin) registers SH as Owner; R and K are plain members. */
async function team(o: O) {
  const n = await o.join('N');
  const r = await o.join('R');
  const k = await o.join('K');
  const p = { ulid: newUlid(), name: 'Support hub', code: 'SH' };
  assert.equal((await requestJson(o.target(n), 'POST', '/v1/projects', p)).status, 200);
  return { n, r, k, p: p.ulid };
}

test('assigning a role holding a key you lack, to someone else or to yourself -> 403 naming that key', async () => {
  const o = await office();
  try {
    const { r, k, p } = await team(o);
    // project: may invite and manage roles, holds little else
    projectRole(o, p, 'Inviter', ['note.view', 'member.invite', 'role.manage']);
    setProjectMember(o.store, null, p, r.device, 'Inviter');
    const want = 'You need "Create notes" (note.create) in SH to do this';
    for (const [who, role] of [[k.device, 'Owner'], [r.device, 'Owner'], [k.device, 'Editor']] as const) {
      const res = await requestJson(o.target(r), 'PUT', `/v1/projects/${p}/members/${who}`, { role });
      assert.equal(res.status, 403, `${role} to ${who === r.device ? 'self' : 'other'}`);
      assert.equal(res.body.error, want);
    }
    assert.equal(roleIn(o, p, r.device), 'Inviter');
    assert.equal(roleIn(o, p, k.device), undefined);
    // office: may manage office roles, may not add members -> may not hand out Office admin
    officeRole(o, 'Role keeper', ['office.project.create', 'module.edit', 'office.role.manage']);
    setOfficeRole(o.store, null, r.device, 'Role keeper');
    for (const who of [k.device, r.device]) {
      const res = await requestJson(o.target(r), 'PUT', `/v1/office/members/${who}`, { role: 'Office admin' });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'You need "Add office members" (office.member.add) in this office to do this');
    }
    assert.equal(officeRoleOf(o, r.device), 'Role keeper');
    assert.equal(officeRoleOf(o, k.device), 'Office member');
  } finally { await o.stop(); }
});

test('managing a higher-ranked member (set, remove, office role, revoke) -> 403 naming the first key you lack', async () => {
  const o = await office();
  try {
    const { n, r, k, p } = await team(o);
    setProjectMember(o.store, null, p, k.device, 'Owner');        // two Owners: no last-Owner 409
    setOfficeRole(o.store, null, k.device, 'Office admin');       // two Office admins: no last-admin 409
    projectRole(o, p, 'Lead', ['note.view', 'member.revoke', 'role.manage']);
    setProjectMember(o.store, null, p, r.device, 'Lead');
    officeRole(o, 'Keeper', ['office.project.create', 'office.member.revoke', 'office.role.manage']);
    setOfficeRole(o.store, null, r.device, 'Keeper');
    const project = 'You need "Create notes" (note.create) in SH to do this';
    const officeWant = 'You need "Add office members" (office.member.add) in this office to do this';
    const tries: Array<[string, string, unknown, string]> = [
      ['PUT', `/v1/projects/${p}/members/${k.device}`, { role: 'Reader' }, project],
      ['DELETE', `/v1/projects/${p}/members/${k.device}`, undefined, project],
      ['PUT', `/v1/office/members/${n.device}`, { role: 'Office member' }, officeWant],
      ['DELETE', `/v1/office/members/${k.device}`, undefined, officeWant],
    ];
    for (const [method, path, body, want] of tries) {
      const res = await requestJson(o.target(r), method as 'PUT' | 'DELETE', path, body);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.body.error, want);
    }
    assert.equal(roleIn(o, p, k.device), 'Owner');
    assert.equal(officeRoleOf(o, n.device), 'Office admin');
    assert.equal((o.store.prepare(`SELECT revoked_at FROM po_members WHERE device_id = ?`).get(k.device) as { revoked_at: string | null }).revoked_at, null);
  } finally { await o.stop(); }
});

test('lowering your own role is accepted; the last Owner lowering themselves -> 409; the last Office admin likewise', async () => {
  const o = await office();
  try {
    const { n, r, p } = await team(o);
    setProjectMember(o.store, null, p, r.device, 'Owner');
    setOfficeRole(o.store, null, r.device, 'Office admin');
    // R lowers themselves in both scopes
    assert.equal((await requestJson(o.target(r), 'PUT', `/v1/projects/${p}/members/${r.device}`, { role: 'Editor' })).status, 200);
    assert.equal(roleIn(o, p, r.device), 'Editor');
    assert.equal((await requestJson(o.target(r), 'PUT', `/v1/office/members/${r.device}`, { role: 'Office member' })).status, 200);
    assert.equal(officeRoleOf(o, r.device), 'Office member');
    // N is now the last of each
    const own = await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/members/${n.device}`, { role: 'Editor' });
    assert.equal(own.status, 409);
    assert.match(own.body.error, /SH needs at least one Owner/);
    const adm = await requestJson(o.target(n), 'PUT', `/v1/office/members/${n.device}`, { role: 'Office member' });
    assert.equal(adm.status, 409);
    assert.match(adm.body.error, /at least one Office admin/);
    assert.equal(roleIn(o, p, n.device), 'Owner');
    assert.equal(officeRoleOf(o, n.device), 'Office admin');
  } finally { await o.stop(); }
});

// ---------------------------------------------------------------- Task 2: project roles
const roleUlid = (o: O, p: string, name: string) =>
  (o.store.prepare(`SELECT ulid FROM po_roles WHERE project_ulid = ? AND name = ?`).get(p, name) as { ulid: string }).ulid;
const storedKeys = (o: O, ulid: string) => (o.store.prepare(`SELECT keys FROM po_roles WHERE ulid = ?`).get(ulid) as { keys: string }).keys;

test('creating a project role holding a key you lack -> 403 naming that key; nothing is created', async () => {
  const o = await office();
  try {
    const { r, p } = await team(o);
    projectRole(o, p, 'Lead', ['note.view', 'note.create', 'role.manage']);
    setProjectMember(o.store, null, p, r.device, 'Lead');
    const res = await requestJson(o.target(r), 'POST', `/v1/projects/${p}/roles`, { name: 'Boss', keys: ['note.view', 'note.supersede', 'member.revoke'] });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'You need "Supersede notes" (note.supersede) in SH to do this');
    assert.equal(o.store.prepare(`SELECT 1 FROM po_roles WHERE project_ulid = ? AND name = 'Boss'`).get(p), undefined);
  } finally { await o.stop(); }
});

test('editing a project role to add a key you lack -> 403 naming that key, your own role included', async () => {
  const o = await office();
  try {
    const { r, p } = await team(o);
    projectRole(o, p, 'Lead', ['note.view', 'note.create', 'note.edit.own', 'role.manage']);
    setProjectMember(o.store, null, p, r.device, 'Lead');
    const contributor = roleUlid(o, p, 'Contributor');
    const lead = roleUlid(o, p, 'Lead');
    const before = [storedKeys(o, contributor), storedKeys(o, lead)];
    for (const [ulid, keys] of [
      [contributor, ['note.view', 'note.create', 'note.edit.own', 'project.edit']],
      [lead, ['note.view', 'note.create', 'note.edit.own', 'role.manage', 'project.edit']],   // raising your own role
    ] as const) {
      const res = await requestJson(o.target(r), 'PUT', `/v1/projects/${p}/roles/${ulid}`, { keys });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'You need "Edit project" (project.edit) in SH to do this');
    }
    assert.deepEqual([storedKeys(o, contributor), storedKeys(o, lead)], before);
    // lowering your own role's keys is accepted
    assert.equal((await requestJson(o.target(r), 'PUT', `/v1/projects/${p}/roles/${lead}`, { keys: ['note.view', 'role.manage'] })).status, 200);
  } finally { await o.stop(); }
});

test('editing or deleting a project role ranked above you -> 403 naming the first key you lack', async () => {
  const o = await office();
  try {
    const { r, p } = await team(o);
    projectRole(o, p, 'Lead', ['note.view', 'role.manage']);
    setProjectMember(o.store, null, p, r.device, 'Lead');
    const editor = roleUlid(o, p, 'Editor');
    const want = 'You need "Create notes" (note.create) in SH to do this';
    for (const body of [{ name: 'Writer' }, { keys: ['note.view'] }]) {
      const res = await requestJson(o.target(r), 'PUT', `/v1/projects/${p}/roles/${editor}`, body);
      assert.equal(res.status, 403, JSON.stringify(body));
      assert.equal(res.body.error, want);
    }
    // (deleting a built-in is a 409 for everyone: a custom role shows the rank rule)
    projectRole(o, p, 'Big', ['note.view', 'note.create']);
    const del = await requestJson(o.target(r), 'DELETE', `/v1/projects/${p}/roles/${roleUlid(o, p, 'Big')}`);
    assert.equal(del.status, 403);
    assert.equal(del.body.error, want);
    assert.equal(roleIn(o, p, r.device), 'Lead');
  } finally { await o.stop(); }
});

// ---------------------------------------------------------------- Task 3: office roles
const officeRoleUlid = (o: O, name: string) =>
  (o.store.prepare(`SELECT ulid FROM po_office_roles WHERE name = ?`).get(name) as { ulid: string }).ulid;
const officeStoredKeys = (o: O, ulid: string) => (o.store.prepare(`SELECT keys FROM po_office_roles WHERE ulid = ?`).get(ulid) as { keys: string }).keys;

test('creating an office role holding a key you lack -> 403 naming that key; nothing is created', async () => {
  const o = await office();
  try {
    const { r } = await team(o);
    officeRole(o, 'Keeper', ['office.project.create', 'office.role.manage']);
    setOfficeRole(o.store, null, r.device, 'Keeper');
    const res = await requestJson(o.target(r), 'POST', '/v1/office/roles', { name: 'Boss', keys: ['office.project.create', 'module.edit'] });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'You need "Edit modules" (module.edit) in this office to do this');
    assert.equal(o.store.prepare(`SELECT 1 FROM po_office_roles WHERE name = 'Boss'`).get(), undefined);
    // within its own keys, Keeper may create
    assert.equal((await requestJson(o.target(r), 'POST', '/v1/office/roles', { name: 'Small', keys: ['office.project.create'] })).status, 200);
  } finally { await o.stop(); }
});

test('editing an office role to add a key you lack -> 403 naming that key, your own role included', async () => {
  const o = await office();
  try {
    const { r } = await team(o);
    officeRole(o, 'Keeper', ['office.project.create', 'office.role.manage']);
    setOfficeRole(o.store, null, r.device, 'Keeper');
    const member = officeRoleUlid(o, 'Office member');
    const keeper = officeRoleUlid(o, 'Keeper');
    const before = [officeStoredKeys(o, member), officeStoredKeys(o, keeper)];
    for (const [ulid, keys] of [
      [member, ['office.project.create', 'office.member.add']],
      [keeper, ['office.project.create', 'office.role.manage', 'office.member.add']],   // raising your own role
    ] as const) {
      const res = await requestJson(o.target(r), 'PUT', `/v1/office/roles/${ulid}`, { keys });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'You need "Add office members" (office.member.add) in this office to do this');
    }
    assert.deepEqual([officeStoredKeys(o, member), officeStoredKeys(o, keeper)], before);
    // lowering your own role's keys is accepted
    assert.equal((await requestJson(o.target(r), 'PUT', `/v1/office/roles/${keeper}`, { keys: ['office.role.manage'] })).status, 200);
    assert.equal(officeStoredKeys(o, keeper), JSON.stringify(['office.role.manage']));
  } finally { await o.stop(); }
});

test('editing or deleting an office role ranked above you -> 403 naming the first key you lack', async () => {
  const o = await office();
  try {
    const { r } = await team(o);
    officeRole(o, 'Keeper', ['office.role.manage']);
    setOfficeRole(o.store, null, r.device, 'Keeper');
    const member = officeRoleUlid(o, 'Office member');
    const want = 'You need "Create projects" (office.project.create) in this office to do this';
    const res = await requestJson(o.target(r), 'PUT', `/v1/office/roles/${member}`, { keys: [] });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, want);
    officeRole(o, 'Big', ['office.project.create', 'office.role.manage']);
    const big = officeRoleUlid(o, 'Big');
    for (const [method, body] of [['PUT', { name: 'Small' }], ['DELETE', undefined]] as const) {
      const r2 = await requestJson(o.target(r), method, `/v1/office/roles/${big}`, body);
      assert.equal(r2.status, 403, method);
      assert.equal(r2.body.error, want);
    }
    assert.equal(officeStoredKeys(o, member), JSON.stringify(['office.project.create']));
    assert.equal(officeRoleOf(o, r.device), 'Keeper');
  } finally { await o.stop(); }
});

test('assigning a custom office role holding a key you lack -> 403 naming that key, to someone else or to yourself', async () => {
  const o = await office();
  try {
    const { n, r, k } = await team(o);
    const made = await requestJson(o.target(n), 'POST', '/v1/office/roles', { name: 'Gatekeeper', keys: ['office.project.create', 'office.member.add'] });
    assert.equal(made.status, 200);
    officeRole(o, 'Keeper', ['office.project.create', 'office.role.manage']);
    setOfficeRole(o.store, null, r.device, 'Keeper');
    for (const who of [k.device, r.device]) {
      const res = await requestJson(o.target(r), 'PUT', `/v1/office/members/${who}`, { role: 'Gatekeeper' });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'You need "Add office members" (office.member.add) in this office to do this');
    }
    assert.equal(officeRoleOf(o, r.device), 'Keeper');
    assert.equal(officeRoleOf(o, k.device), 'Office member');
  } finally { await o.stop(); }
});

test('adding a device whose office role holds a key you lack -> 403 naming that key; nothing is created (S3-14)', async () => {
  const o = await office();
  try {
    const { n, r } = await team(o);
    const made = await requestJson(o.target(n), 'POST', '/v1/office/roles', { name: 'Recruiter', keys: ['office.member.add'] });
    assert.equal(made.status, 200);
    assert.equal((await requestJson(o.target(n), 'PUT', `/v1/office/members/${r.device}`, { role: 'Recruiter' })).status, 200);
    const members = () => (o.store.prepare(`SELECT COUNT(*) AS c FROM po_members`).get() as { c: number }).c;
    const before = members();
    const res = await requestJson(o.target(r), 'POST', '/v1/office/members', { name: 'Newcomer' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'You need "Create projects" (office.project.create) in this office to do this');
    assert.equal(members(), before);
    // an Office admin still adds
    const ok = await requestJson(o.target(n), 'POST', '/v1/office/members', { name: 'Newcomer' });
    assert.equal(ok.status, 200);
    assert.equal(officeRoleOf(o, ok.body.device_id), 'Office member');
    assert.equal(members(), before + 1);
  } finally { await o.stop(); }
});
