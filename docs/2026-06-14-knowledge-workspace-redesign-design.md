# Knowledge Workspace Redesign + Open-Source Prep — Design

**Date:** 2026-06-14
**Status:** Approved (design); pending implementation plan
**Working title:** Knowledge Workspace (candidate product name: "CollabOS" — naming TBD)

---

## 1. Context & Goal

`internal-tools/` started as a personal, local-first collaboration-memory system and has
~2 months of real daily use (167 entries). The backend — Node.js + `better-sqlite3` + FTS5,
exposed to AI agents via an MCP server — is heavily used and solid. The **UI is the weak
point**: a vanilla HTML/JS dashboard that behaves like a database viewer (navigate → list →
detail). Maintenance is high-friction (e.g. `doctor` reports **44 entries with an unknown
module**), so knowledge rots.

**This project's goals, in priority order:**

1. **A genuinely good UI** — easy category/module navigation, clear visibility of what's
   stored, low-friction edit/delete, plus a **Grok-powered AI assistant** to query and
   capture knowledge conversationally.
2. **Open-source it** (clean-room) so others can self-host for personal use.
3. **Team / shared memory** — explicitly **deferred** to its own later spec (introduces auth,
   shared/hosted DB, identity).

Monetization and "public/portfolio reach" are aspirations, not requirements; out of scope here.

### Non-goals (this spec)
- No multi-tenant SaaS, no auth, no hosting/billing.
- No rebuild of the storage engine or MCP tools — they stay as-is.
- No autonomous AI writes (see §4).

---

## 2. Architecture

The storage engine and agent interface are **unchanged**. We add a real UI and an AI proxy.

```
ui/          NEW: Vite + React + Tailwind SPA (currently an empty folder)
               → built to static files
server/      REST API (/api/*) — expand existing server/tools/collab.js
               + NEW /api/ai/* Grok proxy (API key stays server-side)
               → serves the ui/ static bundle
core/        UNCHANGED: db.js + constants.js (shared by server AND mcp)
mcp/         UNCHANGED: the 13 MCP tools — agents keep using this
better-sqlite3 + FTS5   UNCHANGED: ONE SQLite DB = shared brain
```

**Invariant:** AI agents write via MCP; the human reads/edits via the UI; both hit the same
SQLite file. The redesign is a new face on the existing engine, not a new engine.

### Units & boundaries
- **`core/`** — DB access + domain constants. Single source of truth. No HTTP, no UI.
- **`server/` REST layer** — thin HTTP/JSON over `core/`. Stateless. Validates input reusing
  app-layer rules (slug regex, summary ≤ 200, supersede-over-delete).
- **`server/` AI proxy** — owns the Grok API key and the tool-call loop; never exposes the key
  to the browser; can only call read tools + return drafts.
- **`ui/` SPA** — presentation only. Talks to the REST + AI endpoints. No direct DB access.
- **`mcp/`** — agent-facing tool surface. Independent of the UI; shares `core/`.

---

## 3. UI Screens (v1)

| Screen | Purpose | Pain it solves |
|---|---|---|
| **Dashboard** | "What changed / what needs attention": recent activity, counts by module & category, a knowledge-health score | "I can't see what's in there" |
| **Knowledge browser** | Left rail filters: **Category** (Index/Reference/Activity) + **Module** + **Type**. Center: entry list. Right: **detail drawer** with inline edit / supersede / delete / ref links | navigation + low-friction edit/delete |
| **Global search (⌘K)** | FTS5-powered; filter tokens `module:`, `type:`, `since:` | the most-used capability today |
| **Modules** | Module list with goal/status; drill into member entries | project/category-wise view |
| **Tasks** | List / board grouped by status | existing `tasks` table |
| **Knowledge Health** | Cleanup surface: the orphan-module entries, missing summaries, stale/duplicate candidates — one-click resolve | "I feel lazy to maintain it" |
| **AI Assistant** | Persistent right panel — Grok chat: search, summarize, and **draft entries/edits for approval** | conversational capture + retrieval |

Visual design for these screens is produced via **Claude Design** (claude.ai/design →
`DesignSync`), which emits React + Tailwind that drops into `ui/`. Design work happens
**after** this spec is approved, during Phase 1.

---

## 4. AI Assistant — safe by construction

**Scope: read freely + draft-for-approval. No autonomous writes or deletes.**

```
You type → /api/ai/chat → server calls Grok (key in .env, never in browser)
  → Grok requests a search → server runs FTS against DB → returns answer
  → OR Grok proposes a new entry / edit → UI renders it as a DRAFT card
  → you click Approve → normal /api/entries write (same validation as manual edits)
```

- API key lives only in server `.env`; never shipped to the browser.
- The AI can call only **read** tools (search, get). It cannot mutate the DB.
- Every change is a human-approved draft passing the same validation the MCP enforces.
- Provider is **Groq** (Llama, OpenAI-compatible — `api.groq.com`) for v1, confirmed
  2026-06-15. (Earlier drafts wrote "Grok (xAI)" — that was a misnomer; the env key and the
  proven `aiService.ts` reference are Groq.) The proxy is written so swapping providers
  (xAI/OpenAI/Ollama/etc.) is a config change, not a rewrite — but multi-provider UI is out of
  scope for v1.

