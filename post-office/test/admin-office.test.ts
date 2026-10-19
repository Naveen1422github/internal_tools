// file: post-office/test/admin-office.test.ts
// RnR S3 Task 3: office roles are created, edited and deleted at the office, and
// GET /v1/office/members lists who holds which. S3-2 (Office admin fixed, Office
// member's name fixed), S3-3 (delete only when unheld), S3-6 (names), S3-7. Over HTTPS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestJson, openEventStream, newUlid, keysOf } from '@collab-mcp/core';
import { office } from './office.js';
import { setOfficeRole } from '../src/access.js';
import { addMember } from '../src/store.js';

type O = Awaited<ReturnType<typeof office>>;
const officeRole = (o: O, name: string, keys: string[]) => {
  const ulid = newUlid();
  o.store.prepare(`INSERT INTO po_office_roles (ulid, name, keys, is_starter) VALUES (?, ?, ?, 0)`).run(ulid, name, JSON.stringify(keys));
  return ulid;
};
const roleRow = (o: O, name: string) =>
  o.store.prepare(`SELECT ulid, name, keys, is_starter FROM po_office_roles WHERE name = ?`).get(name) as
    { ulid: string; name: string; keys: string; is_starter: number } | undefined;
const roleById = (o: O, ulid: string) =>
  o.store.prepare(`SELECT name, keys FROM po_office_roles WHERE ulid = ?`).get(ulid) as { name: string; keys: string } | undefined;
const roleCount = (o: O) => (o.store.prepare(`SELECT COUNT(*) n FROM po_office_roles`).get() as { n: number }).n;
const officeRoleOf = (o: O, d: string) =>
  (o.store.prepare(`SELECT r.name FROM po_office_members x JOIN po_office_roles r ON r.ulid = x.role_ulid WHERE x.device_id = ?`).get(d) as { name: string } | undefined)?.name;
const revoke = (o: O, d: string) => o.store.prepare(`UPDATE po_members SET revoked_at = datetime('now') WHERE device_id = ?`).run(d);

/** N is the Office admin (first to join); R and X are Office members. */
async function team(o: O) {
  const n = await o.join('N');
  const r = await o.join('R');
  const x = await o.join('X');
  return { n, r, x };
}

async function listen(o: O, who: { device: string; key: string }) {
  const events: string[] = [];
  const stream = openEventStream(o.target(who), '/v1/events', { event: (name) => events.push(name), close: () => {} });
  const end = Date.now() + 3000;
  while (!events.includes('ready') && Date.now() < end) await new Promise((q) => setTimeout(q, 10));
  const count = () => events.filter((e) => e === 'access').length;
  const waitFor = async (n: number) => {
    const until = Date.now() + 3000;
    while (count() < n && Date.now() < until) await new Promise((q) => setTimeout(q, 10));
    return count();
  };
  return { count, waitFor, close: () => stream.close() };
}

test('Office admin cannot be renamed, re-keyed or deleted; Office member cannot be renamed or deleted, but its keys can change', async () => {
  const o = await office();
  try {
    const { n } = await team(o);
    const admin = roleRow(o, 'Office admin')!;
    for (const body of [{ name: 'Boss' }, { keys: ['office.project.create'] }, { name: 'Office admin', keys: [] }, { name: 'OFFICE ADMIN' }, {}]) {
      const res = await requestJson(o.target(n), 'PUT', `/v1/office/roles/${admin.ulid}`, body);
      assert.equal(res.status, 409, JSON.stringify(body));
      assert.equal(res.body.error, "The Office admin role can't be renamed or changed.");
    }
    const delAdmin = await requestJson(o.target(n), 'DELETE', `/v1/office/roles/${admin.ulid}`);
    assert.equal(delAdmin.status, 409);
    assert.equal(delAdmin.body.error, "Office admin is a built-in role and can't be deleted.");
    assert.deepEqual(roleById(o, admin.ulid), { name: admin.name, keys: admin.keys });

    const member = roleRow(o, 'Office member')!;
    for (const name of ['Staff', 'office member', 'OFFICE MEMBER', 'Office admin', 7]) {
      const res = await requestJson(o.target(n), 'PUT', `/v1/office/roles/${member.ulid}`, { name });
      assert.equal(res.status, 409, String(name));
      assert.equal(res.body.error, "The Office member role can't be renamed.");
    }
    assert.equal(roleById(o, member.ulid)!.name, 'Office member');
    // keeping the exact name (trimmed) is fine; keys change
    const ed = await requestJson(o.target(n), 'PUT', `/v1/office/roles/${member.ulid}`, { name: ' Office member ', keys: ['office.module.share', 'office.project.create'] });
    assert.equal(ed.status, 200);
    assert.deepEqual(roleById(o, member.ulid), { name: 'Office member', keys: JSON.stringify(['office.project.create', 'office.module.share']) });
    const delMember = await requestJson(o.target(n), 'DELETE', `/v1/office/roles/${member.ulid}`);
    assert.equal(delMember.status, 409);
    assert.equal(delMember.body.error, "Office member is a built-in role and can't be deleted.");
    assert.ok(roleById(o, member.ulid));
  } finally { await o.stop(); }
});

