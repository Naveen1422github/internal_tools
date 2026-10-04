import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Spec P12 / E-740 bug #2: with no notebook (or no add-on), the MCP must NOT
// exit. Claude Code shows an exited server only as "failed" and never shows
// its stderr, so it starts degraded and every tool answers with the fix.
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.js');

test('no notebook: the MCP stays up, lists its tools, and every tool returns the fix sentence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'collab-degraded-'));
  const env: NodeJS.ProcessEnv = { ...process.env, COLLAB_DATA_DIR: join(root, 'data') };
  delete env.COLLAB_DB_PATH;
  delete env.COLLAB_NOTEBOOK;
  delete env.COLLAB_DB_CREATE;
  const child = spawn(process.execPath, [SERVER], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const pending = new Map<number, (msg: any) => void>();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  const call = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}; stderr:\n${stderr}`)), 15000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await call('tools/list', {});
    const names = list.result.tools.map((t: any) => t.name);
    assert.ok(names.includes('collab_search') && names.includes('collab_doctor'), names.join(','));
    const search = await call('tools/call', { name: 'collab_search', arguments: { query: 'x' } });
    assert.equal(search.result.isError, true);
    assert.match(search.result.content[0].text, /collab notebook/);
    const doc = await call('tools/call', { name: 'collab_doctor', arguments: {} });
    assert.match(doc.result.content[0].text, /collab doctor/);
    assert.match(doc.result.content[0].text, /Notebook/);
    assert.equal(child.exitCode, null, 'the server must still be running');
  } finally {
    // Wait for the exit, not just the kill: on Windows a process still shutting
    // down keeps its working folder, and rmdir fails with EBUSY.
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(root, { recursive: true, force: true });
  }
});
