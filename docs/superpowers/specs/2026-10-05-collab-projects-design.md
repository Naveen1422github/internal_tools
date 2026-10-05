# Collab piece 2 (revised): projects, their own numbers, solo or team, copying

Status: direction agreed with the user in conversation 2026-10-05; awaiting spec review. **Replaces** the sharing and numbering parts of `2026-10-05-collab-join-and-teams-design.md` (J6, J7, J9, J16-J19 and the B/C stages of J24). Still valid from that spec: J1-J5 (join code, join steps, Claude Code registration, web setup mode), J13 (leave), J15/J15a (spikes, `CLAUDE_PROJECT_DIR`), J17 (links by ULID, done in stage A), J20-J23 as recorded, the failure table rows about certificates and unreachable offices. Collab: E-771 (old-note sharing deferred), E-772 (split pages), this spec's decision entry.

## In one paragraph (plain language)

Everything that exists today keeps working exactly as it does: every current note keeps its `E-` number, every current module keeps working, sync keeps doing what it does. New is the **project**: you create one on purpose, as **solo** or **team**. A project has a permanent id, a name you can rename, and a short code (`SH`, `NV`) that numbers its notes: `SH-1`, `SH-2`. A solo project numbers its notes on your laptop and never sends anything. A team project gets its numbers from its post office; if the office is down, a new note is saved at once and waits in a visible queue until it gets its number. Only team-project notes are ever sent, and only to their own team. Notes move between worlds only by **copying**, on purpose: old `E-` notes of a module into a new project, or a team project's notes (all, or only mine) into a solo project. A copy is a new note with the target project's number; the original is untouched and can be deleted afterwards. Searching defaults to the project you're working in. You and Claude can always see which project, which mode, and what is waiting.

## Rules

1. **Nothing about existing notes changes.** Notes without a project keep the `E` series and today's numbering, sync and behaviour, including modules shared through today's post office. `E-760`, `760` and `#760` keep meaning the same note forever.
2. A project's identity is its ULID. Its name can be renamed; its code is fixed once created (numbers printed with it must keep meaning the same note).
3. A note's number is fixed when the note is created: series = the project code at creation (or `E` with no project), number from that project's counter. It never changes afterwards, even if the note is later tagged with other modules.
4. Solo: numbers come from the laptop, nothing is ever sent. Team: numbers come only from the post office; nothing in a team project is ever numbered on a laptop.
5. **A note is sent only if it belongs to a team project, and only to that project's post office.** Solo-project and `E` notes from new projects are never sent, whatever they are tagged with.
6. A team project's office being down never stops saving: the note is saved with no number yet ("pending"), searchable and linkable by ULID, and gets its number when the office is reachable again. Switching a project between solo and team is a deliberate config change, never automatic.
7. Copies are explicit and never silent: the command (or page) lists what will be copied and asks first. A copy never changes or deletes the original.
8. Nothing is guessed: every write and search answer (MCP, CLI, web) states the project, its mode, the office state for team projects and the pending count. `collab doctor` explains every project state.

## Decisions

