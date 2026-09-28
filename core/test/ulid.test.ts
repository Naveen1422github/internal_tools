import { test } from 'node:test';
import assert from 'node:assert';
import { newUlid, ulidFromLegacy, parseSqliteUtc, parseEntryRef } from '../src/ulid.js';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

test('newUlid is 26 Crockford chars', () => {
  assert.match(newUlid(), ULID_RE);
});

test('newUlid is strictly increasing within the same millisecond', () => {
  const t = 1_790_000_000_000;
  const a = newUlid(t), b = newUlid(t), c = newUlid(t);
  assert.ok(a < b && b < c, `${a} ${b} ${c}`);
});

test('newUlid never goes backwards when the clock does', () => {
  const a = newUlid(1_790_000_000_500);
  const b = newUlid(1_790_000_000_100);
  assert.ok(b > a);
});

test('parseSqliteUtc reads SQLite datetime() as UTC, not local time', () => {
  assert.equal(parseSqliteUtc('2026-04-22 20:14:14'), Date.UTC(2026, 3, 22, 20, 14, 14));
  assert.equal(parseSqliteUtc('2026-04-22 20:14:14.25'), Date.UTC(2026, 3, 22, 20, 14, 14, 250));
  assert.throws(() => parseSqliteUtc('22/04/2026'), /unparseable created_at/);
});

test('ulidFromLegacy is deterministic', () => {
  assert.equal(
    ulidFromLegacy(155, '2026-05-01 10:00:00', 'INDEX'),
    ulidFromLegacy(155, '2026-05-01 10:00:00', 'INDEX'),
  );
});

test('ulidFromLegacy orders same-second entries by id (D1)', () => {
  const same = '2026-04-22 20:14:14';
  const ids = [9, 10, 2, 1000, 11];
  const byUlid = [...ids].sort((x, y) =>
    ulidFromLegacy(x, same, 't' + x) < ulidFromLegacy(y, same, 't' + y) ? -1 : 1);
  assert.deepEqual(byUlid, [2, 9, 10, 11, 1000]);
});

test('ulidFromLegacy time part sorts across seconds', () => {
  assert.ok(ulidFromLegacy(999, '2026-04-22 20:14:14', 'a') < ulidFromLegacy(1, '2026-04-22 20:14:15', 'b'));
});

test('parseEntryRef accepts every legacy format seen in the real DB', () => {
  for (const [input, want] of [
    ['214', 214], ['E-214', 214], ['E-00214', 214], ['e-214', 214], ['#116', 116],
    [' 214 ', 214], ['E214', 214],
  ] as const) assert.equal(parseEntryRef(input), want, input);
});

test('parseEntryRef rejects junk', () => {
  for (const input of ['', '0', 'E-', 'abc', '12a', 'T-011', '-5', '1.5']) {
    assert.equal(parseEntryRef(input), null, input);
  }
});