test('after a refused rename of Office member, POST /v1/office/members still adds a device as Office member', async () => {
  const o = await office();
  try {
    const { n } = await team(o);
    const member = roleRow(o, 'Office member')!;
    const admin = roleRow(o, 'Office admin')!;
    for (const [ulid, name] of [[member.ulid, 'office member'], [member.ulid, 'Staff'], [admin.ulid, 'office admin']]) {
      assert.equal((await requestJson(o.target(n), 'PUT', `/v1/office/roles/${ulid}`, { name })).status, 409);
    }
    // a custom role can't take either starter name, in any case
    assert.equal((await requestJson(o.target(n), 'POST', '/v1/office/roles', { name: 'OFFICE member', keys: [] })).status, 409);
    const add = await requestJson(o.target(n), 'POST', '/v1/office/members', { name: 'Z' });
    assert.equal(add.status, 200);
    assert.equal(officeRoleOf(o, add.body.device_id), 'Office member');
    // and the last-Office-admin rule still holds
    const demote = await requestJson(o.target(n), 'PUT', `/v1/office/members/${n.device}`, { role: 'Office member' });
    assert.equal(demote.status, 409);
    assert.match(demote.body.error, /at least one Office admin/);
  } finally { await o.stop(); }
});

test('an Office member (no office.role.manage) gets 403 naming office.role.manage on every role route', async () => {
  const o = await office();
  try {
    const { r } = await team(o);
    const custom = officeRole(o, 'Helper', ['office.project.create']);
    const before = roleCount(o);
    const want = 'You need "Manage office roles" (office.role.manage) in this office to do this';
    for (const [method, path, body] of [
      ['POST', '/v1/office/roles', { name: 'Sneak', keys: [] }],
      ['PUT', `/v1/office/roles/${custom}`, { name: 'Mine' }],
      ['PUT', `/v1/office/roles/${newUlid()}`, { name: 'Mine' }],
      ['DELETE', `/v1/office/roles/${custom}`, undefined],
    ] as const) {
      const res = await requestJson(o.target(r), method, path, body);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.body.error, want);
    }
    assert.equal(roleCount(o), before);
    assert.equal(roleById(o, custom)!.name, 'Helper');
  } finally { await o.stop(); }
});

