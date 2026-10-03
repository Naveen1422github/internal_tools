#!/bin/bash
# Codex Dispatch Wrapper
# Sends tasks to Codex from Claude Code, captures output, persists to collab.db
# via internal-tools/mcp/src/scripts/parse-codex-output.ts --save.
#
# Usage:
#   codex-dispatch "your prompt here"                    # basic dispatch
#   codex-dispatch "prompt" --review                     # persist as type=review
#   codex-dispatch "prompt" --sandbox read-only          # custom sandbox mode
#   codex-dispatch "prompt" --dir /path/to/service       # run in specific directory
#   codex-dispatch "prompt" --output result.md           # save last message to file
#   codex-dispatch "prompt" --task T-001 --module custom-reports
#   codex-dispatch "prompt" --db /path/to/project/collab.db
#   codex-dispatch "prompt" --model gpt-5.6-terra

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Locate the collab MCP package. Prefer the copy shipped alongside this script
# (scripts/ and mcp/ are siblings in the collab-mcp repo), then an explicit
# override, then the legacy layout where this script lived in a consuming
# project's .claude/scripts/. Shipping a command whose dependency resolves only
# in the author's workspace is how /collab-review stayed broken for months.
if [ -z "$COLLAB_MCP_DIR" ]; then
    COLLAB_MCP_DIR="$(cd "$SCRIPT_DIR/../mcp" 2>/dev/null && pwd)"
fi
if [ -z "$COLLAB_MCP_DIR" ]; then
    COLLAB_MCP_DIR="$(cd "$SCRIPT_DIR/../../internal-tools/mcp" 2>/dev/null && pwd)"
fi

# Same rule for the profile helper: repo copy first, home directory as fallback.
PROFILE_SCRIPT="$SCRIPT_DIR/codex-profile.sh"
if [ ! -f "$PROFILE_SCRIPT" ]; then
    PROFILE_SCRIPT="$HOME/.codex/profiles/codex-profile.sh"
fi

# Defaults
SANDBOX="workspace-write"
WORK_DIR="$(pwd)"
OUTPUT_FILE=""
WRITE_REVIEW=false
TASK_ID=""
MODULE=""
DB_PATH="${COLLAB_DB_PATH:-}"
# The account default (gpt-5.5) 404s; gpt-5 and gpt-5-codex are rejected for
# ChatGPT accounts. Override with --model or $CODEX_MODEL.
MODEL="${CODEX_MODEL:-gpt-5.6-terra}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# Parse arguments
PROMPT="$1"
shift

while [[ $# -gt 0 ]]; do
    case "$1" in
        --sandbox)   SANDBOX="$2"; shift 2 ;;
        --dir)       WORK_DIR="$2"; shift 2 ;;
        --output)    OUTPUT_FILE="$2"; shift 2 ;;
        --review)    WRITE_REVIEW=true; shift ;;
        --task)      TASK_ID="$2"; shift 2 ;;
        --module)    MODULE="$2"; shift 2 ;;
        --db)        DB_PATH="$2"; shift 2 ;;
        --model)     MODEL="$2"; shift 2 ;;
        *)           shift ;;
    esac
done

if [ -z "$PROMPT" ]; then
    echo -e "${RED}Error: Prompt required${NC}"
    echo "Usage: codex-dispatch \"your prompt here\" [--dir path] [--sandbox mode] [--output file] [--review] [--task T-001] [--module slug] [--db path] [--model name]"
    exit 1
fi

# Module inference: if --module not supplied, derive from the WorkDir basename.
# $COLLAB_MODULE_PREFIXES is a space-separated list of repo prefixes to strip,
# e.g. "acme- internal-". Explicit --module always wins.
if [ -z "$MODULE" ]; then
    BASE=$(basename "$WORK_DIR")
    for PREFIX in ${COLLAB_MODULE_PREFIXES:-}; do
        case "$BASE" in
            "$PREFIX"*) MODULE="${BASE#"$PREFIX"}"; break ;;
        esac
    done
fi

# Source hint for the parser: --review toggles the entry type to review.
SOURCE="codex-dispatch"
if [ "$WRITE_REVIEW" = true ]; then
    SOURCE="codex-review"
fi

# Check active profile
ACTIVE_PROFILE=""
if [ -f "$PROFILE_SCRIPT" ]; then
    ACTIVE_PROFILE=$(bash "$PROFILE_SCRIPT" status 2>/dev/null | grep "Profile:" | head -1)
fi

