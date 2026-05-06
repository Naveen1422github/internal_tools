# Gemini MCP

Read-side MCP server that exposes Gemini as a repo skim/locate helper for Claude Code.

## Prerequisites

- `gemini` CLI installed and authenticated (auth/config lives in `~/.gemini/`).
- Node.js 20+

## Build

From `internal-tools/gemini-mcp/`:

```bash
npm install
npm run build
```

## MCP wiring

This repo’s `.mcp.json` registers the server as:

- `gemini` → `node ./internal-tools/gemini-mcp/dist/server.js`

Tools are then available as:

- `mcp__gemini__gemini_skim`
- `mcp__gemini__gemini_locate`

## Tools

### `gemini_skim`

Args:
- `prompt: string` (required)
- `context_files?: string[]` (optional)
- `drift_check?: boolean` (optional, default `true`)

Returns structured fields in `structuredContent`:
- `response` (raw markdown)
- `files_read` (best-effort extraction)
- `drift_warnings` (literal drift scan hits)
- `duration_ms`

### `gemini_locate`

Args:
- `query: string` (required)
- `scope?: string` (optional)
- `drift_check?: boolean` (optional, default `true`)

Returns structured fields in `structuredContent`:
- `matches` (best-effort `file:line` extraction)
- `summary` (raw markdown/prose)
- `drift_warnings`
- `duration_ms`

## Drift-grep

After every tool call (unless `drift_check: false`), the server scans Gemini’s raw stdout for common literal drift patterns (e.g. unknown `emp1st-*` services). The allowlist is configured in `drift-allowlist.json`.

## Timeout

Gemini subprocess timeout (default `180000` ms):

- `GEMINI_MCP_TIMEOUT_MS=180000`

## Troubleshooting

- **CLI not found**: install `gemini` or set `GEMINI_BIN` to the executable path.
- **Timeouts**: increase `GEMINI_MCP_TIMEOUT_MS` or keep prompts scoped; long-running jobs are out of scope for v1.

