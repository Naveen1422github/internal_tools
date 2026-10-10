// file: mcp/test/project-tools.test.ts
// Stage B1: MCP tools take SH-12 style references, default to the folder's
// current project (.collab) and start their answers with a status line (rule 8).
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate, addEntry, createProject, addNotebook, initModule, enableSync, setSyncValue } from '@collab-mcp/core';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.js');

async function withServer(fn: (h: {
  root: string; dbPath: string; sh: string;
  call: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean; structured: any }>;
  setProject: (ulid: string | null) => void;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'collab-mcp-projects-'));
  const dbPath = join(root, 'collab.db');
  const db = new Database(dbPath);
  migrate(db);
  const sh = createProject(db, { name: 'supporthub', code: 'SH' }).ulid;
  initModule(db, { slug: 'demo' });
  addEntry(db, { type: 'decision', title: 'E one', summary: 'e note', module: 'demo' });           // E-1
  addEntry(db, { type: 'decision', title: 'SH one', summary: 'sh note', module: 'demo', project: 'SH' }); // SH-1
  db.close();
  const setProject = (ulid: string | null) =>
    writeFileSync(join(root, '.collab'), `notebook = t\n${ulid ? `project = ${ulid}\n` : ''}`);
  setProject(null);
  addNotebook('t', dbPath, join(root, 'data')); // the .collab names notebook t, registered in a temp data folder
  const env: NodeJS.ProcessEnv = { ...process.env, COLLAB_DATA_DIR: join(root, 'data') };
  delete env.COLLAB_DB_PATH; delete env.COLLAB_NOTEBOOK; delete env.CLAUDE_PROJECT_DIR; delete env.COLLAB_DB_CREATE;
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
  const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}; stderr:\n${stderr}`)), 15000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const m = await rpc('tools/call', { name, arguments: args });
    if (m.error) return { text: String(m.error.message), isError: true, structured: null };
    return { text: m.result.content.map((c: any) => c.text).join('\n'), isError: !!m.result.isError, structured: m.result.structuredContent };
  };
  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await fn({ root, dbPath, sh, call, setProject });
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(root, { recursive: true, force: true });
  }
}

test('collab_get: a bare number is E; "SH-1" is the project note; a bad string lists the accepted forms', async () => {
  await withServer(async ({ call }) => {
    const e = await call('collab_get', { id: 1 });
    assert.equal(e.isError, false, e.text);
    assert.equal(e.structured.title, 'E one');
    assert.match(e.text, /\[E-00001\]/);
    const s = await call('collab_get', { id: 'SH-1' });
    assert.equal(s.structured.title, 'SH one');
    assert.match(s.text, /\[SH-1\]/);
    const bad = await call('collab_get', { id: 'SH1' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /E-00760/);
    assert.match(bad.text, /SH-12/);
  });
});

test('collab_supersede with string refs writes the replacement by ULID', async () => {
  await withServer(async ({ call, dbPath }) => {
    const r = await call('collab_supersede', { ids: ['SH-1'], by: 1 });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /SH-1/);
    assert.match(r.text, /E-00001/);
    const db = new Database(dbPath, { readonly: true });
    try {
      const e1 = (db.prepare(`SELECT ulid FROM entries WHERE series = 'E' AND id = 1`).get() as any).ulid;
      const sh1 = db.prepare(`SELECT superseded_by_ulid u, deprecated d FROM entries WHERE series = 'SH' AND id = 1`).get() as any;
      assert.equal(sh1.u, e1);
      assert.equal(sh1.d, 1);
      assert.equal((db.prepare(`SELECT deprecated d FROM entries WHERE series = 'E' AND id = 1`).get() as any).d, 0);
    } finally { db.close(); }
  });
});

test('search defaults to the current project; scope all returns both; answers start with the status line', async () => {
  await withServer(async ({ call, setProject, sh }) => {
    const none = await call('collab_search', { query: '' });
    assert.equal(none.isError, false, none.text);
    assert.match(none.text, /^project: none \(E series\)/);
    assert.equal(none.structured.results.length, 2, 'no current project: everything, as today');
    setProject(sh);
    const p = await call('collab_search', { query: '' });
    assert.match(p.text, /^project: SH supporthub \(solo\)/);
    assert.deepEqual(p.structured.results.map((r: any) => `${r.series}-${r.id}`), ['SH-1']);
    assert.match(p.text, /\[SH-1\]/);
    const all = await call('collab_search', { query: '', scope: 'all' });
    assert.deepEqual(all.structured.results.map((r: any) => `${r.series}-${r.id}`).sort(), ['E-1', 'SH-1']);
    const recent = await call('collab_list_recent', { kind: 'any' });
    assert.deepEqual(recent.structured.results.map((r: any) => `${r.series}-${r.id}`), ['SH-1']);
    const card = await call('collab_module_get', { slug: 'demo' });
    assert.deepEqual(card.structured.recent_decisions.map((d: any) => d.title), ['SH one']);
    const cardAll = await call('collab_module_get', { slug: 'demo', scope: 'all' });
    assert.equal(cardAll.structured.recent_decisions.length, 2);
  });
});

test('collab_add writes into the current project and says so; project "none" writes an E note', async () => {
  await withServer(async ({ call, setProject, sh }) => {
    const plain = await call('collab_add', { type: 'gotcha', title: 'g', summary: 's' });
    assert.match(plain.text, /^project: none \(E series\)/);
    assert.match(plain.text, /Added E-00002/);
    setProject(sh);
    const a = await call('collab_add', { type: 'gotcha', title: 'g2', summary: 's' });
    assert.equal(a.isError, false, a.text);
    assert.match(a.text, /^project: SH supporthub \(solo\)/);
    assert.match(a.text, /Added SH-2/);
    const e = await call('collab_add', { type: 'gotcha', title: 'g3', summary: 's', project: 'none' });
    assert.match(e.text, /Added E-00003/);
    const u = await call('collab_update', { id: 'SH-2', summary: 'edited' });
    assert.equal(u.isError, false, u.text);
    assert.match(u.text, /Updated SH-2/);
  });
});

test('.collab naming a project that is not in this notebook: a clear error, never a fall back to E', async () => {
  await withServer(async ({ call, setProject }) => {
    setProject('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    const r = await call('collab_add', { type: 'gotcha', title: 'g', summary: 's' });
    assert.equal(r.isError, true);
    assert.match(r.text, /collab project list/);
    assert.match(r.text, /\.collab/);
  });
});

// Stage C, rule 8: a team project's status line says how the office looks and what waits.
test('status line: a team project shows the office state and its pending notes; E pending shows with no project', async () => {
  const cdir = mkdtempSync(join(tmpdir(), 'collab-courier-status-'));
  writeFileSync(join(cdir, 'status.json'), JSON.stringify({ state: 'connected', lastError: null, pid: process.pid }));
  writeFileSync(join(cdir, 'courier.pid'), String(process.pid));
  const saved = process.env.COLLAB_COURIER_DIR;
  process.env.COLLAB_COURIER_DIR = cdir; // the spawned server inherits it
  try {
    await withServer(async ({ call, dbPath, setProject }) => {
      const tm = '01J0000000000000000000TEAM';
      const db = new Database(dbPath);
      try {
        enableSync(db);
        setSyncValue(db, 'po_url', 'https://127.0.0.1:1');
        setSyncValue(db, 'po_fingerprint', 'fp');
        setSyncValue(db, 'device_id', 'd');
        setSyncValue(db, 'device_key', 'k');
        db.prepare(`INSERT INTO projects (ulid, name, code, mode, team) VALUES (?, 'Team', 'TM', 'team', 'fp')`).run(tm);
        addEntry(db, { type: 'decision', title: 'tm 1', summary: 's', project: 'TM' });
        addEntry(db, { type: 'decision', title: 'tm 2', summary: 's', project: 'TM' });
        addEntry(db, { type: 'decision', title: 'e waiting', summary: 's' });
      } finally { db.prepare('SELECT crsql_finalize()').get(); db.close(); }
      setProject(tm);
      const s = await call('collab_search', { query: '' });
      assert.equal(s.isError, false, s.text);
      assert.match(s.text, /^project: TM Team \(team, office connected, 2 pending\)/);
      setProject(null);
      const n = await call('collab_search', { query: '', scope: 'all' });
      assert.match(n.text, /^project: none \(E series, 1 pending\)/);
    });
  } finally {
    if (saved === undefined) delete process.env.COLLAB_COURIER_DIR; else process.env.COLLAB_COURIER_DIR = saved;
    rmSync(cdir, { recursive: true, force: true });
  }
});

// Stage C, spec P6: a pending note (no number yet) is reached and linked by its ULID.
test('pending notes by ULID: get, update, update_refs and supersede take the ULID; unknown ULID is not found', async () => {
  await withServer(async ({ call, dbPath }) => {
    const db = new Database(dbPath);
    let pendingUlid: string;
    try {
      db.prepare(`INSERT INTO projects (ulid, name, code, mode, team) VALUES ('01J0000000000000000000TEAM', 'Team', 'TM', 'team', 'fp')`).run();
      const p = addEntry(db, { type: 'decision', title: 'Waiting for a number', summary: 'pending', project: 'TM' });
      assert.equal(p.pending, true);
      pendingUlid = p.ulid;
    } finally { db.close(); }
    const g = await call('collab_get', { id: pendingUlid });
    assert.equal(g.isError, false, g.text);
    assert.equal(g.structured.title, 'Waiting for a number');
    assert.match(g.text, /\[TM-pending /);
    const lower = await call('collab_get', { id: pendingUlid.toLowerCase() });
    assert.equal(lower.structured.title, 'Waiting for a number');
    const u = await call('collab_update', { id: pendingUlid, summary: 'edited while pending' });
    assert.equal(u.isError, false, u.text);
    assert.match(u.text, /Updated TM-pending/);
    const r = await call('collab_update_refs', { id: pendingUlid, add: [{ ref_type: 'entry', ref_value: '1' }] });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /TM-pending .* refs: \+entry:1/);
    const s = await call('collab_supersede', { ids: [1], by: pendingUlid });
    assert.equal(s.isError, false, s.text);
    assert.match(s.text, /replaced by TM-pending/);
    const check = new Database(dbPath, { readonly: true });
    try {
      assert.equal((check.prepare(`SELECT superseded_by_ulid u FROM entries WHERE series = 'E' AND id = 1`).get() as any).u, pendingUlid);
      assert.equal((check.prepare(`SELECT summary FROM entries WHERE ulid = ?`).get(pendingUlid) as any).summary, 'edited while pending');
    } finally { check.close(); }
    // The same not-found answer a missing number gets (today an MCP error: structuredContent null).
    const missing = await call('collab_get', { id: '01J0000000000000000000000Z' });
    const missingNumber = await call('collab_get', { id: 99999 });
    assert.equal(missing.isError, true);
    assert.equal(missing.isError, missingNumber.isError);
    const missingUpd = await call('collab_update', { id: '01J0000000000000000000000Z', summary: 'x' });
    assert.equal(missingUpd.isError, true);
    assert.match(missingUpd.text, /no entry found/);
  });
});
