// consumed by tools/console.js spawn(); see briefs/T3-agent-adapters.md
const { detectBinary } = require('./base');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// Require codex to reuse internal paths and resolution logic but use bash out-of-band to change profile since we can't reliably invoke routes
const codexToolPath = path.join(__dirname, '..', 'codex.js');
let codexTool = null;
if (fs.existsSync(codexToolPath)) {
  codexTool = require(codexToolPath);
}

const HOME = os.homedir();
const PROFILES_DIR = path.join(HOME, '.codex', 'profiles');
const TRACKER = path.join(PROFILES_DIR, 'tracker.json');

function resolveBash() {
  const candidates = [
    process.env.GIT_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return 'bash';
}

function runScript(args) {
  const bash = resolveBash();
  return new Promise((resolve) => {
    const p = spawn(bash, ['codex-profile.sh', ...args], { cwd: PROFILES_DIR, stdio: 'ignore' });
    p.on('close', code => resolve(code));
    p.on('error', () => resolve(-1));
  });
}

function readTracker() {
  try {
    return JSON.parse(fs.readFileSync(TRACKER, 'utf8'));
  } catch {
    return { active_profile: null, profiles: {}, switch_log: [] };
  }
}

function writeTracker(t) {
  fs.writeFileSync(TRACKER, JSON.stringify(t, null, 2));
}

function isAvailable(p) {
  if (!p.limit_resets_at) return true;
  return new Date(p.limit_resets_at).getTime() <= Date.now();
}

function pickNext() {
  const state = readTracker();
  const candidates = Object.entries(state.profiles)
    .filter(([n, p]) => n !== state.active_profile && isAvailable(p))
    .sort((a, b) => (new Date(a[1].last_activated || 0)) - (new Date(b[1].last_activated || 0)));
  if (candidates.length > 0) return candidates[0][0];
  return null; // no ready identities
}

module.exports = {
  name: 'codex',

  detect: async () => detectBinary('codex'),

  spawnArgs: (opts = {}) => {
    let profile = opts.profile;
    if (!profile) {
      profile = pickNext();
    }

    if (profile) {
       const bash = resolveBash();
       try {
         const { execFileSync } = require('child_process');
         execFileSync(bash, ['codex-profile.sh', 'switch', profile], { cwd: PROFILES_DIR, stdio: 'ignore' });
       } catch (e) {
         // ignore
       }
    }

    const args = [];
    if (!opts.autoYes) {
      args.push('--no-auto-confirm');
    }

    const { formatEnvelope } = require('./envelope');
    let initialStdin = undefined;
    if (opts.task) {
      initialStdin = formatEnvelope(opts.task, opts);
    }

    return {
      file: 'codex',
      args,
      env: opts.env || process.env,
      cwd: opts.cwd || process.cwd(),
      initialStdin,
    };
  },

  onExit: async (session, exitCode) => {
    if (exitCode === 429) {
      const state = readTracker();
      const active = state.active_profile;
      if (active && state.profiles[active]) {
        state.profiles[active].limit_hit_at = new Date().toISOString().split('.')[0] + 'Z';
        state.profiles[active].limit_resets_at = new Date(Date.now() + 7 * 86400000).toISOString().split('.')[0] + 'Z';
        writeTracker(state);
      }
    }
  }
};
