#!/usr/bin/env node
// Assembles the installable collab package (spec P2) from the built workspaces:
//   dist-package/collab/                      an npm-installable folder
//   dist-package/collab-mcp-collab-<v>.tgz    from npm pack
// Prebuilt: nobody runs `npm run build` on a user's machine. The cr-sqlite
// add-on is NOT shipped; the package's postinstall downloads and checks it.
// Usage: npm run build && npm run package
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'dist-package');
const OUT = join(OUT_DIR, 'collab');

// Bundled workspaces: folder -> package name inside node_modules.
const BUNDLED = { core: '@collab-mcp/core', courier: '@collab-mcp/courier', 'post-office': '@collab-mcp/post-office', server: '@collab-mcp/server', mcp: 'collab-mcp' };

// Never ship these (carried over from the retired scripts/bundle.mjs).
const DENY = [
  /(^|[\\/])collab\.db/,
  /(^|[\\/])store\.db/,
  /(^|[\\/])\.env$/,
  /(^|[\\/])backups([\\/]|$)/,
  /\.db-wal$/,
];

const die = (msg) => { console.error(`package: ${msg}`); process.exit(1); };
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// 1. Inputs must exist: this script assembles, it never builds.
const needed = ['build-info.json', 'cli/dist', 'ui/dist/index.html', ...Object.keys(BUNDLED).map((w) => `${w}/dist`)];
for (const n of needed) if (!existsSync(join(ROOT, n))) die(`${n} is missing: run npm run build first`);
const info = readJson(join(ROOT, 'build-info.json'));

// 2. Fresh layout, real files only (workspaces are symlinks in node_modules, so copy from the workspace folders).
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const copy = (from, to) => cpSync(join(ROOT, from), join(OUT, to), { recursive: true, dereference: true });
copy('addon-manifest.json', 'addon-manifest.json');
copy('build-info.json', 'build-info.json');
copy('cli/dist', 'cli/dist');
copy('ui/dist', 'ui/dist');
// A bundled package's package.json keeps only what Node needs to load it. Its
// dependencies are dropped on purpose: npm treats every dependency of a bundled
// package as part of the bundle and never fetches it (a global install got
// empty better-sqlite3/ folders). They are top-level dependencies instead (4.).
const RUNTIME_FIELDS = ['name', 'version', 'type', 'main', 'types', 'exports', 'bin', 'engines'];
for (const [w, name] of Object.entries(BUNDLED)) {
  const src = readJson(join(ROOT, w, 'package.json'));
  mkdirSync(join(OUT, 'node_modules', name), { recursive: true });
  writeFileSync(join(OUT, 'node_modules', name, 'package.json'),
    JSON.stringify(Object.fromEntries(RUNTIME_FIELDS.filter((k) => k in src).map((k) => [k, src[k]])), null, 2) + '\n');
  copy(`${w}/dist`, `node_modules/${name}/dist`);
}
if (existsSync(join(ROOT, 'README.md'))) copy('README.md', 'README.md');
if (existsSync(join(ROOT, 'LICENSE'))) copy('LICENSE', 'LICENSE');

// 3. Released migrations only (never staged/); an empty add-on folder for postinstall.
mkdirSync(join(OUT, 'mcp', 'migrations'), { recursive: true });
for (const f of readdirSync(join(ROOT, 'mcp', 'migrations')).filter((f) => f.endsWith('.sql'))) {
  copy(`mcp/migrations/${f}`, `mcp/migrations/${f}`);
}
mkdirSync(join(OUT, 'vendor', 'crsqlite'), { recursive: true });
writeFileSync(join(OUT, 'vendor', 'crsqlite', '.keep'), '');

// 4. package.json: version from the build; third-party runtime deps of every bundled workspace.
const minorPatch = (range) => (range.match(/\d+(?:\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
const higher = (a, b) => {
  const x = minorPatch(a), y = minorPatch(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? a : b;
  return a;
};
const deps = {};
for (const w of [...Object.keys(BUNDLED), 'cli']) {
  for (const [name, range] of Object.entries(readJson(join(ROOT, w, 'package.json')).dependencies ?? {})) {
    if (name.startsWith('@collab-mcp/') || name === 'collab-mcp') continue;
    deps[name] = deps[name] && deps[name] !== range ? higher(deps[name], range) : range;
  }
}
// npm packs a bundleDependencies entry only when it is also a dependency; the
// bundled copy then satisfies it, so nothing is fetched from a registry for it.
for (const [w, name] of Object.entries(BUNDLED)) deps[name] = readJson(join(ROOT, w, 'package.json')).version;
const pkg = readJson(join(ROOT, 'package', 'package.template.json'));
pkg.version = info.version;
pkg.dependencies = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(OUT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
console.log(`package: ${pkg.name}@${pkg.version} (build ${info.build})`);
for (const [n, r] of Object.entries(pkg.dependencies)) console.log(`  dependency ${n} ${r}`);

// 5. Deny list over everything assembled.
const walk = (d, out = []) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; };
for (const f of walk(OUT)) {
  const rel = relative(OUT, f);
  if (DENY.some((re) => re.test(rel))) { rmSync(OUT, { recursive: true, force: true }); die(`refusing to ship ${rel}`); }
}

// 6. npm pack, tarball next to the folder.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tgz = execFileSync(npm, ['pack', '--silent'], { cwd: OUT, encoding: 'utf8', shell: process.platform === 'win32' }).trim().split(/\r?\n/).pop();
rmSync(join(OUT_DIR, tgz), { force: true });
renameSync(join(OUT, tgz), join(OUT_DIR, tgz));
console.log(`package: ${join('dist-package', tgz)}`);
