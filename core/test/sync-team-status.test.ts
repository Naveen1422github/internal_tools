// file: core/test/sync-team-status.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { describeMemberState } from '../src/sync/team-status.js';

// E-739 #3: the post office only knows what a device still has to RECEIVE.
// The wire values stay ("up to date" / "behind"); only the shown words change.
test('member states read as what is left to receive', () => {
  assert.equal(describeMemberState('up to date', 0), 'has everything');
  assert.equal(describeMemberState('behind', 12), '12 to receive');
  assert.equal(describeMemberState('waiting to join', 0), 'waiting to join');
  assert.equal(describeMemberState('revoked', 0), 'revoked');
});
