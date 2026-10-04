# Collab Web UI, part 2 of 4: Sync visibility and conflicts

Status: design approved in conversation 2026-10-04 (data layer, migration 0008, screens A/A, error handling), awaiting spec review. Depends on part 1 (web server locked). Series: (1) lock, (2) this, (3) this-laptop sync controls, (4) team admin.

## In one paragraph (plain language)

The web UI doesn't know sync exists. After this part it shows, on every page, whether this laptop is in sync and how far behind it is; labels every module and note as shared with the team or kept on this laptop; warns before you save into a shared module; lists notes where two people's edits collided; and gives those notes a page where you see both versions side by side, with who wrote each and when, and settle on the final text, either by picking one or by combining them by hand. If someone changes the note while you're deciding, nothing is overwritten: the page shows the new versions instead. An optional AI button explains the difference but never picks.

## Rules this part must meet (from E-642 standing constraints + the enhancement bars)

1. An outage is a named, visible state with its age ("last contact 4 min ago"), never silence and never a stale green.
2. Sharing is visible: every shared note/module says so; a save into a shared module says so before you click.
3. Conflicts are shown, never silently settled; AI may explain, never pick.
4. Each version shows its author and time.
5. Sharing off = the UI looks exactly like today.
6. The device key in `sync_state` never leaves core through any API.
7. Plain words on screen, no sync jargon.

## Decisions

