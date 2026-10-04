// file: post-office/test/server.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import {
  requestJson, openEventStream, newUlid, AccessRevokedError,
  addEntryAsync, setAllocator, readOwnChanges, type PostOfficeTarget,
} from '@collab-mcp/core';
import { laptop } from './helpers.js';
import { office } from './office.js';
import { revokeMember } from '../src/store.js';

function listen(target: PostOfficeTarget) {
  const events: Array<[string, any]> = [];
  let closedWith: Error | undefined | null = null;
  let ready!: () => void;
  const isReady = new Promise<void>((r) => (ready = r));
  const stream = openEventStream(target, '/v1/events', {
    event: (name, data) => { events.push([name, JSON.parse(data)]); if (name === 'ready') ready(); },
    close: (err) => { closedWith = err; },
  });
  return { events, isReady, stream, closed: () => closedWith };
}
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

test('join once, then allocate (idempotent by ulid)', async () => {
  const o = await office(100);
  try {
    const m = await o.join('laptop b');
    const again = await requestJson(o.target(), 'POST', '/v1/join', { device: m.device, secret: m.secret });
    assert.equal(again.status, 403);
    const u = newUlid();
    const r1 = await requestJson(o.target(m), 'POST', '/v1/allocate', { ulid: u });
    const r2 = await requestJson(o.target(m), 'POST', '/v1/allocate', { ulid: u });
    assert.deepEqual([r1.body.id, r2.body.id], [101, 101]);
    assert.equal((await requestJson(o.target(m), 'POST', '/v1/allocate', { ulid: 'junk' })).status, 400);
  } finally { await o.stop(); }
});

test('no key or a wrong key: 401', async () => {
  const o = await office();
  try {
    await assert.rejects(requestJson(o.target(), 'GET', '/v1/status'), AccessRevokedError);
    await assert.rejects(requestJson(o.target({ device: 'd-nope', key: 'x' }), 'GET', '/v1/status'), AccessRevokedError);
  } finally { await o.stop(); }
});

test('push rings everyone but the sender; the others pull it', async () => {
  const o = await office();
  const lap = laptop();
  try {
    const a = await o.join('a'), b = await o.join('b');
    const la = listen(o.target(a)), lb = listen(o.target(b));
    await la.isReady; await lb.isReady;
    setAllocator({ allocate: async () => 1 });
    await addEntryAsync(lap.db, { type: 'decision', title: 'ring', summary: 's', module: 'm' });
    const sent = readOwnChanges(lap.db, 0);
    const r = await requestJson(o.target(a), 'POST', '/v1/changes', { changes: sent });
    assert.equal(r.body.accepted, sent.length);
    await until(() => lb.events.some(([n]) => n === 'changes'));
    assert.equal(la.events.some(([n]) => n === 'changes'), false, 'the sender is not rung');
    const page = await requestJson(o.target(b), 'GET', '/v1/changes?after=0&limit=1000');
    assert.equal(page.body.changes.length, sent.length);
    assert.equal(page.body.more, false);
    const mine = await requestJson(o.target(a), 'GET', '/v1/changes?after=0');
    assert.equal(mine.body.changes.length, 0);
    la.stream.close(); lb.stream.close();
  } finally { setAllocator(null); lap.cleanup(); await o.stop(); }
});

test('revoke: the next request is refused and the open doorbell is closed', async () => {
  const o = await office();
  try {
    const m = await o.join('lost laptop');
    const l = listen(o.target(m));
    await l.isReady;
    revokeMember(o.store, 'lost laptop');
    await assert.rejects(requestJson(o.target(m), 'POST', '/v1/allocate', { ulid: newUlid() }), AccessRevokedError);
    await until(() => l.events.some(([n]) => n === 'revoked'));
    await until(() => l.closed() !== null);
    const again = listen(o.target(m));
    await until(() => again.closed() !== null);
    assert.ok(again.closed() instanceof AccessRevokedError);
  } finally { await o.stop(); }
});

test('shared modules: set over the API, rung to everyone', async () => {
  const o = await office();
  try {
    const a = await o.join('a');
    const l = listen(o.target(a));
    await l.isReady;
    const r = await requestJson(o.target(a), 'POST', '/v1/modules', { slug: 'sync', shared: true });
    assert.deepEqual(r.body.shared, ['sync']);
    assert.deepEqual((await requestJson(o.target(a), 'GET', '/v1/modules')).body.shared, ['sync']);
    await until(() => l.events.some(([n, d]) => n === 'modules' && d.shared[0] === 'sync'));
    l.stream.close();
  } finally { await o.stop(); }
});

test('status, 404, 413', async () => {
  const o = await office(0, { maxBodyBytes: 1000 });
  try {
    const a = await o.join('a');
    const st = await requestJson(o.target(a), 'GET', '/v1/status');
    assert.deepEqual(st.body.members.map((m: any) => [m.name, m.state]), [['a', 'up to date']]);
    assert.equal((await requestJson(o.target(a), 'GET', '/v1/nope')).status, 404);
    assert.equal((await requestJson(o.target(a), 'POST', '/v1/changes', { changes: [], pad: 'x'.repeat(5000) })).status, 413);
  } finally { await o.stop(); }
});
