// consumed by tools/console.js spawn(); see briefs/T3-agent-adapters.md
const { detectBinary } = require('./base');
const { formatEnvelope } = require('./envelope');
const { execSync } = require('child_process');

module.exports = {
  name: 'claude',

  detect: async () => {
    let bin = process.env.CLAUDE_BIN || 'claude';
    try {
      if (!process.env.CLAUDE_BIN) {
        bin = execSync(process.platform === 'win32' ? 'where claude' : 'which claude').toString().trim().split('\n')[0];
      }
    } catch (e) {
      // which/where failed
    }
    return detectBinary(bin || 'claude');
  },

  spawnArgs: (opts = {}) => {
    let bin = process.env.CLAUDE_BIN || 'claude';
    try {
      if (!process.env.CLAUDE_BIN) {
        bin = execSync(process.platform === 'win32' ? 'where claude' : 'which claude').toString().trim().split('\n')[0];
      }
    } catch (e) {
      // which/where failed
    }
    bin = bin || 'claude';

    let args = [];
    let initialStdin = undefined;

    if (opts.task) {
      args = ['--print', '--input-format', 'text'];
      initialStdin = formatEnvelope(opts.task, opts);
    }

    return {
      file: bin,
      args,
      env: opts.env || process.env,
      cwd: opts.cwd || process.cwd(),
      initialStdin,
    };
  },

  onExit: async (session, exitCode) => {
    // No-op for claude
  }
};
