// consumed by tools/console.js spawn(); see briefs/T3-agent-adapters.md

module.exports = {
  name: 'jules',

  detect: async () => ({
    ok: false,
    hint: 'Jules is cloud-only; assign a task at jules.google instead.',
  }),

  spawnArgs: (opts = {}) => {
    throw new Error('Jules has no local CLI; create a task at jules.google.');
  },

  onExit: async (session, exitCode) => {
    // No-op for jules
  }
};