test('a custom office role is created, assigned via PUT /v1/office/members/:d, and cannot be deleted while held', async () => {
  const o = await office();
  try {
    const { n, r, x } = await team(o);
    const ev = await listen(o, n);
    try {
      const start = ev.count();
      const made = await requestJson(o.target(n), 'POST', '/v1/office/roles', { name: '  Module keeper ', keys: ['office.module.share', 'office.project.create', 'office.module.share'] });
      assert.equal(made.status, 200);
      assert.equal(made.body.role.name, 'Module keeper');
      assert.deepEqual(made.body.role.keys, ['office.project.create', 'office.module.share'], 'catalog order, no duplicates');
      const id = made.body.role.ulid as string;
      assert.deepEqual(roleById(o, id), { name: 'Module keeper', keys: JSON.stringify(['office.project.create', 'office.module.share']) });
      assert.equal(roleRow(o, 'Module keeper')!.is_starter, 0);
      assert.equal(await ev.waitFor(start + 1), start + 1, 'create rings access');

      // a no-op edit rings nothing
      assert.equal((await requestJson(o.target(n), 'PUT', `/v1/office/roles/${id}`, { name: 'Module keeper', keys: ['office.module.share', 'office.project.create'] })).status, 200);
      await new Promise((q) => setTimeout(q, 150));
      assert.equal(ev.count(), start + 1, 'a no-op rings nothing');
      // a real edit rings
      assert.equal((await requestJson(o.target(n), 'PUT', `/v1/office/roles/${id}`, { name: 'Keeper', keys: ['office.module.share'] })).status, 200);
      assert.equal(await ev.waitFor(start + 2), start + 2);
      assert.deepEqual(roleById(o, id), { name: 'Keeper', keys: JSON.stringify(['office.module.share']) });

      assert.equal((await requestJson(o.target(n), 'PUT', `/v1/office/members/${r.device}`, { role: 'Keeper' })).status, 200);
      assert.equal(officeRoleOf(o, r.device), 'Keeper');
      const access = await requestJson(o.target(r), 'GET', '/v1/access');
      assert.deepEqual(access.body.office, { role: 'Keeper', keys: ['office.module.share'] });

      setOfficeRole(o.store, null, x.device, 'Keeper');
      const live = await requestJson(o.target(n), 'DELETE', `/v1/office/roles/${id}`);
      assert.equal(live.status, 409);
      assert.equal(live.body.error, '2 members hold Keeper. Give them another role first.');
      revoke(o, x.device);
      const two = await requestJson(o.target(n), 'DELETE', `/v1/office/roles/${id}`);
      assert.equal(two.status, 409);
      assert.equal(two.body.error, "2 members hold Keeper, including 1 removed device. It can't be deleted while a removed device still holds it.");
      setOfficeRole(o.store, null, r.device, 'Office member');
      const one = await requestJson(o.target(n), 'DELETE', `/v1/office/roles/${id}`);
      assert.equal(one.status, 409);
      assert.equal(one.body.error, "1 member holds Keeper, including 1 removed device. It can't be deleted while a removed device still holds it.", 'the revoked holder still counts');
      o.store.prepare(`DELETE FROM po_office_members WHERE device_id = ?`).run(x.device);
      const ringsBefore = ev.count();
      assert.equal((await requestJson(o.target(n), 'DELETE', `/v1/office/roles/${id}`)).status, 200);
      assert.equal(roleById(o, id), undefined);
      assert.equal(await ev.waitFor(ringsBefore + 1), ringsBefore + 1, 'delete rings access');
      // gone: 404 on every role route
      for (const method of ['PUT', 'DELETE'] as const) {
        const res = await requestJson(o.target(n), method, `/v1/office/roles/${id}`, method === 'PUT' ? { name: 'Back' } : undefined);
        assert.equal(res.status, 404, method);
        assert.deepEqual(res.body, { error: 'No such role.' });
      }
    } finally { ev.close(); }
  } finally { await o.stop(); }
});

test('office role names and keys: unknown and project-scope keys refused by name; clashes are case-insensitive; control characters refused', async () => {
  const o = await office();
  try {
    const { n } = await team(o);
    const post = (body: unknown) => requestJson(o.target(n), 'POST', '/v1/office/roles', body);
    const before = roleCount(o);
    for (const key of ['office.fly', 'note.view', 'role.manage']) {
      const res = await post({ name: 'Bad', keys: ['office.project.create', key] });
      assert.equal(res.status, 400, key);
      assert.equal(res.body.error, `"${key}" is not a permission that can be given.`);
    }
    assert.equal((await post({ name: 'Bad', keys: 'office.project.create' })).status, 400, 'keys must be a list');
    for (const name of ['office admin', ' Office Member ']) {
      const res = await post({ name, keys: [] });
      assert.equal(res.status, 409, name);
      assert.equal(res.body.error, `"${name.trim()}" is the name of a built-in role.`);
    }
    assert.equal((await post({ name: '   ', keys: [] })).status, 400);
    assert.equal((await post({ keys: [] })).status, 400);
    assert.equal((await post({ name: 'x'.repeat(41), keys: [] })).status, 400);
    assert.equal((await post({ name: 'Bad\nname', keys: [] })).body.error, 'A role name can\'t contain control characters.');
    assert.equal(roleCount(o), before);
    // a project starter name is not an office one
    assert.equal((await post({ name: 'Owner', keys: [] })).status, 200);
    assert.equal((await post({ name: 'Équipe', keys: [] })).status, 200);
    const clash = await post({ name: 'éQUIPE', keys: [] });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error, 'This office already has a role called "Équipe".');
    const other = await post({ name: 'Other', keys: [] });
    assert.equal((await requestJson(o.target(n), 'PUT', `/v1/office/roles/${other.body.role.ulid}`, { name: 'équipe' })).status, 409);
    assert.equal((await requestJson(o.target(n), 'PUT', `/v1/office/roles/${other.body.role.ulid}`, { name: 'OTHER' })).status, 200, 'a role may change the case of its own name');
    assert.equal(roleById(o, other.body.role.ulid)!.name, 'OTHER');
    // S3-4 in office scope: no office key is inactive today, so only the sanitizing shows here:
    // a stored unknown key is not kept by an edit (an inactive one would be, as in project scope)
    const id = officeRole(o, 'Legacy', ['office.project.create', 'office.zap']);
    assert.equal((await requestJson(o.target(n), 'PUT', `/v1/office/roles/${id}`, { keys: ['office.module.share'] })).status, 200);
    assert.deepEqual(JSON.parse(roleById(o, id)!.keys), ['office.module.share']);
  } finally { await o.stop(); }
});

