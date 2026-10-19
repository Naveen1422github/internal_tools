// file: post-office/test/admin-members.test.ts
// RnR S3-1 (the rank rule): nobody changes, removes or revokes a member ranked
// above them. Rank = key sets, active keys only. Over HTTPS, as the lower-ranked device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestJson, newUlid } from '@collab-mcp/core';
import { office } from './office.js';
import { setOfficeRole, setProjectMember } from '../src/access.js';
import { revokeMember } from '../src/store.js';

const mkProject = (code: string) => ({ ulid: newUlid(), name: `Proj ${code}`, code });
const NOTES = ['note.view', 'note.create', 'note.edit.own', 'note.edit.any', 'note.supersede', 'note.archive', 'note.copy.out'];
/** A manager without project.edit: Owner's first active key it lacks is project.edit. */
const LEAD = [...NOTES, 'merge.resolve', 'member.invite', 'member.revoke', 'role.manage'];

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
const revokedAt = (o: O, d: string) =>
  (o.store.prepare(`SELECT revoked_at FROM po_members WHERE device_id = ?`).get(d) as { revoked_at: string | null }).revoked_at;

/** N registers SH (Owner); a second Owner O2, so the last-Owner 409 never hides the rank rule. */
async function team(o: O) {
  const n = await o.join('N');
  const o2 = await o.join('O2');
  const r = await o.join('R');
  const x = await o.join('X');
  const p = mkProject('SH');
  assert.equal((await requestJson(o.target(n), 'POST', '/v1/projects', p)).status, 200);
  setProjectMember(o.store, null, p.ulid, o2.device, 'Owner');
  return { n, o2, r, x, p: p.ulid };
}

test('a custom manager role (role.manage + member.revoke, no project.edit) cannot change or remove an Owner, naming project.edit', async () => {
  const o = await office();
  try {
    const { n, r, p } = await team(o);
    projectRole(o, p, 'Lead', LEAD);
    setProjectMember(o.store, null, p, r.device, 'Lead');
    const want = 'You need "Edit project" (project.edit) in SH to do this';
    const set = await requestJson(o.target(r), 'PUT', `/v1/projects/${p}/members/${n.device}`, { role: 'Reader' });
    assert.equal(set.status, 403);
    assert.equal(set.body.error, want);
    const same = await requestJson(o.target(r), 'PUT', `/v1/projects/${p}/members/${n.device}`, { role: 'Owner' });
    assert.equal(same.status, 403, 'a no-op on a higher-ranked member is refused too');
    const del = await requestJson(o.target(r), 'DELETE', `/v1/projects/${p}/members/${n.device}`);
    assert.equal(del.status, 403);
    assert.equal(del.body.error, want);
    assert.equal(roleIn(o, p, n.device), 'Owner');
  } finally { await o.stop(); }
});

test('the same role can change and remove a Contributor', async () => {
  const o = await office();
  try {
    const { r, x, p } = await team(o);
    projectRole(o, p, 'Lead', LEAD);
    setProjectMember(o.store, null, p, r.device, 'Lead');
    setProjectMember(o.store, null, p, x.device, 'Contributor');
    assert.equal((await requestJson(o.target(r), 'PUT', `/v1/projects/${p}/members/${x.device}`, { role: 'Reader' })).status, 200);
    assert.equal(roleIn(o, p, x.device), 'Reader');
    assert.equal((await requestJson(o.target(r), 'DELETE', `/v1/projects/${p}/members/${x.device}`)).status, 200);
    assert.equal(roleIn(o, p, x.device), undefined);
  } finally { await o.stop(); }
});

test('an Editor-like custom role is not blocked by Editor\'s stored inactive task.* keys', async () => {
  const o = await office();
  try {
    const { r, x, p } = await team(o);
    const editorActive = [...NOTES, 'merge.resolve'];
    assert.ok(!editorActive.some((k) => k.startsWith('task.')));
    projectRole(o, p, 'Desk', [...editorActive, 'role.manage']);
    setProjectMember(o.store, null, p, r.device, 'Desk');
    setProjectMember(o.store, null, p, x.device, 'Editor');   // Editor stores task.*, which grants nothing (rule 4)
    assert.equal((await requestJson(o.target(r), 'PUT', `/v1/projects/${p}/members/${x.device}`, { role: 'Reader' })).status, 200);
    assert.equal((await requestJson(o.target(r), 'PUT', `/v1/projects/${p}/members/${x.device}`, { role: 'Editor' })).status, 200);
    assert.equal(roleIn(o, p, x.device), 'Editor');
  } finally { await o.stop(); }
});

test('an Owner can demote another Owner; the last Owner still cannot be demoted or removed (409)', async () => {
  const o = await office();
  try {
    const { n, o2, p } = await team(o);
    assert.equal((await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/members/${o2.device}`, { role: 'Editor' })).status, 200);
    const demote = await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/members/${n.device}`, { role: 'Editor' });
    assert.equal(demote.status, 409);
    assert.match(demote.body.error, /needs at least one Owner/);
    assert.equal((await requestJson(o.target(n), 'DELETE', `/v1/projects/${p}/members/${n.device}`)).status, 409);
    assert.equal(roleIn(o, p, n.device), 'Owner');
  } finally { await o.stop(); }
});

test('office: a custom office role with office.role.manage but not office.member.add cannot change an Office admin\'s office role', async () => {
  const o = await office();
  try {
    const { n, o2, r, x } = await team(o);
    setOfficeRole(o.store, null, o2.device, 'Office admin');   // N is not the only admin: no 409 to hide behind
    officeRole(o, 'Role keeper', ['office.project.create', 'office.module.share', 'office.role.manage']);
    setOfficeRole(o.store, null, r.device, 'Role keeper');
    const res = await requestJson(o.target(r), 'PUT', `/v1/office/members/${n.device}`, { role: 'Office member' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'You need "Add office members" (office.member.add) in this office to do this');
    assert.equal(officeRoleOf(o, n.device), 'Office admin');
    // an Office member is below Role keeper: changing it is fine
    officeRole(o, 'Sharer', ['office.project.create', 'office.module.share']);
    assert.equal((await requestJson(o.target(r), 'PUT', `/v1/office/members/${x.device}`, { role: 'Sharer' })).status, 200);
    assert.equal(officeRoleOf(o, x.device), 'Sharer');
  } finally { await o.stop(); }
});

test('office: revoking a device ranked above you is refused naming the key; the office CLI (actor null) is exempt', async () => {
  const o = await office();
  try {
    const { n, o2, r, x } = await team(o);
    setOfficeRole(o.store, null, o2.device, 'Office admin');
    officeRole(o, 'Revoker', ['office.project.create', 'office.module.share', 'office.member.revoke']);
    setOfficeRole(o.store, null, r.device, 'Revoker');
    const res = await requestJson(o.target(r), 'DELETE', `/v1/office/members/${o2.device}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'You need "Add office members" (office.member.add) in this office to do this');
    assert.equal(revokedAt(o, o2.device), null);
    // below you: revoked
    assert.equal((await requestJson(o.target(r), 'DELETE', `/v1/office/members/${x.device}`)).status, 200);
    assert.ok(revokedAt(o, x.device));
    // the office machine's CLI is not ranked
    revokeMember(o.store, o2.device);
    assert.ok(revokedAt(o, o2.device));
    assert.equal(officeRoleOf(o, n.device), 'Office admin');
  } finally { await o.stop(); }
});
