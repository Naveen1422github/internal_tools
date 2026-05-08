// consumed by tools/console.js spawn(); see briefs/T3-agent-adapters.md
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { detectBinary } = require('./base');
const { formatEnvelope } = require('./envelope');

const HOME = os.homedir();
const PROFILES_DIR = path.join(HOME, '.codex', 'profiles');
const TRACKER = path.join(PROFILES_DIR, 'tracker.json');
const PROFILE_SCRIPT = path.join(PROFILES_DIR, 'codex-profile.sh');

function resolveBash() {
  const candidates = [
    process.env.GIT_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    'bash',
  ].filter(Boolean);
  return candidates.find((candidate) => !path.isAbsolute(candidate) || fs.existsSync(candidate)) || 'bash';
}

function readTracker() {
  try {
    return JSON.parse(fs.readFileSync(TRACKER, 'utf8'));
  } catch {
    return { active_profile: null, profiles: {}, switch_log: [] };
  }
}

function writeTracker(state) {
  fs.writeFileSync(TRACKER, JSON.stringify(state, null, 2));
}

function isAvailable(profile) {
  return !profile.limit_resets_at || new Date(profile.limit_resets_at).getTime() <= Date.now();
}

function pickNext() {
  const state = readTracker();
  return Object.entries(state.profiles || {})
    .filter(([name, profile]) => name !== state.active_profile && isAvailable(profile))
    .sort((a, b) => new Date(a[1].last_activated || 0) - new Date(b[1].last_activated || 0))
    .map(([name]) => name)[0] || null;
}

function switchProfile(profile) {
  if (!profile || !fs.existsSync(PROFILE_SCRIPT)) return;
  execFileSync(resolveBash(), [PROFILE_SCRIPT, 'switch', profile], {
    cwd: PROFILES_DIR,
    stdio: 'ignore',
    windowsHide: true,
  });
}

module.exports = {
  name: 'codex',

  detect: async () => detectBinary('codex'),

  spawnArgs: (opts = {}) => {
    const profile = opts.profile || pickNext();
    try {
      switchProfile(profile);
    } catch (err) {
      console.warn(`[codex adapter] profile switch failed: ${err.message}`);
    }

    return {
      file: 'codex',
      args: opts.autoYes ? [] : ['--no-auto-confirm'],
      env: opts.env || process.env,
      cwd: opts.cwd || process.cwd(),
      initialStdin: opts.task ? formatEnvelope(opts.task, opts) : undefined,
    };
  },

  onExit: async (session, exitCode) => {
    if (exitCode !== 429) return;
    const state = readTracker();
    const active = state.active_profile;
    if (!active || !state.profiles?.[active]) return;
    state.profiles[active].limit_hit_at = new Date().toISOString().split('.')[0] + 'Z';
    state.profiles[active].limit_resets_at = new Date(Date.now() + 7 * 86400000).toISOString().split('.')[0] + 'Z';
    writeTracker(state);
  },
};
