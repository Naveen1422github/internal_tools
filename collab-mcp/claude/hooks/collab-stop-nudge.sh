#!/bin/bash
# Stop hook: if there are tracked-file changes and no handoff recorded since session start, nudge to /collab-handoff.
# Must never fail the session.

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Prefer CLAUDE_PROJECT_DIR (set by Claude Code for hooks). Fall back to
# computing relative to script: this file lives at
# <repo>/internal-tools/collab-mcp/claude/hooks/, so go up 4 levels.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"

SESSION_START_FILE="$PROJECT_DIR/.claude/sessions/.last-start"
if [ ! -f "$SESSION_START_FILE" ]; then
  exit 0
fi

since="$(cat "$SESSION_START_FILE" 2>/dev/null | tr -d '\r\n')"
if [ -z "$since" ]; then
  exit 0
fi

changed="$(git diff --name-only HEAD 2>/dev/null | tr -d '\r')"
if [ -z "$changed" ]; then
  exit 0
fi

count="$(printf "%s\n" "$changed" | sed '/^$/d' | wc -l | tr -d ' ')"

checker_dist="$PROJECT_DIR/internal-tools/collab-mcp/dist/scripts/check-handoff-needed.js"
if [ -f "$checker_dist" ]; then
  node "$checker_dist" --since "$since" >/dev/null 2>&1
  rc=$?
else
  npm --prefix "$PROJECT_DIR/internal-tools/collab-mcp" exec -- tsx src/scripts/check-handoff-needed.ts --since "$since" >/dev/null 2>&1
  rc=$?
fi

if [ "$rc" -eq 0 ]; then
  exit 0
fi
if [ "$rc" -ne 1 ]; then
  exit 0
fi

msg="Session has uncommitted changes in ${count} file(s) and no handoff recorded — consider /collab-handoff before ending."
node -e 'process.stdout.write(JSON.stringify({ additionalContext: process.argv[1] }))' "$msg" 2>/dev/null

exit 0