test('GET /v1/office/members lists live members with their office role; each role counts every holder (S3-3)', async () => {
  const o = await office();
  try {
    const { n, r, x } = await team(o);
    const keeper = officeRole(o, 'Keeper', ['office.module.share', 'office.zap']);
    setOfficeRole(o.store, null, r.device, 'Keeper');
    revoke(o, x.device);
    addMember(o.store, 'Waiting');   // never joined
    const res = await requestJson(o.target(r), 'GET', '/v1/office/members');   // any live member may read it
    assert.equal(res.status, 200);
    const members = res.body.members as Array<{ device_id: string; name: string; role: string; role_ulid: string; last_seen_at: string | null }>;
    assert.deepEqual(members.map((m) => m.name), ['N', 'R']);
    const admin = roleRow(o, 'Office admin')!;
    const member = roleRow(o, 'Office member')!;
    assert.deepEqual(Object.keys(members[0]).sort(), ['device_id', 'last_seen_at', 'name', 'role', 'role_ulid']);
    assert.deepEqual([members[0].device_id, members[0].role, members[0].role_ulid], [n.device, 'Office admin', admin.ulid]);
    assert.deepEqual([members[1].device_id, members[1].role, members[1].role_ulid], [r.device, 'Keeper', keeper]);
    assert.ok(members[0].last_seen_at);
    const roles = res.body.roles as Array<{ ulid: string; name: string; keys: string[]; is_starter: boolean; locked: string | null }>;
    const by = (name: string) => roles.find((q) => q.name === name)!;
    assert.deepEqual(by('Office admin'), { ulid: admin.ulid, name: 'Office admin', keys: keysOf('office'), is_starter: true, locked: 'all', holders: 1 });
    assert.deepEqual(by('Office member'), { ulid: member.ulid, name: 'Office member', keys: ['office.project.create'], is_starter: true, locked: 'name', holders: 2 }, 'the revoked X and the waiting device');
    assert.deepEqual(by('Keeper'), { ulid: keeper, name: 'Keeper', keys: ['office.module.share'], is_starter: false, locked: null, holders: 1 }, 'stored keys are sanitized');
    assert.equal(roles.length, 3);
    // a revoked device reads nothing
    await assert.rejects(requestJson(o.target(x), 'GET', '/v1/office/members'), { name: 'AccessRevokedError' });
  } finally { await o.stop(); }
});

test('the last Office admin still cannot be moved to another office role (409)', async () => {
  const o = await office();
  try {
    const { n, r } = await team(o);
    // a custom role holding every office key is still not Office admin
    const all = await requestJson(o.target(n), 'POST', '/v1/office/roles', { name: 'Everything', keys: keysOf('office') });
    assert.equal(all.status, 200);
    for (const role of ['Everything', 'Office member']) {
      const res = await requestJson(o.target(n), 'PUT', `/v1/office/members/${n.device}`, { role });
      assert.equal(res.status, 409, role);
      assert.equal(res.body.error, 'this office needs at least one Office admin; make someone else Office admin first');
    }
    assert.equal(officeRoleOf(o, n.device), 'Office admin');
    // with a second admin, N may step down onto the custom role
    setOfficeRole(o.store, null, r.device, 'Office admin');
    assert.equal((await requestJson(o.target(n), 'PUT', `/v1/office/members/${n.device}`, { role: 'Everything' })).status, 200);
    assert.equal(officeRoleOf(o, n.device), 'Everything');
  } finally { await o.stop(); }
});
