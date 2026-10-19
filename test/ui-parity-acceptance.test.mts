// UI parity acceptance (plan Task 13): the whole story over the web API, with
// one office, the web's laptop N (Office admin) and a laptop R invited from
// the web. Refusals are checked at the office, with no web server in the path.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startTeamServer } from './helpers/team-server.mjs';
import { Courier } from '../courier/src/engine.ts';

let srv: any;
let core: any;
let courier: Courier;
before(async () => {
  srv = await startTeamServer();
  core = await import('@collab-mcp/core');
  core.initModule(srv.db, { slug: 'billing' });
  courier = new Courier({ dbPath: srv.a.path, watch: false, retryMs: 60_000 });
});
after(async () => { await courier.stop(); await srv.close(); });

const projectName = (code: string) => core.findProject(srv.db, code)?.name;
let rTarget: any;

test('1-3. N creates a solo project, promotes it, renames it (the name holds after a sync), binds a module', async () => {
  assert.equal((await srv.api('/api/projects/create', { name: 'Ledger', code: 'LG', team: false })).status, 200);
  core.addEntry(srv.db, { type: 'decision', title: 'before promote', summary: 's', project: 'LG' });
  const p = await srv.api('/api/projects/promote', { code: 'LG' });
  assert.deepEqual([p.status, p.body.next], [200, 'LG-2']);
  assert.equal((await srv.api('/api/projects/rename', { code: 'LG', name: 'General ledger' })).status, 200);
  await courier.syncNow();
  assert.equal(projectName('LG'), 'General ledger', 'the courier keeps the office\'s (new) name');
  const b = await srv.api('/api/projects/bind', { module: 'billing', code: 'LG' });
  assert.match(b.body.line, /^Module billing is bound to LG/);
});

test('4-5. N invites R from the web; R joins with the code; N adds R to LG as a Contributor', async () => {
  const inv = await srv.api('/api/team/invite', { name: 'Rinku' });
  assert.equal(inv.status, 200);
  const jc = core.parseJoinCode(inv.body.join_code);
  const joined = await core.requestJson({ url: jc.url, fingerprint: jc.fingerprint }, 'POST', '/v1/join', { device: jc.device, secret: jc.secret });
  assert.equal(joined.status, 200);
  rTarget = { url: jc.url, fingerprint: jc.fingerprint, auth: { device: jc.device, key: joined.body.key }, schema: core.latestMigration(srv.db) };
  const office = await srv.api('/api/team/office');
  assert.ok(office.body.members.some((m: any) => m.device_id === jc.device && m.name === 'Rinku'), 'R is listed once joined');
  const lg = core.findProject(srv.db, 'LG');
  const add = await srv.api('/api/team/member/set', { scope: 'project', project: lg.ulid, device: jc.device, role: 'Contributor' });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const members = await core.requestJson(rTarget, 'GET', `/v1/projects/${lg.ulid}/members`);
  assert.equal(members.status, 200, 'R can see LG now');
});

test('6. R (Office member) tries to revoke N and to rename LG, straight at the office: refused naming the key', async () => {
  const lg = core.findProject(srv.db, 'LG');
  const revoke = await core.requestJson(rTarget, 'DELETE', `/v1/office/members/${srv.a.device}`);
  assert.deepEqual([revoke.status, revoke.body.error], [403, 'You need "Revoke office members" (office.member.revoke) in this office to do this']);
  const rename = await core.requestJson(rTarget, 'PUT', `/v1/projects/${lg.ulid}`, { name: 'Mine' });
  assert.deepEqual([rename.status, rename.body.error], [403, 'You need "Edit project" (project.edit) in LG to do this']);
});

test('7. N writes a note into LG from the New note form and copies it to a solo project', async () => {
  assert.equal((await srv.api('/api/projects/create', { name: 'Mine', code: 'MY', team: false })).status, 200);
  const dest = await srv.api('/api/collab/note-destination?module=billing');
  assert.equal(dest.body.project.code, 'LG');
  const n = await srv.api('/api/collab/entry/upsert', { type: 'decision', title: 'From the form', summary: 's', module: 'billing' });
  assert.equal(n.body.series, 'LG');
  const from = `note:${n.body.ulid}`;
  const plan = await srv.api('/api/projects/copy/plan', { from, to: 'MY' });
  const done = await srv.api('/api/projects/copy/apply', { from, to: 'MY', expect: plan.body.items.map((i: any) => i.ulid), target: plan.body.target.ulid });
  assert.deepEqual(done.body.copied.map((c: any) => c.to), ['MY-1']);
});

test('8. N revokes R from the web: every request from R is refused', async () => {
  const r = await srv.api('/api/team/revoke', { device: rTarget.auth.device });
  assert.equal(r.status, 200);
  await assert.rejects(core.requestJson(rTarget, 'GET', '/v1/status'), core.AccessRevokedError);
});

// Last: the office stays down.
test('9. office down: solo actions still work; team actions answer the plain 503', async () => {
  await srv.office.down();
  assert.equal((await srv.api('/api/projects/create', { name: 'Offline', code: 'OF', team: false })).status, 200);
  assert.equal((await srv.api('/api/projects/rename', { code: 'MY', name: 'Mine, renamed' })).status, 200);
  const team = await srv.api('/api/projects/rename', { code: 'LG', name: 'Nope' });
  assert.deepEqual([team.status, team.body], [503, { error: "The post office can't be reached right now." }]);
  const inv = await srv.api('/api/team/invite', { name: 'Later' });
  assert.equal(inv.status, 503);
  assert.equal(projectName('LG'), 'General ledger');
});
