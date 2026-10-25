// file: post-office/test/access.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newUlid, labelOf } from '@collab-mcp/core';
import { tempStore } from './helpers.js';
import { addMember, registerProject, revokeMember, StoreError, type Store } from '../src/store.js';
import {
  projectKeys, officeKeys, memberProjects, requireProjectKey, requireOfficeKey,
  setProjectMember, setOfficeRole, seedAccess,
} from '../src/access.js';

const refused = (status: number, text?: string) => (e: unknown) =>
  e instanceof StoreError && e.status === status && (text === undefined || e.message.includes(text));

/** Back to a pre-RnR store: no access rows, never seeded. */
function preRnR(db: Store): void {
  db.exec(`DELETE FROM po_office_members; DELETE FROM po_office_roles; DELETE FROM po_project_members; DELETE FROM po_roles;
           DELETE FROM po_note_owners; DELETE FROM po_meta WHERE key = 'access_seeded';`);
}
const joined = (db: Store, device: string, at: string) =>
  db.prepare(`UPDATE po_members SET joined_at = ? WHERE device_id = ?`).run(at, device);
const rawProject = (db: Store, code: string) => {
  const ulid = newUlid();
  db.prepare(`INSERT INTO po_projects (ulid, name, code) VALUES (?, ?, ?)`).run(ulid, `Project ${code}`, code);
  db.prepare(`INSERT INTO po_series_counters (series, value) VALUES (?, 0)`).run(code);
  return ulid;
};
const snapshot = (db: Store) => ['po_office_members', 'po_project_members', 'po_roles', 'po_office_roles', 'po_note_owners']
  .map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all());

/** A fresh office: N is the first member (Office admin), R the second, P a project N registered. */
function office() {
  const t = tempStore();
  const n = addMember(t.store, 'naveen').deviceId;
  const r = addMember(t.store, 'rinku').deviceId;
  const p = registerProject(t.store, { ulid: newUlid(), name: 'Support hub', code: 'SH', seed: 0 }, n).ulid;
  return { ...t, n, r, p };
}

test('seedAccess: earliest member is Office admin, others Office member; all Owners of existing projects', () => {
  const { store, cleanup } = tempStore();
  try {
    const r = addMember(store, 'rinku').deviceId;   // added first, joined second
    const n = addMember(store, 'naveen').deviceId;
    const gone = addMember(store, 'lost').deviceId;
    const p = rawProject(store, 'SH');
    preRnR(store);
    joined(store, n, '2026-01-01 00:00:00');
    joined(store, r, '2026-02-01 00:00:00');
    joined(store, gone, '2025-01-01 00:00:00');
    store.prepare(`UPDATE po_members SET revoked_at = datetime('now') WHERE device_id = ?`).run(gone);
    // two notes: one first delivered by R, one only ever by the office itself
    const pk = (u: string) => (store.prepare(`SELECT crsql_pack_columns(?) pk`).get(u) as { pk: Buffer }).pk;
    const note1 = newUlid(), note2 = newUlid();
    const ins = store.prepare(`INSERT INTO po_deliveries (origin, tbl, pk, cid, val, col_version, db_version, site_id, cl, ch_seq)
                               VALUES (?, 'entries', ?, 'title', 't', 1, ?, x'02', 1, 0)`);
    ins.run(r, pk(note1), 1);
    ins.run(n, pk(note1), 2);
    ins.run('post-office', pk(note2), 3);

    seedAccess(store);
    assert.ok(officeKeys(store, n).has('office.role.manage'));
    assert.deepEqual([...officeKeys(store, r)], ['office.project.create']);
    assert.equal(officeKeys(store, gone).size, 0, 'a revoked device holds nothing');
    assert.ok(projectKeys(store, r, p).has('role.manage'));
    assert.ok(projectKeys(store, n, p).has('role.manage'));
    assert.equal(projectKeys(store, gone, p).size, 0);
    const owners = store.prepare(`SELECT ulid, device_id FROM po_note_owners`).all();
    assert.deepEqual(owners, [{ ulid: note1, device_id: r }], 'owner = first delivery; office writes own nothing');

    // second call changes nothing, even after new members and projects arrive
    const before = snapshot(store);
    store.prepare(`INSERT INTO po_members (device_id, name, joined_at) VALUES ('d-late', 'late', datetime('now'))`).run();
    const p2 = rawProject(store, 'NV');
    seedAccess(store);
    assert.deepEqual(snapshot(store), before);
    assert.equal(projectKeys(store, 'd-late', p).size, 0, 'no upgrade path for later joiners (R7a)');
    assert.equal(projectKeys(store, n, p2).size, 0);
  } finally { cleanup(); }
});

