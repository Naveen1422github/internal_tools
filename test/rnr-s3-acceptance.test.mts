// RnR S3 acceptance (plan Task 10, scenarios 1-7; scenario 8 is in
// rnr-s3-acceptance-solo.test.mts, since the web server is a singleton).
// One office, two laptops: N (`a`, the Owner) behind this process's web server,
// and R (`b`, the teammate) driven by a courier, straight over HTTPS to the
// office (scenarios 3-4: no web server in the path), and by R's own web server
// in a child process (scenario 7). The tests run in order and share the world.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database as DB } from 'better-sqlite3';
import { startTeamServer } from './helpers/team-server.mjs';
import { openWriter, closeWriter } from '../courier/test/world.ts';
import { Courier } from '../courier/src/engine.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let srv: any;
let core: any;
let wr: DB;
let cn: Courier;
let cr: Courier;
let N: string;
let R: string;
let sh: { ulid: string };
let rWeb: { proc: ChildProcess; api: (route: string, body?: unknown) => Promise<{ status: number; body: any }> } | null = null;
const roles: Record<string, string> = {}; // name -> ulid, for the roles N makes

before(async () => {
  srv = await startTeamServer();
  core = await import('@collab-mcp/core');
  N = srv.a.device;
  R = srv.b.device;
  wr = openWriter(srv.b.path);
  cn = new Courier({ dbPath: srv.a.path, watch: false, retryMs: 60_000 });
  cr = new Courier({ dbPath: srv.b.path, watch: false, retryMs: 60_000 });
  core.setAllocationRetry({ delaysMs: [0, 0], timeoutMs: 1500 });
  // N creates SH as `collab project create --team` does: N is its only Owner.
  sh = await core.createTeamProject(srv.db, { name: 'Support hub', code: 'SH' });
  await cn.syncNow();
});

after(async () => {
  if (rWeb) {
    const exited = new Promise((r) => rWeb!.proc.once('exit', r));
    rWeb.proc.kill();
    await exited;
  }
  await cn.stop();
  await cr.stop();
  closeWriter(wr);
  core.setAllocationRetry(null);
  await srv.close();
});

const note = (title: string) => ({ type: 'decision' as const, title, summary: `${title} summary`, project: 'SH' });
const titleOf = (db: DB, ulid: string) => (db.prepare(`SELECT title FROM entries WHERE ulid = ?`).get(ulid) as { title: string } | undefined)?.title;
const idOf = (db: DB, ulid: string) => (db.prepare(`SELECT id FROM entries WHERE ulid = ?`).get(ulid) as { id: number | null } | undefined)?.id;
const want = (key: string) => `You need "${core.labelOf(key)}" (${key}) in SH to do this`;
/** R, straight to the office over HTTPS as R's device: no web server in the path. */
const asR = (method: string, route: string, body?: unknown) => core.requestJson(core.postOfficeTargetFromDb(wr), method, route, body);
const roleAtOffice = (device: string) =>
  (srv.office.store.prepare(`SELECT r.name FROM po_project_members x JOIN po_roles r ON r.ulid = x.role_ulid WHERE x.project_ulid = ? AND x.device_id = ?`)
    .get(sh.ulid, device) as { name: string } | undefined)?.name;
const shRoles = async () => (await srv.api(`/api/team/project?ulid=${sh.ulid}`)).body.roles as Array<{ ulid: string; name: string; keys: string[] }>;
const ACTIVE = () => new Set<string>(core.keysOf('project'));
const nNotes: string[] = [];

