// consumed by tools/console.js spawn(); see briefs/T3-agent-adapters.md
const { detectBinary } = require('./base');

module.exports = {
  name: 'gemini',

  detect: async () => detectBinary('gemini'),

  spawnArgs: (opts = {}) => {
    return {
      file: 'gemini',
      args: [],
      env: opts.env || process.env,
      cwd: opts.cwd || process.cwd(),
      initialStdin: undefined,
    };
  },

  onExit: async (session, exitCode) => {
    // No-op for gemini
  }
};
