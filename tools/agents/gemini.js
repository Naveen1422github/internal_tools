// consumed by tools/console.js spawn(); see briefs/T3-agent-adapters.md
const { detectBinary } = require('./base');
const { formatEnvelope } = require('./envelope');

module.exports = {
  name: 'gemini',

  detect: async () => detectBinary('gemini'),

  spawnArgs: (opts = {}) => ({
    file: 'gemini',
    args: [],
    env: opts.env || process.env,
    cwd: opts.cwd || process.cwd(),
    initialStdin: opts.task ? formatEnvelope(opts.task, opts) : undefined,
  }),

  onExit: async () => {},
};