test('1. N makes R a Contributor of SH on the web; R\'s courier refreshes and R creates a note', async () => {
  for (const t of ['N original', 'N second']) nNotes.push((await core.addEntryAsync(srv.db, note(t))).ulid);
  await cn.pushNow();
  const r = await srv.api('/api/team/member/set', { scope: 'project', project: sh.ulid, device: R, role: 'Contributor' });
  assert.deepEqual([r.status, r.body], [200, { ok: true }]);
  await cr.syncNow();
  assert.equal(core.readAccessCache(wr).get(sh.ulid)?.role, 'Contributor');
  assert.deepEqual(nNotes.map((u) => titleOf(wr, u)), ['N original', 'N second'], 'R received the history');

  const allocs = () => srv.office.requests.filter((q: any) => q.route === 'POST /v1/allocate' && q.device === R).length;
  const before = allocs();
  const mine = (await core.addEntryAsync(wr, note('R first'))).ulid;
  assert.ok(allocs() > before, 'R\'s own device asked the office for the number');
  assert.notEqual(idOf(wr, mine), null, 'numbered');
  await cr.syncNow();
  await cn.syncNow();
  assert.equal(titleOf(srv.db, mine), 'R first', 'the office accepted it and N received it');
  assert.equal(core.listRefused(wr).length, 0);
});

test('2. N creates "Reviewer" = Reader + note.supersede and gives it to R', async () => {
  const reader = (await shRoles()).find((x) => x.name === 'Reader')!;
  const keys = [...reader.keys.filter((k) => ACTIVE().has(k)), 'note.supersede'];
  const made = await srv.api('/api/team/role/create', { scope: 'project', project: sh.ulid, name: 'Reviewer', keys });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  roles.Reviewer = made.body.role.ulid;
  const set = await srv.api('/api/team/member/set', { scope: 'project', project: sh.ulid, device: R, role: 'Reviewer' });
  assert.deepEqual([set.status, set.body], [200, { ok: true }]);
  await cr.syncNow();
  const mine = core.readAccessCache(wr).get(sh.ulid);
  assert.equal(mine?.role, 'Reviewer');
  assert.deepEqual([...mine.keys].sort(), [...keys].sort());
  const members = (await srv.api(`/api/team/project?ulid=${sh.ulid}`)).body.members;
  assert.equal(members.find((m: any) => m.device_id === R).role, 'Reviewer');
});

test('3. R, straight to the office, tries to change N\'s role -> 403 naming role.manage', async () => {
  const seen = srv.office.requests.length;
  const r = await asR('PUT', `/v1/projects/${sh.ulid}/members/${N}`, { role: 'Reader' });
  assert.deepEqual([r.status, r.body.error], [403, want('role.manage')]);
  const sent = srv.office.requests.slice(seen);
  assert.ok(sent.length >= 1 && sent.every((q: any) => q.device === R), 'only R talked to the office: the web server was not in the path');
  assert.equal(roleAtOffice(N), 'Owner');
});

test('4. R holds "Lead" (manages roles and members, no project.edit) and tries to remove N, an Owner -> 403 naming project.edit', async () => {
  // Every active project key but project.edit: Owner's first key Lead lacks is then project.edit.
  // (With only role.manage + member.revoke the first missing key would be note.view.)
  const keys = [...ACTIVE()].filter((k) => k !== 'project.edit');
  assert.ok(keys.includes('role.manage') && keys.includes('member.revoke'));
  const made = await srv.api('/api/team/role/create', { scope: 'project', project: sh.ulid, name: 'Lead', keys });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  roles.Lead = made.body.role.ulid;
  assert.equal((await srv.api('/api/team/member/set', { scope: 'project', project: sh.ulid, device: R, role: 'Lead' })).status, 200);
  const seen = srv.office.requests.length;
  const rm = await asR('DELETE', `/v1/projects/${sh.ulid}/members/${N}`);
  assert.deepEqual([rm.status, rm.body.error], [403, want('project.edit')], 'S3-1: R is ranked below N');
  const demote = await asR('PUT', `/v1/projects/${sh.ulid}/members/${N}`, { role: 'Reader' });
  assert.deepEqual([demote.status, demote.body.error], [403, want('project.edit')]);
  // S3-14: R can't give a key it lacks to its own role either.
  const raise = await asR('PUT', `/v1/projects/${sh.ulid}/roles/${roles.Lead}`, { keys: [...keys, 'project.edit'] });
  assert.deepEqual([raise.status, raise.body.error], [403, want('project.edit')]);
  assert.ok(srv.office.requests.slice(seen).every((q: any) => q.device === R));
  assert.equal(roleAtOffice(N), 'Owner', 'N is still Owner');
  assert.equal(roleAtOffice(R), 'Lead');
});

