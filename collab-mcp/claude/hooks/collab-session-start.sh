#!/bin/bash
# SessionStart hook: writes a timestamp + (optionally) loads a module card as additional context.
# Must never fail the session.

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Prefer CLAUDE_PROJECT_DIR (set by Claude Code for hooks). Fall back to
# computing relative to script: this file lives at
# <repo>/internal-tools/collab-mcp/claude/hooks/, so go up 4 levels.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"

SESSION_DIR="$PROJECT_DIR/.claude/sessions"
SESSION_START_FILE="$SESSION_DIR/.last-start"
mkdir -p "$SESSION_DIR" >/dev/null 2>&1
date -u +"%Y-%m-%d %H:%M:%S" > "$SESSION_START_FILE" 2>/dev/null

base="$(basename "$PWD" 2>/dev/null)"
slug="$base"
slug="${slug#emp1st-}"
slug="${slug#ingxt-}"

out="$(
  npm --prefix "$PROJECT_DIR/internal-tools/collab-mcp" run -s module-card -- --slug "$slug" 2>/dev/null
)"

if [ -n "$out" ]; then
  printf "%s" "$out" | node -e '
    const fs = require("fs");
    const s = fs.readFileSync(0, "utf8");
    process.stdout.write(JSON.stringify({ additionalContext: s }));
  ' 2>/dev/null
fi

exit 0

