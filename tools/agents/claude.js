// consumed by tools/console.js spawn(); see briefs/T3-agent-adapters.md
const { execFileSync } = require('child_process');
const { detectBinary } = require('./base');
const { formatEnvelope } = require('./envelope');

function resolveCommand(command, envVar) {
  if (process.env[envVar]) return process.env[envVar];
  try {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    return execFileSync(lookup, [command], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/)
      .find(Boolean) || command;
  } catch {
    return command;
  }
}

module.exports = {
  name: 'claude',

  detect: async () => detectBinary(resolveCommand('claude', 'CLAUDE_BIN')),

  spawnArgs: (opts = {}) => ({
    file: resolveCommand('claude', 'CLAUDE_BIN'),
    args: opts.task ? ['--print', '--input-format', 'text'] : [],
    env: opts.env || process.env,
    cwd: opts.cwd || process.cwd(),
    initialStdin: opts.task ? formatEnvelope(opts.task, opts) : undefined,
  }),

  onExit: async () => {},
};
