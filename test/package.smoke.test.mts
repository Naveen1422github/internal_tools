import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds, assembles and installs the real package, so it only runs on request:
//   COLLAB_PACKAGE_SMOKE=1 npx tsx --test test/package.smoke.test.mts
// COLLAB_SMOKE_NETWORK=1 also checks that `collab doctor --fix` fetches the add-on.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const shell = process.platform === 'win32';

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

/**
 * The environment of a machine with no repo: npx / npm run put the repo's
 * node_modules/.bin on PATH and describe the repo in npm_package_* and
 * npm_lifecycle_* vars. Machine settings (npm_config_*, e.g. a proxy) stay.
 */
function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^npm_(package|lifecycle)_|^npm_(execpath|command)$|^npm_config_local_prefix$/i.test(k)) env[k] = v;
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const k of Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')) {
    env[k] = env[k]!.split(sep).filter((d) => !/node_modules[\\/]\.bin/.test(d)).join(sep);
  }
  for (const k of ['COLLAB_DB_PATH', 'COLLAB_NOTEBOOK', 'COLLAB_DB_CREATE', 'COLLAB_INSTALL_ROOT', 'COLLAB_CRSQLITE_PATH']) delete env[k];
  return { ...env, ...extra };
}

/** Starts a long-running collab command; resolves with the first stdout line matching `ready`, or the exit. */
function startUntil(bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }, ready: RegExp, input?: string) {
  const child = spawn(bin, args, { ...opts, shell, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  const done = new Promise<{ line: string | null; code: number | null; err: string }>((resolve) => {
    const timer = setTimeout(() => resolve({ line: null, code: null, err }), 20000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.split(/\r?\n/).find((l) => ready.test(l));
      if (m) { clearTimeout(timer); resolve({ line: m, code: null, err }); }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ line: null, code, err }); });
  });
  if (input) child.stdin.write(input);
  return { child, done };
}
const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } }) + '\n';

test('the assembled package installs with no repo around it and works', { skip: process.env.COLLAB_PACKAGE_SMOKE !== '1', timeout: 900_000 }, async () => {
  execFileSync(NPM, ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell });
  execFileSync(NPM, ['run', 'package'], { cwd: ROOT, stdio: 'inherit', shell });
  const tgz = readdirSync(join(ROOT, 'dist-package')).find((f) => /^collab-mcp-collab-.*\.tgz$/.test(f));
  assert.ok(tgz, 'npm run package made no .tgz');

  const tmp = mkdtempSync(join(tmpdir(), 'collab-smoke-'));
  try {
    const prefix = join(tmp, 'prefix');
    const cwd = join(tmp, 'work');
    execFileSync(NPM, ['install', '-g', '--prefix', prefix, join(ROOT, 'dist-package', tgz)], {
      cwd: tmp, stdio: 'inherit', shell, env: cleanEnv({ COLLAB_SKIP_ADDON: '1' }),
    });
    execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(cwd)})`]);
    const bin = process.platform === 'win32' ? join(prefix, 'collab.cmd') : join(prefix, 'bin', 'collab');
    const env = cleanEnv({ COLLAB_DATA_DIR: join(tmp, 'data'), COLLAB_WEB_KEY_FILE: join(tmp, 'web-key') });
    const collab = (...args: string[]) => spawnSync(bin, args, { cwd, env, encoding: 'utf8', shell });

    const v = collab('--version');
    assert.equal(v.status, 0, v.stderr);
    assert.match(v.stdout, /^collab /);

    const n = collab('notebook', 'new', 'smoke');
    assert.equal(n.status, 0, n.stderr);
    assert.ok(existsSync(join(tmp, 'data', 'notebooks', 'smoke', 'notebook.db')));

    const d = collab('doctor', '--json');
    const report = JSON.parse(d.stdout);
    const by = (id: string) => report.checks.find((c: any) => c.id === id);
    assert.equal(by('install.addon').mark, 'error');
    assert.match(by('install.addon').fix, /collab doctor --fix/);
    assert.equal(by('notebook.choice').mark, 'ok');

    // Without the add-on: the MCP still answers (degraded, spec P12); the web server refuses with the fix.
    const mcp0 = startUntil(bin, ['mcp'], { cwd, env }, /"result"/, INIT);
    const m0 = await mcp0.done; mcp0.child.kill();
    assert.ok(m0.line, `collab mcp did not answer initialize: ${m0.err}`);
    const web0 = startUntil(bin, ['web'], { cwd, env: { ...env, PORT: '0' } }, /^collab web: http/);
    const w0 = await web0.done; web0.child.kill();
    assert.equal(w0.code, 2, w0.err);
    assert.match(w0.err, /fix: collab doctor --fix/);

    if (process.env.COLLAB_SMOKE_NETWORK === '1') {
      collab('doctor', '--fix');
      const again = JSON.parse(collab('doctor', '--json').stdout);
      assert.equal(again.checks.find((c: any) => c.id === 'install.addon').mark, 'ok');
      const web = startUntil(bin, ['web'], { cwd, env: { ...env, PORT: '0' } }, /^collab web: http/);
      const w = await web.done;
      try {
        assert.ok(w.line, `collab web did not start: ${w.err}`);
        const url = w.line!.match(/http:\/\/\S+/)![0];
        const res = await fetch(url);
        assert.equal(res.status, 200);
        assert.match(await res.text(), /<div id="root">/);
      } finally { web.child.kill(); }
    }

    const installed = walk(prefix).map((p) => p.replace(/\\/g, '/'));
    for (const bad of [/\/collab\.db/, /\/\.env$/, /\/store\.db/]) {
      assert.deepEqual(installed.filter((p) => bad.test(p)), [], `the package must not ship ${bad}`);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
