#!/bin/bash
# Quiet wrapper around codex-dispatch.sh.
# Streams a milestone-only view to the terminal; full JSONL is captured
# to a timestamped log file under $HOME/.codex/logs/ for post-mortem.
#
# Usage: identical to codex-dispatch.sh — args are forwarded verbatim.
#   bash .claude/scripts/codex-dispatch-quiet.sh "prompt" --module collab-mcp --task T-STEP8

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="${CODEX_LOG_DIR:-$HOME/.codex/logs}"
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$LOG_DIR/dispatch-$STAMP.log"

echo "Full log → $LOG"
echo ""

bash "$SCRIPT_DIR/codex-dispatch.sh" "$@" 2>&1 \
  | tee "$LOG" \
  | node "$SCRIPT_DIR/dispatch-filter.mjs"

EXIT=${PIPESTATUS[0]}
echo ""
if [ "$EXIT" -ne 0 ]; then
    echo "Dispatch failed (exit $EXIT). Inspect: $LOG"
fi
exit "$EXIT"
