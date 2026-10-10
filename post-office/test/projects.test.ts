// file: post-office/test/projects.test.ts
// Stage C: the office keeps the team-project list and one counter per series.
import { test } from 'node:test';
import assert from 'node:assert';
import { newUlid } from '@collab-mcp/core';
import { tempStore } from './helpers.js';
import { allocate, registerProject, listOfficeProjects, StoreError } from '../src/store.js';

const storeError = (status: number, re?: RegExp) => (e: unknown) =>
  e instanceof StoreError && e.status === status && (!re || re.test(e.message));

test('series counters are independent of each other and of E', () => {
  const t = tempStore(100);
  try {
    registerProject(t.store, { ulid: newUlid(), name: 'Support hub', code: 'SH', seed: 0 });
    const [u1, u2, u3] = [newUlid(), newUlid(), newUlid()];
    assert.equal(allocate(t.store, u1, 'd', 'SH'), 1);
    assert.equal(allocate(t.store, u2, 'd', 'SH'), 2);
    assert.equal(allocate(t.store, u3, 'd'), 101, 'E continues its own counter');
    assert.equal(allocate(t.store, newUlid(), 'd', 'E'), 102);
  } finally { t.cleanup(); }
});

test('same ulid in the same series: same number, counter moves once', () => {
  const t = tempStore();
  try {
    registerProject(t.store, { ulid: newUlid(), name: 'Support hub', code: 'SH', seed: 0 });
    const u = newUlid();
    assert.equal(allocate(t.store, u, 'd', 'SH'), 1);
    assert.equal(allocate(t.store, u, 'd', 'SH'), 1);
    assert.equal(allocate(t.store, newUlid(), 'd', 'SH'), 2);
  } finally { t.cleanup(); }
});

test('one ulid never gets numbers in two series', () => {
  const t = tempStore();
  try {
    registerProject(t.store, { ulid: newUlid(), name: 'Support hub', code: 'SH', seed: 0 });
    registerProject(t.store, { ulid: newUlid(), name: 'Navi', code: 'NV', seed: 0 });
    const u = newUlid();
    allocate(t.store, u, 'd', 'SH');
    assert.throws(() => allocate(t.store, u, 'd', 'NV'), storeError(409, /already numbered SH-1/));
    assert.throws(() => allocate(t.store, u, 'd'), storeError(409, /already numbered SH-1/));
    const e = newUlid();
    allocate(t.store, e, 'd');
    assert.throws(() => allocate(t.store, e, 'd', 'SH'), storeError(409, /E number/));
  } finally { t.cleanup(); }
});

test('unknown series: 404', () => {
  const t = tempStore();
  try {
    assert.throws(() => allocate(t.store, newUlid(), 'd', 'XX'), storeError(404, /XX/));
  } finally { t.cleanup(); }
});

test('seed: a promoted project continues after its highest number', () => {
  const t = tempStore();
  try {
    registerProject(t.store, { ulid: newUlid(), name: 'Navi', code: 'NV', seed: 7 });
    assert.equal(allocate(t.store, newUlid(), 'd', 'NV'), 8);
  } finally { t.cleanup(); }
});

test('register: clashes refused, the same project again is idempotent, bad input refused', () => {
  const t = tempStore();
  try {
    const u = newUlid();
    const first = registerProject(t.store, { ulid: u, name: 'Support hub', code: 'sh', seed: 0 });
    assert.equal(first.code, 'SH');
    assert.throws(() => registerProject(t.store, { ulid: newUlid(), name: 'Other', code: 'SH', seed: 0 }), storeError(409));
    assert.throws(() => registerProject(t.store, { ulid: newUlid(), name: 'SUPPORT HUB', code: 'SX', seed: 0 }), storeError(409));
    assert.throws(() => registerProject(t.store, { ulid: u, name: 'Support hub', code: 'SX', seed: 0 }), storeError(409));
    const again = registerProject(t.store, { ulid: u, name: 'Support hub', code: 'SH', seed: 0 });
    assert.deepEqual(again, first);
    assert.throws(() => registerProject(t.store, { ulid: newUlid(), name: 'x', code: 'E', seed: 0 }), storeError(400));
    assert.throws(() => registerProject(t.store, { ulid: newUlid(), name: 'x', code: 'S', seed: 0 }), storeError(400));
    assert.throws(() => registerProject(t.store, { ulid: 'junk', name: 'x', code: 'XY', seed: 0 }), storeError(400));
    assert.throws(() => registerProject(t.store, { ulid: newUlid(), name: 'x', code: 'XY', seed: -1 }), storeError(400));
    assert.throws(() => registerProject(t.store, { ulid: newUlid(), name: ' ', code: 'XY', seed: 0 }), storeError(400));
  } finally { t.cleanup(); }
});

test('listOfficeProjects: ordered by code', () => {
  const t = tempStore();
  try {
    registerProject(t.store, { ulid: newUlid(), name: 'Support hub', code: 'SH', seed: 0 });
    registerProject(t.store, { ulid: newUlid(), name: 'Navi', code: 'NV', seed: 3 });
    const list = listOfficeProjects(t.store);
    assert.deepEqual(list.map((p) => [p.code, p.name]), [['NV', 'Navi'], ['SH', 'Support hub']]);
    assert.ok(list.every((p) => typeof p.ulid === 'string' && typeof p.created_at === 'string'));
  } finally { t.cleanup(); }
});
