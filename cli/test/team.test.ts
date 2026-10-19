// file: cli/test/team.test.ts
// RnR S1 task 8: `collab team ...` talks to the post office's membership endpoints.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, newUlid, parseJoinCode } from '@collab-mcp/core';
import { setProjectMember } from '@collab-mcp/post-office';
import { main } from '../src/main.js';
import { startOffice, joinedDb, type Office } from '../../courier/test/world.js';

async function withOffice(fn: (w: { office: Office; a: { path: string; device: string }; b: { path: string; device: string }; as: (who: { path: string }, argv: string[]) => Promise<{ code: number; out: string[]; err: string[] }> }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'collab-cli-team-'));
  const saved = { data: process.env.COLLAB_DATA_DIR, db: process.env.COLLAB_DB_PATH, nb: process.env.COLLAB_NOTEBOOK, cpd: process.env.CLAUDE_PROJECT_DIR, cwd: process.cwd() };
  process.env.COLLAB_DATA_DIR = join(root, 'data');
  for (const k of ['COLLAB_NOTEBOOK', 'CLAUDE_PROJECT_DIR']) delete process.env[k];
  process.chdir(root);
  const office = await startOffice(root, 0);
  try {
    const a = await joinedDb(office, root, 'a'); // first member: Office admin
    const b = await joinedDb(office, root, 'b'); // Office member
    const as = async (who: { path: string }, argv: string[]) => {
      process.env.COLLAB_DB_PATH = who.path;
      const out: string[] = []; const err: string[] = [];
      const r = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
      closeDb();
      return { code: r.code, out, err };
    };
    await fn({ office, a, b, as });
  } finally {
    closeDb();
    await office.close();
    process.chdir(saved.cwd);
    for (const [k, v] of [['COLLAB_DATA_DIR', saved.data], ['COLLAB_DB_PATH', saved.db], ['COLLAB_NOTEBOOK', saved.nb], ['CLAUDE_PROJECT_DIR', saved.cpd]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('team list shows the members with their roles, and the project roles', async () => {
  await withOffice(async ({ a, as }) => {
    assert.equal((await as(a, ['project', 'create', 'Team One', '--code', 'TM', '--team'])).code, 0);
    const r = await as(a, ['team', 'list', 'TM']);
    assert.equal(r.code, 0, r.err.join('\n'));
    const text = r.out.join('\n');
    assert.match(text, /TM \(Team One\)/);
    assert.match(text, /a\b.*Owner/);
    assert.match(text, /Roles in TM:/);
    assert.match(text, /Reader/);
  });
});

test('team set / remove resolve a member by name, and change their role', async () => {
  await withOffice(async ({ a, as }) => {
    await as(a, ['project', 'create', 'Team One', '--code', 'TM', '--team']);
    const set = await as(a, ['team', 'set', 'b', 'TM', 'Reader']);
    assert.equal(set.code, 0, set.err.join('\n'));
    assert.match((await as(a, ['team', 'list', 'TM'])).out.join('\n'), /b\b.*Reader/);
    const rm = await as(a, ['team', 'remove', 'b', 'TM']);
    assert.equal(rm.code, 0, rm.err.join('\n'));
    assert.doesNotMatch((await as(a, ['team', 'list', 'TM'])).out.join('\n'), /\bb\b.*Reader/);
    const nobody = await as(a, ['team', 'set', 'zed', 'TM', 'Reader']);
    assert.equal(nobody.code, 1);
    assert.match(nobody.err.join('\n'), /no member called zed/);
  });
});

test('a refusal is shown as its plain message with exit code 1', async () => {
  await withOffice(async ({ a, b, as }) => {
    const r = await as(b, ['team', 'office-role', a.device, 'Office member']);
    assert.equal(r.code, 1);
    assert.match(r.err.join('\n'), /You need ".+" \(office\.role\.manage\) in this office/);
  });
});

test('collab team set by a lower-ranked member prints the office refusal (cli)', async () => {
  await withOffice(async ({ office, a, b, as }) => {
    // b registers TM (so b's notebook knows it); the office machine then makes a and c Owners, b a Lead without project.edit
    assert.equal((await as(b, ['project', 'create', 'Team One', '--code', 'TM', '--team'])).code, 0);
    const p = (office.store.prepare(`SELECT ulid FROM po_projects WHERE code = 'TM'`).get() as { ulid: string }).ulid;
    const lead = ['note.view', 'note.create', 'note.edit.own', 'note.edit.any', 'note.supersede', 'note.archive', 'note.copy.out',
      'merge.resolve', 'member.invite', 'member.revoke', 'role.manage'];
    office.store.prepare(`INSERT INTO po_roles (ulid, project_ulid, name, keys, is_starter) VALUES (?, ?, 'Lead', ?, 0)`).run(newUlid(), p, JSON.stringify(lead));
    const c = office.code('c').device;
    setProjectMember(office.store, null, p, a.device, 'Owner');
    setProjectMember(office.store, null, p, c, 'Owner');
    setProjectMember(office.store, null, p, b.device, 'Lead');
    for (const argv of [['team', 'set', a.device, 'TM', 'Reader'], ['team', 'remove', a.device, 'TM']]) {
      const r = await as(b, argv);
      assert.equal(r.code, 1, argv.join(' '));
      assert.match(r.err.join('\n'), /You need "Edit project" \(project\.edit\) in TM to do this/);
    }
    assert.match((await as(b, ['team', 'list', 'TM'])).out.join('\n'), /\ba\b.*Owner/, 'a is still Owner');
  });
});

test('office-role, invite and revoke work for the Office admin', async () => {
  await withOffice(async ({ office, a, b, as }) => {
    assert.equal((await as(a, ['team', 'office-role', 'b', 'Office admin'])).code, 0);
    const inv = await as(a, ['team', 'invite', 'third laptop']);
    assert.equal(inv.code, 0, inv.err.join('\n'));
    const code = inv.out.find((l) => l.startsWith('collab1-'))!;
    const jc = parseJoinCode(code);
    assert.equal(jc.url, office.url);
    assert.equal(jc.fingerprint, office.fingerprint);
    const rv = await as(a, ['team', 'revoke', jc.device]);
    assert.equal(rv.code, 0, rv.err.join('\n'));
    assert.match(rv.out.join('\n'), /revoked/i);
    void b;
  });
});

test('a solo project has no team or roles', async () => {
  await withOffice(async ({ a, as }) => {
    await as(a, ['project', 'create', 'Mine', '--code', 'SO']);
    const r = await as(a, ['team', 'list', 'SO']);
    assert.equal(r.code, 1);
    assert.equal(r.err.join('\n'), 'collab: SO is a solo project: it has no team or roles');
    const u = await as(a, ['team', 'list', 'NOPE']);
    assert.equal(u.code, 1);
    assert.match(u.err.join('\n'), /NOPE/);
  });
});
