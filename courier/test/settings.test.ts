// file: courier/test/settings.test.ts
// UI parity Task 11: `collab sync set-address` and `collab sync autostart` as
// functions, shared by the CLI and the web's Settings page.
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { getSyncValue, SYNC_KEYS, type AutostartContext } from '@collab-mcp/core';
import { tempDir, startOffice, joinedDb } from './world.js';
import { setPostOfficeAddress, setAutostart } from '../src/settings.js';
import { readCourierConfig, writeCourierConfig } from '../src/setup.js';
import type { Command } from '../src/autostart.js';

test('setPostOfficeAddress: a bad address, another certificate and no answer change nothing; the right one updates the DB and the config', async () => {
  const t = tempDir('collab-settings-');
  mkdirSync(`${t.dir}/other`, { recursive: true });
  const office = await startOffice(t.dir, 0);
  const other = await startOffice(`${t.dir}/other`, 0).catch(async (e) => { await office.close(); throw e; });
  try {
    const a = await joinedDb(office, t.dir, 'a');
    const dir = `${t.dir}/courier`;
    writeCourierConfig(dir, { dbPath: a.path, postOffice: 'https://old.example:7443', device: a.device, autostart: false, backup: null });
    const urlOf = () => { const db = new Database(a.path); try { return getSyncValue(db, SYNC_KEYS.url); } finally { db.close(); } };
    const before = urlOf();
    assert.deepEqual(await setPostOfficeAddress(dir, 'http://x'), { ok: false, kind: 'usage', reason: 'the address must look like https://host:port, e.g. https://192.168.1.40:7443' });
    const wrong = await setPostOfficeAddress(dir, other.url);
    assert.deepEqual([wrong.ok, (wrong as any).kind], [false, 'refused']);
    assert.match((wrong as any).reason, /answers with a different certificate, so it is not your post office\. Nothing changed\./);
    assert.equal(urlOf(), before);
    assert.equal(readCourierConfig(dir)!.postOffice, 'https://old.example:7443');
    const ok = await setPostOfficeAddress(dir, `${office.url}/`);
    assert.deepEqual(ok, { ok: true, url: office.url });
    assert.equal(urlOf(), office.url);
    assert.equal(readCourierConfig(dir)!.postOffice, office.url);
    // The web server passes its own open notebook: a courier serving another notebook keeps its config.
    writeCourierConfig(dir, { ...readCourierConfig(dir)!, dbPath: `${t.dir}/elsewhere.db`, postOffice: 'https://keep.example:1' });
    const db = new Database(a.path);
    try {
      assert.deepEqual(await setPostOfficeAddress(dir, office.url, { db, dbPath: a.path }), { ok: true, url: office.url });
    } finally { db.close(); }
    assert.equal(readCourierConfig(dir)!.postOffice, 'https://keep.example:1');
    assert.equal((await setPostOfficeAddress(`${t.dir}/none`, office.url) as any).kind, 'setup');
  } finally { await other.close(); await office.close(); t.cleanup(); }
});

test('setAutostart: installs or removes through the plan and records it; null when not set up', () => {
  const t = tempDir('collab-autostart-');
  try {
    const dir = `${t.dir}/courier`;
    const ctx: AutostartContext = { platform: 'linux', nodePath: '/usr/bin/node', binPath: '/it/courier/dist/bin.js', home: t.dir, env: {}, courierDir: dir, logPath: `${dir}/c.log`, systemctl: '/usr/bin/systemctl' } as any;
    const ran: Command[] = [];
    const deps = { run: (c: Command) => { ran.push(c); }, write: () => {}, remove: () => {} };
    assert.equal(setAutostart(dir, true, ctx, deps), null);
    writeCourierConfig(dir, { dbPath: '/x.db', postOffice: 'https://o:1', device: 'd', autostart: false, backup: null });
    const on = setAutostart(dir, true, ctx, deps)!;
    assert.equal(on[0], 'start at login: ON');
    assert.equal(readCourierConfig(dir)!.autostart, true);
    assert.ok(ran.some((c) => c.args.includes('enable')), JSON.stringify(ran));
    const off = setAutostart(dir, false, ctx, deps)!;
    assert.equal(off[0], 'start at login: OFF');
    assert.equal(readCourierConfig(dir)!.autostart, false);
  } finally { t.cleanup(); }
});
