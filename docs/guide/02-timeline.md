# 2. Timeline — what was built when

Dates are when the decision or the go-live happened. Each line names the collab note behind it.

## June 2026 — from files to a database

- **Collab MCP Phase 1:** the file-based collab system replaced by SQLite + full-text search + an MCP server.
- **06-12, knowledge model redesign** (COLLAB-7, migration 0004). A note's `type` was doing too many jobs. It was split into **modules** (a note can belong to several), a **category** (Index / Reference / Activity, which decides what gets archived) and `type` (just the shape: decision, gotcha, handoff…). `superseded_by` was added so a newer note can replace an older one.
- **06-13, simplification** (COLLAB-11): the terminal and multi-tab workspace layers were removed (heavy native dependencies) to focus only on collaboration.
- **06-14, workspace redesign:** a real web UI (React + Vite + Tailwind) and an AI assistant panel were planned. The AI may read and draft; it never writes on its own.
- **06-27, learning campaign:** internal-tools became your deliberate learning project (principal-engineer constraints, trade-off logging).

## July 2026

- **07-03, "reachable ≠ found"** (COLLAB-15, task T-011): notes that belonged to a module but weren't linked from its index looked missing. The fix: read-time detection plus a `doctor` check. Still in progress.
- **07-07:** Gemini retired; Codex takes implementation.

## September 2026 — preparing for teams

- **09-09, backups** (COLLAB-19): snapshot with `VACUUM INTO`, verified, zipped and pruned, triggered when a Claude session ends.
- **09-22, market scan** (COLLAB-24): **adopt cr-sqlite** for sync instead of building sync ourselves. The biggest competitive threat is memory built into the AI tools, not startups.
- **09-24, sync rules** (COLLAB-29, COLLAB-31): one central allocator hands out note numbers so they never collide. Simultaneous edits get a **git-style three-way merge**, not "last write wins" (which would silently lose edits).
- **09-28 → 10-02, ULIDs** (migrations 0005 expand, 0006 contract): every note got a permanent hidden ID (ULID) so two laptops can create notes without clashing. The visible number became a label.

## October 2026 — teams, projects, permissions

- **10-03/04, team sync v1** (COLLAB-51): courier + post office designed and built. A save "pings" the courier instantly (COLLAB-63, COLLAB-64), not polling. Retried saves reuse the same number (COLLAB-57).
- **10-04, web UI part 1 "lock":** the web server accepts only requests from its own page, so a malicious website can't edit your notes.
- **10-04, web UI part 2 "sync visibility":** the UI shows sync status, labels what's shared, and has a merge page for colliding edits. An optional AI "Explain" button describes the difference but never picks (COLLAB-77).
- **10-05, packaging + `collab doctor`:** collab installs as one command, notebooks live in your user folder, and `doctor` explains every problem with the exact fix.
- **10-05, projects redirect** (COLLAB-103): instead of sharing modules, you create **projects**, solo or team, each with its own note code (`SH-1`). Sharing means copying on purpose.
- **10-06/07, B1 projects + solo numbering** (migration 0009).
- **10-10, stage C team projects live:** team numbers come from the post office. With the office down, notes are saved as "pending" and numbered later. **The two-laptop test with Rinku passed** (COLLAB-120).
- **10-11, B2 copy live** (migration 0010). Your notebook was reorganised into **PS** (personal) and **COLLAB**; 194 old notes were replaced by their copies (COLLAB-178). The same day: **module → project binding** (migration 0011, COLLAB-179), plus the **local-first** (COLLAB-121) and **AI parity** (COLLAB-122) principles.
- **10-17, RnR designed** (COLLAB-180): roles and permissions for team projects, nothing hardcoded, and the AI never does more than its human.
- **10-17/18, RnR stage S1 built and live** (migration 0012, COLLAB-182, COLLAB-183): membership, each project's notes only to its members, history for new members, read-only on removal.
- **10-18, RnR stage S2 built and merged: change enforcement** (migration 0013, COLLAB-189): the post office now refuses changes a role doesn't allow, refused work is kept on the laptop, and `collab refused` lets you recover it.
