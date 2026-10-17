// file: post-office/test/cli.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateTo, addEntry, parseJoinCode, requestJson, AccessRevokedError, newUlid } from '@collab-mcp/core';
import { openStore, closeStore, registerProject } from '../src/store.js';
import { tempDir } from './helpers.js';
import { runCli } from '../src/cli.js';
import { defaultDataDir } from '../src/paths.js';

function io() {
  const out: string[] = [], err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

test('default data dirs per OS (never in the repo)', () => {
  assert.equal(defaultDataDir({ LOCALAPPDATA: 'C:\\Users\\n\\AppData\\Local' }, 'win32', 'C:\\Users\\n'), 'C:\\Users\\n\\AppData\\Local\\collab\\post-office');
  assert.equal(defaultDataDir({}, 'win32', 'C:\\Users\\n'), 'C:\\Users\\n\\AppData\\Local\\collab\\post-office');
  assert.equal(defaultDataDir({}, 'darwin', '/Users/n'), '/Users/n/Library/Application Support/collab/post-office');
  assert.equal(defaultDataDir({ XDG_DATA_HOME: '/x' }, 'linux', '/home/n'), '/x/collab/post-office');
  assert.equal(defaultDataDir({}, 'linux', '/home/n'), '/home/n/.local/share/collab/post-office');
});

test('init needs a seed, seeds from the main notes DB, refuses to run twice', async () => {
  const t = tempDir();
  try {
    const notes = join(t.dir, 'collab.db');
    const db = new Database(notes);
    migrateTo(db, '0006', { includeStaged: true });
    for (let i = 0; i < 37; i++) addEntry(db, { type: 'decision', title: `n${i}`, summary: 's' });
    db.close();
    const data = join(t.dir, 'office');
    const c0 = io();
    assert.equal((await runCli(['init', '--data', data], c0.io)).code, 1);
    assert.match(c0.err.join('\n'), /--seed-from/);
    const c1 = io();
    assert.equal((await runCli(['init', '--data', data, '--seed-from', notes, '--url', 'https://10.1.2.3:7443'], c1.io)).code, 0);
    for (const f of ['store.db', 'cert.pem', 'key.pem', 'config.json']) assert.ok(existsSync(join(data, f)), f);
    const cfg = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));
    assert.equal(cfg.url, 'https://10.1.2.3:7443');
    assert.match(c1.out.join('\n'), new RegExp(cfg.fingerprint));
    assert.match(c1.out.join('\n'), /E-00038/);
    assert.match(c1.out.join('\n'), /remove/i);
    const c2 = io();
    assert.equal((await runCli(['init', '--data', data, '--seed-max-id', '5'], c2.io)).code, 1);
  } finally { t.cleanup(); }
});

test('add-member prints a join code; status, revoke, share', async () => {
  const t = tempDir();
  try {
    const data = join(t.dir, 'office');
    await runCli(['init', '--data', data, '--seed-max-id', '0', '--url', 'https://10.0.0.9:7443'], io().io);
    // RnR: the first member is Office admin and cannot be revoked; revoke the second.
    assert.equal((await runCli(['add-member', 'main', '--data', data], io().io)).code, 0);
    const c = io();
    assert.equal((await runCli(['add-member', 'second laptop', '--data', data], c.io)).code, 0);
    const code = c.out.find((l) => l.startsWith('collab1-'))!;
    const jc = parseJoinCode(code);
    const cfg = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));
    assert.deepEqual([jc.url, jc.fingerprint], ['https://10.0.0.9:7443', cfg.fingerprint]);
    let s = io();
    await runCli(['status', '--data', data], s.io);
    assert.match(s.out.join('\n'), /second laptop\s+waiting to join/);
    // E-739 #3: the office only sees the RECEIVE side; say so instead of "up to date".
    assert.match(s.out.join('\n'), /what each device still has to receive/);
    assert.equal((await runCli(['share', 'sync', '--data', data], io().io)).code, 0);
    s = io();
    await runCli(['modules', '--data', data], s.io);
    assert.match(s.out.join('\n'), /sync/);
    assert.equal((await runCli(['revoke', 'second laptop', '--data', data], io().io)).code, 0);
    s = io();
    await runCli(['status', '--data', data], s.io);
    assert.match(s.out.join('\n'), /second laptop\s+revoked/);
    assert.equal((await runCli(['revoke', 'nobody', '--data', data], io().io)).code, 1);
  } finally { t.cleanup(); }
});

test('serve answers over HTTPS with the pinned certificate', async () => {
  const t = tempDir();
  try {
    const data = join(t.dir, 'office');
    await runCli(['init', '--data', data, '--seed-max-id', '0', '--port', '0'], io().io);
    const c = io();
    const r = await runCli(['serve', '--data', data, '--host', '127.0.0.1'], c.io);
    try {
      assert.equal(r.code, 0);
      const cfg = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));
      await assert.rejects(requestJson({ url: r.office!.url, fingerprint: cfg.fingerprint }, 'GET', '/v1/status'), AccessRevokedError);
    } finally { await r.office!.close(); }
  } finally { t.cleanup(); }
});

test('unknown command: usage, exit code 2', async () => {
  const c = io();
  assert.equal((await runCli(['frobnicate'], c.io)).code, 2);
  assert.match(c.err.join('\n'), /add-member/);
});

