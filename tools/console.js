const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const AGENT_ADAPTERS = require('./agents');

const SESSIONS_FILE = path.join(__dirname, '..', 'data', 'sessions.json');

let sessions = [];
let ready;
let pty;
let ptyLoadError;

function loadPty() {
  if (pty) return pty;
  if (ptyLoadError) throw ptyLoadError;

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

const DEBUG = process.env.CONSOLE_DEBUG === '1' || process.env.CONSOLE_DEBUG === 'true';
const log = (...args) => DEBUG && console.log('[console]', ...args);

function broadcast(session, event) {
  const listeners = session._listeners || [];
  log(session.id, 'broadcast', event.type, '->', listeners.length, 'listener(s)');
  for (const res of listeners) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

async function attachPty(session) {
  const ptyLib = loadPty();
  session._listeners = session._listeners || [];
  delete session.error;
  delete session._isAgent;

  const isAgent = Boolean(session.agent && AGENT_ADAPTERS[session.agent]);
  let spawnFile;
  let spawnArgs;
  let spawnOpts;
  let shell = null;

  if (isAgent) {
    const adapter = AGENT_ADAPTERS[session.agent];
    const detection = await adapter.detect().catch(() => ({ ok: false, hint: 'detect failed' }));
    if (!detection.ok) {
      session.error = `${session.agent} not available: ${detection.hint || 'unknown'}`;
      log(session.id, 'agent detect failed:', session.error);
      return;
    }
    const sa = adapter.spawnArgs({
      task: session.task || null,
      cwd: session.cwd || process.cwd(),
      env: process.env,
      autoYes: session.autoYes || false,
    });
    spawnFile = sa.file;
    spawnArgs = sa.args || [];
    spawnOpts = {
      name: 'xterm-color',
      cols: 100,
      rows: 30,
      cwd: sa.cwd || process.cwd(),
      env: sa.env || process.env,
    };
    session._isAgent = true;
    session._initialStdin = sa.initialStdin;
    log(session.id, 'spawn path=agent', session.agent, 'file=', spawnFile, 'args=', spawnArgs.join(' '));
  } else {
    shell = resolveShell();
    session._shellKind = shell.kind;
    spawnFile = shell.file;
    spawnArgs = shell.kind === 'bash' ? ['-i'] : (shell.kind === 'powershell' ? ['-NoExit', '-NoLogo'] : []);
    spawnOpts = {
      name: 'xterm-color',
      cols: 100,
      rows: 30,
      cwd: session.cwd || process.cwd(),
      env: process.env,
    };
    log(session.id, 'spawn path=shell', shell.kind, 'file=', spawnFile, 'args=', spawnArgs.join(' '));
  }

  try {
    session._pty = ptyLib.spawn(spawnFile, spawnArgs, spawnOpts);
    log(session.id, 'spawned', spawnFile, spawnArgs.join(' '), 'pid=' + session._pty.pid, isAgent ? '(agent)' : '(shell)');
  } catch (err) {
    log(session.id, 'spawn failed for', spawnFile, '-', err.message);
    if (isAgent) {
      session.error = `Failed to start ${session.agent}: ${err.message}`;
      return;
    }
    if (process.platform !== 'win32' || spawnFile === 'cmd.exe') throw err;
    session._shellKind = 'cmd';
    session._pty = ptyLib.spawn('cmd.exe', [], spawnOpts);
    log(session.id, 'fallback spawned cmd.exe pid=' + session._pty.pid);
  }

  session.pid = session._pty.pid;
  if (session._initialStdin) {
    setTimeout(() => session._pty && session._pty.write(session._initialStdin), 200);
    delete session._initialStdin;
  }

  session._pty.onData((data) => {
    broadcast(session, { type: 'raw', sessionId: session.id, payload: String(data || '') });
  });

  session._pty.onExit(({ exitCode, signal }) => {
    const runner = isAgent ? spawnFile : (shell && shell.file ? shell.file : spawnFile);
    log(session.id, 'PTY exited code=' + exitCode + ' signal=' + signal + ' shell=' + runner);
    session.error = `Shell exited (code ${exitCode}). Shell: ${runner}`;
    broadcast(session, { type: 'exit', sessionId: session.id, payload: { exitCode, signal, shell: runner } });
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

  for (const session of sessions) {
    try {
      await attachPty(session);
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
  if (session._shellKind === 'cmd') return `${text}\r\n`;
  return `${text}\n`;
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
      _listeners: [],
    };

    try {
      await attachPty(session);
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
    log(sessionId, 'run cmd:', JSON.stringify(text));
    session._pty.write(commandWithSentinel(session, text));
    send(200, { ok: true });
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

  'POST /api/console/session/resize': async (req, res, send, body) => {
    await ensureReady();
    const { id, cols, rows } = body || {};
    const session = sessions.find((s) => s.id === id);
    if (!session) return send(404, { error: 'Session not found' });
    if (!session._pty) return send(400, { error: session.error || 'PTY not active' });
    try {
      session._pty.resize(Math.max(1, +cols || 80), Math.max(1, +rows || 24));
      send(200, { ok: true });
    } catch (err) {
      send(500, { error: err.message });
    }
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
