// file: post-office/test/store.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { newUlid } from '@collab-mcp/core';
import { tempStore } from './helpers.js';
import {
  openStore, closeStore, allocate, nextNumber, addMember, redeemJoin, authenticate, revokeMember,
  teamStatus, setModuleShared, sharedModules, StoreError,
} from '../src/store.js';

test('the counter starts at the seed; a repeated ulid gets the same number', () => {
  const { store, cleanup } = tempStore(811);
  try {
    const u1 = newUlid(), u2 = newUlid();
    assert.equal(nextNumber(store), 812);
    assert.equal(allocate(store, u1, 'd-a'), 812);
    assert.equal(allocate(store, u2, 'd-b'), 813);
    assert.equal(allocate(store, u1, 'd-a'), 812, 'idempotent by ulid (E-713)');
    assert.equal(nextNumber(store), 814);
    assert.throws(() => allocate(store, 'not-a-ulid', 'd-a'), StoreError);
  } finally { cleanup(); }
});

test('the increment and the record commit together (a failed record leaves the counter alone)', () => {
  const { store, cleanup } = tempStore(10);
  try {
    store.prepare(`INSERT INTO po_allocations (ulid, id, device_id) VALUES (?, 11, 'x')`).run(newUlid()); // id 11 taken behind its back
    assert.throws(() => allocate(store, newUlid(), 'd'), /UNIQUE/);
    assert.equal(nextNumber(store), 11, 'counter unchanged');
  } finally { cleanup(); }
});

test('allocations are unique on ulid and on id', () => {
  const { store, cleanup } = tempStore();
  try {
    const idx = store.prepare(`SELECT sql FROM sqlite_master WHERE name = 'po_allocations'`).get() as { sql: string };
    assert.match(idx.sql, /ulid\s+TEXT\s+NOT NULL\s+PRIMARY KEY/i);
    assert.match(idx.sql, /id\s+INTEGER\s+NOT NULL\s+UNIQUE/i);
  } finally { cleanup(); }
});

test('reopening keeps the counter and loads cr-sqlite', () => {
  const { store, path, cleanup } = tempStore(5);
  try {
    allocate(store, newUlid(), 'd');
    closeStore(store);
    const again = openStore(path);
    try {
      assert.equal(nextNumber(again), 7);
      assert.ok(again.prepare('SELECT crsql_db_version() v').get());
    } finally { closeStore(again); }
  } finally { cleanup(); }
});

test('join codes are one-time; keys authenticate until revoked', () => {
  const { store, cleanup } = tempStore();
  try {
    const { deviceId, secret } = addMember(store, 'second laptop');
    assert.throws(() => redeemJoin(store, deviceId, 'wrong'), (e: any) => e instanceof StoreError && e.status === 403);
    const { key } = redeemJoin(store, deviceId, secret);
    assert.throws(() => redeemJoin(store, deviceId, secret), /not valid/);
    assert.equal(authenticate(store, `Bearer ${deviceId}:${key}`)?.name, 'second laptop');
    assert.equal(authenticate(store, `Bearer ${deviceId}:nope`), null);
    assert.equal(authenticate(store, undefined), null);
    revokeMember(store, 'second laptop');
    assert.equal(authenticate(store, `Bearer ${deviceId}:${key}`), null, 'revoked = locked out at once');
  } finally { cleanup(); }
});

test('an expired join code is refused', () => {
  const { store, cleanup } = tempStore();
  try {
    const { deviceId, secret } = addMember(store, 'late', { ttlHours: -1 });
    assert.throws(() => redeemJoin(store, deviceId, secret), /expired/);
  } finally { cleanup(); }
});

test('team status: waiting / up to date / behind / revoked', () => {
  const { store, cleanup } = tempStore();
  try {
    const a = addMember(store, 'main');
    addMember(store, 'pending');
    redeemJoin(store, a.deviceId, a.secret);
    store.prepare(`INSERT INTO po_deliveries (origin, tbl, pk, cid, val, col_version, db_version, site_id, cl, ch_seq) VALUES ('other', 'entries', x'01', 'title', 't', 1, 1, x'02', 1, 0)`).run();
    let rows = teamStatus(store);
    assert.deepEqual(rows.map((r) => [r.name, r.state, r.behind]), [['main', 'behind', 1], ['pending', 'waiting to join', 0]]);
    store.prepare(`UPDATE po_members SET receive_bookmark = 1 WHERE device_id = ?`).run(a.deviceId);
    revokeMember(store, 'pending');
    rows = teamStatus(store);
    assert.deepEqual(rows.map((r) => [r.name, r.state]), [['main', 'up to date'], ['pending', 'revoked']]);
  } finally { cleanup(); }
});

test('shared modules: opt-in per module, slugs validated', () => {
  const { store, cleanup } = tempStore();
  try {
    assert.deepEqual(sharedModules(store), []);
    assert.deepEqual(setModuleShared(store, 'sync', true), ['sync']);
    assert.deepEqual(setModuleShared(store, 'api', true), ['api', 'sync']);
    assert.deepEqual(setModuleShared(store, 'sync', false), ['api']);
    assert.throws(() => setModuleShared(store, 'Bad Slug', true), StoreError);
  } finally { cleanup(); }
});
