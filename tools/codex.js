const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const HOME = os.homedir();
const CODEX_DIR = path.join(HOME, '.codex');
const PROFILES_DIR = path.join(CODEX_DIR, 'profiles');
const TRACKER = path.join(PROFILES_DIR, 'tracker.json');
const SCRIPT = path.join(PROFILES_DIR, 'codex-profile.sh');

const nowIso = () => new Date().toISOString().split('.')[0] + 'Z';

async function readTracker() {
  try {
    return JSON.parse(await fs.readFile(TRACKER, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { active_profile: null, profiles: {}, switch_log: [] };
    }
    throw err;
  }
}

async function writeTracker(t) {
  await fs.writeFile(TRACKER, JSON.stringify(t, null, 2));
}

// Resolve bash. Prefer GIT_BASH env override, then common Git for Windows
// install locations, then plain 'bash' on PATH (Linux/macOS or Windows with bash on PATH).
function resolveBash() {
  const fsSync = require('fs');
  const candidates = [
    process.env.GIT_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fsSync.existsSync(c)) return c; } catch {}
  }
  return 'bash';
}
const BASH_PATH = resolveBash();

// Shell out to codex-profile.sh via bash (Git Bash on Windows must be in PATH).
// We reuse the script instead of duplicating its logic so the dashboard
// and CLI always stay in sync.
function runScript(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    console.log(`[codex] Executing: ${BASH_PATH} ${SCRIPT} ${args.join(' ')}`);
    // stdin: 'ignore' so the child can never block on a TTY prompt
    const p = spawn(BASH_PATH, [SCRIPT, ...args], { cwd: PROFILES_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[codex] Command timed out after ${timeoutMs}ms`);
      p.kill('SIGTERM');
      // SIGTERM not always honored on Windows — escalate after a beat
      setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 2000);
    }, timeoutMs);
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    p.on('close', code => {
      clearTimeout(timer);
      console.log(`[codex] Command finished with code ${code}${timedOut ? ' (timed out)' : ''}`);
      if (stderr) console.error(`[codex] Stderr: ${stderr}`);
      resolve({
        code: timedOut ? 124 : code,
        stdout,
        stderr: timedOut ? `dashboard timeout after ${timeoutMs}ms — script killed\n${stderr}` : stderr,
        timedOut,
      });
    });
    p.on('error', err => {
      clearTimeout(timer);
      console.error(`[codex] Process error: ${err.message}`);
      resolve({ code: -1, stdout, stderr: err.message });
    });
  });
}

module.exports.routes = {
  'GET /api/codex/state': async (req, res, send) => {
    send(200, await readTracker());
  },

  'POST /api/codex/activate': async (req, res, send, body) => {
    const { name } = body;
    if (!name) return send(400, { error: 'name required' });
    const result = await runScript(['switch', name]);
    send(result.code === 0 ? 200 : 500, {
      ok: result.code === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      state: await readTracker(),
    });
  },

  'POST /api/codex/save': async (req, res, send, body) => {
    const { name, label } = body;
    if (!name) return send(400, { error: 'name required' });
    const result = await runScript(['save', name, label || name]);
    send(result.code === 0 ? 200 : 500, {
      ok: result.code === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      state: await readTracker(),
    });
  },

  'POST /api/codex/mark-limited': async (req, res, send, body) => {
    const { name } = body;
    const t = await readTracker();
    if (!t.profiles[name]) return send(404, { error: 'not found' });
    t.profiles[name].limit_hit_at = nowIso();
    t.profiles[name].limit_resets_at = new Date(Date.now() + 7 * 86400000).toISOString().split('.')[0] + 'Z';
    await writeTracker(t);
    send(200, { ok: true, state: t });
  },

  'POST /api/codex/clear-limit': async (req, res, send, body) => {
    const { name } = body;
    const t = await readTracker();
    if (!t.profiles[name]) return send(404, { error: 'not found' });
    t.profiles[name].limit_hit_at = null;
    t.profiles[name].limit_resets_at = null;
    await writeTracker(t);
    send(200, { ok: true, state: t });
  },

  'POST /api/codex/edit': async (req, res, send, body) => {
    const { name, label, resetAt } = body;
    const t = await readTracker();
    if (!t.profiles[name]) return send(404, { error: 'not found' });
    if (label !== undefined) t.profiles[name].label = label;
    if (resetAt !== undefined) {
      t.profiles[name].limit_resets_at = resetAt || null;
      if (!resetAt) t.profiles[name].limit_hit_at = null;
    }
    await writeTracker(t);
    send(200, { ok: true, state: t });
  },

  'POST /api/codex/delete': async (req, res, send, body) => {
    const { name } = body;
    const t = await readTracker();
    delete t.profiles[name];
    if (t.active_profile === name) t.active_profile = null;
    await writeTracker(t);
    send(200, { ok: true, state: t });
  },

  'POST /api/codex/check': async (req, res, send, body) => {
    const { name, all } = body;
    const args = all ? ['check', '--all'] : ['check', name];
    // Per-profile script timeout is 45s. Allow 15s buffer for single,
    // and budget per-profile for --all (capped at 10min total).
    const t = await readTracker();
    const profileCount = Object.keys(t.profiles || {}).length || 1;
    const timeoutMs = all
      ? Math.min(profileCount * 60 * 1000, 10 * 60 * 1000)
      : 60 * 1000;
    const result = await runScript(args, timeoutMs);
    // Auto-mark as rate-limited when probe says so. The script writes
    // check_message into tracker.json; if that says "rate limited" and
    // there's no existing limit_resets_at, set one (now+7d, codex free
    // tier convention used elsewhere in this script).
    let state = await readTracker();
    let autoMarked = [];
    const sevenDays = () => new Date(Date.now() + 7*86400000).toISOString().split('.')[0] + 'Z';
    const candidates = all ? Object.keys(state.profiles || {}) : (name ? [name] : []);
    for (const n of candidates) {
      const p = state.profiles[n];
      if (p && /rate limit/i.test(p.check_message || '') && !p.limit_resets_at) {
        p.limit_hit_at = nowIso();
        p.limit_resets_at = sevenDays();
        autoMarked.push(n);
      }
    }
    if (autoMarked.length) await writeTracker(state);
    send(200, {
      ok: result.code === 0,
      timedOut: !!result.timedOut,
      autoMarked,
      stdout: result.stdout,
      stderr: result.stderr,
      message: result.timedOut
        ? `Probe timed out after ${Math.round(timeoutMs / 1000)}s — likely bad auth or stalled network.`
        : (result.code === 0 ? 'probe complete' : `probe failed (exit ${result.code})`),
      state,
    });
  },
};
