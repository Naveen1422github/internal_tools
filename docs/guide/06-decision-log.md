# 6. Decision log

The big choices, newest first. "Rejected" is what was considered and turned down. Ask Claude for the note to see the full reasoning.

| Date | Decision | Why | Rejected | Note |
|---|---|---|---|---|
| 10-18 | A refused save is refused whole (all-or-nothing) | half a note is worse than none | letting the allowed half through | COLLAB-189 |
| 10-18 | A refused creation kills the note: it stays only on the laptop | a note the team may not have must not leak half-way | keeping it in the office anyway | COLLAB-189 |
| 10-18 | The office writes the correction back under its own site | laptops pick the true value up through normal sync, no special channel | a separate "undo" message | COLLAB-189 |
| 10-18 | Note numbers accepted only if the office allocated them | a laptop can't claim a number it was never given | trusting the number sent | COLLAB-189 |
| 10-18 | Courier keeps a crash-safe outbox; refusals are recorded per note | a crash mid-send must not lose or repeat work | in-memory queue | COLLAB-189 |
| 10-18 | Speed gate (classify + stamp under 5 ms per 2000 changes) is strict only with `COLLAB_PERF=1` | a busy machine made the strict test flaky; normal runs use a 3x smoke limit | strict always | COLLAB-189 |
| 10-17 | RnR: SupportHub-style catalog, team projects only, enforced at the post office, AI ≤ its human | real security can only live on the server; the AI must never be a way around a person's limits | emp1st's fixed action grid; browser-side checks; AI with its own separate rights | COLLAB-180 |
| 10-17 | Two permission levels: Office and Project | some actions (create a project, add a member) belong to no single project | one level only | spec R13 |
| 10-17 | New members get the project's full history | same as joining a Slack channel or cloning a repo | only new notes from now on | spec R14 |
| 10-17 | Removed member keeps a read-only copy | same as leaving a team today | deleting their copy | spec R15 |
| 10-17 | AI separate key and "member = person, not laptop": **deferred** | needed, but not now | — | COLLAB-180 |
| 10-11 | Module → project binding beats the folder | sessions mix topics from one folder | folder-only `.collab` | COLLAB-179 |
| 10-11 | Local-first: solo never depends on a server | 7 notes sat waiting while the office was down | requiring the office for everything | COLLAB-121 |
| 10-11 | The AI must be able to do anything the CLI can | setting up jarvis hit 4 CLI-only walls | AI as a limited helper | COLLAB-122 |
| 10-11 | Two projects: PS (personal) and COLLAB; office work stays E | keep personal, tooling and office knowledge apart | one big notebook | COLLAB-123 |
| 10-10 | One office per notebook; office down = notes go pending | saving must never be blocked | refusing to save (the earlier choice, COLLAB-52) | COLLAB-115 |
| 10-10 | Finish development before sharing with the team; Rinku is the tester | team too busy for experiments | sharing early | COLLAB-114 |
| 10-07 | Post office to move to the company server (on hold) | lets a friend join SupportHub | home laptop forever | COLLAB-113 |
| 10-05 | Projects with their own codes; sharing = deliberate copy | numbers never collide; nothing leaves by accident | sharing whole modules; renumbering | COLLAB-103 |
| 10-04 | Web server accepts only its own page's requests | any open website could otherwise edit your notes | trusting localhost | web-lock spec |
| 10-04 | Merge page AI "Explain" may describe, never pick | a person settles conflicts | AI auto-resolve | COLLAB-77 |
| 10-04 | Saves ping the courier; all writes go through core | instant and free when idle | polling | COLLAB-63/64 |
| 10-03 | A retried save reuses its number | no double numbers after a network blip | — | COLLAB-57 |
| 09-24 | Git-style three-way merge for edits | last-write-wins loses work | last-write-wins | COLLAB-31 |
| 09-24 | One central allocator owns note numbers | two laptops must never mint the same number | per-laptop ID blocks | COLLAB-29 |
| 09-22 | Adopt cr-sqlite; don't build sync | proven, MIT, fits the existing schema | build our own; Turso | COLLAB-24 |
| 09-09 | Backups: snapshot on session end | cheap and automatic | manual copies | COLLAB-19 |
| 06-13 | Remove terminal/workspace layers | heavy native deps, off-focus | keeping them | COLLAB-11 |
| 06-12 | Modules × category × type knowledge model | `type` was overloaded | type-only | COLLAB-7 |

## Smaller rulings made while building RnR S1

During the build, Claude made 21 small calls on your behalf. All are listed in COLLAB-182 and in the final message of the 2026-10-17 session. The ones you'd notice:

- `collab team …` instead of `collab office …` for laptop commands (that name was already taken).
- Any role, even one without "view", makes a project visible in your list.
- The office's member list decides which projects are read-only on a laptop. That means a future "leave team" must remove you at the office too.
