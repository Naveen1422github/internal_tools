import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHeartbeat, readHeartbeats, removeStaleHeartbeats, runtimeDirFor } from '../src/heartbeat.js';

test('an adopted notebook inside a repo gets its runtime folder in the DATA folder, never next to the file', () => {
  const data = '/data';
  assert.equal(runtimeDirFor({ path: '/repo/internal-tools/mcp/collab.db', name: 'emp1st' }, data), join(data, 'notebooks', 'emp1st'));
  assert.match(runtimeDirFor({ path: '/repo/internal-tools/mcp/collab.db', name: null }, data), /notebooks[\\/]_path-/);
});

test('heartbeat is written, refreshed, and removed on stop', async () => {
  const d = mkdtempSync(join(tmpdir(), 'collab-hb-'));
  try {
    const h = startHeartbeat(d, { program: 'mcp', version: '0.1.0', build: 'b1', dbPath: '/x.db', notebook: 'emp1st' }, { intervalMs: 20 });
    const [hb] = readHeartbeats(d);
    assert.deepEqual([hb.program, hb.build, hb.pid, hb.stale], ['mcp', 'b1', process.pid, false]);
    const first = hb.beatAt;
    await new Promise((r) => setTimeout(r, 60));
    assert.notEqual(readHeartbeats(d)[0].beatAt, first);
    h.stop();
    assert.equal(readdirSync(join(d, 'running')).length, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('stale = pid gone or beat older than 90 s; removeStale deletes only those', () => {
  const d = mkdtempSync(join(tmpdir(), 'collab-hb-'));
  try {
    mkdirSync(join(d, 'running'));
    const now = new Date('2026-10-05T10:00:00Z');
    const mk = (pid: number, beatAt: string) =>
      writeFileSync(join(d, 'running', `web-${pid}.json`), JSON.stringify({ program: 'web', version: 'v', build: 'b', pid, startedAt: beatAt, beatAt, dbPath: '/x', notebook: null }));
    mk(1, '2026-10-05T09:59:30Z'); // fresh, alive
    mk(2, '2026-10-05T09:57:00Z'); // too old
    mk(3, '2026-10-05T09:59:50Z'); // fresh but dead
    const alive = (pid: number) => pid !== 3;
    const stale = readHeartbeats(d, now, alive).filter((h) => h.stale).map((h) => h.pid).sort();
    assert.deepEqual(stale, [2, 3]);
    assert.equal(removeStaleHeartbeats(d, now, alive).length, 2);
    assert.deepEqual(readHeartbeats(d, now, alive).map((h) => h.pid), [1]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('an unreadable heartbeat file is reported stale, not thrown', () => {
  const d = mkdtempSync(join(tmpdir(), 'collab-hb-'));
  try {
    mkdirSync(join(d, 'running'));
    writeFileSync(join(d, 'running', 'mcp-9.json'), '{');
    const [h] = readHeartbeats(d);
    assert.equal(h.stale, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
