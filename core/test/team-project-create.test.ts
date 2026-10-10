// file: core/test/team-project-create.test.ts
// Stage C, spec P9 / E-820: any member creates a team project or promotes a
// solo one. The office is asked FIRST; nothing is written locally unless it agreed.
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { stubServer } from './helpers/https-stub.js';
import { migrate } from '../src/db.js';
import { addEntry } from '../src/ops/add.js';
import { setSyncValue } from '../src/sync/state.js';
import { SYNC_KEYS } from '../src/sync/http-allocator.js';
import { createProject, createTeamProject, promoteProject, findProject, ProjectClashError } from '../src/projects.js';

/** A fake office that keeps a project list like post-office registerProject does. */
async function fakeOffice() {
  const projects = new Map<string, { ulid: string; name: string; code: string; seed: number }>();
  const posts: any[] = [];
  const s = await stubServer((req, res, body) => {
    if (req.method === 'POST' && req.url === '/v1/projects') {
      const b = JSON.parse(body);
      posts.push(b);
      const same = [...projects.values()].find((p) => p.ulid === b.ulid);
      if (same) { res.end(JSON.stringify({ project: same })); return; }
      const byCode = projects.get(b.code);
      if (byCode) { res.writeHead(409); res.end(JSON.stringify({ error: `this team already has a project with code ${b.code} ("${byCode.name}")` })); return; }
      projects.set(b.code, b);
      res.end(JSON.stringify({ project: { ...b, created_at: 'now' } }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  return { ...s, projects, posts };
}

function shared(url: string, fingerprint: string) {
  const t = freshDb({ shared: true });
  migrate(t.db);
  setSyncValue(t.db, SYNC_KEYS.url, url);
  setSyncValue(t.db, SYNC_KEYS.fingerprint, fingerprint);
  setSyncValue(t.db, SYNC_KEYS.device, 'd-test');
  setSyncValue(t.db, SYNC_KEYS.key, 'k-test');
  return t;
}

test('create: registered at the office, then a local team row bound to its fingerprint', async () => {
  const o = await fakeOffice();
  const t = shared(o.url, o.fingerprint);
  try {
    const p = await createTeamProject(t.db, { name: 'Support hub', code: 'sh' });
    assert.deepEqual([p.code, p.mode, p.team], ['SH', 'team', o.fingerprint]);
    assert.equal(o.projects.get('SH')?.ulid, p.ulid);
    assert.equal(o.posts[0].seed, 0);
  } finally { await o.close(); t.cleanup(); }
});

test('create: a code the office already has is a clash; nothing local', async () => {
  const o = await fakeOffice();
  const t = shared(o.url, o.fingerprint);
  try {
    o.projects.set('SH', { ulid: '01J000000000000000000000AA', name: 'Theirs', code: 'SH', seed: 0 });
    await assert.rejects(createTeamProject(t.db, { name: 'Mine', code: 'SH' }), (e: Error) => e instanceof ProjectClashError && /SH/.test(e.message));
    assert.equal(findProject(t.db, 'SH'), null);
  } finally { await o.close(); t.cleanup(); }
});

test('create: a code a LOCAL project has is a clash before any network call', async () => {
  const o = await fakeOffice();
  const t = shared(o.url, o.fingerprint);
  try {
    createProject(t.db, { name: 'mine', code: 'SH' });
    await assert.rejects(createTeamProject(t.db, { name: 'Support hub', code: 'SH' }), ProjectClashError);
    await assert.rejects(createTeamProject(t.db, { name: 'MINE', code: 'XY' }), ProjectClashError);
    assert.equal(o.seen.length, 0, 'the office was never asked');
  } finally { await o.close(); t.cleanup(); }
});

test('create on an unshared notebook: share it first', async () => {
  const t = freshDb();
  try {
    migrate(t.db);
    await assert.rejects(createTeamProject(t.db, { name: 'Support hub', code: 'SH' }), /share this notebook first \(`collab sync setup <join code>`\)/);
    assert.equal(findProject(t.db, 'SH'), null);
  } finally { t.cleanup(); }
});

test('create while the office is down: an error naming it; nothing local', async () => {
  const o = await fakeOffice();
  const t = shared(o.url, o.fingerprint);
  try {
    await o.close();
    await assert.rejects(createTeamProject(t.db, { name: 'Support hub', code: 'SH' }), (e: Error) =>
      e.message.includes(o.url) && /creating a team project needs the post office; nothing was created/.test(e.message));
    assert.equal(findProject(t.db, 'SH'), null);
  } finally { t.cleanup(); }
});

test('promote: the office continues after the highest number ever used (a hard-deleted one included); idempotent', async () => {
  const o = await fakeOffice();
  const t = shared(o.url, o.fingerprint);
  try {
    const nv = createProject(t.db, { name: 'Navi', code: 'NV' });
    for (let i = 0; i < 4; i++) addEntry(t.db, { type: 'decision', title: `nv ${i + 1}`, summary: 's', project: 'NV' });
    t.db.prepare(`DELETE FROM entries WHERE series = 'NV' AND id = 4`).run();
    assert.equal((t.db.prepare(`SELECT MAX(id) m FROM entries WHERE series = 'NV'`).get() as any).m, 3);
    const p = await promoteProject(t.db, 'nv');
    assert.deepEqual([p.ulid, p.mode, p.team], [nv.ulid, 'team', o.fingerprint]);
    assert.equal(o.posts[0].seed, 4, 'the counter, so NV-4 is never handed out again');
    assert.equal(o.posts[0].ulid, nv.ulid);
    const again = await promoteProject(t.db, 'NV');
    assert.equal(again.mode, 'team');
    assert.equal(o.projects.size, 1);
  } finally { await o.close(); t.cleanup(); }
});

test('promote while the office is down: an error; still solo', async () => {
  const o = await fakeOffice();
  const t = shared(o.url, o.fingerprint);
  try {
    createProject(t.db, { name: 'Navi', code: 'NV' });
    await o.close();
    await assert.rejects(promoteProject(t.db, 'NV'), (e: Error) => e.message.includes(o.url));
    assert.equal(findProject(t.db, 'NV')!.mode, 'solo');
  } finally { t.cleanup(); }
});

test('createProject still refuses team mode, pointing at the team commands', () => {
  const t = freshDb();
  try {
    migrate(t.db);
    assert.throws(() => createProject(t.db, { name: 'x', code: 'XX', mode: 'team' } as any), /--team|createTeamProject/);
  } finally { t.cleanup(); }
});
