// RnR S3: the web UI keeps its own copy of the permission catalog (its TypeScript
// project can't import core). This test keeps the copy from drifting.
import { test } from 'node:test';
import assert from 'node:assert';
import { CATALOG as UI_CATALOG, activeKeys } from '../ui/src/team/catalog.ts';
import { CATALOG, keysOf } from '../core/src/access/catalog.ts';

test('the UI catalog equals core\'s CATALOG', () => {
  assert.deepStrictEqual(UI_CATALOG, CATALOG);
});

test('activeKeys matches core\'s active keys per scope', () => {
  assert.deepStrictEqual(activeKeys('project'), keysOf('project'));
  assert.deepStrictEqual(activeKeys('office'), keysOf('office'));
});