test('addMember: Office admin when no live admin exists, else Office member', () => {
  const { store, cleanup } = tempStore();
  try {
    const first = addMember(store, 'first').deviceId;
    const second = addMember(store, 'second').deviceId;
    assert.ok(officeKeys(store, first).has('office.role.manage'));
    assert.deepEqual([...officeKeys(store, second)], ['office.project.create']);
    // no live admin left (only possible by direct edit): the next joiner becomes one
    store.prepare(`UPDATE po_members SET revoked_at = datetime('now') WHERE device_id = ?`).run(first);
    const third = addMember(store, 'third').deviceId;
    assert.ok(officeKeys(store, third).has('office.role.manage'));
  } finally { cleanup(); }
});

test('registerProject: creator is Owner, nobody else is a member', () => {
  const { store, cleanup, n, r, p } = office();
  try {
    assert.ok(projectKeys(store, n, p).has('member.invite'));
    assert.equal(projectKeys(store, r, p).size, 0);
    assert.deepEqual(memberProjects(store, n), [p]);
    assert.ok(!memberProjects(store, r).includes(p));
    // re-registering the same project changes no membership
    registerProject(store, { ulid: p, name: 'Support hub', code: 'SH', seed: 0 }, r);
    assert.equal(projectKeys(store, r, p).size, 0);
    assert.throws(() => registerProject(store, { ulid: newUlid(), name: 'X', code: 'XY', seed: 0 }, 'd-nobody'), refused(400));
  } finally { cleanup(); }
});

test('setProjectMember gates on member.invite / role.manage / member.revoke', () => {
  const { store, cleanup, n, r, p } = office();
  try {
    const k = addMember(store, 'third').deviceId;
    setProjectMember(store, n, p, r, 'Reader');
    assert.throws(() => setProjectMember(store, r, p, k, 'Reader'), refused(403, 'member.invite'));
    assert.throws(() => setProjectMember(store, r, p, r, 'Owner'), refused(403, 'role.manage'));
    setProjectMember(store, n, p, k, 'Contributor');
    assert.throws(() => setProjectMember(store, r, p, k, null), refused(403, 'member.revoke'));
    assert.throws(() => setProjectMember(store, r, p, k, null),
      (e: unknown) => e instanceof StoreError && e.message === 'You need "Revoke members" (member.revoke) in SH to do this');
    setProjectMember(store, n, p, k, 'Editor');
    assert.ok(projectKeys(store, k, p).has('note.edit.any'));
    setProjectMember(store, n, p, k, null);
    assert.equal(projectKeys(store, k, p).size, 0);
    assert.throws(() => setProjectMember(store, n, p, k, 'Boss'), refused(404));
    assert.throws(() => setProjectMember(store, n, p, 'd-nobody', 'Reader'), refused(404));
  } finally { cleanup(); }
});

test('require*Key: 403 names the missing key in plain words', () => {
  const { store, cleanup, n, r, p } = office();
  try {
    requireProjectKey(store, n, p, 'note.create');
    requireOfficeKey(store, n, 'office.member.add');
    assert.throws(() => requireProjectKey(store, r, p, 'note.create'),
      (e: unknown) => e instanceof StoreError && e.status === 403 && e.message === 'You need "Create notes" (note.create) in SH to do this');
    assert.throws(() => requireOfficeKey(store, r, 'office.member.add'),
      (e: unknown) => e instanceof StoreError && e.status === 403 && e.message === 'You need "Add office members" (office.member.add) in this office to do this');
  } finally { cleanup(); }
});

test('last Owner cannot be demoted, removed, or revoked', () => {
  const { store, cleanup, n, r, p } = office();
  try {
    setOfficeRole(store, null, r, 'Office admin');            // so N's office role is not what blocks the revoke
    assert.throws(() => setProjectMember(store, n, p, n, 'Editor'), refused(409, 'Owner'));
    assert.throws(() => setProjectMember(store, n, p, n, null), refused(409, 'Owner'));
    assert.throws(() => revokeMember(store, n), refused(409, 'SH'));
    // a revoked co-Owner does not count
    setProjectMember(store, n, p, r, 'Owner');
    const k = addMember(store, 'third').deviceId;
    setProjectMember(store, n, p, k, 'Owner');
    revokeMember(store, k);
    setProjectMember(store, r, p, r, 'Editor');                // N still Owner
    assert.throws(() => setProjectMember(store, n, p, n, 'Editor'), refused(409));
  } finally { cleanup(); }
});

