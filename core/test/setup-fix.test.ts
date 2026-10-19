// UI parity Task 7b: the safe setup repairs, shared by `collab doctor --fix` and the Health page.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixableIds, runSafeFix, SAFE_FIXES } from '../src/setup/fix.js';
import { runtimeDirFor } from '../src/heartbeat.js';
import type { SetupReport } from '../src/setup/types.js';

const report = (checks: Array<{ id: string; mark: string }>, notebook: SetupReport['notebook'] = null): SetupReport =>
  ({ checks: checks.map((c) => ({ group: 'install', text: c.id, ...c })) as any, errors: 0, warnings: 0, exitCode: 0, notebook });

test('fixableIds: the add-on only when missing (error), stale status files only with a notebook; in --fix order', () => {
  const nb = { name: 'main', path: '/x/notebook.db', source: 'default', described: 'main' };
  assert.deepEqual(fixableIds(report([{ id: 'install.addon', mark: 'ok' }])), []);
  assert.deepEqual(fixableIds(report([{ id: 'programs.stale', mark: 'warn' }, { id: 'install.addon', mark: 'error' }], nb)), ['install.addon', 'programs.stale']);
  assert.deepEqual(fixableIds(report([{ id: 'programs.stale', mark: 'warn' }])), [], 'no notebook: nothing to clean');
  assert.deepEqual(Object.keys(SAFE_FIXES), ['install.addon', 'programs.stale']);
});

test('runSafeFix(programs.stale) removes a dead program\'s status file and keeps a live one', async () => {
  const data = mkdtempSync(join(tmpdir(), 'collab-fix-'));
  const saved = process.env.COLLAB_DATA_DIR;
  process.env.COLLAB_DATA_DIR = data;
  try {
    const nb = { name: 'main', path: join(data, 'notebook.db'), source: 'default', described: 'main' };
    const dir = join(runtimeDirFor({ name: 'main', path: nb.path }), 'running');
    mkdirSync(dir, { recursive: true });
    const hb = (pid: number) => JSON.stringify({ program: 'web', pid, version: '1', build: 'b', dbPath: nb.path, notebook: 'main', startedAt: new Date().toISOString(), beatAt: new Date().toISOString() });
    writeFileSync(join(dir, 'web-999999.json'), hb(999999));
    writeFileSync(join(dir, `web-${process.pid}.json`), hb(process.pid));
    assert.equal(await runSafeFix('programs.stale', report([], nb)), null);
    assert.equal(existsSync(join(dir, 'web-999999.json')), false);
    assert.equal(existsSync(join(dir, `web-${process.pid}.json`)), true);
    assert.equal(await runSafeFix('programs.stale', report([])), 'no notebook is open');
  } finally {
    if (saved === undefined) delete process.env.COLLAB_DATA_DIR; else process.env.COLLAB_DATA_DIR = saved;
    rmSync(data, { recursive: true, force: true });
  }
});
