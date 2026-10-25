// file: core/test/compat.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { schemaCompatible, WIRE_COMPAT } from '../src/sync/compat.js';

test('equal schemas are compatible', () => {
  assert.equal(schemaCompatible('0013_access_cache', '0013_access_cache'), true);
});

test('unlisted, unequal schemas are not compatible (WIRE_COMPAT is empty today)', () => {
  assert.deepEqual(WIRE_COMPAT, {});
  assert.equal(schemaCompatible('0013_access_cache', '0012_x'), false);
  assert.equal(schemaCompatible('0013_access_cache', 'unknown'), false);
});

test('a listed peer is compatible one way only', () => {
  const table = { '0014_x': ['0013_access_cache'] };
  assert.equal(schemaCompatible('0014_x', '0013_access_cache', table), true);
  assert.equal(schemaCompatible('0013_access_cache', '0014_x', table), false);
});
