// file: courier/test/live.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { addEntryAsync, updateEntry } from '@collab-mcp/core';
import { setModuleShared, revokeMember } from '@collab-mcp/post-office';
import { tempDir, startOffice, joinedDb, openWriter, closeWriter, until, sleep } from './world.js';
import { Courier } from '../src/engine.js';

async function pair() {
  const t = tempDir();
  const office = await startOffice(t.dir, 0);
  setModuleShared(office.store, 'team', true);
  const ja = await joinedDb(office, t.dir, 'a'), jb = await joinedDb(office, t.dir, 'b');
  const wa = openWriter(ja.path), wb = openWriter(jb.path);
  const opts = { retryMs: 300, maxReconnectMs: 200 };
  const ca = new Courier({ dbPath: ja.path, ...opts }), cb = new Courier({ dbPath: jb.path, ...opts });
  ca.start(); cb.start();
  await until(() => ca.status.state === 'connected' && cb.status.state === 'connected', 3000, 'both doorbells');
  return {
    t, office, ja, jb, wa, wb, ca, cb,
    done: async () => { await ca.stop(); await cb.stop(); closeWriter(wa); closeWriter(wb); await office.close(); t.cleanup(); },
  };
}
const title = (db: any, id: number) => (db.prepare('SELECT title, description FROM entries WHERE id = ?').get(id) as any) ?? null;

test('a save on one machine reaches the other with nobody calling push or pull', async () => {
  const p = await pair();
  try {
    const { id } = await addEntryAsync(p.wa, { type: 'decision', title: 'tapir', summary: 's', module: 'team' });
    await until(() => title(p.wb, id)?.title === 'tapir', 2000, 'the doorbell + pull');
  } finally { await p.done(); }
});

test('idle = no work: no requests while nothing changes, no timers pending', async () => {
  const p = await pair();
  try {
    await addEntryAsync(p.wa, { type: 'decision', title: 'settle', summary: 's', module: 'team' });
    await until(() => p.wb.prepare(`SELECT 1 FROM entries WHERE title = 'settle'`).get() !== undefined, 2000);
    await sleep(500);
    const n = p.office.requests.length;
    await sleep(1000);
    assert.equal(p.office.requests.length, n, 'no requests in a quiet second');
    assert.equal(p.ca.pendingTimers() + p.cb.pendingTimers(), 0);
  } finally { await p.done(); }
});

test('the post office goes away and comes back: the doorbell reconnects and offline edits arrive', async () => {
  const p = await pair();
  try {
    const { id } = await addEntryAsync(p.wa, { type: 'decision', title: 'ibis', summary: 's', description: 'v1', module: 'team' });
    await until(() => title(p.wb, id)?.description === 'v1', 2000);
    await p.office.down();
    await until(() => p.ca.status.state === 'offline' && p.cb.status.state === 'offline', 3000, 'both offline');
    updateEntry(p.wa, { id, description: 'v2, written while the post office was down' });
    await sleep(400);
    await p.office.up();
    await until(() => title(p.wb, id)?.description === 'v2, written while the post office was down', 5000, 'catch-up');
    await until(() => p.ca.status.state === 'connected', 2000);
  } finally { await p.done(); }
});

test('revoked: "access revoked", and no more retries or reconnects', async () => {
  const p = await pair();
  try {
    revokeMember(p.office.store, p.jb.device);
    await until(() => p.cb.status.state === 'revoked', 3000, 'the revoked state');
    assert.match(p.cb.status.lastError ?? '', /revoked/);
    const fromB = () => p.office.requests.filter((r) => r.device === p.jb.device).length;
    await addEntryAsync(p.wa, { type: 'decision', title: 'not for b', summary: 's', module: 'team' });
    const n = fromB();
    await sleep(800);
    assert.equal(fromB(), n, 'B makes no more requests');
    assert.equal(p.cb.pendingTimers(), 0);
  } finally { await p.done(); }
});
