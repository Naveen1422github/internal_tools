# Jules Task T2 — Frontend visual parity + designer C-borrows (Phase 2)

## Goal
Bring the Console tab in `public/` to full visual + interactive parity with the design bundle in `design-reference/`, **staying on Alpine.js + Tailwind, no build step**. Add the four designer's C-borrows on top of Variant A.

## Scope — files you may touch
- `internal-tools/public/index.html`
- `internal-tools/public/app.js`
- `internal-tools/public/style.css` (extend, don't replace)
- `internal-tools/public/styles.css`, `styles-terminal.css`, `styles-overlays.css` (these were copied from the design bundle — feel free to extend)
- New CSS partials are fine if you keep them in `public/`.

**DO NOT touch** `tools/console.js`, `server.js`, `tools/codex.js`, `tools/collab.js`, `package.json`, anything in `collab-mcp/`, `briefs/`, `design-reference/`.

## Background
The Console tab is partially ported from the React design (`design-reference/app.jsx`). Many UI features from the design are missing. This task ports them all to Alpine.

Reference the design source verbatim — the component logic is in:
- `design-reference/app.jsx` — main app state, drag/drop, Cmd-K keybind
- `design-reference/overlays.jsx` — Cmd-K palette, context menu, Task Detail
- `design-reference/terminal.jsx` — terminal pane structure
- `design-reference/tweaks-panel.jsx` — Tweaks panel
- `design-reference/ui-bits.jsx` — TreeNode, ChipFilter, TaskRow, AGENT_META icons
- `design-reference/data.js` — fixture data shapes
- `design-reference/styles*.css` — visual treatment

The current Alpine app is in `public/index.html` + `public/app.js`.

## Functional requirements

### A. Overlays (port from `design-reference/overlays.jsx`)

**A1. Cmd-K palette** (existing keybind already wired, but the palette UI is missing).
- Slide-down modal overlay. Search input, results list grouped by section: "Sessions", "Tasks", "Spawn", "Themes/Layout".
- Items support `kind: 'task' | 'session' | 'spawn' | 'theme' | 'layout' | 'density'`.
- Arrow keys navigate, Enter selects, Esc closes.

**A2. Right-click context menu on task rows.**
- On `@contextmenu.prevent` capture coords, show menu at cursor.
- Menu items: Open · Run with Claude · Run with Codex · Run with Gemini · Inject into focused terminal · Transition to {next statuses} · Delete.
- Click-away closes.

**A3. Drag-task-to-tab.**
- Drag a task row, the terminal tab strip highlights drop targets, drop on a tab calls `injectTaskIntoSession(sessionId, task)` which appends a new block to that session.
- Show a small drag-ghost at cursor: `{taskId}  {short title}`.
- Dropping on the empty area in the tab strip (after the last tab) spawns a new session with that task.

**A4. Rich Task Detail slide-over** (replace the current minimal one).
- Right-side panel, ~480px wide. Sections: header (id, status, priority, assignee with avatar dot), title, summary, body sections (heading + paragraph or code or bulleted list — see `task.body` shape in `design-reference/data.js`), Activity log, action buttons (Run with Claude/Codex/Gemini, Transition, Reassign).

**A5. Tweaks panel** (port from `design-reference/tweaks-panel.jsx`).
- Floating panel, hidden by default, opened via the cog icon in the activity bar (already there) or `window.dispatchEvent(new CustomEvent('toggle-tweaks'))`.
- Sections: Theme (warp/vscode), Accent (purple/cyan/amber/green), Layout (balanced/terminal-first), Density (compact/cozy/comfy).
- Live updates: writes to `document.documentElement.dataset.{theme,density}` and CSS vars `--accent` / `--accent-2`. The accent color map is already in `app.js applyConsoleTheme()`.

### B. Activity bar wiring (left rail — currently 4 placeholders)

Wire the four icons so they swap the sidebar content:
- **Files** (active) — workspace tree (already shown). Keep.
- **Tasks** — replace tree with a dedicated full-height task list (chip filters at top, all tasks below). Show a numeric badge on the icon for in-progress count.
- **Modules** — module/service browser. Group tasks and active terminals by `@module`. Use `/api/collab/modules` for the list (already exists).
- **Terminals** — session manager. List every running session with: agent pill, name, cwd, last block stamp, kill / focus / split buttons. This is the place to manage agents from outside the canvas.
- **Settings** (cog) — already opens Tweaks. Keep.

Track active rail in `activitySection: 'files'|'tasks'|'modules'|'terminals'`. The sidebar `<aside class="sidebar">` re-renders based on this state.

### C. Designer's C-borrows (TUI-flavored polish — port from `design-reference/variants/squad-codex.jsx`)

**C1. Bottom keyboard-shortcut bar.**
Replace the statusbar (when no terminal session is focused or when the user is in the Tasks rail view) with a single-row hint bar:
```
n new · D kill · ↵/o open · p push · c checkout · ?
```
Use monospace, dim text, accent for the keys. When a session IS active, revert to the regular statusbar (branch, cwd, session count). Make the toggle smooth, not a flicker.

**C2. Boxed terminal frame with thin colored accent border.**
Add `box-shadow` / `border` to the active terminal pane keyed to the agent color (Claude #d97757, Codex #5fa8ff, Gemini #f472b6, bash #94a3b8, dev #4ade80). Inactive split pane gets a dim 1px version. CSS var `--agent-color` is already set on tabs — extend it to the pane.

**C3. Auto-yes toggle pill in the task rail header.**
Small pill labelled `auto-yes` with a green dot when on. Lives in the right-aligned actions area of the Tasks sidebar header. Persists in `localStorage`. When on, agent confirmation prompts in any spawned session are answered with `y\n` automatically (this is FRONTEND-ONLY for now — set `state.autoYes` and stamp it into the spawn options the frontend sends; backend will respect it later).

**C4. Numbered instance rows on agent sessions (in the Terminals rail view).**
Each running session gets `λ#N — branch  +x −y` line where N is its index, branch is `main` or stub, x/y are diff stats (use 0/0 if unknown). Pure visual borrow — the data plumbing comes later, but render the row with placeholders.

### D. SSE consumption (talks to T1, but only via fetch — no T1 file edits)
- Replace the current `submitCommand()` POST→push pattern with: open an EventSource on `/api/console/session/stream?id=<id>` for the active session, accumulate `data` events into the live block, finalize on `block-end`. Existing block history stays in `session.blocks`.
- If T1 is not yet merged, the EventSource will 404 — gracefully fall back to the old behavior.

### E. Tighten existing flow
- Fix the `submitCommand` scroll-to-bottom (it currently selects by `[data-session-id]` which exists but may race the DOM update).
- Make `closeSession` confirm if `splitWith === id`.
- Cmd-K registers globally — already done, keep.

## Acceptance criteria
- [ ] All overlays render and dismiss properly. Esc closes the topmost.
- [ ] Drag a task chip from the sidebar onto a terminal tab → tab gets a new block prefixed `/run @T-XXX`.
- [ ] Tweaks panel changes the live look (theme, accent, density). Persists in `localStorage`.
- [ ] Activity bar's 4 icons swap sidebar content. Tasks badge shows in-progress count.
- [ ] Bottom kbd shortcut bar appears when no session is focused; statusbar reappears when one is.
- [ ] Active terminal pane has agent-colored thin border.
- [ ] Auto-yes pill toggles and persists in localStorage.
- [ ] Terminals rail shows numbered λ rows for each session.
- [ ] No regressions to Profiles tab or Collab tab.
- [ ] No JavaScript errors in console on load.

## Constraints
- **Stay on Alpine.js + Tailwind.** No React, no build step. The site is served as static files from `server.js`.
- Keep additions inside the existing `consoleApp()` Alpine component or as small helper functions on `window`. Don't introduce a bundler.
- Match the design's spacing and typography (Inter Tight + JetBrains Mono are already loaded).
- Keep accessibility: keyboard navigation in Cmd-K, focus rings, aria-labels on icon buttons.

## Out of scope
- Backend changes (T1 owns those).
- Real agent CLI invocation (T3 backend, follow-up frontend wiring later).
- Auth, multi-user, persistence beyond `localStorage`.

## PR title
`T2: full visual parity + designer C-borrows + activity bar wiring`
