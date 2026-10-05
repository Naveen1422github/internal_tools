// file: courier/test/address.test.ts
// Collab E-767: a laptop-hosted post office changes address whenever its host
// changes network. (1) A running courier must follow a corrected address
// without a restart. (2) `collab sync set-address` changes it safely: only to
// the post office whose certificate this laptop already trusts.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getSyncValue, setSyncValue, SYNC_KEYS } from '@collab-mcp/core';
import { tempDir, startOffice, joinedDb, openWriter, closeWriter, until } from './world.js';
import { Courier } from '../src/engine.js';
import { runCli } from '../src/cli.js';

const DEAD = 'https://127.0.0.1:1';
const io = () => {
  const out: string[] = [], err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err, text: () => [...out, ...err].join('\n') };
};

test('a running courier follows a corrected post office address without a restart', async () => {
  const t = tempDir();
  const office = await startOffice(t.dir, 0);
  const ja = await joinedDb(office, t.dir, 'a');
  const w = openWriter(ja.path);
  setSyncValue(w, SYNC_KEYS.url, DEAD); // the host laptop changed network
  const c = new Courier({ dbPath: ja.path, retryMs: 300, maxReconnectMs: 200 });
  try {
    c.start();
    await until(() => c.status.state === 'offline', 5000, 'offline at the old address');
    setSyncValue(w, SYNC_KEYS.url, office.url); // corrected while the courier runs
    await until(() => c.status.state === 'connected', 5000, 'connected at the new address, same courier');
  } finally { await c.stop(); closeWriter(w); await office.close(); t.cleanup(); }
});

async function configured() {
  const t = tempDir();
  const office = await startOffice(t.dir, 0);
  const ja = await joinedDb(office, t.dir, 'a');
  const w = openWriter(ja.path);
  setSyncValue(w, SYNC_KEYS.url, DEAD);
  closeWriter(w);
  const courierDir = join(t.dir, 'courier');
  mkdirSync(courierDir, { recursive: true });
  writeFileSync(join(courierDir, 'config.json'), JSON.stringify({ dbPath: ja.path, postOffice: DEAD, device: ja.device, autostart: false, backup: null }));
  const url = () => { const d = openWriter(ja.path); try { return getSyncValue(d, SYNC_KEYS.url); } finally { closeWriter(d); } };
  const shown = () => JSON.parse(readFileSync(join(courierDir, 'config.json'), 'utf8')).postOffice;
  return { t, office, courierDir, url, shown, done: async () => { await office.close(); t.cleanup(); } };
}

test('set-address switches to the trusted post office at its new address', async () => {
  const s = await configured();
  try {
    const c = io();
    const r = await runCli(['sync', 'set-address', s.office.url], c.io, { courierDir: s.courierDir });
    assert.equal(r.code, 0, c.text());
    assert.equal(s.url(), s.office.url);
    assert.equal(s.shown(), s.office.url);
    assert.match(c.text(), /certificate/);
  } finally { await s.done(); }
});

test('set-address refuses a different post office (wrong certificate) and changes nothing', async () => {
  const s = await configured();
  const other = await startOffice(tempDir().dir, 0);
  try {
    const c = io();
    const r = await runCli(['sync', 'set-address', other.url], c.io, { courierDir: s.courierDir });
    assert.notEqual(r.code, 0);
    assert.match(c.text(), /not your post office|certificate/i);
    assert.equal(s.url(), DEAD);
    assert.equal(s.shown(), DEAD);
  } finally { await other.close(); await s.done(); }
});

test('set-address refuses an address nobody answers at, and changes nothing', async () => {
  const s = await configured();
  try {
    const c = io();
    const r = await runCli(['sync', 'set-address', 'https://127.0.0.1:2'], c.io, { courierDir: s.courierDir });
    assert.notEqual(r.code, 0);
    assert.match(c.text(), /could not reach|can't reach/i);
    assert.equal(s.url(), DEAD);
  } finally { await s.done(); }
});

test('set-address refuses something that is not an https address', async () => {
  const s = await configured();
  try {
    const c = io();
    const r = await runCli(['sync', 'set-address', '192.168.1.40:7443'], c.io, { courierDir: s.courierDir });
    assert.notEqual(r.code, 0);
    assert.match(c.text(), /https:\/\//);
    assert.equal(s.url(), DEAD);
  } finally { await s.done(); }
});
