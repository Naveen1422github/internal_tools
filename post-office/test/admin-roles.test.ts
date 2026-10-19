// file: post-office/test/admin-roles.test.ts
// RnR S3 Task 2: project roles are created, edited and deleted at the office.
// S3-1 (rank), S3-2 (Owner fixed), S3-3 (delete only when unheld), S3-4 (stored
// inactive keys kept), S3-5 (an edit moves replays), S3-6 (names), R7a. Over HTTPS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestJson, openEventStream, newUlid } from '@collab-mcp/core';
import { office } from './office.js';
import { setProjectMember } from '../src/access.js';

type O = Awaited<ReturnType<typeof office>>;
const NOTES = ['note.view', 'note.create', 'note.edit.own', 'note.edit.any', 'note.supersede', 'note.archive', 'note.copy.out'];
/** A manager without project.edit. */
const LEAD = [...NOTES, 'merge.resolve', 'member.invite', 'member.revoke', 'role.manage'];

const projectRole = (o: O, p: string, name: string, keys: string[]) => {
  const ulid = newUlid();
  o.store.prepare(`INSERT INTO po_roles (ulid, project_ulid, name, keys, is_starter) VALUES (?, ?, ?, ?, 0)`).run(ulid, p, name, JSON.stringify(keys));
  return ulid;
};
const roleRow = (o: O, p: string, name: string) =>
  o.store.prepare(`SELECT ulid, name, keys, is_starter FROM po_roles WHERE project_ulid = ? AND name = ?`).get(p, name) as
    { ulid: string; name: string; keys: string; is_starter: number } | undefined;
const roleById = (o: O, ulid: string) =>
  o.store.prepare(`SELECT name, keys FROM po_roles WHERE ulid = ?`).get(ulid) as { name: string; keys: string } | undefined;
const roleCount = (o: O, p: string) => (o.store.prepare(`SELECT COUNT(*) n FROM po_roles WHERE project_ulid = ?`).get(p) as { n: number }).n;
const hasReplay = (o: O, d: string, p: string) => !!o.store.prepare(`SELECT 1 FROM po_replays WHERE device_id = ? AND project_ulid = ?`).get(d, p);
const revoke = (o: O, d: string) => o.store.prepare(`UPDATE po_members SET revoked_at = datetime('now') WHERE device_id = ?`).run(d);

