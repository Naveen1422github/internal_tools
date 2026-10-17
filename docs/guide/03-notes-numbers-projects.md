# 3. Notes, numbers, projects

## A note

Every note has:

- a **type** (its shape): handoff, decision, gotcha, review, proposal, session-note, changelog, rollup
- a **category** (its lifecycle): **Index** (navigation hubs), **Reference** (decisions, gotchas: kept long-term) or **Activity** (handoffs, session notes: can be archived)
- one or more **modules** (topics, e.g. `collab-mcp`, `custom-reports`), where the first is the primary module
- links to files, tasks, other notes and URLs
- an optional `superseded_by`, meaning "this note is replaced by that newer one". Old notes are hidden from search but never lost.

**Why categories exist** (COLLAB-7): "should this be archived?" can't be answered from the type alone. A handoff from last month is noise, while a decision from last month is still law.

## Two identities per note

| | ULID (hidden) | Number (visible) |
|---|---|---|
| Example | `01M4NRDH3PWAF8T8CZKA18ERKY` | `COLLAB-123`, `E-760` |
| Made by | your laptop, instantly | the series' owner (your laptop for solo, the post office for team) |
| Purpose | permanent identity; links point at it | human-friendly name |

**Why both** (migrations 0005/0006): two laptops can create notes at the same moment. Random ULIDs never clash, but short readable numbers need one owner. So identity is the ULID, and the number is a label added by whoever owns that series.

## Series (the letters before the number)

- **`E`**: your notebook's original series. All notes from before projects exist keep their `E-` number forever. A bare number like `760` means `E-760`.
- **Project codes** (`COLLAB`, `PS`, `TT`…): each project numbers its own notes. That's why you should always write full refs in mixed sessions: `PS-3`, not `3`.

## Projects (since 10-05, COLLAB-103)

A project is a deliberate container with a fixed code and a mode:

| | Solo | Team |
|---|---|---|
| Numbers from | your laptop | the post office |
| Ever sent anywhere? | **never** | only to that team's post office |
| If the office is down | n/a | the note is saved as **pending**, still searchable and linkable, and numbered later |

Your projects today: **COLLAB** (solo: collab-mcp, internal-tools-learning, workspace-redesign, gemini-mcp), **PS** (solo: jarvis, resource-constrained-agent, portfolio, expense-tracker), **TT** (team test with Rinku), plus the retired test projects **JV** and **SO**. Office work (emp1st modules, SupportHub, qa-system) stays in **E** (COLLAB-123).

## Which project does a new note land in? (binding, COLLAB-179)

When a note is saved, the project is chosen in this order:

1. a project named explicitly in the save
2. the project its **primary module is bound to** (`collab project bind`)
3. the folder's `.collab` file
4. otherwise `E`

**Why module binding beats the folder:** you start every session from `frontend2` and mix topics in one session. A folder can't tell a jarvis note from a custom-reports note, but the module can. Bindings are stored in a **local** table, because a personal "jarvis → PS" setting must never be sent to the office.

## Copy (stage B2, migration 0010)

Notes move between projects only by **copying**: new notes get the target's numbers, links inside the copied set are re-pointed, and each original gets a `copied_to` link. The original is never changed. This is how the 10-11 reorganisation into PS and COLLAB was done.

**Why copy instead of move:** a number printed somewhere (a commit message, a chat) must keep meaning the same note forever.

Known gaps found while using copy (listed in COLLAB-178, still open):

- no single "retire the originals" step
- links between notes copied in separate runs keep pointing at the originals
- very verbose output (~40K tokens for one copy)
- a project can't be retired
- copying by module trusts tags blindly
