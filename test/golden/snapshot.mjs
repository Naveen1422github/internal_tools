import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '__snapshots__');

export function matchSnapshot(name, value) {
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