test('5. Owner can\'t be renamed, re-keyed or deleted (409); the only Owner can\'t be demoted (409)', async () => {
  const owner = (await shRoles()).find((x) => x.name === 'Owner')!;
  const rename = await srv.api('/api/team/role/update', { scope: 'project', project: sh.ulid, role: owner.ulid, name: 'Boss' });
  assert.deepEqual([rename.status, rename.body], [409, { error: "The Owner role can't be renamed or changed." }]);
  const rekey = await srv.api('/api/team/role/update', { scope: 'project', project: sh.ulid, role: owner.ulid, keys: ['note.view'] });
  assert.deepEqual([rekey.status, rekey.body], [409, { error: "The Owner role can't be renamed or changed." }]);
  const del = await srv.api('/api/team/role/delete', { scope: 'project', project: sh.ulid, role: owner.ulid });
  assert.deepEqual([del.status, del.body], [409, { error: "Owner is a built-in role and can't be deleted." }]);
  const demote = await srv.api('/api/team/member/set', { scope: 'project', project: sh.ulid, device: N, role: 'Reader' });
  assert.deepEqual([demote.status, demote.body], [409, { error: 'SH needs at least one Owner; make someone else Owner first' }]);
  const after = (await shRoles()).find((x) => x.ulid === owner.ulid)!;
  assert.equal(after.name, 'Owner');
  assert.deepEqual([...after.keys].sort(), [...owner.keys].sort());
  assert.equal(roleAtOffice(N), 'Owner');
});

test('6. N takes note.view from the role R holds, then gives it back: R is owed a replay and receives what it missed', async () => {
  assert.equal((await srv.api('/api/team/member/set', { scope: 'project', project: sh.ulid, device: R, role: 'Reviewer' })).status, 200);
  await cr.syncNow();
  const replay = () => srv.office.store.prepare(`SELECT upto_seq FROM po_replays WHERE device_id = ? AND project_ulid = ?`).get(R, sh.ulid);
  const reviewer = (await shRoles()).find((x) => x.ulid === roles.Reviewer)!;
  const full = reviewer.keys.filter((k) => ACTIVE().has(k));
  assert.ok(full.includes('note.view'));

  const off = await srv.api('/api/team/role/update', { scope: 'project', project: sh.ulid, role: roles.Reviewer, keys: full.filter((k) => k !== 'note.view') });
  assert.deepEqual([off.status, off.body], [200, { ok: true }]);
  assert.equal(replay(), undefined, 'no replay owed while R cannot view');
  await cr.syncNow();
  assert.equal(core.readAccessCache(wr).get(sh.ulid)?.role, 'Reviewer', 'still a member');
  assert.ok(core.findProject(wr, 'SH').left_at, 'read-only on R\'s laptop');
  await assert.rejects(core.addEntryAsync(wr, note('R writes blind')), /SH \(Support hub\) is a team you left/,
    'the wording is the removed-member one, though R is still a member (open item)');

  const missed = (await core.addEntryAsync(srv.db, note('while R cannot view'))).ulid;
  await cn.pushNow();
  await cr.syncNow();
  assert.equal(titleOf(wr, missed), undefined, 'nothing arrives while R cannot view');

  const on = await srv.api('/api/team/role/update', { scope: 'project', project: sh.ulid, role: roles.Reviewer, keys: full });
  assert.deepEqual([on.status, on.body], [200, { ok: true }]);
  assert.ok(replay(), 'a po_replays row for R in SH (R14)');
  const access = await asR('GET', '/v1/access');
  assert.ok(access.body.replays.some((x: any) => x.project_ulid === sh.ulid), 'R\'s access payload lists the replay');
  await cr.syncNow();
  assert.equal(titleOf(wr, missed), 'while R cannot view', 'R\'s courier received the history');
  assert.equal(core.findProject(wr, 'SH').left_at, null, 'writable again');
});