| # | Decision | Why |
|---|---|---|
| P1 | `projects` table: `ulid` (PK), `name`, `code` (2-8 of A-Z/0-9, not `E`, unique in the notebook), `mode` (`solo` \| `team`), `team` (the connection for team mode), `created_at`. Notes gain `series` and `project_ulid` (NULL = no project, today's notes) | One identity per project; old notes untouched |
| P2 | `collab project create <name> --code <CODE> [--solo \| --team <team>]`, `collab project rename <code> <new name>`, `collab project list`, `collab project use <code>` (writes the project into the folder's `.collab`) | Explicit setup, readable config |
| P3 | Which project you're working in: the nearest `.collab` (walk starting at `CLAUDE_PROJECT_DIR` when set, else the working folder, J15a) names the project by ULID. No project named = today's behaviour | Scope without guessing |
| P4 | Search, list and module views default to the current project's notes (both mine and the team's); `scope: "all"` searches everything, as today. No current project = today's behaviour | The supporthub case: one search, team + own notes |
| P5 | Numbers: solo = local counter per project, `next = max(id in series) + 1` inside the write transaction. Team = the post office counter for that project's series; laptops never allocate team numbers | Rule 4 |
| P6 | Pending team notes: `id` NULL, shown `NV-pending`; the courier asks the office for numbers (idempotent by ULID, E-713) and then sends them. Sync bar, MCP answers and doctor show the pending count. Replaces E-708's "refuse to save" for team projects; E-708 stays as is for today's `E` sync | Rule 6 |
| P7 | Sending: the courier sends a note's changes only when its `project_ulid` is a team project bound to this connection. Today's module-based sending stays for `E` notes only | Rule 5; ends the E-758 class of leak for everything new |
| P8 | `collab copy --from <module \| project> --to <project> [--author me] [--since <date>]`: lists, asks, then creates new notes (new ULIDs, target series, numbered by the target's rule); links inside the copied set are re-pointed to the copies by ULID; each original gets a `copied_to` link to its copy; body text mentions (`see E-729`) are not rewritten | User's model: sharing = copying; covers old module → new project and team → solo |
| P9 | Promote a solo project to team: the post office takes over the project's counter starting after the highest local number, so its notes keep their numbers (fresh team: nobody else has that series). Solo means one laptop; two laptops need a team project (even a team of one) | Solo → team without copying |
| P10 | Name or code clash when creating or joining a project in a notebook: stop with a clear message: rename one, or use a different notebook | User: warn, don't mix |
| P11 | Leaving a team keeps its project's notes on the laptop, read-only, marked "left team"; `collab copy` into a solo project makes them yours to edit | Simpler than copy-back on leave |

## Build order (each stage tested on Windows and merged before the next)

- **B1 projects + solo numbering:** migration 0009 (`projects`, `entries.series`, `entries.project_ulid` via the 0008 CRR-alter path, S3), series-aware parse/format/lookup (`NV-12`, `E-760`, `760`, `#760` everywhere a number is taken: MCP, REST, UI, scripts; the 93-site inventory), `trg_refs_fill_target_ulid` learns series, `dispatches` link by ULID, P2, P3, P4, P10, status lines (rule 8). No post office change.
- **B2 copy:** P8, P11's read-only mark.
- **C team projects:** office per-project series counters, P6 pending queue, P7 sending, P9 promote, per-connection courier bookmarks (spike verdict item 1), group-safe paging (E-772) if any multi-column logic depends on it.
- **D join/leave/web welcome:** J1-J5, J13, LAN self-healing (J23).

## Testing ("done" = all pass)

- Today's notebook (a copy of the real one) before and after 0009: every `E-` note, module, search, golden and sync test behaves the same.
- Series round trips: `formatEntryRef(series, id)` / `parseEntryRef` for `SH-1`, `E-00760`, `760`, `#760`, and rejects `E-`, `X-0`, lowercase codes and codes longer than 8.
- Two projects with notes `SH-1` and `NV-1` plus `E-1`: every by-number tool reaches the right note.
- Solo: no network call ever made while saving; nothing sent by the courier.
- Team: office down → note saved pending, visible, linkable; office back → numbered, sent; retries never produce two numbers (E-713).
- Copy: module of `E-` notes → solo project; team project (author filter) → solo; links inside the set point at the copies; originals unchanged apart from `copied_to`.
- Leak tests: a solo note tagged with a team project's module is never sent; an `E` note in a module of the same name as a team module is never sent by the new path.

## Not in this piece

- Renumbering or aliases (dropped: copying replaces them).
- Moving a project between teams; renaming a project's code.
- Rewriting note-body mentions after copying.

## Settled items

- Today's shared `portfolio` module stays on the legacy `E` sync path (user: no preference, 2026-10-05). It can become a team project later by copying (P8); nothing in B-D depends on it.
