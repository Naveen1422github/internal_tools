// Every write to a synced table goes through core (collab E-720): one place
// for revisions, input checks and future rules. This test fails if any code
// outside core writes one with its own SQL.
import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYNCED_TABLES } from '../src/sync/enable.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)); // internal-tools/
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-share', 'vendor', 'docs', 'test', 'tests', 'migrations']);
const ALLOWED = ['core/src/', 'post-office/src/']; // core itself; the post office's own store
const EXT = /\.(ts|js|mjs|cjs|py|sh)$/;
const WRITE = new RegExp(String.raw`\b(INSERT(\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+(main\.)?(${SYNCED_TABLES.join('|')})\b`, 'i');

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (EXT.test(name)) yield p;
  }
}

test('no code outside core writes a synced table directly', () => {
  const offenders: string[] = [];
  for (const f of files(ROOT)) {
    const rel = relative(ROOT, f).split(sep).join('/');
    if (ALLOWED.some((a) => rel.startsWith(a))) continue;
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (WRITE.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(offenders, [], `write through core instead (collab E-720):\n${offenders.join('\n')}`);
});
