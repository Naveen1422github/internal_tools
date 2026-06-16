import { test } from 'node:test';
import assert from 'node:assert';
import { validateEntryInput } from '../src/validate.js';

test('rejects unknown type', () => {
  const r = validateEntryInput({ type: 'nope', title: 't', summary: 's' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /invalid type/);
});
test('rejects rollup', () => {
  assert.equal(validateEntryInput({ type: 'rollup', title: 't', summary: 's' }).ok, false);
});
test('rejects summary > 200', () => {
  const r = validateEntryInput({ type: 'decision', title: 't', summary: 'x'.repeat(201) });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /summary exceeds 200/);
});
test('accepts a valid entry and resolves category', () => {
  const r = validateEntryInput({ type: 'decision', title: 't', summary: 's' });
  assert.equal(r.ok, true);
  assert.equal(r.category, 'Reference');
});