/** R's own web server: the built server in a child process, bound to R's notebook. */
async function startRWeb() {
  const keyFile = path.join(srv.root, 'web-key-r');
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'dist', 'server.js')], {
    env: { ...process.env, COLLAB_DB_PATH: srv.b.path, PORT: '0', COLLAB_WEB_KEY_FILE: keyFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  proc.stderr!.on('data', (d) => { err += d; });
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`R's web server did not start: ${err}`)), 15_000);
    proc.stdout!.on('data', (d) => {
      out += d;
      const m = /Internal tools server:\s+http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    proc.once('exit', (code) => { clearTimeout(t); reject(new Error(`R's web server exited ${code}: ${err}`)); });
  });
  const { readFileSync } = await import('node:fs');
  const key = readFileSync(keyFile, 'utf8').trim();
  const base = `http://127.0.0.1:${port}`;
  const api = async (route: string, body?: unknown) => {
    const res = await fetch(base + route, body === undefined
      ? { headers: { 'x-collab-key': key } }
      : { method: 'POST', headers: { 'x-collab-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { proc, api };
}

test('7. R\'s refused edits: R\'s web server lists them; copy to R\'s solo project keeps R\'s text; delete removes another', async () => {
  // The S2 way: R (Reviewer: no note.edit.any) edits N's notes on R's laptop; R's courier sends them and the office refuses.
  wr.prepare(`UPDATE entries SET title = ? WHERE ulid = ?`).run('R typed one', nNotes[0]);
  wr.prepare(`UPDATE entries SET title = ? WHERE ulid = ?`).run('R typed two', nNotes[1]);
  await cr.pushNow();
  const typedIn = (r: any) => r.cells.find((c: any) => c.table === 'entries' && c.cid === 'title')?.val;
  const refused = core.listRefused(wr);
  const one = refused.find((r: any) => typedIn(r) === 'R typed one');
  const two = refused.find((r: any) => typedIn(r) === 'R typed two');
  assert.ok(one && two, JSON.stringify(refused.map((r: any) => [r.kind, r.key, r.reason])));
  assert.equal(one.key, 'note.edit.any');
  await cr.pullNow();
  assert.deepEqual(nNotes.map((u) => titleOf(wr, u)), ['N original', 'N second'], 'R is reverted to the office\'s text');
  core.createProject(wr, { name: 'Mine', code: 'MY' });

  rWeb = await startRWeb();
  const me = await rWeb.api('/api/team/overview');
  assert.equal(me.body.me?.device_id, R, 'the child web server opened R\'s notebook');
  const list = await rWeb.api('/api/refused');
  assert.equal(list.status, 200);
  const row = list.body.results.find((x: any) => x.id === one.ulid);
  assert.ok(row && list.body.results.some((x: any) => x.id === two.ulid), JSON.stringify(list.body));
  assert.deepEqual([row.project_code, row.kind, row.key, row.reason], ['SH', 'edit', 'note.edit.any', one.reason]);
  assert.match(row.reason, /note\.edit\.any/);
  assert.deepEqual(list.body.solo_projects, [{ code: 'MY', name: 'Mine' }], 'only R\'s solo project is a copy target');

  const copy = await rWeb.api('/api/refused/copy', { id: one.ulid, to: 'MY' });
  assert.equal(copy.status, 200, JSON.stringify(copy.body));
  assert.match(copy.body.ref, /^MY-\d+$/);
  const copied = wr.prepare(`SELECT title FROM entries WHERE series = 'MY' AND id = ?`).get(Number(copy.body.ref.slice(3))) as { title: string };
  assert.equal(copied.title, 'R typed one', 'the new note holds R\'s text');
  const del = await rWeb.api('/api/refused/delete', { id: two.ulid });
  assert.deepEqual([del.status, del.body], [200, { ok: true }]);
  const left = (await rWeb.api('/api/refused')).body.results.map((x: any) => x.id);
  assert.ok(!left.includes(one.ulid) && !left.includes(two.ulid));
  assert.equal(titleOf(wr, nNotes[1]), 'N second', 'deleting an edit refusal leaves the note as the office has it');
});