test('set-office-role (office machine, unguarded) changes who is Office admin', async () => {
  const t = tempDir();
  try {
    const data = join(t.dir, 'office');
    await runCli(['init', '--data', data, '--seed-max-id', '0', '--url', 'https://10.0.0.9:7443'], io().io);
    await runCli(['add-member', 'main', '--data', data], io().io); // seeded as Office admin
    await runCli(['add-member', 'second', '--data', data], io().io); // Office member
    const roleOf = (name: string) => {
      const db = new Database(join(data, 'store.db'), { readonly: true });
      try {
        return (db.prepare(`SELECT r.name n FROM po_members m JOIN po_office_members om ON om.device_id = m.device_id JOIN po_office_roles r ON r.ulid = om.role_ulid WHERE m.name = ?`).get(name) as { n: string }).n;
      } finally { db.close(); }
    };
    assert.equal(roleOf('main'), 'Office admin');
    // The only admin cannot be demoted, with a plain message.
    const bad = io();
    assert.equal((await runCli(['set-office-role', 'main', 'Office member', '--data', data], bad.io)).code, 1);
    assert.match(bad.err.join('\n'), /at least one Office admin/);
    const ok = io();
    assert.equal((await runCli(['set-office-role', 'second', 'Office admin', '--data', data], ok.io)).code, 0, ok.err.join('\n'));
    assert.equal(roleOf('second'), 'Office admin');
    assert.equal((await runCli(['set-office-role', 'main', 'Office member', '--data', data], io().io)).code, 0);
    assert.equal(roleOf('main'), 'Office member');
    const nobody = io();
    assert.equal((await runCli(['set-office-role', 'ghost', 'Office admin', '--data', data], nobody.io)).code, 1);
    assert.match(nobody.err.join('\n'), /no member called ghost/);
    const norole = io();
    assert.equal((await runCli(['set-office-role', 'main', 'Wizard', '--data', data], norole.io)).code, 1);
    assert.match(norole.err.join('\n'), /no role called "Wizard"/);
  } finally { t.cleanup(); }
});

test('set-project-role (office machine, unguarded) lets the only Owner of a project be revoked', async () => {
  const t = tempDir();
  try {
    const data = join(t.dir, 'office');
    await runCli(['init', '--data', data, '--seed-max-id', '0', '--url', 'https://10.0.0.9:7443'], io().io);
    await runCli(['add-member', 'main', '--data', data], io().io);
    await runCli(['add-member', 'second', '--data', data], io().io);
    const s = openStore(join(data, 'store.db'));
    let ulid: string;
    try {
      const main = (s.prepare(`SELECT device_id FROM po_members WHERE name = 'main'`).get() as { device_id: string }).device_id;
      ulid = registerProject(s, { ulid: newUlid(), name: 'Support hub', code: 'SH', seed: 0 }, main).ulid;
      s.prepare(`UPDATE po_office_members SET role_ulid = (SELECT ulid FROM po_office_roles WHERE name = 'Office admin')`).run();
    } finally { closeStore(s); }
    const roleIn = (name: string) => {
      const db = new Database(join(data, 'store.db'), { readonly: true });
      try {
        return (db.prepare(`SELECT r.name n FROM po_members m JOIN po_project_members x ON x.device_id = m.device_id JOIN po_roles r ON r.ulid = x.role_ulid WHERE m.name = ? AND x.project_ulid = ?`).get(name, ulid) as { n: string } | undefined)?.n;
      } finally { db.close(); }
    };
    // The only Owner: refused, and the message says how to fix it.
    const bad = io();
    assert.equal((await runCli(['revoke', 'main', '--data', data], bad.io)).code, 1);
    assert.match(bad.err.join('\n'), /only Owner of SH; make someone else Owner first/);
    assert.match(bad.err.join('\n'), /collab office set-project-role <new owner> SH Owner/);
    // second is not in SH at all: the office CLI may still give it Owner (no keys checked).
    const ok = io();
    assert.equal((await runCli(['set-project-role', 'second', 'sh', 'Owner', '--data', data], ok.io)).code, 0, ok.err.join('\n'));
    assert.match(ok.out.join('\n'), /second .* is now Owner in SH/);
    assert.equal(roleIn('second'), 'Owner');
    // A project still keeps one Owner, even from the office machine.
    const last = io();
    assert.equal((await runCli(['set-project-role', 'second', 'SH', 'Reader', '--data', data], last.io)).code, 0);
    assert.equal(roleIn('second'), 'Reader');
    assert.equal((await runCli(['set-project-role', 'main', 'SH', 'Reader', '--data', data], last.io)).code, 1);
    assert.match(last.err.join('\n'), /SH needs at least one Owner/);
    assert.equal((await runCli(['set-project-role', 'second', 'SH', 'Owner', '--data', data], io().io)).code, 0);
    const rev = io();
    assert.equal((await runCli(['revoke', 'main', '--data', data], rev.io)).code, 0, rev.err.join('\n'));
    assert.match(rev.out.join('\n'), /revoked main/);
    // Plain errors for the wrong member, project or role.
    const nobody = io();
    assert.equal((await runCli(['set-project-role', 'ghost', 'SH', 'Owner', '--data', data], nobody.io)).code, 1);
    assert.match(nobody.err.join('\n'), /no member called ghost/);
    const noproj = io();
    assert.equal((await runCli(['set-project-role', 'second', 'ZZ', 'Owner', '--data', data], noproj.io)).code, 1);
    assert.match(noproj.err.join('\n'), /no team project with code ZZ/);
    const norole = io();
    assert.equal((await runCli(['set-project-role', 'second', 'SH', 'Wizard', '--data', data], norole.io)).code, 1);
    assert.match(norole.err.join('\n'), /SH has no role called "Wizard"/);
    const usage = io();
    assert.equal((await runCli(['set-project-role', 'second', '--data', data], usage.io)).code, 1);
    assert.match(usage.err.join('\n'), /set-project-role needs a member, a project code and a role/);
  } finally { t.cleanup(); }
});