/** N registers SH (Owner); R, X, Y are office members, not yet in SH. */
async function team(o: O) {
  const n = await o.join('N');
  const r = await o.join('R');
  const x = await o.join('X');
  const y = await o.join('Y');
  const p = { ulid: newUlid(), name: 'Support hub', code: 'SH' };
  assert.equal((await requestJson(o.target(n), 'POST', '/v1/projects', p)).status, 200);
  return { n, r, x, y, p: p.ulid };
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

test('an Owner creates a custom role; a holder of role.manage without project.edit cannot create one holding project.edit', async () => {
  const o = await office();
  try {
    const { n, r, p } = await team(o);
    const made = await requestJson(o.target(n), 'POST', `/v1/projects/${p}/roles`, { name: '  Reviewer ', keys: ['note.supersede', 'note.view', 'note.view'] });
    assert.equal(made.status, 200);
    assert.equal(made.body.role.name, 'Reviewer');
    assert.deepEqual(made.body.role.keys, ['note.view', 'note.supersede'], 'catalog order, no duplicates');
    const row = roleRow(o, p, 'Reviewer')!;
    assert.equal(row.ulid, made.body.role.ulid);
    assert.equal(row.is_starter, 0);
    // the new role can be assigned straight away
    assert.equal((await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/members/${r.device}`, { role: 'Reviewer' })).status, 200);

    projectRole(o, p, 'Lead', LEAD);
    setProjectMember(o.store, null, p, r.device, 'Lead');
    const before = roleCount(o, p);
    const res = await requestJson(o.target(r), 'POST', `/v1/projects/${p}/roles`, { name: 'Boss', keys: ['note.view', 'project.edit'] });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'You need "Edit project" (project.edit) in SH to do this');
    assert.equal(roleCount(o, p), before);
    // within its own keys, Lead may create
    assert.equal((await requestJson(o.target(r), 'POST', `/v1/projects/${p}/roles`, { name: 'Helper', keys: ['note.view', 'note.create'] })).status, 200);
    // a Reader (no role.manage) may not
    setProjectMember(o.store, null, p, r.device, 'Reader');
    const rd = await requestJson(o.target(r), 'POST', `/v1/projects/${p}/roles`, { name: 'Mine', keys: [] });
    assert.equal(rd.status, 403);
    assert.equal(rd.body.error, 'You need "Manage roles" (role.manage) in SH to do this');
  } finally { await o.stop(); }
});

test('unknown, office-scope and inactive keys are refused by name; names clash case-insensitively; "owner" is refused', async () => {
  const o = await office();
  try {
    const { n, p } = await team(o);
    const post = (body: unknown) => requestJson(o.target(n), 'POST', `/v1/projects/${p}/roles`, body);
    for (const key of ['note.fly', 'office.module.share', 'task.create', 'project.delete']) {
      const res = await post({ name: 'Bad', keys: ['note.view', key] });
      assert.equal(res.status, 400, key);
      assert.equal(res.body.error, `"${key}" is not a permission that can be given`);
    }
    assert.equal((await post({ name: 'Bad', keys: 'note.view' })).status, 400, 'keys must be a list');
    for (const name of ['owner', 'EDITOR', ' Reader ', 'contributor']) {
      const res = await post({ name, keys: [] });
      assert.equal(res.status, 409, name);
      assert.equal(res.body.error, `"${name.trim()}" is the name of a built-in role`);
    }
    assert.equal((await post({ name: '   ', keys: [] })).status, 400);
    assert.equal((await post({ keys: [] })).status, 400);
    assert.equal((await post({ name: 'x'.repeat(41), keys: [] })).status, 400);
    assert.equal((await post({ name: 'x'.repeat(40), keys: [] })).status, 200);
    assert.equal((await post({ name: 'Reviewer', keys: [] })).status, 200);
    const clash = await post({ name: 'reviewer', keys: [] });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error, 'SH already has a role called "Reviewer"');
    assert.equal(roleRow(o, p, 'Bad'), undefined);
    // renaming into a clash is refused too
    const other = await post({ name: 'Other', keys: [] });
    const ren = await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/roles/${other.body.role.ulid}`, { name: 'REVIEWER' });
    assert.equal(ren.status, 409);
    const own = await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/roles/${other.body.role.ulid}`, { name: 'OTHER' });
    assert.equal(own.status, 200, 'a role may change the case of its own name');
    assert.equal(roleById(o, other.body.role.ulid)!.name, 'OTHER');
  } finally { await o.stop(); }
});

test('S3-6: names clash case-insensitively beyond ASCII; control characters are refused', async () => {
  const o = await office();
  try {
    const { n, p } = await team(o);
    const post = (body: unknown) => requestJson(o.target(n), 'POST', `/v1/projects/${p}/roles`, body);
    assert.equal((await post({ name: 'Équipe', keys: [] })).status, 200);
    const clash = await post({ name: 'équipe', keys: [] });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error, 'SH already has a role called "Équipe"');
    // the same letter written decomposed (E + combining acute) clashes too
    const nfd = await post({ name: 'e\u0301quipe', keys: [] });
    assert.equal(nfd.status, 409);
    // renaming into a non-ASCII clash is refused
    const other = await post({ name: 'Straße', keys: [] });
    assert.equal(other.status, 200);
    assert.equal((await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/roles/${other.body.role.ulid}`, { name: 'ÉQUIPE' })).status, 409);
    for (const name of ['Bad\u0000name', 'Bad\nname', 'Bad\tname', 'Bad\u001bname', 'Bad\u007fname']) {
      const res = await post({ name, keys: [] });
      assert.equal(res.status, 400, JSON.stringify(name));
      assert.equal(res.body.error, 'a role name can\'t contain control characters');
    }
    const ren = await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/roles/${other.body.role.ulid}`, { name: 'Line\nbreak' });
    assert.equal(ren.status, 400);
    assert.equal(roleById(o, other.body.role.ulid)!.name, 'Straße');
  } finally { await o.stop(); }
});

test('renaming, re-keying or deleting Owner -> 409; Editor can be renamed and re-keyed; Editor keeps its stored task.* keys', async () => {
  const o = await office();
  try {
    const { n, r, p } = await team(o);
    const owner = roleRow(o, p, 'Owner')!;
    const ownerKeys = owner.keys;
    for (const body of [{ name: 'Boss' }, { keys: ['note.view'] }, { name: 'Owner', keys: [] }, {}]) {
      const res = await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/roles/${owner.ulid}`, body);
      assert.equal(res.status, 409, JSON.stringify(body));
      assert.equal(res.body.error, "The Owner role can't be renamed or changed");
    }
    const del = await requestJson(o.target(n), 'DELETE', `/v1/projects/${p}/roles/${owner.ulid}`);
    assert.equal(del.status, 409);
    assert.equal(del.body.error, "Owner is a built-in role and can't be deleted");
    assert.deepEqual(roleById(o, owner.ulid), { name: 'Owner', keys: ownerKeys });
    // the last-Owner rule still holds after the refused attempts (Review Focus 2/5)
    const demote = await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/members/${n.device}`, { role: 'Reader' });
    assert.equal(demote.status, 409);
    assert.match(demote.body.error, /SH needs at least one Owner/);

    const editor = roleRow(o, p, 'Editor')!;
    assert.ok(JSON.parse(editor.keys).includes('task.create'));
    const ed = await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/roles/${editor.ulid}`, { name: 'Writer', keys: ['note.view', 'note.create', 'merge.resolve'] });
    assert.equal(ed.status, 200);
    const after = roleById(o, editor.ulid)!;
    assert.equal(after.name, 'Writer');
    assert.deepEqual(JSON.parse(after.keys), ['note.view', 'note.create', 'task.create', 'task.assign', 'task.status.change', 'merge.resolve']);
    // the renamed starter is still assignable, by its new name
    assert.equal((await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/members/${r.device}`, { role: 'Writer' })).status, 200);
    // built-ins other than Owner can't be deleted either (even unheld)
    const reader = roleRow(o, p, 'Reader')!;
    const dr = await requestJson(o.target(n), 'DELETE', `/v1/projects/${p}/roles/${reader.ulid}`);
    assert.equal(dr.status, 409);
    assert.equal(dr.body.error, "Reader is a built-in role and can't be deleted");
    const dw = await requestJson(o.target(n), 'DELETE', `/v1/projects/${p}/roles/${editor.ulid}`);
    assert.equal(dw.body.error, "Writer is a built-in role and can't be deleted");
    // S3-6: a built-in name only for the role that holds it now: once renamed, Editor can't take "Editor" back
    const back = await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/roles/${editor.ulid}`, { name: 'Editor' });
    assert.equal(back.status, 409);
    assert.equal(back.body.error, '"Editor" is the name of a built-in role');
    assert.equal(roleById(o, editor.ulid)!.name, 'Writer');
    // ... and no other starter can take it either
    const contributor = roleRow(o, p, 'Contributor')!;
    const steal = await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/roles/${contributor.ulid}`, { name: 'editor' });
    assert.equal(steal.status, 409);
    assert.equal(steal.body.error, '"editor" is the name of a built-in role');
    assert.equal(roleById(o, contributor.ulid)!.name, 'Contributor');
    // a starter may still change the case of its own built-in name
    assert.equal((await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/roles/${contributor.ulid}`, { name: 'CONTRIBUTOR' })).status, 200);
    assert.equal(roleById(o, contributor.ulid)!.name, 'CONTRIBUTOR');
  } finally { await o.stop(); }
});

