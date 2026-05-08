// consumed by tools/console.js spawn(); see briefs/T3-agent-adapters.md
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFilePromise = promisify(execFile);

async function detectBinary(command, args = ['--version']) {
  try {
    const argv = Array.isArray(args) ? args : [args];
    const { stdout, stderr } = await execFilePromise(command, argv, { windowsHide: true });
    return { ok: true, version: (stdout || stderr || '').trim() };
  } catch {
    return { ok: false, hint: `Could not run '${command}'. Is it installed and on PATH?` };
  }
}

module.exports = { detectBinary };
