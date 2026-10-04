import { test } from 'node:test';
import assert from 'node:assert';
import { createSocket, type Socket } from 'node:dgram';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { freshDb } from './helpers/sync.js';
import { insertEntryRow } from '../src/entry-write.js';
import { updateEntry } from '../src/ops/update.js';
import { setSyncValue } from '../src/sync/state.js';
import { loadCrsqlite } from '../src/sync/extension.js';
import { COURIER_PORT_KEY, installSyncPing, readCourierPort } from '../src/sync/ping.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function listener(): Promise<{ sock: Socket; port: number; hits: () => number; close: () => void }> {
  const sock = createSocket('udp4');
  let n = 0;
  sock.on('message', () => { n += 1; });
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  return { sock, port: sock.address().port, hits: () => n, close: () => sock.close() };
}
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await sleep(10); }
}
let seq = 0;
const row = (title: string) => {
  seq += 1;
  return { type: 'decision', kind: 'signal', title, summary: 's', description: 'd', status: 'active', agent: 'Claude',
    module: null, task_id: null, tokens_estimate: 1, assigned: { ulid: `01JPING0000000000000000${String(seq).padStart(3, '0')}`, id: 1000 + seq } };
};

test('sharing off: installs nothing, returns false', () => {
  const t = freshDb({ shared: false });
  try {
    assert.strictEqual(installSyncPing(t.db), false);
    const n = (t.db.prepare(`SELECT count(*) c FROM sqlite_temp_master WHERE type='trigger'`).get() as any).c;
    assert.strictEqual(n, 0);
  } finally { t.cleanup(); }
});

test('core insert, core edit, raw UPDATE and raw module INSERT each ping once, after the save', async () => {
  const t = freshDb({ shared: true });
  const l = await listener();
  try {
    setSyncValue(t.db, COURIER_PORT_KEY, String(l.port));
    assert.strictEqual(installSyncPing(t.db), true);
    assert.strictEqual(installSyncPing(t.db), true, 'second call is a no-op');
    const { id } = insertEntryRow(t.db, row('a'));
    await until(() => l.hits() === 1);
    updateEntry(t.db, { id, title: 'b' }); // entries UPDATE x2 + revision INSERTs: ONE ping per burst
    await until(() => l.hits() === 2);
    t.db.exec(`UPDATE entries SET summary = 'raw' WHERE id = ${id}`);
    await until(() => l.hits() === 3);
    t.db.exec(`INSERT INTO modules (slug, name) VALUES ('m1', 'M1')`);
    await until(() => l.hits() === 4);
    await sleep(100);
    assert.strictEqual(l.hits(), 4, 'no extra pings');
  } finally { l.close(); t.cleanup(); }
});

test('nothing is stored in the DB file; a plain connection without the function can still write', async () => {
  const t = freshDb({ shared: true });
  try {
    installSyncPing(t.db);
    const stored = (t.db.prepare(`SELECT count(*) c FROM main.sqlite_master WHERE type='trigger' AND sql LIKE '%collab_sync_ping%'`).get() as any).c;
    assert.strictEqual(stored, 0);
    const other = new Database(t.path);
    try {
      loadCrsqlite(other);
      other.exec(`INSERT INTO modules (slug, name) VALUES ('gui', 'written by another tool')`);
    } finally { try { other.prepare('SELECT crsql_finalize()').get(); } catch { /* closing */ } other.close(); }
  } finally { t.cleanup(); }
});

test('manual BEGIN … await … COMMIT: no ping until COMMIT', async () => {
  const t = freshDb({ shared: true });
  const l = await listener();
  try {
    setSyncValue(t.db, COURIER_PORT_KEY, String(l.port));
    installSyncPing(t.db);
    t.db.exec('BEGIN');
    insertEntryRow(t.db, row('in-tx'));
    await sleep(150);
    assert.strictEqual(l.hits(), 0, 'pinged before commit');
    t.db.exec('COMMIT');
    await until(() => l.hits() === 1);
  } finally { l.close(); t.cleanup(); }
});

test('closeDb straight after a write still pings (last known port)', async () => {
  const t = freshDb({ shared: true });
  const l = await listener();
  try {
    setSyncValue(t.db, COURIER_PORT_KEY, String(l.port));
    installSyncPing(t.db);
    insertEntryRow(t.db, row('then-close'));
    t.db.prepare('SELECT crsql_finalize()').get();
    t.db.close();
    await until(() => l.hits() === 1);
  } finally { l.close(); t.cleanup(); }
});

test('the port is re-read at every ping (courier restarted on a new port)', async () => {
  const t = freshDb({ shared: true });
  const l1 = await listener(), l2 = await listener();
  try {
    setSyncValue(t.db, COURIER_PORT_KEY, String(l1.port));
    installSyncPing(t.db);
    insertEntryRow(t.db, row('one'));
    await until(() => l1.hits() === 1);
    setSyncValue(t.db, COURIER_PORT_KEY, String(l2.port));
    insertEntryRow(t.db, row('two'));
    await until(() => l2.hits() === 1);
    assert.strictEqual(l1.hits(), 1);
  } finally { l1.close(); l2.close(); t.cleanup(); }
});

test('no courier listening / no port: the save still succeeds', async () => {
  const t = freshDb({ shared: true });
  try {
    installSyncPing(t.db);
    assert.strictEqual(readCourierPort(t.db), null);
    insertEntryRow(t.db, row('nobody'));
    setSyncValue(t.db, COURIER_PORT_KEY, '1'); // a port nobody listens on
    insertEntryRow(t.db, row('closed-port'));
    await sleep(100);
  } finally { t.cleanup(); }
});

test('a separate script that writes and exits normally gets its ping out', async () => {
  const t = freshDb({ shared: true });
  const l = await listener();
  try {
    setSyncValue(t.db, COURIER_PORT_KEY, String(l.port));
    t.db.prepare('SELECT crsql_finalize()').get();
    t.db.close();
    const fixture = fileURLToPath(new URL('./fixtures/ping-writer.ts', import.meta.url));
    const code = await new Promise<number>((resolve, reject) => {
      const p = spawn(process.execPath, ['--import', 'tsx', fixture, t.path], { stdio: 'inherit', env: process.env });
      p.on('error', reject);
      p.on('exit', (c) => resolve(c ?? -1));
    });
    assert.strictEqual(code, 0);
    await until(() => l.hits() === 1);
  } finally { l.close(); t.cleanup(); }
});