test('a lower-ranked manager cannot edit or delete a role holding keys they lack', async () => {
  const o = await office();
  try {
    const { r, p } = await team(o);
    projectRole(o, p, 'Lead', LEAD);
    setProjectMember(o.store, null, p, r.device, 'Lead');
    const senior = projectRole(o, p, 'Senior', ['note.view', 'project.edit']);
    const want = 'You need "Edit project" (project.edit) in SH to do this';
    for (const [method, body] of [['PUT', { name: 'Junior' }], ['PUT', { keys: ['note.view'] }], ['DELETE', undefined]] as const) {
      const res = await requestJson(o.target(r), method, `/v1/projects/${p}/roles/${senior}`, body);
      assert.equal(res.status, 403, `${method} ${JSON.stringify(body)}`);
      assert.equal(res.body.error, want);
    }
    assert.deepEqual(roleById(o, senior), { name: 'Senior', keys: JSON.stringify(['note.view', 'project.edit']) });
    // a role within Lead's keys: edited and deleted
    const low = projectRole(o, p, 'Low', ['note.view']);
    assert.equal((await requestJson(o.target(r), 'PUT', `/v1/projects/${p}/roles/${low}`, { keys: ['note.view', 'note.create'] })).status, 200);
    assert.equal((await requestJson(o.target(r), 'DELETE', `/v1/projects/${p}/roles/${low}`)).status, 200);
    assert.equal(roleById(o, low), undefined);
  } finally { await o.stop(); }
});

