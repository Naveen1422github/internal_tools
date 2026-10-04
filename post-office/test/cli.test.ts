// file: post-office/test/cli.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateTo, addEntry, parseJoinCode, requestJson, AccessRevokedError } from '@collab-mcp/core';
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
