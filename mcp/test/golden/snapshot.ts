import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__snapshots__');

export function matchSnapshot(name: string, value: unknown): void {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${name}.json`);
  const actual = JSON.stringify(value, null, 2);
  if (process.env.UPDATE_GOLDEN === '1' || !fs.existsSync(file)) {
    fs.writeFileSync(file, actual);
    return;
  }
  const expected = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  assert.strictEqual(actual.replace(/\r\n/g, '\n'), expected, `golden mismatch for ${name}`);
}

// Crockford base32, 26 chars: a ULID anywhere in a value (doctor items, labels) is per-run.
const ULID_RE = /[0-9A-HJKMNP-TV-Z]{26}/g;
const ULID_KEYS = new Set(['ulid', 'entry_ulid', 'target_ulid', 'superseded_by_ulid']);

// Replace volatile fields so snapshots are stable. Null stays null so a
// snapshot still shows "not set" (e.g. deleted_at on a live entry).
export function stable<T>(obj: T): T {
  return JSON.parse(
    JSON.stringify(obj, (k, v) =>
      k === 'id' || k === 'entry_id' ? '<id>'
      : k === 'created_at' || k === 'updated_at' ? '<ts>'
      : k === 'tokens_estimate' ? '<tok>'
      : k === 'since' ? (v == null ? v : '<since>')  // normalize a real since value; keep undefined dropped (JSON omits it)
      : ULID_KEYS.has(k) ? (v == null ? v : '<ulid>')
      : k === 'author' ? (v == null ? v : '<author>')   // machine/git identity, differs per machine
      : k === 'deleted_at' ? (v == null ? v : '<ts>')
      : typeof v === 'string' ? v.replace(ULID_RE, '<ulid>')
      : v),
  );
}