test('deleting a held role -> 409 with the count, revoked holders included; an unheld custom role is deleted', async () => {
  const o = await office();
  try {
    const { n, r, x, p } = await team(o);
    const made = await requestJson(o.target(n), 'POST', `/v1/projects/${p}/roles`, { name: 'Reviewer', keys: ['note.view'] });
    const id = made.body.role.ulid as string;
    setProjectMember(o.store, null, p, r.device, 'Reviewer');
    setProjectMember(o.store, null, p, x.device, 'Reviewer');
    revoke(o, x.device);
    const two = await requestJson(o.target(n), 'DELETE', `/v1/projects/${p}/roles/${id}`);
    assert.equal(two.status, 409);
    assert.equal(two.body.error, '2 members hold Reviewer. Give them another role first');
    setProjectMember(o.store, null, p, r.device, 'Reader');
    const one = await requestJson(o.target(n), 'DELETE', `/v1/projects/${p}/roles/${id}`);
    assert.equal(one.status, 409);
    assert.equal(one.body.error, '1 member holds Reviewer. Give them another role first', 'the revoked holder still counts');
    o.store.prepare(`DELETE FROM po_project_members WHERE device_id = ?`).run(x.device);
    assert.equal((await requestJson(o.target(n), 'DELETE', `/v1/projects/${p}/roles/${id}`)).status, 200);
    assert.equal(roleById(o, id), undefined);
    // a role ulid that no longer exists, or belongs to another project: the same 404
    const q = { ulid: newUlid(), name: 'Other', code: 'OT' };
    await requestJson(o.target(n), 'POST', '/v1/projects', q);
    const foreign = roleRow(o, q.ulid, 'Reader')!.ulid;
    const gone = await requestJson(o.target(n), 'DELETE', `/v1/projects/${p}/roles/${id}`);
    const elsewhere = await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/roles/${foreign}`, { name: 'Viewer' });
    assert.equal(gone.status, 404);
    assert.deepEqual(elsewhere.body, gone.body);
    assert.equal(elsewhere.status, 404);
    assert.equal(roleById(o, foreign)!.name, 'Reader');
  } finally { await o.stop(); }
});

test('taking note.view from a role drops its holders\' replays; giving it back queues one per live holder and rings access', async () => {
  const o = await office();
  try {
    const { n, r, x, y, p } = await team(o);
    const reader = roleRow(o, p, 'Reader')!.ulid;
    for (const d of [r, x, y]) setProjectMember(o.store, null, p, d.device, 'Reader');
    o.store.prepare(`DELETE FROM po_replays`).run();   // as if each had finished its first replay
    revoke(o, y.device);
    const ev = await listen(o, n);
    try {
      const start = ev.count();
      // no-op: same keys, same name -> 200, nothing rung
      assert.equal((await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/roles/${reader}`, { name: 'Reader', keys: ['note.view'] })).status, 200);
      await new Promise((q) => setTimeout(q, 150));
      assert.equal(ev.count(), start, 'a no-op rings nothing');

      o.store.prepare(`INSERT INTO po_replays (device_id, project_ulid, upto_seq) VALUES (?, ?, 0)`).run(r.device, p);   // one still pending
      assert.equal((await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/roles/${reader}`, { keys: [] })).status, 200);
      assert.equal(await ev.waitFor(start + 1), start + 1);
      assert.equal(hasReplay(o, r.device, p), false, 'R15: losing note.view drops the replay');
      assert.deepEqual(JSON.parse(roleById(o, reader)!.keys), []);

      assert.equal((await requestJson(o.target(n), 'PUT', `/v1/projects/${p}/roles/${reader}`, { keys: ['note.view'] })).status, 200);
      assert.equal(await ev.waitFor(start + 2), start + 2);
      assert.equal(hasReplay(o, r.device, p), true, 'R14: R is owed a replay');
      assert.equal(hasReplay(o, x.device, p), true, 'R14: X is owed a replay');
      assert.equal(hasReplay(o, y.device, p), false, 'a revoked holder gets nothing');
      assert.equal(hasReplay(o, n.device, p), false, 'the Owner never lost note.view');
      const access = await requestJson(o.target(r), 'GET', '/v1/access');
      assert.ok(access.body.replays.some((q: { project_ulid: string }) => q.project_ulid === p));
    } finally { ev.close(); }
    // setProjectMember still moves replays through the shared helper
    setProjectMember(o.store, null, p, x.device, null);
    assert.equal(hasReplay(o, x.device, p), false);
  } finally { await o.stop(); }
});

test('a non-member gets the same 404 for every role route; nothing is rung', async () => {
  const o = await office();
  try {
    const { n, r, p } = await team(o);
    const ev = await listen(o, n);
    try {
      const start = ev.count();
      const reader = roleRow(o, p, 'Reader')!.ulid;
      const missing = newUlid();
      for (const [method, path, body] of [
        ['POST', 'roles', { name: 'Sneak', keys: ['note.view'] }],
        ['PUT', `roles/${reader}`, { name: 'Viewer' }],
        ['DELETE', `roles/${reader}`, undefined],
      ] as const) {
        const a = await requestJson(o.target(r), method, `/v1/projects/${p}/${path}`, body);
        const b = await requestJson(o.target(r), method, `/v1/projects/${missing}/${path}`, body);
        assert.equal(a.status, 404, `${method} ${path}`);
        assert.deepEqual(a.body, { error: 'no such team project' });
        assert.deepEqual(b.body, a.body);
      }
      await new Promise((q) => setTimeout(q, 150));
      assert.equal(ev.count(), start);
      assert.equal(roleRow(o, p, 'Sneak'), undefined);
      assert.equal(roleRow(o, p, 'Reader')!.ulid, reader);
      // a real change rings
      assert.equal((await requestJson(o.target(n), 'POST', `/v1/projects/${p}/roles`, { name: 'Viewer', keys: ['note.view'] })).status, 200);
      assert.equal(await ev.waitFor(start + 1), start + 1);
    } finally { ev.close(); }
  } finally { await o.stop(); }
});

test('membersOf marks built-in and locked roles', async () => {
  const o = await office();
  try {
    const { n, r, p } = await team(o);
    await requestJson(o.target(n), 'POST', `/v1/projects/${p}/roles`, { name: 'Reviewer', keys: ['note.view'] });
    setProjectMember(o.store, null, p, r.device, 'Reviewer');
    const res = await requestJson(o.target(n), 'GET', `/v1/projects/${p}/members`);
    assert.equal(res.status, 200);
    const roles = res.body.roles as Array<{ ulid: string; name: string; keys: string[]; is_starter: boolean; locked: string | null }>;
    const by = (name: string) => roles.find((x) => x.name === name)!;
    assert.deepEqual([by('Owner').is_starter, by('Owner').locked], [true, 'all']);
    for (const name of ['Editor', 'Contributor', 'Reader']) assert.deepEqual([by(name).is_starter, by(name).locked], [true, null], name);
    assert.deepEqual([by('Reviewer').is_starter, by('Reviewer').locked], [false, null]);
    const members = res.body.members as Array<{ device_id: string; role: string; role_ulid: string }>;
    assert.equal(members.find((m) => m.device_id === r.device)!.role_ulid, by('Reviewer').ulid);
    assert.equal(members.find((m) => m.device_id === n.device)!.role_ulid, by('Owner').ulid);
  } finally { await o.stop(); }
});