---

## 5. Open-Source: clean-room gate (HARD requirement)

`internal-tools/` has its **own git history** containing `data/sessions.json` (from the old
removed terminal feature) and employer-specific commit messages. The live `collab.db` is
**not** and was **never** committed (verified) — but the history is still not publishable.

**Do NOT `git push` this repo to a public remote.** Instead:

- Create a **new public repo**, seeded with only: `core/ server/ ui/ mcp/` source,
  `migrations/`, `README`, `LICENSE`, and a `seed-demo.sql` (fake demo entries).
- **Never** ship `collab.db`, `data/`, `export/`, or the existing git history.
- First run creates an empty DB from migrations → every user gets a clean instance.
- Sweep the code/docs for hardcoded employer strings before publishing.

---

## 6. Add / Remove / Simplify

- **Add:** Dashboard, Knowledge Health view, AI assistant, inline edit/delete drawer, ⌘K
  search, `seed-demo.sql`, `LICENSE`, setup README.
- **Keep (do not remove):** `dispatches` / savings tables — lightly used but part of the
  agent-collaboration story and harmless.
- **Simplify:** collapse the two stray CSS files (`style.css` + `styles.css`) into Tailwind.

---

## 7. Error Handling & Safety

- AI never writes directly; all mutations go through human-approved drafts → existing
  validation in `core/`.
- Destructive UI actions (delete / supersede) require confirmation; prefer **supersede over
  delete** (matches existing ethos and preserves history).
- Input validation reuses app-layer checks (slug regex, summary ≤ 200, type/category enums).
- Localhost-only, no auth (unchanged) — acceptable for a self-hosted single-user tool; auth
  is a Team-phase concern.

---

## 8. Phasing (rough effort, hours)

- **Phase 1 — UI core (~20–30h):** complete REST API + React/Vite/Tailwind scaffold +
  Dashboard / Browser / Search / Modules / Tasks. Claude Design drives visuals.
- **Phase 2 — AI + Health (~12–18h):** Grok proxy, draft-for-approval flow, Knowledge Health
  cleanup tools.
- **Phase 3 — Open-source (~6–10h):** clean-room repo, LICENSE, README, demo seed, employer-
  string sweep.
- **Phase 4 — Team (deferred):** auth + shared/hosted DB — a separate spec when ready. DB
  schema is left team-friendly (entries already carry `agent`; a future `author`/`workspace`
  column is additive).

---

## 9. Open Items

- **Product name** — "CollabOS" vs other; decide before the public repo is created.
- **License choice** — MIT (permissive) is the default candidate; confirm in Phase 3.

## 10. Backlog from external review (GPT / DeepSeek, 2026-06-14)

Triaged; recorded here so they survive. Not in Phase 1A.

- **`audit_log` table before open-sourcing** (migration 0005): `id, action, entity_type, entity_id, actor, created_at`; append a row on create/edit/delete/supersede/reassign. Cheap now, valuable for history + the future Team phase. **Adopt — do in 1B or a dedicated migration task.**
- **Dashboard "recently modified / recently superseded"** (not just recently-created): extend `/api/collab/stats` with `recent_modified` (by `updated_at`) and `recent_superseded`. Cheap. **Adopt in 1B.**
- **Saved Views** — named filter combos (e.g. `module:collab status:active category:Reference`) as first-class routes. Reserve concept; build after the Knowledge browser exists.
- **Entry relationships** — typed `related_to` beyond supersede. Largely already covered by the existing `refs` table (`ref_type='entry'`); revisit only if a typed relation is needed.
- **API versioning** `/api/v1/collab/*` — do during Phase 3 (open-source) to avoid churning the current dashboard + new routes now.

**Claude Design brief inputs (from DeepSeek's screen detail — for Phase 1C visuals, not the mock-server approach):**
- Per-type entry cards render differently (decision / gotcha / changelog / reference / constraint).
- ⌘K command palette with typed filter tokens (`module:`, `type:`, `category:`, `since:`) + simple natural-language mapping.
- Knowledge Health page = per-category actionable lists with one-click fixes (duplicates → side-by-side merge→supersede; missing summaries → inline edit; stale → AI summary; orphan tasks → link; unknown-module → bulk reassign).
- Superseded entries show a banner "Superseded by E-00123" linking to the replacement.
- Floating "Quick Capture" + an "AI-assisted capture" tab (paste text → extract decisions/tasks/gotchas as approvable drafts).

**Rejected:** DeepSeek's disposable mock-server + fake-seed + hardcoded-AI prototype (contradicts the real shared-SQLite moat); workspace switcher and agent API-key/permissions screens (that's the deferred Team / orchestration scope, not v1).
