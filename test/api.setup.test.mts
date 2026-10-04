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

// Spec P10: the Health page renders the same report as `collab doctor --json`.
test('GET /api/doctor/setup returns the setup report', async () => {
  const data = mkdtempSync(join(tmpdir(), 'collab-web-data-'));
  process.env.COLLAB_DATA_DIR = data;
  const { startTestServer } = await import('./helpers/server.mjs');
  const { addNotebook } = await import('@collab-mcp/core');
  const s = await startTestServer();
  try {
    addNotebook('web-test', s.db.name, data);
    const res = await fetch(`${s.baseUrl}/api/doctor/setup`);
    assert.equal(res.status, 200);
    const report = await res.json();
    assert.ok([0, 1, 2].includes(report.exitCode));
    assert.ok(report.checks.some((c: any) => c.group === 'notebook' && c.mark === 'ok'), JSON.stringify(report.checks));
  } finally {
    await s.close();
    rmSync(data, { recursive: true, force: true });
  }
});
