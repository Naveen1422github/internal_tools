// file: courier/test/cli.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrateTo, addEntry, isSyncEnabled, hasCrrTables, getSyncValue, SYNC_KEYS } from '@collab-mcp/core';
import { tempDir, startOffice, openWriter, closeWriter, until } from './world.js';
import { runCli } from '../src/cli.js';
import type { Command } from '../src/autostart.js';

function io() {
  const out: string[] = [], err: string[] = [];
  return { out, err, text: () => out.join('\n'), io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}
function recorder() {
  const ran: Command[] = [], wrote: string[] = [], removed: string[] = [];
  return { ran, wrote, removed, deps: { run: (c: Command) => { ran.push(c); }, write: (p: string) => { wrote.push(p); }, remove: (p: string) => { removed.push(p); } } };
}
async function env() {
  const t = tempDir();
  const office = await startOffice(t.dir, 0);
  const courierDir = join(t.dir, 'courier');
  const rec = recorder();
  const deps = (ask = '') => ({
    courierDir, ask: async () => ask, autostartDeps: rec.deps,
    autostartCtx: { platform: 'linux' as NodeJS.Platform, home: t.dir, env: {}, systemctl: '/usr/bin/systemctl' },
  });
  return { t, office, courierDir, rec, deps, db: join(t.dir, 'b', 'collab.db'), done: async () => { await office.close(); t.cleanup(); } };
}
const shared = (path: string) => { const db = openWriter(path); try { return [isSyncEnabled(db), getSyncValue(db, SYNC_KEYS.key) !== null] as const; } finally { closeWriter(db); } };

test('setup joins, turns sharing on and says exactly what it did; the default answer is no', async () => {
  const e = await env();
  try {
    const c = io();
    const r = await runCli(['sync', 'setup', e.office.code('b').code, '--db', e.db, '--include-staged'], c.io, e.deps(''));
    assert.equal(r.code, 0, c.err.join('\n'));
    assert.match(c.text(), /start at login: no/);
    assert.match(c.text(), /collab sync uninstall/);
    assert.match(c.text(), /created a new, empty notes DB/);
    assert.match(c.text(), /Restart every program that writes this notes DB/);
    assert.deepEqual([e.rec.ran.length, e.rec.wrote.length], [0, 0], 'nothing registered');
    assert.deepEqual(shared(e.db), [true, true]);
    const s = io();
    await runCli(['sync', 'status'], s.io, e.deps());
    assert.match(s.text(), /not running/);
    assert.match(s.text(), /start at login: no/);
  } finally { await e.done(); }
});

test('setup asks; "y" registers the login entry and prints it', async () => {
  const e = await env();
  try {
    const c = io();
    assert.equal((await runCli(['sync', 'setup', e.office.code('b').code, '--db', e.db, '--include-staged'], c.io, e.deps('y'))).code, 0);
    assert.match(c.text(), /start at login: YES/);
    assert.match(c.text(), /collab-sync\.service/);
    assert.equal(e.rec.wrote.length, 1);
    assert.deepEqual(e.rec.ran.map((x) => x.args.join(' ')), ['--user daemon-reload', '--user enable collab-sync.service']);
  } finally { await e.done(); }
});

test('a DB with notes needs --upload-existing; a refused setup changes nothing and keeps the code usable', async () => {
  const e = await env();
  try {
    const main = join(e.t.dir, 'main.db');
    const db = new Database(main);
    migrateTo(db, '0006', { includeStaged: true });
    addEntry(db, { type: 'decision', title: 'old', summary: 's' });
    db.close();
    const { code } = e.office.code('main');
    const c = io();
    assert.equal((await runCli(['sync', 'setup', code, '--db', main, '--no-autostart', '--include-staged'], c.io, e.deps())).code, 1);
    assert.match(c.err.join('\n'), /--upload-existing/);
    assert.equal(existsSync(e.courierDir), false);
    const c2 = io();
    assert.equal((await runCli(['sync', 'setup', code, '--db', main, '--no-autostart', '--include-staged', '--upload-existing'], c2.io, e.deps())).code, 0, c2.err.join('\n'));
    assert.match(c2.text(), /backup first/);
  } finally { await e.done(); }
});

test('a used join code is refused and leaves no notes file behind', async () => {
  const e = await env();
  try {
    const { code } = e.office.code('b');
    assert.equal((await runCli(['sync', 'setup', code, '--db', e.db, '--no-autostart', '--include-staged'], io().io, e.deps())).code, 0);
    const other = join(e.t.dir, 'c', 'collab.db');
    const c = io();
    assert.equal((await runCli(['sync', 'setup', code, '--db', other, '--no-autostart', '--include-staged'], c.io, { ...e.deps(), courierDir: join(e.t.dir, 'courier2') })).code, 1);
    assert.match(c.err.join('\n'), /refused the join code/);
    assert.equal(existsSync(other), false);
  } finally { await e.done(); }
});

test('modules, share, status --team talk to the post office', async () => {
  const e = await env();
  try {
    await runCli(['sync', 'setup', e.office.code('b').code, '--db', e.db, '--no-autostart', '--include-staged'], io().io, e.deps());
    const c = io();
    assert.equal((await runCli(['sync', 'share', 'team'], c.io, e.deps())).code, 0);
    assert.match(c.text(), /team/);
    const m = io();
    await runCli(['sync', 'modules'], m.io, e.deps());
    assert.match(m.text(), /shared modules \(for the whole team\): team/);
    const s = io();
    await runCli(['sync', 'status', '--team'], s.io, e.deps());
    assert.match(s.text(), /team \(deliveries/);
    assert.match(s.text(), /\bb\b/);
  } finally { await e.done(); }
});

test('autostart on --dry-run shows the Windows commands and registers nothing', async () => {
  const e = await env();
  try {
    await runCli(['sync', 'setup', e.office.code('b').code, '--db', e.db, '--no-autostart', '--include-staged'], io().io, e.deps());
    const c = io();
    const winDeps = { ...e.deps(), autostartCtx: { platform: 'win32' as NodeJS.Platform, env: { SystemRoot: 'C:\\Windows', USERDOMAIN: 'PC', USERNAME: 'n' }, nodePath: 'C:\\node\\node.exe', binPath: 'C:\\it\\courier\\dist\\bin.js', courierDir: 'C:\\Users\\n\\AppData\\Local\\collab\\courier' } };
    assert.equal((await runCli(['sync', 'autostart', 'on', '--dry-run'], c.io, winDeps)).code, 0);
    assert.match(c.text(), /dry run: nothing is registered/);
    assert.match(c.text(), /run "C:\\Windows\\System32\\schtasks\.exe" \/Create \/TN CollabSync \/XML/);
    assert.deepEqual([e.rec.ran.length, e.rec.wrote.length], [0, 0]);
  } finally { await e.done(); }
});

test('uninstall --yes removes everything setup added; the notes stay', async () => {
  const e = await env();
  try {
    await runCli(['sync', 'setup', e.office.code('b').code, '--db', e.db, '--include-staged'], io().io, e.deps('y'));
    const w = openWriter(e.db);
    w.prepare(`INSERT INTO entries (ulid, id, title, summary) VALUES ('01J0000000000000000000000A', 7, 'kept', 's')`).run();
    closeWriter(w);
    const c = io();
    assert.equal((await runCli(['sync', 'uninstall', '--yes'], c.io, e.deps())).code, 0, c.err.join('\n'));
    assert.match(c.text(), /removed start-at-login/);
    assert.ok(e.rec.ran.some((x) => x.args.join(' ') === '--user disable collab-sync.service'));
    assert.equal(existsSync(e.courierDir), false);
    const db = new Database(e.db);
    try {
      assert.equal(hasCrrTables(db), false);
      assert.equal(getSyncValue(db, SYNC_KEYS.key), null);
      assert.equal((db.prepare(`SELECT title FROM entries WHERE id = 7`).get() as { title: string }).title, 'kept');
    } finally { db.close(); }
    const again = io();
    assert.equal((await runCli(['sync', 'uninstall', '--yes'], again.io, e.deps())).code, 1);
  } finally { await e.done(); }
});

test('start launches ONE background courier; stop ends it', async () => {
  const e = await env();
  const saved = process.env.COLLAB_COURIER_DIR;
  process.env.COLLAB_COURIER_DIR = e.courierDir; // the child finds the same folder
  try {
    await runCli(['sync', 'setup', e.office.code('b').code, '--db', e.db, '--no-autostart', '--include-staged'], io().io, e.deps());
    const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
    const deps = { ...e.deps(), launcher: { file: process.execPath, args: ['--import', 'tsx', bin] } };
    const c = io();
    assert.equal((await runCli(['sync', 'start'], c.io, deps)).code, 0, c.err.join('\n'));
    assert.match(c.text(), /running in the background \(pid \d+\)/);
    await until(() => e.office.po.listeners().length === 1, 10_000, 'the background courier to ring in');
    const again = io();
    await runCli(['sync', 'start'], again.io, deps);
    assert.match(again.text(), /already running/);
    const s = io();
    await runCli(['sync', 'status'], s.io, deps);
    assert.match(s.text(), /running \(pid \d+\)/);
    const stop = io();
    await runCli(['sync', 'stop'], stop.io, deps);
    assert.match(stop.text(), /stopped/);
    await until(() => e.office.po.listeners().length === 0, 5000, 'the doorbell to hang up');
  } finally {
    if (saved === undefined) delete process.env.COLLAB_COURIER_DIR; else process.env.COLLAB_COURIER_DIR = saved;
    await e.done();
  }
});

test('anything else prints the usage', async () => {
  const c = io();
  assert.equal((await runCli(['sync', 'frobnicate'], c.io, { courierDir: '/nonexistent' })).code, 2);
  assert.match(c.err.join('\n'), /collab sync setup/);
  assert.equal((await runCli(['other'], io().io)).code, 2);
});

test('sync run refuses to start when its notebook is missing, with the doctor sentence (spec P12)', async () => {
  const t = tempDir();
  const saved = process.env.COLLAB_DATA_DIR;
  process.env.COLLAB_DATA_DIR = join(t.dir, 'data');
  try {
    const courierDir = join(t.dir, 'courier');
    mkdirSync(courierDir, { recursive: true });
    writeFileSync(join(courierDir, 'config.json'), JSON.stringify({ dbPath: join(t.dir, 'gone.db'), postOffice: 'https://127.0.0.1:1', device: 'd', autostart: false, backup: null }));
    const c = io();
    const r = await runCli(['sync', 'run'], c.io, { courierDir });
    assert.equal(r.code, 2);
    assert.match(c.err.join('\n'), /can't start/);
    assert.match(c.err.join('\n'), /fix:/);
  } finally {
    if (saved === undefined) delete process.env.COLLAB_DATA_DIR; else process.env.COLLAB_DATA_DIR = saved;
    t.cleanup();
  }
});
