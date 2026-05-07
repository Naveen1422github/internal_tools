// consumed by tools/console.js spawn(); see briefs/T3-agent-adapters.md
const claude = require('./claude');
const codex = require('./codex');
const gemini = require('./gemini');
const jules = require('./jules');

module.exports = {
  claude,
  codex,
  gemini,
  jules,
};
