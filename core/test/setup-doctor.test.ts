import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetupDoctor, startupProblem } from '../src/setup/engine.js';
import { getDb, closeDb, migrate } from '../src/db.js';
import { addEntry } from '../src/ops/add.js';
import { runtimeDirFor } from '../src/heartbeat.js';
import { addNotebook } from '../src/notebooks.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'collab-doc-'));
  const data = join(root, 'data'); const proj = join(root, 'proj'); mkdirSync(proj, { recursive: true });
  const nb = join(root, 'nb.db');
  const db = getDb(nb, { create: true }); migrate(db); closeDb();
  const base = { cwd: proj, env: { COLLAB_DATA_DIR: data } as NodeJS.ProcessEnv, dataDir: data, now: new Date(), probePostOffice: null, claudeConfigFiles: [], isAlive: () => true };
  return { root, data, proj, nb, base, done: () => rmSync(root, { recursive: true, force: true }) };
}
const by = (r: any, id: string) => r.checks.find((c: any) => c.id === id);

test('no notebook: notebook.choice is an error with the fix; dependent groups are skipped, not passed', async () => {
  const s = setup();
  try {
    const r = await runSetupDoctor({ ...s.base, groups: ['notebook', 'version', 'notes'] });
    assert.equal(by(r, 'notebook.choice').mark, 'error');
    assert.match(by(r, 'notebook.choice').fix, /collab notebook/);
    assert.ok(r.checks.filter((c: any) => c.group === 'version').every((c: any) => c.mark === 'skipped'));
    assert.equal(r.exitCode, 2);
  } finally { s.done(); }
});

test('registered default notebook on the latest migration: notebook + version are ok', async () => {
  const s = setup();
  try {
    addNotebook('emp1st', s.nb, s.data);
    const r = await runSetupDoctor({ ...s.base, groups: ['notebook', 'version'] });
    assert.equal(by(r, 'notebook.choice').mark, 'ok');
    assert.match(by(r, 'notebook.choice').text, /emp1st \(the default notebook\)/);
    assert.equal(by(r, 'version.notebook').mark, 'ok');
    assert.equal(r.exitCode, 0);
    assert.equal(r.notebook?.name, 'emp1st');
  } finally { s.done(); }
});

test('COLLAB_DB_PATH vs .collab disagreement is an error', async () => {
  const s = setup();
  try {
    addNotebook('emp1st', s.nb, s.data);
    const other = join(s.root, 'other.db'); const db = getDb(other, { create: true }); migrate(db); closeDb();
    addNotebook('supporthub', other, s.data);
    writeFileSync(join(s.proj, '.collab'), 'notebook = supporthub\n');
    const r = await runSetupDoctor({ ...s.base, env: { ...s.base.env, COLLAB_DB_PATH: s.nb }, groups: ['notebook'] });
    assert.equal(by(r, 'notebook.clash').mark, 'error');
    assert.match(by(r, 'notebook.clash').fix, /COLLAB_DB_PATH/);
  } finally { s.done(); }
});

test('a check that throws becomes an error line and the rest still run', async () => {
  const s = setup();
  mkdirSync(s.data, { recursive: true });
  writeFileSync(join(s.data, 'config.json'), '{ broken');
  try {
    const r = await runSetupDoctor({ ...s.base, groups: ['install', 'notebook'] });
    assert.equal(by(r, 'notebook.choice').mark, 'error');
    assert.match(by(r, 'notebook.choice').text, /config\.json/);
    assert.ok(by(r, 'install.node'));
  } finally { s.done(); }
});

test('startupProblem returns the first blocking error, or null', async () => {
  const s = setup();
  try {
    assert.equal((await startupProblem({ ...s.base }))?.id, 'notebook.choice');
    addNotebook('emp1st', s.nb, s.data);
    const p = await startupProblem({ ...s.base });
    assert.ok(p === null || p.group === 'install', 'only an install problem (e.g. add-on missing in CI) may remain');
  } finally { s.done(); }
});

