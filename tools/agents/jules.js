// consumed by tools/console.js spawn(); see briefs/T3-agent-adapters.md
const { detectBinary } = require('./base');

module.exports = {
  name: 'jules',

  detect: async () => detectBinary('jules', ['version']),

  spawnArgs: () => {
    throw new Error('Jules is an async cloud/PR agent; dispatch with `jules remote new` instead of spawning a PTY.');
  },

  onExit: async () => {},
};
