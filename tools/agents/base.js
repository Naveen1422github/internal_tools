// consumed by tools/console.js spawn(); see briefs/T3-agent-adapters.md
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

async function detectBinary(command, versionArgs = '--version') {
  try {
    const { stdout } = await execPromise(`${command} ${versionArgs}`);
    return { ok: true, version: stdout.trim() };
  } catch (err) {
    return { ok: false, hint: `Could not run '${command}'. Is it installed and on PATH?` };
  }
}

module.exports = { detectBinary };
