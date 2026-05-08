## Verdict
REQUEST_CHANGES

## Scope check
- Files touched: `package.json`, `tools/agents/__tests__/claude.test.js`, `tools/agents/__tests__/envelope.test.js`, `tools/agents/__tests__/registry.test.js`, `tools/agents/base.js`, `tools/agents/claude.js`, `tools/agents/codex.js`, `tools/agents/envelope.js`, `tools/agents/gemini.js`, `tools/agents/index.js`, `tools/agents/jules.js`
- Files in brief's "Scope" section:
  - `tools/agents/index.js`: PASS
  - `tools/agents/base.js`: PASS
  - `tools/agents/claude.js`: PASS
  - `tools/agents/codex.js`: PASS
  - `tools/agents/gemini.js`: PASS
  - `tools/agents/jules.js`: PASS
  - `tools/agents/envelope.js`: PASS
  - `tools/agents/__tests__/`: PASS
  - `package.json`: PASS - only adds a test script.
- Files in brief's "DO NOT touch" list: PASS - no forbidden files touched.

## Acceptance criteria walk-through
- PASS - All four adapter files exist and implement the named exports: `tools/agents/claude.js:5`, `tools/agents/codex.js:62`, `tools/agents/gemini.js:4`, `tools/agents/jules.js:3`.
- NEEDS-LOCAL-VERIFY - `registry.test.js` and `envelope.test.js` pass. Tests are added under `tools/agents/__tests__/`, but test execution was not requested.
- PASS - `require('./tools/agents')` should load without requiring agent CLIs because binary checks are only in `detect()`/`spawnArgs()`.
- PASS - missing binary detection returns `{ ok: false, hint }` via `tools/agents/base.js:10`, though path handling has a bug below.
- PASS - no edits to `tools/console.js`.
- PASS - no new runtime dependencies in `package.json`.

## Bugs / risks
1. `tools/agents/base.js:8` - `detectBinary()` interpolates the executable into a shell command without quoting or argument array spawning. A resolved Windows path with spaces, such as `C:\Program Files\...`, will fail or be parsed incorrectly - severity medium.
2. `tools/agents/codex.js:72` - `execSync(\`"${bash}" codex-profile.sh switch "${profile}"\`)` builds a shell command from `profile`; a profile containing quotes or shell metacharacters can execute unintended shell syntax - severity high.
3. `tools/agents/codex.js:90` - task envelopes are never passed to Codex (`initialStdin: undefined`), so a task-launched Codex session would not receive the task context described by the adapter task goal - severity medium.
4. `tools/agents/envelope.js:83` - DB read failures are logged to stderr from a pure formatter; this can add noisy output when an adapter is used interactively. Prefer silent best-effort or caller-controlled logging - severity low.

## Conflicts with other Jules sessions
T3 conflicts with T1 on `package.json`. T3 adds `"test"` while T1 adds `node-pty`; both changes must be merged manually.

## Recommendation for the human
Apply but fix issues 1, 2, and 3 before push. The scaffold is mostly in-scope, but the Codex profile switch should use argument-array spawning and task context should not be dropped.
