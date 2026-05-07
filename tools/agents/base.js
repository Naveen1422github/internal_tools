// consumed by tools/console.js spawn(); see briefs/T3-agent-adapters.md
const { execFile } = require('child_process');
const util = require('util');
const execFilePromise = util.promisify(execFile);

async function detectBinary(command, versionArgs = '--version') {
  try {
    const args = Array.isArray(versionArgs) ? versionArgs : [versionArgs];
    const { stdout } = await execFilePromise(command, args);
    return { ok: true, version: stdout.trim() };
  } catch (err) {
    return { ok: false, hint: `Could not run '${command}'. Is it installed and on PATH?` };
  }
}

module.exports = { detectBinary };