test('last Office admin cannot be demoted or revoked', () => {
  const { store, cleanup, n, r } = office();
  try {
    assert.throws(() => setOfficeRole(store, null, n, 'Office member'), refused(409, 'Office admin'));
    assert.throws(() => revokeMember(store, n), refused(409, 'Office admin'));
    assert.throws(() => setOfficeRole(store, r, r, 'Office admin'), refused(403, 'office.role.manage'));
    setOfficeRole(store, n, r, 'Office admin');
    setOfficeRole(store, r, n, 'Office member');
    assert.deepEqual([...officeKeys(store, n)], ['office.project.create']);
    assert.throws(() => setOfficeRole(store, null, r, 'Nobody'), refused(404));
  } finally { cleanup(); }
});

test('gaining note.view queues a replay at the current last seq; losing it clears it', () => {
  const { store, cleanup, n, r, p } = office();
  try {
    const replay = () => store.prepare(`SELECT upto_seq FROM po_replays WHERE device_id = ? AND project_ulid = ?`).get(r, p) as { upto_seq: number } | undefined;
    const ins = store.prepare(`INSERT INTO po_deliveries (origin, tbl, pk, cid, val, col_version, db_version, site_id, cl, ch_seq)
                               VALUES (?, 'entries', x'01', 'title', 't', 1, ?, x'02', 1, 0)`);
    ins.run(n, 1); ins.run(n, 2);
    const top = (store.prepare(`SELECT MAX(seq) s FROM po_deliveries`).get() as { s: number }).s;
    setProjectMember(store, n, p, r, 'Reader');
    assert.deepEqual(replay(), { upto_seq: top });
    ins.run(n, 3);
    setProjectMember(store, n, p, r, 'Editor');                // still has note.view: the cursor is kept
    assert.deepEqual(replay(), { upto_seq: top });
    setProjectMember(store, n, p, r, null);
    assert.equal(replay(), undefined);
  } finally { cleanup(); }
});

test('stored bogus keys grant nothing; inactive keys grant nothing', () => {
  const { store, cleanup, n, r, p } = office();
  try {
    setProjectMember(store, n, p, r, 'Reader');
    store.prepare(`UPDATE po_roles SET keys = '["note.view","ticket.close","office.role.manage"]' WHERE project_ulid = ? AND name = 'Reader'`).run(p);
    assert.deepEqual([...projectKeys(store, r, p)], ['note.view']);
    assert.ok(!projectKeys(store, n, p).has('task.create'), 'Owner stores task.create, but it guards nothing yet (rule 4)');
    store.prepare(`UPDATE po_roles SET keys = 'not json' WHERE project_ulid = ? AND name = 'Reader'`).run(p);
    assert.equal(projectKeys(store, r, p).size, 0);
    assert.deepEqual(memberProjects(store, r), []);
  } finally { cleanup(); }
});

test('no one assigns a role holding a key they lack (ruling 4)', () => {
  const { store, cleanup, n, r, p } = office();
  try {
    const k = addMember(store, 'third').deviceId;
    // project: a custom role that may invite, but holds little else
    store.prepare(`INSERT INTO po_roles (ulid, project_ulid, name, keys) VALUES (?, ?, 'Inviter', '["note.view","member.invite","role.manage"]')`).run(newUlid(), p);
    setProjectMember(store, n, p, r, 'Inviter');
    assert.throws(() => setProjectMember(store, r, p, k, 'Owner'),
      (e: unknown) => e instanceof StoreError && e.status === 403 && e.message === `You need "${labelOf('note.create')}" (note.create) in SH to do this`);
    assert.throws(() => setProjectMember(store, r, p, r, 'Owner'), refused(403, 'note.create'), 'no self-promotion either');
    assert.equal(projectKeys(store, k, p).size, 0);
    setProjectMember(store, r, p, k, 'Reader');
    assert.deepEqual([...projectKeys(store, k, p)], ['note.view']);
    assert.throws(() => setProjectMember(store, r, p, k, 'Editor'), refused(403, 'note.create'), 'role change is checked too');
    // office: may manage roles but not add members -> may not hand out Office admin
    store.prepare(`INSERT INTO po_office_roles (ulid, name, keys) VALUES (?, 'Role keeper', '["office.project.create","module.edit","office.role.manage"]')`).run(newUlid());
    setOfficeRole(store, null, r, 'Role keeper');
    assert.throws(() => setOfficeRole(store, r, k, 'Office admin'),
      (e: unknown) => e instanceof StoreError && e.status === 403 && e.message === `You need "${labelOf('office.member.add')}" (office.member.add) in this office to do this`);
    assert.deepEqual([...officeKeys(store, k)], ['office.project.create']);
    setOfficeRole(store, null, k, 'Office admin');            // the office machine's CLI is exempt
    assert.ok(officeKeys(store, k).has('office.member.add'));
  } finally { cleanup(); }
});