test('programs: an MCP running older code than is installed is an error with the /mcp fix', async () => {
  const s = setup();
  const prevRoot = process.env.COLLAB_INSTALL_ROOT;
  try {
    addNotebook('emp1st', s.nb, s.data);
    const fake = join(s.root, 'install');
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, 'addon-manifest.json'), JSON.stringify({ version: 'v0.16.3', platforms: {} }));
    writeFileSync(join(fake, 'package.json'), JSON.stringify({ version: '0.1.0', engines: { node: '>=20.9.0' } }));
    writeFileSync(join(fake, 'build-info.json'), JSON.stringify({ version: '0.1.0', build: 'new', builtAt: '2026-10-05T18:40:00Z' }));
    process.env.COLLAB_INSTALL_ROOT = fake;
    const run = join(runtimeDirFor({ path: s.nb, name: 'emp1st' }, s.data), 'running');
    mkdirSync(run, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(join(run, `mcp-${process.pid}.json`), JSON.stringify({ program: 'mcp', version: '0.1.0', build: 'old', pid: process.pid, startedAt: now, beatAt: now, dbPath: s.nb, notebook: 'emp1st' }));
    const r = await runSetupDoctor({ ...s.base, groups: ['notebook', 'programs'] });
    assert.equal(by(r, 'programs.mcp').mark, 'error');
    assert.match(by(r, 'programs.mcp').text, /running older code than is installed/);
    assert.match(by(r, 'programs.mcp').fix, /\/mcp/);
  } finally {
    if (prevRoot === undefined) delete process.env.COLLAB_INSTALL_ROOT; else process.env.COLLAB_INSTALL_ROOT = prevRoot;
    s.done();
  }
});

test('claude: a file-path entry is a warning with the replacement; collab mcp is ok; none is a warning', async () => {
  const s = setup();
  try {
    addNotebook('emp1st', s.nb, s.data);
    const f = join(s.proj, '.mcp.json');
    const run = () => runSetupDoctor({ ...s.base, claudeConfigFiles: [f], groups: ['notebook', 'claude'] });
    writeFileSync(f, JSON.stringify({ mcpServers: { collab: { command: 'node', args: ['internal-tools/mcp/dist/server.js'] } } }));
    let c = by(await run(), 'claude.registered');
    assert.equal(c.mark, 'warn');
    assert.match(c.fix, /"command": "collab", "args": \["mcp"\]/);
    writeFileSync(f, JSON.stringify({ mcpServers: { collab: { command: 'collab', args: ['mcp'] } } }));
    assert.equal(by(await run(), 'claude.registered').mark, 'ok');
    rmSync(f);
    c = by(await run(), 'claude.registered');
    assert.equal(c.mark, 'warn');
    assert.match(c.fix, /claude mcp add/);
  } finally { s.done(); }
});

test('notes: a live note missing from the search index is an error with the reindex fix', async () => {
  const s = setup();
  try {
    addNotebook('emp1st', s.nb, s.data);
    const db = getDb(s.nb);
    addEntry(db, { type: 'decision', title: 'findable', summary: 's' });
    db.exec('DELETE FROM entries_fts');
    closeDb();
    const r = await runSetupDoctor({ ...s.base, groups: ['notebook', 'notes'] });
    assert.equal(by(r, 'notes.search').mark, 'error');
    assert.equal(by(r, 'notes.search').text, "1 note(s) can't be found by search");
    assert.match(by(r, 'notes.search').fix, /collab notebook reindex/);
  } finally { s.done(); }
});

test('sync is one skipped line when sharing is off', async () => {
  const s = setup();
  try {
    addNotebook('emp1st', s.nb, s.data);
    const r = await runSetupDoctor({ ...s.base, groups: ['notebook', 'sync'] });
    const sync = r.checks.filter((c: any) => c.group === 'sync');
    assert.equal(sync.length, 1);
    assert.equal(sync[0].mark, 'skipped');
  } finally { s.done(); }
});

// A connection that loaded cr-sqlite must run crsql_finalize() before close(),
// or close() returns while the file stays open (a leaked handle). Windows then
// refuses to delete or move the notebook; Linux doesn't notice, so this test
// only fails on Windows, which is where the leak hurts.
test('doctor and the startup check release a SHARED notebook file when they finish', async () => {
  const s = setup();
  try {
    const { enableSync } = await import('../src/sync/enable.js');
    const shared = join(s.root, 'shared.db');
    const h = getDb(shared, { create: true }); migrate(h, { includeStaged: true }); enableSync(h); closeDb();
    const env = { ...s.base.env, COLLAB_DB_PATH: shared };
    const { startupProblemSync } = await import('../src/setup/engine.js');
    startupProblemSync({ ...s.base, env });
    await runSetupDoctor({ ...s.base, env });
    const { unlinkSync } = await import('node:fs');
    assert.doesNotThrow(() => unlinkSync(shared), 'the notebook file is still held open');
  } finally {
    // A leaked handle also blocks this cleanup; don't let that error hide the assertion above.
    try { s.done(); } catch { /* reported by the assertion */ }
  }
});
