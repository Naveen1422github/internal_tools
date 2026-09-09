// Assembles a clean, friend-installable Collab MCP bundle from the single source.
// Ships ONLY core + mcp (source) + onboarding assets. Never ships data/secrets/UI.
// Run: npm run bundle  ->  dist-share/collab-mcp/  (+ collab-mcp.zip)
import { cpSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const OUT = join(ROOT, 'dist-share', 'collab-mcp');

// Never ship these (matched against any path segment during copy).
const DENY = [
  /(^|[\\/])collab\.db($|-)/,        // runtime DB + -wal/-shm/-journal
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])dist([\\/]|$)/,          // built output — friend rebuilds
  /(^|[\\/])dist-share([\\/]|$)/,
  /(^|[\\/])\.env$/,
  /(^|[\\/])package-lock\.json$/,    // friend regenerates from the slim root package.json
];
const denied = (p) => DENY.some((re) => re.test(p));

const copyPkg = (name) =>
  cpSync(join(ROOT, name), join(OUT, name), {
    recursive: true,
    filter: (src) => !denied(src),
  });

// Fresh output dir
rmSync(join(ROOT, 'dist-share'), { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1. The two shipped packages (clean source).
copyPkg('core');
copyPkg('mcp');

// 2. Shared root config needed to build.
for (const f of ['tsconfig.base.json', '.nvmrc', '.env.example']) {
  if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(OUT, f));
}

// 3. Onboarding assets (created by later tasks; copied if present).
//    Format "src:dst" maps a source path to its bundle destination.
for (const spec of [
  'README.bundle.md:README.md',
  'SETUP-PROMPT.md:SETUP-PROMPT.md',
  'LICENSE:LICENSE',
  'AGENTS.md:AGENTS.md',
  'scripts/seed-starter.mjs:scripts/seed-starter.mjs',
  'skills/collab-workflow/SKILL.md:skills/collab-workflow/SKILL.md',
]) {
  const [src, dst] = spec.split(':');
  if (existsSync(join(ROOT, src))) {
    mkdirSync(dirname(join(OUT, dst)), { recursive: true });
    cpSync(join(ROOT, src), join(OUT, dst));
  }
}

// 4. A .gitignore so a friend's clone keeps their own data/build out of git.
writeFileSync(
  join(OUT, '.gitignore'),
  ['node_modules/', 'dist/', 'collab.db', 'collab.db-*', '.env', ''].join('\n'),
);

// 5. Slim root package.json: workspaces = core + mcp only.
writeFileSync(
  join(OUT, 'package.json'),
  JSON.stringify(
    {
      name: 'collab-mcp-bundle',
      version: '0.1.0',
      private: true,
      type: 'module',
      engines: { node: '>=20.9.0' },
      workspaces: ['core', 'mcp'],
      scripts: {
        build: 'npm -w @collab-mcp/core run build && npm -w collab-mcp run build',
        'seed:starter': 'node scripts/seed-starter.mjs',
      },
    },
    null,
    2,
  ) + '\n',
);

// 6. Zip it (PowerShell Compress-Archive ships with Windows).
try {
  const zip = join(ROOT, 'dist-share', 'collab-mcp.zip');
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Force -Path '${OUT}\\*' -DestinationPath '${zip}'"`,
    { stdio: 'inherit' },
  );
  console.log('Zipped ->', zip);
} catch {
  console.warn('zip step skipped (Compress-Archive unavailable)');
}

console.log('Bundle ready ->', OUT);
