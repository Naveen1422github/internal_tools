const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const SESSIONS_FILE = path.join(__dirname, '..', 'data', 'sessions.json');
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

let sessions = [];
let ready;
let pty;
let ptyLoadError;

function loadPty() {
  if (pty) return pty;
  if (ptyLoadError) throw ptyLoadError;

  // node-pty ships Windows prebuilds for Node 22; @homebridge fork only ships Linux.
  // Try upstream first, fall back to the fork for non-Windows hosts where it works.
  const candidates = ['node-pty', '@homebridge/node-pty-prebuilt-multiarch'];
  const errors = [];
  for (const name of candidates) {
    try {
      pty = require(name);
      return pty;
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  ptyLoadError = new Error(`No PTY backend available. Tried:\n  - ${errors.join('\n  - ')}`);
  throw ptyLoadError;
}

function ptyUnavailableMessage(err) {
  const detail = err && err.message ? err.message : String(err || 'unknown error');
  return `PTY unavailable: ${detail}`;
}

function cloneSession(session) {
  const copy = { ...session };
  delete copy._pty;
  delete copy._listeners;
  delete copy._shellKind;
  delete copy._activeBlockStart;
  delete copy._activeBlockIndex;
  return copy;
}

async function ensureDataDir() {
  await fs.mkdir(path.dirname(SESSIONS_FILE), { recursive: true });
}

async function saveSessions() {
  await ensureDataDir();
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions.map(cloneSession), null, 2), 'utf8');
}

function resolveWindowsShell() {
  // Bare `bash.exe` on Windows usually resolves to C:\Windows\System32\bash.exe
  // (the WSL launcher) which exits with an error if WSL isn't set up. Prefer
  // explicit Git Bash paths and fall back to PowerShell, NOT bare bash.exe.
  const candidates = [
    process.env.GIT_BASH && { file: process.env.GIT_BASH, kind: 'bash' },
    { file: 'C:\\Program Files\\Git\\bin\\bash.exe', kind: 'bash' },
    { file: 'C:\\Program Files (x86)\\Git\\bin\\bash.exe', kind: 'bash' },
    process.env.ProgramFiles && { file: path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'), kind: 'bash' },
    process.env.LOCALAPPDATA && { file: path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'), kind: 'bash' },
    { file: 'powershell.exe', kind: 'powershell' },
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate.file) || fsSync.existsSync(candidate.file)) return candidate;
  }
  return { file: 'cmd.exe', kind: 'cmd' };
}

function resolveShell() {
  // AGENT_ADAPTER_HOOK - see tools/agents/<agent>.js (T3)
  if (process.platform === 'win32') return resolveWindowsShell();
  return { file: process.env.SHELL || 'bash', kind: 'bash' };
}

