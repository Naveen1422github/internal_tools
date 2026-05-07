const fs = require('fs/promises');
const path = require('path');
let pty;
try {
  pty = require('node-pty');
} catch (e) {
  // Fallback to prebuilt if node-pty fails to load/build (e.g. Windows)
  pty = require('@homebridge/node-pty-prebuilt-multiarch');
}

const SESSIONS_FILE = path.join(__dirname, '..', 'data', 'sessions.json');

// Ensure data directory exists
async function ensureDataDir() {
  const dir = path.dirname(SESSIONS_FILE);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    // Ignore error
  }
}

// In-memory sessions
let sessions = [];

// Load sessions from disk
function loadSessionsSync() {
  const fsSync = require('fs');
  const dir = path.dirname(SESSIONS_FILE);
  try {
    fsSync.mkdirSync(dir, { recursive: true });
  } catch (e) {}

  try {
    const data = fsSync.readFileSync(SESSIONS_FILE, 'utf-8');
    sessions = JSON.parse(data);
    // Remove _pty from loaded sessions just in case, and initialize other runtime state
    for (const session of sessions) {
      delete session._pty;
      session._listeners = []; // SSE connections
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Failed to load sessions:', err);
    }
    // Leave sessions as is (could be empty or whatever was there)
  }
}

// Save sessions to disk
async function saveSessions() {
  await ensureDataDir();
  // We need to omit _pty and _listeners
  const toSave = sessions.map(s => {
    const copy = { ...s };
    delete copy._pty;
    delete copy._listeners;
    return copy;
  });
  try {
    await fs.writeFile(SESSIONS_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save sessions:', err);
  }
}

function getBashPath() {
  if (process.platform === 'win32') {
    const commonPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
    try {
      require('fs').accessSync(commonPath);
      return commonPath;
    } catch {
      // Ignored
    }
    if (process.env.GIT_BASH) return process.env.GIT_BASH;
    return 'bash.exe';
  }
  return 'bash';
}

function parseAnsi(line) {
  // Simple coarse ANSI mapping
  let cls = '';
  if (line.includes('\x1b[31m')) cls = 'ansi-red';
  else if (line.includes('\x1b[32m')) cls = 'ansi-green';
  else if (line.includes('\x1b[33m')) cls = 'ansi-yellow';
  else if (line.includes('\x1b[36m')) cls = 'ansi-cyan';
  else if (line.includes('\x1b[35m')) cls = 'ansi-purple';
  else if (line.includes('\x1b[2m')) cls = 'ansi-dim';
  else if (line.includes('\x1b[1m')) cls = 'ansi-bold';

  // Strip all escape codes
  // eslint-disable-next-line no-control-regex
  const stripped = line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  return { line: stripped, ansiClass: cls };
}

function broadcast(session, event) {
  if (!session._listeners) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of session._listeners) {
    res.write(payload);
  }
}

// Helper to spawn PTY
function spawnPty(session) {
  const isWin = process.platform === 'win32';
  const shell = session.agent === 'bash' || true ? (isWin ? getBashPath() : 'bash') : 'bash'; // TODO: AGENT_ADAPTER_HOOK — see tools/agents/<agent>.js (T3)

  try {
    session._pty = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: session.cwd || process.env.HOME || process.cwd(),
      env: process.env
    });
  } catch (err) {
    // Fallback to cmd.exe on Windows if bash fails
    if (isWin) {
      try {
        session._pty = pty.spawn('cmd.exe', [], {
          name: 'xterm-color',
          cols: 80,
          rows: 24,
          cwd: session.cwd || process.env.HOME || process.cwd(),
          env: process.env
        });
      } catch (cmdErr) {
        // Fallback if node-pty is broken or native module error occurs on Windows
        throw cmdErr;
      }
    } else {
      throw err;
    }
  }

  session.pid = session._pty.pid;

  let buffer = '';

  session._pty.onData((data) => {
    buffer += data;
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep remainder

    for (const line of lines) {
      const cleanLine = line.replace(/\r/g, '');

      // Check for sentinel
      const match = cleanLine.match(/::END::(\d+)/);
      if (match) {
        const code = parseInt(match[1], 10);
        // We found block end. Find active block.
        const activeBlock = session.blocks[session.blocks.length - 1];
        if (activeBlock && activeBlock.exit === 'run') {
          activeBlock.exit = code === 0 ? 'ok' : 'err';
          activeBlock.code = code;
          if (session._activeBlockStart) {
            const elapsedMs = Date.now() - session._activeBlockStart;
            activeBlock.duration = (elapsedMs / 1000).toFixed(1) + 's';
          } else {
            activeBlock.duration = '0.0s';
          }
          broadcast(session, { type: 'block-end', sessionId: session.id, payload: { exit: activeBlock.exit, code, duration: activeBlock.duration } });
          saveSessions();
        }
      } else {
        const parsed = parseAnsi(cleanLine);
        const activeBlock = session.blocks[session.blocks.length - 1];
        if (activeBlock && activeBlock.exit === 'run') {
          const outLine = [parsed.ansiClass, parsed.line];
          activeBlock.out.push(outLine);
        }
        broadcast(session, { type: 'data', sessionId: session.id, payload: parsed });
      }
    }
  });

  session._pty.onExit(({ exitCode, signal }) => {
    broadcast(session, { type: 'exit', sessionId: session.id, payload: { exitCode, signal } });
  });
}

