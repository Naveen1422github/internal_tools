// Spec P12: the web server refuses to start on a setup problem, printing the
// doctor sentence and its fix. Imported right after env.js and BEFORE
// tools/collab.js, which opens the DB at import time; synchronous because ES
// modules don't wait for a sibling's top-level await.
import { startupProblemSync } from '@collab-mcp/core';

const problem = startupProblemSync();
if (problem) {
  console.error(`collab web can't start: ${problem.text}${problem.fix ? `\n  fix: ${problem.fix}` : ''}`);
  process.exit(2);
}
