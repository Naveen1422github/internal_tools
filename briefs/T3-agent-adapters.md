# Jules Task T3 — Agent CLI adapter scaffolds (Phase 3, scaffold only)

## Goal
Create the adapter modules that will let `tools/console.js` spawn real Claude Code, Codex, Gemini, and Jules agent CLIs as PTY sessions. Plus the task-envelope formatter that pulls task context out of the collab DB and feeds it to the agent on stdin.

This task is **scaffold + unit tests only**. The wiring into `tools/console.js` happens later (after T1 lands) — leave a clear comment at the top of every adapter saying "consumed by tools/console.js spawn(); see briefs/T3-agent-adapters.md".

## Scope — files you may create / touch
NEW:
- `internal-tools/tools/agents/index.js`           — registry: `{ claude, codex, gemini, jules }` → adapter
- `internal-tools/tools/agents/base.js`            — shared adapter interface + helpers
- `internal-tools/tools/agents/claude.js`
- `internal-tools/tools/agents/codex.js`
- `internal-tools/tools/agents/gemini.js`
- `internal-tools/tools/agents/jules.js`
- `internal-tools/tools/agents/envelope.js`        — task → markdown envelope formatter
- `internal-tools/tools/agents/__tests__/`         — unit tests using node's built-in test runner (no Jest)

You MAY do a small read-only require of `tools/codex.js` from `agents/codex.js` to reuse profile activation — but DO NOT modify `tools/codex.js` itself.

**DO NOT touch** `tools/console.js`, `server.js`, `tools/collab.js`, `public/`, `package.json` (other than adding a `test` script if missing), `briefs/`, `design-reference/`.

## Adapter interface

Every adapter exports:
```js
module.exports = {
  name: 'claude' | 'codex' | 'gemini' | 'jules',
  detect: () => Promise<{ ok: boolean, version?: string, hint?: string }>,
  // Returns the spawn args for node-pty.
  // Caller (tools/console.js T1) will do the actual pty.spawn.
  spawnArgs: (opts) => ({
    file: string,            // executable to spawn
    args: string[],
    env: Record<string,string>,
    cwd: string,
    initialStdin?: string,   // text to write right after spawn (the envelope)
  }),
  // Hook called after the pty exits — for cleanup, profile cooldown stamping, etc.
  onExit: (session, exitCode) => Promise<void>,
};
```

`opts` shape: `{ task?, cwd?, autoYes?, profile?, env? }`.

## Per-agent details

### `claude.js`
- `file`: resolve `claude` from PATH (use `which`/`where`). Fall back to `process.env.CLAUDE_BIN`.
- `args`: `['--print', '--input-format', 'text']` if `task` is given (one-shot mode); `[]` for interactive.
- `initialStdin`: the envelope (see below) when `task` is given.
- `detect` runs `claude --version`.

### `codex.js`
- Reuse profile rotation: before spawn, call `tools/codex.js`'s public helpers (read its `module.exports` and use whatever profile-activation export exists, e.g. `activateProfile(name)`). If no public API exists, shell out to `bash codex-profile.sh activate <name>` like `tools/codex.js` already does.
- Pick the profile via `opts.profile`; if not given, pick the first ready one (mimic the dashboard's `pickNext()` logic — see `public/app.js`).
- `file`: `codex`. `args`: `['--no-auto-confirm']` unless `opts.autoYes`.
- `onExit`: if exit code looks like 429 / rate-limit, write a `limit_resets_at` mark via `tools/codex.js` (best effort — log if unsupported).

### `gemini.js`
- `file`: `gemini`. `args`: `[]`.
- `detect`: `gemini --version`.

### `jules.js`
- Jules is a cloud agent (jules.google) — there is no local CLI. `detect()` returns `{ ok: false, hint: 'Jules is cloud-only; assign a task at jules.google instead.' }`.
- `spawnArgs` throws `Error('Jules has no local CLI; create a task at jules.google.')`.
- Keep the file and registry entry so the UI can show Jules as an "assignee" without trying to spawn it.

### `envelope.js`
Pure function: `formatEnvelope(task, opts) => string`.

Task shape comes from `/api/collab/tasks` (already returns `{ id, title, status, priority, assignee, module, summary, description, ... }`). To pull richer context, the formatter MAY read from the same SQLite DB (`collab-mcp/collab.db`) using `better-sqlite3` (already a dep — verify in `internal-tools/package.json`). Read-only — no writes.

The envelope should be a plain markdown blob, ~under 4 KB, looking like:
```
# Task @T-042 — Wire collab MCP into agent handoff hook

**Module:** @collab-mcp
**Status:** in-progress  ·  **Priority:** high  ·  **Assignee:** Claude

## Summary
Hook fires before subagent context is sealed; needs to flush pending entries.

## Context
…task.body sections joined…

## Recent activity
- 14:02  User    created task
- 14:18  Claude  sent to claude-1 (workspace)

## Linked entries
- E-00231 (proposal) — title…
- E-00229 (handoff)  — title…

—— READY ——
```
End with the literal sentinel `—— READY ——` so the agent knows context-load is done.

## Tests
Use the built-in `node:test` runner. At minimum:
- `agents/__tests__/envelope.test.js` — formats a sample task fixture, asserts headings + sentinel.
- `agents/__tests__/registry.test.js` — registry exports all 4 names; each adapter implements the interface.
- `agents/__tests__/claude.test.js` — `spawnArgs({ task })` includes `initialStdin` containing the task id.

Run with: `node --test tools/agents/__tests__`.

If `package.json` does not have a `test` script, add `"test": "node --test tools/agents/__tests__"`.

## Acceptance criteria
- [ ] All four adapter files exist and conform to the interface.
- [ ] `registry.test.js` and `envelope.test.js` pass on a fresh checkout.
- [ ] `node tools/agents/index.js` (or `require('./tools/agents')`) loads with no errors even if Claude/Codex/Gemini are not installed.
- [ ] `detect()` returns `{ ok: false, hint }` cleanly when an agent binary is missing — never throws.
- [ ] No edits to `tools/console.js` (T1 will do the wiring).
- [ ] No new runtime deps in `package.json` (only existing `better-sqlite3` is OK).

## How to verify
```bash
npm test
node -e "console.log(Object.keys(require('./tools/agents')))"   # → ['claude','codex','gemini','jules']
node -e "require('./tools/agents').claude.detect().then(console.log)"
```

## Out of scope
- Wiring adapters into `tools/console.js` (a follow-up 5-line patch after T1+T3 both land).
- Frontend UI changes (T2 owns those).
- Auth, secrets management.

## PR title
`T3: agent adapter scaffolds (claude, codex, gemini, jules) + envelope formatter`