// Initial load synchronously before spawning
loadSessionsSync();

// Re-spawn any persistent PTYs (wait, requirement says: "On server start, read the file if present; spawn fresh PTYs for each session and replay nothing")
function init() {
  for (const session of sessions) {
    spawnPty(session);
  }
}
init();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  for (const session of sessions) {
    if (session._pty) {
      session._pty.kill();
    }
  }
  await saveSessions();
  process.exit(0);
});

module.exports.routes = {
  'GET /api/console/sessions': async (req, res, send) => {
    const safeSessions = sessions.map(s => {
      const copy = { ...s };
      delete copy._pty;
      delete copy._listeners;
      return copy;
    });
    send(200, { sessions: safeSessions });
  },

  'POST /api/console/session/spawn': async (req, res, send, body) => {
    const { agent, opts = {} } = body;
    const id = 's-' + Date.now();
    const meta = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', jules: 'Jules', bash: 'shell', dev: 'dev' }[agent] || agent;
    const name = opts.task ? `${agent} / ${opts.task.id}` : opts.label || `${agent}`;
    
    const newSession = {
      id,
      name,
      agent,
      cwd: opts.cwd || process.env.HOME || process.cwd(),
      activeTaskId: opts.task ? opts.task.id : null,
      blocks: [],
      _listeners: []
    };
    
    sessions.push(newSession);
    spawnPty(newSession);
    await saveSessions();

    const safeSession = { ...newSession };
    delete safeSession._pty;
    delete safeSession._listeners;

    send(200, { ok: true, session: safeSession });
  },

  'POST /api/console/session/close': async (req, res, send, body) => {
    const { id } = body;
    const idx = sessions.findIndex(s => s.id === id);
    if (idx !== -1) {
      const session = sessions[idx];
      if (session._pty) {
        session._pty.kill();
      }
      sessions.splice(idx, 1);
      await saveSessions();
    }
    send(200, { ok: true });
  },

  'POST /api/console/command/run': async (req, res, send, body) => {
    const { sessionId, text } = body;
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return send(404, { error: 'Session not found' });
    if (!session._pty) return send(400, { error: 'PTY not active' });

    const stamp = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    
    const block = {
      stamp,
      cmd: text,
      exit: 'run',
      out: []
    };
    
    if (session.agent !== 'bash') {
      block.kind = 'agent';
      block.agentLabel = `${session.agent} · running`;
    }

    session.blocks.push(block);
    session._activeBlockStart = Date.now();

    broadcast(session, { type: 'block-start', sessionId, payload: block });

    // Write command and sentinel
    session._pty.write(text + `\necho "::END::$?"\n`);

    send(200, { ok: true, blockId: session.blocks.length - 1 });
  },

  'POST /api/console/session/input': async (req, res, send, body) => {
    const { id, data } = body;
    const session = sessions.find(s => s.id === id);
    if (!session) return send(404, { error: 'Session not found' });
    if (!session._pty) return send(400, { error: 'PTY not active' });

    session._pty.write(data);
    send(200, { ok: true });
  },

  'GET /api/console/session/stream': async (req, res, send) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const id = url.searchParams.get('id');
    const session = sessions.find(s => s.id === id);

    if (!session) {
      res.writeHead(404);
      res.end('Session not found');
      return '__sse__';
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    if (!session._listeners) session._listeners = [];
    session._listeners.push(res);

    req.on('close', () => {
      session._listeners = session._listeners.filter(l => l !== res);
    });

    return '__sse__';
  }
};