echo -e "${CYAN}=== Codex Dispatch ===${NC}"
echo -e "  Profile: ${ACTIVE_PROFILE:-unknown}"
echo -e "  Model:   $MODEL"
echo -e "  Sandbox: $SANDBOX"
echo -e "  WorkDir: $WORK_DIR"
echo -e "  Source:  $SOURCE"
echo -e "  Module:  ${MODULE:-(none)}"
echo -e "  Task:    ${TASK_ID:-(none)}"
echo -e "  DB:      ${DB_PATH:-(ambient - set --db or \$COLLAB_DB_PATH)}"
echo -e "  Prompt:  ${PROMPT:0:80}..."
echo ""

# Point Codex's OWN collab MCP server at the same database this dispatch will
# persist into. Without it Codex registers `collab` with an empty Env and writes
# wherever its global config's install implies - a different project's knowledge
# base, silently (collab E-550). Per-invocation, so the shared global config is
# left alone.
CODEX_DB_OVERRIDE=()
if [ -n "$DB_PATH" ]; then
    CODEX_DB_OVERRIDE=(-c "mcp_servers.collab.env={COLLAB_DB_PATH=\"$DB_PATH\"}")
fi

# Pass prompt through verbatim; collab persistence now happens post-exec
# via internal-tools/mcp/src/scripts/parse-codex-output.ts --save.
FULL_PROMPT="$PROMPT"

# Temp JSONL capture for the post-exec parser
WIN_TEMP="${USERPROFILE:-$HOME}/.codex/.tmp"
mkdir -p "$WIN_TEMP"
TEMP_JSON="$WIN_TEMP/dispatch_json_$$.txt"

# Compute prompt size for dispatch metrics (Claude-side cost)
PROMPT_CHARS=${#FULL_PROMPT}

# Run codex exec (wrapped with auto-switch on rate limit)
echo -e "${YELLOW}Dispatching to Codex...${NC}"
START_NS=$(date +%s%N 2>/dev/null || echo 0)
if [ -f "$PROFILE_SCRIPT" ]; then
    echo "$FULL_PROMPT" | bash "$PROFILE_SCRIPT" exec codex exec \
        --full-auto \
        --json \
        -m "$MODEL" \
        "${CODEX_DB_OVERRIDE[@]}" \
        --sandbox "$SANDBOX" \
        -C "$WORK_DIR" \
        ${OUTPUT_FILE:+-o "$OUTPUT_FILE"} \
        2>&1 | tee "$TEMP_JSON"
else
    echo "$FULL_PROMPT" | codex exec \
        --full-auto \
        --json \
        -m "$MODEL" \
        "${CODEX_DB_OVERRIDE[@]}" \
        --sandbox "$SANDBOX" \
        -C "$WORK_DIR" \
        ${OUTPUT_FILE:+-o "$OUTPUT_FILE"} \
        2>&1 | tee "$TEMP_JSON"
fi

EXIT_CODE=${PIPESTATUS[0]}
END_NS=$(date +%s%N 2>/dev/null || echo 0)
if [ "$START_NS" != "0" ] && [ "$END_NS" != "0" ]; then
    WALL_MS=$(( (END_NS - START_NS) / 1000000 ))
else
    WALL_MS=0
fi

echo ""

# Parse results
if [ $EXIT_CODE -ne 0 ]; then
    echo -e "${RED}Codex exec failed (exit code: $EXIT_CODE)${NC}"
    rm -f "$TEMP_JSON"
    exit 1
fi

# Persist the dispatch via the collab-mcp parser. The parser streams a
# human-readable summary to stderr and emits {id, confidence} JSON on stdout.
if [ -z "$COLLAB_MCP_DIR" ] || [ ! -d "$COLLAB_MCP_DIR" ]; then
    echo -e "${RED}collab MCP package not found. Looked in $SCRIPT_DIR/../mcp and $SCRIPT_DIR/../../internal-tools/mcp. Set \$COLLAB_MCP_DIR to override.${NC}"
    rm -f "$TEMP_JSON"
    exit 1
fi

echo -e "${GREEN}=== Persisting to collab.db ===${NC}"
SAVE_JSON=$(cd "$COLLAB_MCP_DIR" && npx tsx src/scripts/parse-codex-output.ts \
    --input "$TEMP_JSON" \
    --source "$SOURCE" \
    --save \
    --prompt-chars "$PROMPT_CHARS" \
    --wall-ms "$WALL_MS" \
    --exit-code "$EXIT_CODE" \
    ${DB_PATH:+--db "$DB_PATH"} \
    ${TASK_ID:+--task "$TASK_ID"} \
    ${MODULE:+--module "$MODULE"})
PARSE_EXIT=$?

if [ $PARSE_EXIT -ne 0 ]; then
    echo -e "${RED}Parser failed (exit $PARSE_EXIT) — entry not saved${NC}"
    rm -f "$TEMP_JSON"
    exit 1
fi

echo "$SAVE_JSON"

# Cleanup
rm -f "$TEMP_JSON"

echo -e "${GREEN}Dispatch complete.${NC}"