| # | Decision | Why |
|---|---|---|
| V1 | Status comes from data on this laptop only (`sync_state` + the courier's `status.json`), not by asking the post office | The courier owns the connection; the UI reports what it sees. No network on page load, no key in the web server. Cost: up to ~30 s lag, made honest by showing the age |
| V2 | Status bar = thin bar across the top of every page (user chose A) | Always visible, doesn't take menu space |
| V3 | Conflict page = its own route `/merge/:id` (user chose A) | Long descriptions need full width; shareable link |
| V4 | Resolve = pick a version, or combine by hand (user chose both) | Core already supports both: `resolveNeedsMerge` and "any edit settles it" |
| V5 | Version check (`expectedHeads`) inside core's transaction; mismatch = `VersionsChangedError` → HTTP 409 | Prevents overwriting a newer edit that arrived while deciding; in core so MCP tools get it too |
| V6 | Migration 0008: `entry_revisions.author` (user chose this over "this laptop vs another") | Exact names for a team of any size |
| V7 | Schema guard: courier and post office refuse to exchange changes when their latest migration differs | A laptop on old code would receive a column it doesn't have |
| V8 | Needs-merge list ignores search filters | Session-notes are kind=log and hidden from default search; E-738 would be invisible |

## Components

### 1. Migration 0008: `entry_revisions.author`
- `mcp/migrations/staged/0008_revision_author.sql`: `ALTER TABLE entry_revisions ADD COLUMN author TEXT;` plus the `schema_migrations` row.
- `entry_revisions` is a CRR. Altering it must be wrapped in `crsql_begin_alter('entry_revisions')` / `crsql_commit_alter('entry_revisions')` when the table is a CRR (and must NOT be when it isn't, e.g. an unshared notebook). `core/src/db.ts` gets an `AFTER_MIGRATION` hook map next to the existing `BEFORE_MIGRATION`; 0008 registers begin (before) and commit (after), both no-ops on a non-CRR table.
- `finishRevision` (core/src/revisions.ts) writes `author = resolveAuthor()` (core/src/author.ts, same source as `entries.author`). The backfilled root revision (`<ulid>.0`) takes `entries.author` of its note. Older revisions stay NULL and show "unknown".
- Release follows the 0007 path: staged → `mcp/migrations/` in a commit, pushed BEFORE any laptop pulls.
- Post office: `openStore` today does not migrate. `collab-post-office serve` applies released migrations to its store at start (backup first, same `backupBeforeMigrating`), so the office is on 0008 before any laptop.

### 2. Schema guard (V7)
- Every courier request sends `X-Collab-Schema: <latest applied migration>` of its notebook.
- The post office compares it with its store's latest migration. Different → `409 {"error":"schema", "office":"0008_...", "device":"0007_..."}` on `/v1/changes` (both directions) and `/v1/allocate`.
- Courier on that 409: state `needs-update`, no retry storm (back off to the normal 30 s), `lastError` = "update this laptop: the post office is on 0008".
- Rollout order (runbook): back up → post office laptop pulls + builds + restarts `serve` (migrates its store) → each laptop pulls + builds + `npm run migrate` + restarts its courier and writers. Between steps, out-of-date laptops pause instead of corrupting.

### 3. Core: `readSyncOverview(db, courierDir?)` (new `core/src/sync/overview.ts`)
Returns:
```
{ enabled: false }
| { enabled: true,
    postOffice: "https://192.168.0.104:7443",   // URL only
    deviceId, sharedModules: string[],
    unsent: number,                              // changes in shared modules not yet sent
    courier: { running: boolean, state: string | "unknown", lastError: string | null,
               lastPushAt: string | null, lastPullAt: string | null },
    lastContactAt: string | null,                // max(lastPushAt, lastPullAt)
    health: "ok" | "behind" | "not-syncing" | "needs-update" | "unknown" }
```
- `unsent` logic moves here from `courier/src/cli.ts` (`sync status`); the CLI calls this function so there is one copy.
- `running` = pid in `status.json` is alive.
- `health`: courier not running → `not-syncing`; state `needs-update` → `needs-update`; `status.json` missing/unreadable → `unknown`; `unsent > 0` or last contact older than 60 s → `behind`; else `ok`.
- Never includes `device_key` (test asserts the serialized object).
- Courier dir default moves from `courier/src/paths.ts` to core so core doesn't import courier.

### 4. Core: the version check
- `headsOf` already gives the competing versions. New `getMergeView(db, id)` returns `{ id, current: {title, summary, description}, heads: [{rev_id, title, summary, description, author, created_at}] }` for a flagged note (throws if not flagged).
- `resolveNeedsMerge(db, id, expectedHeads)` (keep current text) and new `resolveWithText(db, { id, expectedHeads, title, summary, description })` (pick or combine) both, inside one transaction: recompute heads; if the set of `rev_id`s differs from `expectedHeads` → throw `VersionsChangedError`; else write (the edit settles the flag via `finishRevision`).
- `resolveNeedsMerge` is not exposed by any caller today (MCP, server, CLIs), so making `expectedHeads` required breaks nothing.
- **V9 (approved by the user 2026-10-04):** today an agent's `collab_update` on a flagged note silently settles the conflict (any edit folds every version in) without the agent ever seeing the other version. That breaks rule 3. Proposal: `updateEntry`/`editEntry` on a note with `needs_merge = 1` are refused with "E-738 needs a merge first: open /merge/738 in the collab web UI", unless called through `resolveWithText`. The MCP gains no new tool in this part.

### 5. Server: `server/src/tools/sync.ts` (new; `collab.ts` stays as is)
| Route | Returns |
|---|---|
| `GET /api/sync/status` | `readSyncOverview` |
| `GET /api/sync/needs-merge` | `[{id, title, module, type, updated_at}]`, no kind/status filters |
| `GET /api/sync/versions?id=` | `getMergeView` |
| `POST /api/sync/resolve` | body `{id, expectedHeads, choice: "keep-current" \| {title, summary, description}}` → 200 / 409 `{error:"versions-changed"}` / 404 |
| `POST /api/sync/explain` | `{id}` → `{text}` from the existing AI tool (prompt: describe the differences neutrally, never recommend); 503 `{error:"ai-unavailable"}` if no key/failure |
| `GET /api/collab/modules` (existing) | each module gains `shared: boolean` when sharing is on |

### 6. UI
- `components/SyncBar.tsx`: thin bar at the top of `AppShell`, polls `/api/sync/status` every 10 s and on window focus. Hidden when `enabled: false`. Three colours / wording:
  - ok: "● Sharing on · last contact 12 s ago · nothing waiting to send"
  - behind: "● Behind · last contact 4 min ago · 3 changes waiting to send · the courier is retrying"
  - not-syncing / needs-update / unknown: red, with one "how to fix" line ("run `collab sync start`" until part 3 replaces it with a button; "update this laptop"; "sync status unknown").
- Sidebar: "Needs merge (n)" item, only when n > 0.
- `pages/NeedsMerge.tsx`: the list; each row links to `/merge/:id`.
- `pages/Merge.tsx` (`/merge/:id`): yellow header "Two people changed this note at the same time. Nothing was lost."; versions side by side (2+ columns; 3+ heads scroll), each with author + time; only differing fields shown in full, equal fields collapsed to "same in both"; "Use this version" per column; "Combine by hand…" opens an editor prefilled with the first version; "✦ Explain the difference (AI)"; on 409 the red line "Someone changed this note while you were deciding. Nothing was saved." and the page reloads the versions.
- `Modules.tsx`: label per module "⇄ Shared with team" / "🔒 Only on this laptop".
- `EntryDrawer.tsx`: label under the title + "by <author>"; yellow line with link to `/merge/:id` when flagged.
- Save paths (`EntryDrawer` edit, `DraftCard` AI draft): note above Save when the target module is shared: "⇄ <module> is shared: when you save, this note goes to everyone on the team." Nothing for private modules.

## Failure behaviour
| Situation | What you see |
|---|---|
| Note changed while deciding | 409 → red line, versions reload, nothing saved |
| Post office down while resolving | Resolution saved locally (edits need no number); bar amber "1 change waiting to send"; goes out on reconnect |
| Courier not running | Red bar with the fix |
| `status.json` missing/corrupt | "sync status unknown", never green |
| Laptop behind the office's migration | Courier pauses; red bar "update this laptop" |
| AI explain fails / no key | Button shows "couldn't explain"; resolving still works |
| Sharing off | No bar, labels, menu item or save note |

## Testing ("done" = all pass)
- Core: 0008 on a shared DB keeps cr-sqlite working (an edit after 0008 replicates to a second DB via the test `ship` helper, `author` included); 0008 on an unshared DB works without the extension; edits record `author`; root revision takes the note's author; `resolveNeedsMerge` / `resolveWithText` refuse on `expectedHeads` mismatch and write nothing; `readSyncOverview` never contains `device_key`, computes `unsent` like the courier did, maps each `health` case; schema guard: office 409s a device on a different migration, courier enters `needs-update`.
- Server: each route, including 409 and 503 paths, and needs-merge returns a session-note.
- UI (vitest): bar's three states + hidden when off; Merge page: pick, combine, 409 reload, explain failure; shared-module save note shown/not shown; module labels.
- By hand, two laptops: create a fresh conflict, settle it on NAVEEN's merge page, RINKU receives the text with the flag cleared and the resolution's author recorded. Then settle E-738 the same way.

## Not in this part
Buttons for start/stop/join/leave (part 3); members, share/unshare, revoke, post office control (part 4). Until part 3, the red bar's fix line names the command.

## Risks and open items
- 0008 is the first ALTER of a CRR table here; the plan's first task is a spike proving `crsql_begin_alter`/`commit_alter` + replication of the new column on our schema before anything else is built.
- Rollout requires every laptop to update before editing resumes; the schema guard makes a missed laptop pause, not corrupt.
