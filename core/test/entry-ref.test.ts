import { test } from 'node:test';
import assert from 'node:assert';
import { formatEntryRef } from '../src/entry-ref.js';
import { parseEntryRef } from '../src/ulid.js';

test('pads to 5 digits with the E series by default', () => {
  assert.equal(formatEntryRef(12), 'E-00012');
  assert.equal(formatEntryRef(123456), 'E-123456');
});
test('a missing number prints E-pending (stage C), never E-0null', () => {
  assert.equal(formatEntryRef(null), 'E-pending');
  assert.equal(formatEntryRef(null, 'SH'), 'SH-pending');
  assert.equal(formatEntryRef(undefined), 'E-pending');
});
test('a project series prints its bare number; only E is padded', () => {
  assert.equal(formatEntryRef(7, 'ACME'), 'ACME-7');
  assert.equal(formatEntryRef(12, 'SH'), 'SH-12');
  assert.equal(formatEntryRef(12), 'E-00012');
});
test('round trip with parseEntryRef for the E series', () => {
  for (const n of [1, 42, 760, 99999, 100000]) assert.equal(parseEntryRef(formatEntryRef(n)), n);
});
