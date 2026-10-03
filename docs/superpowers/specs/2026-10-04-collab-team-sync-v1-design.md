# Collab Team Sync v1: Design

**Status:** design approved in conversation 2026-10-04, written spec awaiting user review.
**Goal:** the user's two laptops share chosen topics of the collab notes. A note written on either one appears on the other within about 2 seconds, search finds it, note numbers never clash, deletes stick, and simultaneous edits are merged (or flagged), never silently lost.
**Audience after v1:** real teammates, who may not use Claude (Codex, Cursor, plain web UI).

## In one paragraph (plain language)

Each laptop keeps its own notes file, and every tool keeps reading and writing it at full speed. A small **courier** program runs on each laptop. The owner either starts it themselves or opts in to having it start at login. It notices new notes the moment they're saved and sends them to a **post office**. The post office runs on the main laptop for now and later on a server. It gives each note its official number, keeps a copy of everything shared, merges simultaneous edits, and **rings the doorbell** of the other laptops so they collect new notes straight away. If anything is unreachable, the courier retries every 30 seconds. When nothing changes, nothing happens.

## Decisions (with where they came from)

| # | Decision | Source |
|---|---|---|
| D1 | Local-first SQLite on each machine. Sharing is a transport problem; no storage rewrite. | E-640 (do not re-litigate) |
| D2 | cr-sqlite does the row-level replication. We don't hand-roll a CRDT. | E-644 (spike: ADOPT) |
| D3 | v1 = two real machines (the user's main and second laptop). Built so the post office can move to a server with a config change only. | 2026-10-04 (B + C) |
| D4 | Push on write. Doorbell (server push) for receiving. Retry every 30 s on failure. Idle = no work. | 2026-10-04, user's proposal + doorbell |
| D5 | **Notes only.** Tasks stay per-machine (personal; T-numbers would collide; task conflict policy is parked). | 2026-10-04; E-646 |
| D6 | One courier per machine, independent of any AI client, set up with one plain command. **Start-at-login is opt-in:** setup asks, and the default is no. Without it, the user runs `collab sync start` themselves. Nothing is installed silently, and setup prints exactly what it installs and how to remove it. | 2026-10-04 ("not everyone will use Claude"; "should not appear fishy") |
| D7 | E-numbers come only from the post office once sharing is on, for every new note including private-topic ones (only the ULID is sent to ask). Idempotent by ULID, atomic, never reused. **v1: if the post office is unreachable, the write is refused and nothing is saved** (collab E-708; relaxes E-642 constraint #5 on purpose; revisit when real teammates join). No "number pending" state: ~150 code sites assume a non-null id. | E-648, E-708 |
| D8 | Concurrent edits: git-style. Links are separate rows and never conflict. Text edits become revision rows. The **post office alone** runs a three-way merge. Clean merge = merged revision; overlap, or a fixed-choice field (status/type) changed differently = `needs_merge` for a person. Last-writer-wins is **withdrawn**. | E-651 (re-confirmed 2026-10-04) |
| D9 | Deletes travel as tombstones (`deleted_at`, from 0006) and never resurrect. | E-646, 0006 |
| D10 | A note travels iff its **primary topic** is shared. Sharing is opt-in per topic. Un-sharing stops future sends; already-delivered notes stay delivered. | E-646 + 2026-10-04 |
| D11 | A new machine starts with an **empty** notes file and downloads all shared topics on first join. (The second laptop has no notes, so there's no import path in v1.) | 2026-10-04 |
| D12 | Membership: a per-machine key from a one-time join code. The post office keeps members + per-machine bookmarks and offers a "team status" view. Revoking a key locks that machine out immediately. | 2026-10-04 |
| D13 | Traffic is encrypted even on a LAN. The join code carries the post office's certificate fingerprint (pinning), so an impostor on the same Wi-Fi is rejected. | 2026-10-04 |
| D14 | Post office storage = SQLite. | E-646 |
| D15 | Synced notes are re-indexed for search on arrival. 0006 already moved FTS to its own copy keyed by ULID, so duplicate numbers can't corrupt it. | E-643, 0006 |

## Components

### 1. `@collab-mcp/core` changes (shared by every writer)
- **Load the cr-sqlite extension in `getDb()` once sync is enabled.** Once tables are CRRs, their triggers call cr-sqlite functions, so **every** process that writes the notes file (MCP servers, REST server, scripts, Codex runs) must load the extension or its writes fail. This is the biggest blast-radius item in v1. See Risks.
- **Numbering mode:** when sync is enabled, `insertEntryRow` refuses to mint from `local_counters`. New entries go through `addEntryAsync`, which gets the number from the post office first, or writes nothing (E-708). Before sync is enabled, behaviour is unchanged.
- **Edits write revisions:** `updateEntry` appends an `entry_revisions` row (parent = current revision) as well as updating the entry. The table exists since 0005; today it holds 4 rows.
- **`needs_merge` surfacing:** the module card and doctor show entries flagged by the post office.

### 2. Courier (new package, one per machine)
- Set up by `collab sync setup <join-code>`. Setup asks "Start sync automatically when you log in? [y/N]" (also `--autostart` / `--no-autostart` for scripted installs).
  - **Yes:** it registers an OS login entry (Windows Task Scheduler / macOS launchd / Linux systemd user unit) and prints its name and location.
  - **No (default):** nothing is registered. The user runs `collab sync start` / `stop` / `status`.
  - Either way: `collab sync autostart on|off` changes the choice later, and `collab sync uninstall` removes everything setup added. Notes always save locally; if the courier isn't running, it catches up from its bookmark when it starts.
- **Watch:** a file-change watch on the notes DB and its WAL, debounced at about 200 ms. On change, it reads `crsql_changes` since its last-sent `db_version`.
- **Filter:** sends only rows whose entry's primary topic is shared (entries, refs, entry_modules and entry_revisions are mapped to their entry ULID). Allocation requests (ULID only) are sent for every new note.
- **Send:** HTTPS POST to the post office with its device key. On failure, retry every 30 s. It persists its sent-bookmark, and the post office ignores duplicates, so resending is always safe.
- **Doorbell:** a long-lived server-push connection (SSE). On "new changes", it fetches everything after its receive-bookmark, applies it via `crsql_changes`, **re-indexes the affected ULIDs in FTS**, and advances the bookmark. If the connection drops, it reconnects within 30 s and catches up from its bookmark.
- **Never blocks local work.** If the courier is down, every tool keeps working, and it catches up on restart.

### 3. Post office (new package)
- An HTTPS + SSE server with its own SQLite (cr-sqlite) store holding every shared change, plus:
  - `deliveries`: a global, ordered sequence (#1, #2, ...) of accepted changes.
  - `members`: device id, owner name, key hash, revoked flag, last-seen, receive-bookmark.
  - `allocations`: ulid → E-number, unique on both. The counter starts at the current max(id) of the main laptop's notes. The increment and the record commit in one transaction. A repeat request returns the same number.
- **Merge:** when two revisions share a parent, it runs a three-way merge (node-diff3, MIT). Clean = it writes the merged revision and the entry text. Because the post office's write is the newest, cr-sqlite replication carries it everywhere. Conflict, or diverging status/type = it sets `needs_merge`. Laptops may briefly see one side's text until the merge lands.
- **Doorbell:** after accepting a delivery, it notifies every connected member except the sender.
- **Admin commands:** `add-member <name>` (prints a join code), `revoke <device>`, `status` (who is up to date / behind / last seen).
- v1 runs on the main laptop. Moving it is only a URL + certificate change in courier config.

### Not in v1
- Task sync, the task conflict policy, T-number allocation.
- Importing an existing non-empty notes file on join.
- A web UI for team status (command only; the page comes later).
- Rewriting E-number mentions inside note text.
- Server hosting, multi-team, per-person permissions beyond "member or not".

## Data flow: a note written on the second laptop

1. The writing tool mints a ULID and asks the post office for an E-number (`addEntryAsync`). If that fails, nothing is saved and the tool gets a clear error.
2. The note is saved locally with its real number. The courier sees the file change, reads the new `crsql_changes` rows, and sends them.
3. The post office records the delivery (#N) and rings the doorbell.
4. The main laptop's courier fetches after its bookmark, applies the rows, re-indexes FTS for the ULIDs, and advances its bookmark. The note is searchable.

## Failure behaviour

| Situation | Behaviour |
|---|---|
| Post office down | **New notes are refused** with a clear message (v1, E-708). Reads, search and edits keep working locally, and the courier retries every 30 s to send pending edits. |
| Other laptop asleep | It catches up from its bookmark on wake. |
| Courier crashes mid-send | Its persisted bookmark resends from the last confirmed point. The post office de-duplicates. |
| Same note edited on both | Clean = merged. Overlap = `needs_merge`, shown on the card and in doctor. Nothing is silently discarded. |
| Key revoked | Every request is refused (401). The courier shows "access revoked" and stops retrying. |
| Impostor post office on the LAN | Certificate pin mismatch. The courier refuses to connect. |
| A writer process without the cr-sqlite extension | Its write fails loudly (it never silently skips sync). Doctor checks that the extension loads. |

## Testing ("done" = all pass: automated with two simulated machines in one process, then once on the real two laptops)

1. A note written on B appears on A in ≤ 2 s **and `collab_search` finds it** (not merely "the row is present", per E-643).
2. B offline while A writes → B catches up on reconnect.
3. Post office offline while B writes → the write is refused, nothing is saved, and the message names the post office. Edits made while offline sync once it's back.
4. Same note edited on A and B: different paragraphs → merged; same line → `needs_merge`.
5. Delete on A → gone on B and never returns after further syncs.
6. A private-topic note never leaves its machine (assert on the post office store).
7. A revoked key → refused.
8. Courier killed between send and acknowledgement → no loss, no duplicate.
9. Doctor `duplicate_entry_ids` stays ok across all scenarios. The allocator returns the same number for a repeated ULID.

## Risks and open items
- **cr-sqlite binary.** Unreleased since Jan 2024 (E-646). v1 uses the 0.16.3 prebuilt for win-x86_64. A Mac or Linux teammate later needs a build. This must be checked before any second OS joins.
- **Every writer must load the extension.** That includes the REST server, mcp scripts, and Codex runs (which set `COLLAB_DB_PATH`). A forgotten writer fails loudly. The plan must list every `getDb` caller.
- **First join size:** about 14k change rows for the current corpus (E-646), well under a minute on a LAN.
- **The post office on a laptop is a single point.** Acceptable for v1 (D3). Moving it is a config change.
- **Brief divergence during merge:** a laptop can show one side's text for a moment before the merged revision arrives. Acceptable.
- **Public-release flags** (separate thread, unchanged): a clean-room repo copy, and IP ownership.
