// file: core/test/sync-overview.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb } from './helpers/sync.js';
import { readSyncOverview, unsentSharedCount } from '../src/sync/overview.js';
import { setSyncValue } from '../src/sync/state.js';
import { addEntryAsync } from '../src/ops/add.js';
import { setAllocator } from '../src/sync/allocator.js';

function shared(t: ReturnType<typeof freshDb>, modules: string[]) {
  setSyncValue(t.db, 'po_url', 'https://192.168.0.104:7443');
  setSyncValue(t.db, 'device_id', 'd-1');
  setSyncValue(t.db, 'device_key', 'SECRET-KEY-VALUE');
  setSyncValue(t.db, 'po_fingerprint', 'abc');
  setSyncValue(t.db, 'shared_modules', JSON.stringify(modules));
}
function courier(status: object | null, pid = 4242) {
  const dir = mkdtempSync(join(tmpdir(), 'courier-'));
  if (status) writeFileSync(join(dir, 'status.json'), JSON.stringify({ ...status, pid }));
  writeFileSync(join(dir, 'courier.pid'), String(pid));
  return dir;
}
const st = (state: string, extra: object = {}) => ({ state, lastError: null, lastPushAt: '2026-10-04T10:00:00Z', lastPullAt: '2026-10-04T10:05:00Z', sentTotal: 0, receivedTotal: 0, ...extra });

test('sharing off -> { enabled: false }', () => {
  const t = freshDb();
  try { assert.deepEqual(readSyncOverview(t.db), { enabled: false }); } finally { t.cleanup(); }
});

test('never contains the device key or any unlisted sync_state value', () => {
  const t = freshDb({ shared: true });
  const dir = courier(st('connected'));
  try {
    shared(t, ['portfolio']);
    const o = readSyncOverview(t.db, { courierDir: dir, isAlive: () => true });
    const s = JSON.stringify(o);
    assert.ok(!s.includes('SECRET-KEY-VALUE'));
    assert.ok(!s.includes('abc'), 'fingerprint is not part of the overview');
  } finally { t.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('ok: connected, nothing waiting; lastContactAt = the later of push/pull', () => {
  const t = freshDb({ shared: true });
  const dir = courier(st('connected'));
  try {
    shared(t, ['portfolio']);
    setSyncValue(t.db, 'sent_db_version', String(1e9)); // everything counted as sent
    const o: any = readSyncOverview(t.db, { courierDir: dir, isAlive: () => true });
    assert.equal(o.health, 'ok');
    assert.equal(o.lastContactAt, '2026-10-04T10:05:00Z');
    assert.deepEqual(o.sharedModules, ['portfolio']);
    assert.equal(o.postOffice, 'https://192.168.0.104:7443');
  } finally { t.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('behind: changes in a SHARED module are waiting; private-module changes do not count', async () => {
  const t = freshDb({ shared: true });
  const dir = courier(st('connected'));
  try {
    shared(t, ['portfolio']);
    setSyncValue(t.db, 'sent_db_version', '0');
    let n = 0;
    setAllocator({ allocate: async () => ++n }); // a shared notebook takes its numbers from the post office
    await addEntryAsync(t.db, { type: 'decision', title: 'private', summary: 's', module: 'secret' });
    assert.equal(unsentSharedCount(t.db), 0);
    await addEntryAsync(t.db, { type: 'decision', title: 'shared', summary: 's', module: 'portfolio' });
    assert.ok(unsentSharedCount(t.db) > 0);
    assert.equal((readSyncOverview(t.db, { courierDir: dir, isAlive: () => true }) as any).health, 'behind');
  } finally { setAllocator(null); t.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('behind: courier offline, even with nothing waiting', () => {
  const t = freshDb({ shared: true });
  const dir = courier(st('offline', { lastError: 'ECONNREFUSED' }));
  try {
    shared(t, ['portfolio']);
    setSyncValue(t.db, 'sent_db_version', String(1e9));
    const o: any = readSyncOverview(t.db, { courierDir: dir, isAlive: () => true });
    assert.equal(o.health, 'behind');
    assert.equal(o.courier.lastError, 'ECONNREFUSED');
  } finally { t.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('a dead pid means not syncing, whatever status.json says', () => {
  const t = freshDb({ shared: true });
  const dir = courier(st('connected'));
  try {
    shared(t, ['portfolio']);
    assert.equal((readSyncOverview(t.db, { courierDir: dir, isAlive: () => false }) as any).health, 'not-syncing');
  } finally { t.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('needs-update and revoked pass through; missing status.json is unknown', () => {
  const t = freshDb({ shared: true });
  try {
    shared(t, ['portfolio']);
    for (const [state, health] of [['needs-update', 'needs-update'], ['revoked', 'revoked']] as const) {
      const dir = courier(st(state));
      assert.equal((readSyncOverview(t.db, { courierDir: dir, isAlive: () => true }) as any).health, health);
      rmSync(dir, { recursive: true, force: true });
    }
    const empty = courier(null);
    assert.equal((readSyncOverview(t.db, { courierDir: empty, isAlive: () => true }) as any).health, 'unknown');
    rmSync(empty, { recursive: true, force: true });
  } finally { t.cleanup(); }
});
