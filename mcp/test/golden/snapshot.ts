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
  const expected = fs.readFileSync(file, 'utf8');
  assert.strictEqual(actual, expected, `golden mismatch for ${name}`);
}

// Replace volatile fields so snapshots are stable.
export function stable<T>(obj: T): T {
  return JSON.parse(
    JSON.stringify(obj, (k, v) =>
      k === 'id' || k === 'entry_id' ? '<id>'
      : k === 'created_at' || k === 'updated_at' ? '<ts>'
      : k === 'tokens_estimate' ? '<tok>'
      : k === 'since' ? (v == null ? v : '<since>')  // normalize a real since value; keep undefined dropped (JSON omits it)
      : v),
  );
}
