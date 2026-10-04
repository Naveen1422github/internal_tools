import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('build identity changes when built code changes, even with the same version', () => {
  const root = mkdtempSync(join(tmpdir(), 'collab-bi-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    mkdirSync(join(root, 'core', 'dist'), { recursive: true });
    writeFileSync(join(root, 'core', 'dist', 'a.js'), 'one');
    const run = () => { execFileSync(process.execPath, ['scripts/write-build-info.mjs', root]); return JSON.parse(readFileSync(join(root, 'build-info.json'), 'utf8')); };
    const a = run();
    writeFileSync(join(root, 'core', 'dist', 'a.js'), 'two');
    const b = run();
    assert.equal(a.version, '0.1.0');
    assert.equal(b.version, '0.1.0');
    assert.notEqual(a.build, b.build);
    assert.match(a.build, /^[0-9a-f]{12}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
