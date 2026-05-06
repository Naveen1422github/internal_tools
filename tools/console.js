const { exec } = require('child_process');
const path = require('path');

// In-memory sessions (persistence can be added later if needed)
let sessions = [
  {
    id: 's-initial',
    name: 'shell',
    agent: 'bash',
    cwd: '~/code/frontend2',
    blocks: [
      {
        stamp: new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }),
        duration: '0.0s',
        exit: 'ok',
        cmd: 'bash --version',
        out: [['ansi-dim', 'New shell — workspace root']]
      }
    ]
  }
];

module.exports.routes = {
  'GET /api/console/sessions': async (req, res, send) => {
    send(200, { sessions });
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
      cwd: opts.cwd || '~/code/frontend2',
      activeTaskId: opts.task ? opts.task.id : null,
      blocks: opts.task ? [{
        stamp: new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }),
        duration: '—', exit: 'run', kind: 'agent',
        cmd: `/run @${opts.task.id}  ${opts.task.title}`,
        agentLabel: `${meta} · ready`,
        out: [
          ['ansi-bold', `Mounted task ${opts.task.id}`],
          ['', `Module: @${opts.task.module}`],
          ['ansi-dim', `\nWaiting for input…`],
        ],
      }] : [{
        stamp: new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }),
        duration: '0.0s', exit: 'ok',
        cmd: agent === 'bash' ? '$ ' : `${agent} --version`,
        out: agent === 'bash' ? [['ansi-dim', 'New shell — workspace root']] : [['ansi-cyan', `${meta}-cli 0.4.2`]],
      }],
    };
    
    sessions.push(newSession);
    send(200, { ok: true, session: newSession });
  },

  'POST /api/console/session/close': async (req, res, send, body) => {
    const { id } = body;
    sessions = sessions.filter(s => s.id !== id);
    send(200, { ok: true });
  },

  'POST /api/console/command/run': async (req, res, send, body) => {
    const { sessionId, text } = body;
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return send(404, { error: 'Session not found' });

    const stamp = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    
    // In a real implementation, we'd execute the command here.
    // For now, we'll simulate an agent response or shell output.
    let block;
    if (session.agent === 'bash') {
      block = { 
        stamp, 
        duration: '0.1s', 
        exit: 'ok', 
        cmd: text, 
        out: [['', `Output for: ${text}`], ['ansi-dim', 'Command completed.']] 
      };
    } else {
      block = {
        stamp, 
        duration: '1.2s', 
        exit: 'ok', 
        kind: 'agent',
        cmd: text, 
        agentLabel: `${session.agent} · finished`,
        out: [['', `Response from ${session.agent} to: "${text}"`], ['ansi-dim', 'Reasoning complete.']],
      };
    }
    
    session.blocks.push(block);
    send(200, { ok: true, block });
  }
};