function parseAnsi(chunk) {
  let ansiClass = '';
  if (/\x1b\[[0-9;]*31m/.test(chunk)) ansiClass = 'ansi-red';
  else if (/\x1b\[[0-9;]*32m/.test(chunk)) ansiClass = 'ansi-green';
  else if (/\x1b\[[0-9;]*33m/.test(chunk)) ansiClass = 'ansi-yellow';
  else if (/\x1b\[[0-9;]*36m/.test(chunk)) ansiClass = 'ansi-cyan';
  else if (/\x1b\[[0-9;]*35m/.test(chunk)) ansiClass = 'ansi-purple';
  else if (/\x1b\[[0-9;]*2m/.test(chunk)) ansiClass = 'ansi-dim';
  else if (/\x1b\[[0-9;]*1m/.test(chunk)) ansiClass = 'ansi-bold';
  return { line: chunk.replace(ANSI_RE, '').replace(/\r/g, ''), ansiClass };
}

const DEBUG = process.env.CONSOLE_DEBUG === '1' || process.env.CONSOLE_DEBUG === 'true';
const log = (...args) => DEBUG && console.log('[console]', ...args);

function broadcast(session, event) {
  const listeners = session._listeners || [];
  log(session.id, 'broadcast', event.type, '→', listeners.length, 'listener(s)');
  if (listeners.length === 0 && (event.type === 'block-start' || event.type === 'block-end')) {
    log(session.id, 'WARN: dropping', event.type, '(no listeners attached yet)');
  }
  for (const res of listeners) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function finishActiveBlock(session, code) {
  const activeBlock = session.blocks[session._activeBlockIndex];
  if (!activeBlock || activeBlock.exit !== 'run') return;

  const elapsedMs = Date.now() - (session._activeBlockStart || Date.now());
  activeBlock.exit = code === 0 ? 'ok' : 'err';
  activeBlock.code = code;
  activeBlock.duration = `${(elapsedMs / 1000).toFixed(1)}s`;
  delete session._activeBlockStart;
  delete session._activeBlockIndex;

  broadcast(session, {
    type: 'block-end',
    sessionId: session.id,
    payload: { exit: activeBlock.exit, code, duration: activeBlock.duration },
  });
  saveSessions().catch((err) => console.error('[console] save failed:', err));
}

function attachPty(session) {
  const ptyLib = loadPty();
  const shell = resolveShell();
  session._shellKind = shell.kind;
  session._listeners = session._listeners || [];
  delete session.error;

  const spawnOpts = {
    name: 'xterm-color',
    cols: 100,
    rows: 30,
    cwd: session.cwd || process.cwd(),
    env: process.env,
  };

  // Interactive flag keeps shells from exiting when stdin is empty. Without
  // -i / -NoExit, bash and PowerShell read stdin once and exit.
  const shellArgs = shell.kind === 'bash' ? ['-i'] : (shell.kind === 'powershell' ? ['-NoExit', '-NoLogo'] : []);

  try {
    session._pty = ptyLib.spawn(shell.file, shellArgs, spawnOpts);
    log(session.id, 'spawned', shell.file, shellArgs.join(' '), 'pid=' + session._pty.pid);
  } catch (err) {
    log(session.id, 'spawn failed for', shell.file, '-', err.message);
    if (process.platform !== 'win32' || shell.file === 'cmd.exe') throw err;
    session._shellKind = 'cmd';
    session._pty = ptyLib.spawn('cmd.exe', [], spawnOpts);
    log(session.id, 'fallback spawned cmd.exe pid=' + session._pty.pid);
  }

  session.pid = session._pty.pid;
  let buffer = '';

  session._pty.onData((data) => {
    buffer += data;
    const lines = buffer.split(/\n/);
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const cleanLine = rawLine.replace(/\r/g, '');
      const sentinel = cleanLine.match(/::END::(-?\d+)/);
      if (sentinel) {
        finishActiveBlock(session, Number(sentinel[1]));
        continue;
      }

      const parsed = parseAnsi(rawLine);
      log(session.id, 'data:', JSON.stringify(parsed.line.slice(0, 120)));
      const activeBlock = session.blocks[session._activeBlockIndex];
      if (activeBlock && activeBlock.exit === 'run' && parsed.line) {
        activeBlock.out.push([parsed.ansiClass, parsed.line]);
      }
      if (parsed.line) {
        broadcast(session, { type: 'data', sessionId: session.id, payload: parsed });
      }
    }
  });

  session._pty.onExit(({ exitCode, signal }) => {
    log(session.id, 'PTY exited code=' + exitCode + ' signal=' + signal + ' shell=' + shell.file);
    session.error = `Shell exited (code ${exitCode}). Shell: ${shell.file}`;
    broadcast(session, { type: 'exit', sessionId: session.id, payload: { exitCode, signal, shell: shell.file } });
  });
}

async function loadSessions() {
  await ensureDataDir();
  try {
    const raw = (await fs.readFile(SESSIONS_FILE, 'utf8')).trim();
    sessions = raw ? JSON.parse(raw).map((session) => ({ ...session, _listeners: [] })) : [];
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[console] load failed (resetting sessions):', err.message);
    sessions = [];
  }

  // PTYs don't survive process restarts. Any block left in 'run' is orphaned
  // — mark it as interrupted so the session isn't permanently locked by the
  // 409 'command already running' guard.
  for (const session of sessions) {
    for (const block of session.blocks || []) {
      if (block.exit === 'run') {
        block.exit = 'err';
        block.code = -1;
        block.duration = block.duration || '—';
        if (Array.isArray(block.out)) block.out.push(['ansi-dim', '[interrupted by server restart]']);
      }
    }
  }

  for (const session of sessions) {
    try {
      attachPty(session);
    } catch (err) {
      session.error = ptyUnavailableMessage(err);
      console.error('[console] restore PTY failed:', err);
    }
  }
}

function ensureReady() {
  if (!ready) ready = loadSessions();
  return ready;
}

function commandWithSentinel(session, text) {
  if (session._shellKind === 'cmd') return `${text}\r\necho ::END::%ERRORLEVEL%\r\n`;
  if (session._shellKind === 'powershell') return `${text}\r\nWrite-Output "::END::$LASTEXITCODE"\r\n`;
  return `${text}\necho "::END::$?"\n`;
}

process.once('SIGINT', async () => {
  for (const session of sessions) {
    if (session._pty) session._pty.kill();
  }
  await saveSessions().catch(() => {});
  process.exit(0);
});

ready = loadSessions();

module.exports.routes = {
  'GET /api/console/sessions': async (req, res, send) => {
    await ensureReady();
    send(200, { sessions: sessions.map(cloneSession) });
  },

  'POST /api/console/session/spawn': async (req, res, send, body) => {
    await ensureReady();
    const { agent = 'bash', opts = {} } = body || {};
    const id = `s-${Date.now()}`;
    const name = opts.task ? `${agent} / ${opts.task.id}` : opts.label || `${agent}`;
    const session = {
      id,
      name,
      agent,
      cwd: opts.cwd || process.cwd(),
      activeTaskId: opts.task ? opts.task.id : null,
      blocks: [],
      _listeners: [],
    };

    try {
      attachPty(session);
    } catch (err) {
      return send(503, { error: ptyUnavailableMessage(err) });
    }

    sessions.push(session);
    await saveSessions();
    send(200, { ok: true, session: cloneSession(session) });
  },

  'POST /api/console/session/close': async (req, res, send, body) => {
    await ensureReady();
    const { id } = body || {};
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx !== -1) {
      const [session] = sessions.splice(idx, 1);
      if (session._pty) session._pty.kill();
      await saveSessions();
    }
    send(200, { ok: true });
  },

  'POST /api/console/command/run': async (req, res, send, body) => {
    await ensureReady();
    const { sessionId, text } = body || {};
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return send(404, { error: 'Session not found' });
    if (!session._pty) return send(400, { error: session.error || 'PTY not active' });
    if (!text || !text.trim()) return send(400, { error: 'text required' });
    if (session.blocks.some((b) => b.exit === 'run')) {
      return send(409, { error: 'A command is already running in this session' });
    }

    const block = {
      id: `b-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      stamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      cmd: text,
      exit: 'run',
      out: [],
    };
    if (session.agent !== 'bash') {
      block.kind = 'agent';
      block.agentLabel = `${session.agent} - running`;
    }

    session.blocks.push(block);
    session._activeBlockIndex = session.blocks.length - 1;
    session._activeBlockStart = Date.now();
    log(sessionId, 'run cmd:', JSON.stringify(text));
    broadcast(session, { type: 'block-start', sessionId, payload: block });
    session._pty.write(commandWithSentinel(session, text));
    send(200, { ok: true, blockId: session._activeBlockIndex });
  },

  'POST /api/console/session/input': async (req, res, send, body) => {
    await ensureReady();
    const { id, data } = body || {};
    const session = sessions.find((s) => s.id === id);
    if (!session) return send(404, { error: 'Session not found' });
    if (!session._pty) return send(400, { error: session.error || 'PTY not active' });
    session._pty.write(String(data || ''));
    send(200, { ok: true });
  },

  'GET /api/console/session/stream': async (req, res) => {
    await ensureReady();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const id = url.searchParams.get('id');
    const session = sessions.find((s) => s.id === id);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Session not found');
      return '__sse__';
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');

    session._listeners.push(res);
    log(id, 'SSE listener attached, total =', session._listeners.length);
    req.on('close', () => {
      session._listeners = session._listeners.filter((listener) => listener !== res);
      log(id, 'SSE listener detached, total =', session._listeners.length);
    });
    return '__sse__';
  },
};
