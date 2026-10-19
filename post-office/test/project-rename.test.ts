// file: post-office/test/project-rename.test.ts
// UI parity D1: a team project's name lives at the office. Renaming it is
// `PUT /v1/projects/:p {name}`, checked here (project.edit), never only on a laptop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestJson, newUlid } from '@collab-mcp/core';
import { office } from './office.js';
import { setProjectMember } from '../src/access.js';

type O = Awaited<ReturnType<typeof office>>;
const nameOf = (o: O, p: string) => (o.store.prepare(`SELECT name FROM po_projects WHERE ulid = ?`).get(p) as { name: string }).name;

async function team(o: O) {
  const n = await o.join('N');
  const r = await o.join('R');
  const x = await o.join('X');
  const p = { ulid: newUlid(), name: 'Support hub', code: 'SH' };
  assert.equal((await requestJson(o.target(n), 'POST', '/v1/projects', p)).status, 200);
  setProjectMember(o.store, null, p.ulid, r.device, 'Reader');
  return { n, r, x, p: p.ulid };
}

test('an Owner renames a team project; the name is trimmed and stored at the office', async () => {
  const o = await office();
  try {
    const { n, p } = await team(o);
    const r = await requestJson(o.target(n), 'PUT', `/v1/projects/${p}`, { name: '  Support desk ' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.project, { ulid: p, name: 'Support desk', code: 'SH', created_at: r.body.project.created_at });
    assert.equal(nameOf(o, p), 'Support desk');
    const list = await requestJson(o.target(n), 'GET', '/v1/projects');
    assert.equal(list.body.projects[0].name, 'Support desk');
  } finally { await o.stop(); }
});

test('a Reader is refused naming project.edit; nothing changes', async () => {
  const o = await office();
  try {
    const { r, p } = await team(o);
    const res = await requestJson(o.target(r), 'PUT', `/v1/projects/${p}`, { name: 'Mine now' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'You need "Edit project" (project.edit) in SH to do this');
    assert.equal(nameOf(o, p), 'Support hub');
  } finally { await o.stop(); }
});

test('a non-member gets the same 404 as for a project that does not exist (R7a)', async () => {
  const o = await office();
  try {
    const { x, p } = await team(o);
    const a = await requestJson(o.target(x), 'PUT', `/v1/projects/${p}`, { name: 'Peek' });
    const b = await requestJson(o.target(x), 'PUT', `/v1/projects/${newUlid()}`, { name: 'Peek' });
    assert.equal(a.status, 404);
    assert.equal(b.status, 404);
    assert.equal(a.body.error, b.body.error);
  } finally { await o.stop(); }
});

test('a name another project has is refused; a project you are not in is not named', async () => {
  const o = await office();
  try {
    const { n, x, p } = await team(o);
    const theirs = { ulid: newUlid(), name: 'Secret plans', code: 'SP' };
    assert.equal((await requestJson(o.target(x), 'POST', '/v1/projects', theirs)).status, 200);
    const mine = { ulid: newUlid(), name: 'Navi', code: 'NV' };
    assert.equal((await requestJson(o.target(n), 'POST', '/v1/projects', mine)).status, 200);
    const clashMine = await requestJson(o.target(n), 'PUT', `/v1/projects/${p}`, { name: 'navi' });
    assert.equal(clashMine.status, 409);
    assert.equal(clashMine.body.error, 'this team already has a project named "navi" (NV)');
    const clashTheirs = await requestJson(o.target(n), 'PUT', `/v1/projects/${p}`, { name: 'SECRET PLANS' });
    assert.equal(clashTheirs.status, 409);
    assert.equal(clashTheirs.body.error, 'that project name is taken');
    const same = await requestJson(o.target(n), 'PUT', `/v1/projects/${p}`, { name: 'support HUB' });
    assert.equal(same.status, 200, 'a change of case of its own name is fine');
    const empty = await requestJson(o.target(n), 'PUT', `/v1/projects/${p}`, { name: '  ' });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, 'a project needs a name');
  } finally { await o.stop(); }
});
