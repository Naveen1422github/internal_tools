import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Spec P12: the web server refuses to start on a setup problem, printing the doctor sentence.
test('the web server with no notebook exits 2 and prints the fix', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'collab-web-start-'));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, COLLAB_DATA_DIR: join(tmp, 'data'), PORT: '0' };
    for (const k of ['COLLAB_DB_PATH', 'COLLAB_NOTEBOOK', 'COLLAB_DB_CREATE']) delete env[k];
    const child = spawn(process.execPath, [join(ROOT, 'server', 'dist', 'server.js')], { cwd: tmp, env });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(null); }, 15000);
      child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 2, stderr);
    assert.match(stderr, /fix:/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
