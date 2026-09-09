# Collab UI

React + Vite single-page app for browsing and editing the Collab knowledge base
(entries, tasks, modules) — the human-facing front door to the same `mcp/collab.db`
the `mcp__collab__*` tools use. Served by `@collab-mcp/server` in production; runs against
the Vite dev server with hot reload during development.

## Stack

- **React 19** + **react-router-dom 7** (client-side routing)
- **zustand 5** for store state (`src/store/ui.ts`)
- **react-markdown** for rendering AI answers and entry bodies
- **Tailwind CSS 3** (`tailwind.config.js`, `postcss.config.js`)
- **Vitest** + Testing Library for component/store tests
- TypeScript, ESM

## Run

The UI talks to the Node backend (`@collab-mcp/server`) on `:7473` for `/api/*`.

**Dev (hot reload):** run the backend and the Vite dev server in parallel.

```bash
# from internal-tools/
npm run dev            # backend on http://127.0.0.1:7473

# in another terminal, from internal-tools/ui/
npm run dev            # UI on http://localhost:5173, proxies /api -> :7473
```

`vite.config.ts` proxies `/api` to `http://127.0.0.1:7473`, so API calls work without CORS.

**Integrated (single server):** build the UI, then the Node server serves it.

```bash
# from internal-tools/
npm run ui:build       # -> ui/dist
npm start              # builds + runs server, serves ui/dist at http://127.0.0.1:7473/
```

If `ui/dist` is missing, the server returns `503 — UI not built. Run npm run ui:build first.`

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (HMR) on `:5173` |
| `npm run build` | `tsc -b` typecheck + `vite build` → `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Run Vitest (`*.test.ts(x)`) once |
| `npm run lint` | ESLint |

## Layout

```
ui/src/
├── main.tsx              # entry — router + root render
├── App.tsx               # route tree
├── components/
│   ├── AppShell.tsx      # sidebar + main + right AI panel
│   ├── Sidebar.tsx
│   ├── CommandPalette.tsx
│   ├── Drawer.tsx / EntryDrawer.tsx   # entry detail / edit
│   ├── AiPanel.tsx       # right-side AI chat (POST /api/ai/chat)
│   └── DraftCard.tsx     # editable AI draft → "Approve & Save" upserts an entry
├── pages/
│   ├── Dashboard.tsx
│   ├── Tasks.tsx
│   ├── Modules.tsx
│   ├── Knowledge.tsx     # entry search / browse
│   └── Health.tsx        # collab_doctor view
├── store/ui.ts           # zustand store (selection, AI conversation, etc.)
└── api/client.ts         # typed fetch wrappers over /api/collab/* and /api/ai/*
```

## AI Assistant panel

`AiPanel.tsx` queries the knowledge base via the backend's `POST /api/ai/chat` and renders
markdown answers. The AI **never writes to the DB** — it returns a draft entry that appears
as an editable `DraftCard`; the human's **Approve & Save** click is what persists it (via the
same upsert path as manual edits). See `docs/2026-06-19-ai-assistant-panel-design.md` for the
original design.
