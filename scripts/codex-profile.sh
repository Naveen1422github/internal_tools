#!/bin/bash
# Codex Profile Manager
# Manages multiple Codex accounts by swapping auth.json files
# Usage:
#   codex-profile list                    - List all profiles
#   codex-profile save <name> [label]     - Save current auth as a named profile
#   codex-profile switch <name>           - Switch to a saved profile
#   codex-profile status                  - Show active profile and limit info
#   codex-profile limits                  - Show all profiles with limit reset times
#   codex-profile exec <cmd...>           - Run command, auto-switch profile on rate limit
#   codex-profile delete <name>           - Delete a saved profile

CODEX_DIR="$HOME/.codex"
PROFILES_DIR="$CODEX_DIR/profiles"
TRACKER="$PROFILES_DIR/tracker.json"
AUTH_FILE="$CODEX_DIR/auth.json"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Python helper: wraps path to be Windows-compatible
# Python on Windows needs C:\... not /c/...
py_tracker() {
    python -c "
import os
tracker = os.path.join(os.path.expanduser('~'), '.codex', 'profiles', 'tracker.json')
$1
"
}

ensure_dirs() {
    mkdir -p "$PROFILES_DIR"
    if [ ! -f "$TRACKER" ]; then
        echo '{"active_profile":null,"profiles":{},"switch_log":[]}' > "$TRACKER"
    fi
}

cmd_save() {
    local name="$1"
    local label="${2:-$name}"

    if [ -z "$name" ]; then
        echo -e "${RED}Error: Profile name required${NC}"
        echo "Usage: codex-profile save <name> [label]"
        return 1
    fi

    if [ ! -f "$AUTH_FILE" ]; then
        echo -e "${RED}Error: No auth.json found. Run 'codex login' first.${NC}"
        return 1
    fi

    local profile_dir="$PROFILES_DIR/$name"
    mkdir -p "$profile_dir"
    cp "$AUTH_FILE" "$profile_dir/auth.json"

    local now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    python -c "
import json, os
tracker = os.path.join(os.path.expanduser('~'), '.codex', 'profiles', 'tracker.json')
t = json.load(open(tracker))
t['active_profile'] = '$name'
t['profiles']['$name'] = {
    'label': '$label',
    'created': '$now',
    'last_activated': '$now',
    'limit_hit_at': None,
    'limit_resets_at': None
}
json.dump(t, open(tracker, 'w'), indent=2)
"

    echo -e "${GREEN}Saved profile '$name' ($label)${NC}"
    echo -e "Auth stored at: $profile_dir/auth.json"
}

cmd_switch() {
    local name="$1"

    if [ -z "$name" ]; then
        echo -e "${RED}Error: Profile name required${NC}"
        echo "Usage: codex-profile switch <name>"
        return 1
    fi

    local profile_dir="$PROFILES_DIR/$name"
    if [ ! -f "$profile_dir/auth.json" ]; then
        echo -e "${RED}Error: Profile '$name' not found${NC}"
        cmd_list
        return 1
    fi

    # Save current auth back to active profile before switching
    local current=$(python -c "
import json, os
tracker = os.path.join(os.path.expanduser('~'), '.codex', 'profiles', 'tracker.json')
t = json.load(open(tracker))
print(t.get('active_profile') or '')
")
    if [ -n "$current" ] && [ "$current" != "$name" ] && [ -f "$AUTH_FILE" ]; then
        mkdir -p "$PROFILES_DIR/$current"
        cp "$AUTH_FILE" "$PROFILES_DIR/$current/auth.json"
    fi

    # Switch
    cp "$profile_dir/auth.json" "$AUTH_FILE"

    local now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    python -c "
import json, os
tracker = os.path.join(os.path.expanduser('~'), '.codex', 'profiles', 'tracker.json')
t = json.load(open(tracker))
old = t.get('active_profile')
t['active_profile'] = '$name'
if '$name' in t['profiles']:
    t['profiles']['$name']['last_activated'] = '$now'
t['switch_log'].append({
    'from': old,
    'to': '$name',
    'at': '$now'
})
t['switch_log'] = t['switch_log'][-50:]
json.dump(t, open(tracker, 'w'), indent=2)
"

    echo -e "${GREEN}Switched to profile '$name'${NC}"
    codex login status 2>/dev/null
}

cmd_mark_limited() {
    local name="$1"
    if [ -z "$name" ]; then
        name=$(python -c "
import json, os
tracker = os.path.join(os.path.expanduser('~'), '.codex', 'profiles', 'tracker.json')
t = json.load(open(tracker))
print(t.get('active_profile') or '')
")
    fi

    if [ -z "$name" ]; then
        echo -e "${RED}No active profile to mark${NC}"
        return 1
    fi

    python -c "
import json, os
from datetime import datetime, timedelta, timezone
tracker = os.path.join(os.path.expanduser('~'), '.codex', 'profiles', 'tracker.json')
t = json.load(open(tracker))
name = '$name'
if name in t['profiles']:
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    t['profiles'][name]['limit_hit_at'] = now
    reset = (datetime.now(timezone.utc) + timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ')
    t['profiles'][name]['limit_resets_at'] = reset
    json.dump(t, open(tracker, 'w'), indent=2)
    print(f'Profile {name} marked as limited. Resets at: {reset}')
else:
    print('Profile not found')
"
}

cmd_list() {
    echo -e "${CYAN}=== Codex Profiles ===${NC}"
    python -c "
import json, os
tracker = os.path.join(os.path.expanduser('~'), '.codex', 'profiles', 'tracker.json')
t = json.load(open(tracker))
active = t.get('active_profile')
profiles = t.get('profiles', {})
if not profiles:
    print('  No profiles saved. Use: codex-profile save <name>')
else:
    for name, info in profiles.items():
        marker = ' *ACTIVE*' if name == active else ''
        label = info.get('label', name)
        limited = ''
        if info.get('limit_resets_at'):
            limited = f' [LIMITED - resets: {info[\"limit_resets_at\"]}]'
        print(f'  {name} ({label}){marker}{limited}')
"
}

cmd_status() {
    echo -e "${CYAN}=== Active Profile ===${NC}"
    python -c "
import json, os
from datetime import datetime, timezone
tracker = os.path.join(os.path.expanduser('~'), '.codex', 'profiles', 'tracker.json')
t = json.load(open(tracker))
active = t.get('active_profile')
if not active:
    print('  No active profile')
else:
    info = t['profiles'].get(active, {})
    print(f'  Profile: {active} ({info.get(\"label\", active)})')
    print(f'  Last activated: {info.get(\"last_activated\", \"unknown\")}')
    if info.get('limit_resets_at'):
        reset = datetime.fromisoformat(info['limit_resets_at'].replace('Z','+00:00'))
        now = datetime.now(timezone.utc)
        if now < reset:
            remaining = reset - now
            print(f'  RATE LIMITED - resets in {remaining.days}d {remaining.seconds//3600}h')
        else:
            print(f'  Limit has reset - good to use')
    else:
        print(f'  No rate limit recorded')
"
    echo ""
    codex login status 2>/dev/null
}

cmd_limits() {
    echo -e "${CYAN}=== All Profile Limits ===${NC}"
    python -c "
import json, os
from datetime import datetime, timezone
tracker = os.path.join(os.path.expanduser('~'), '.codex', 'profiles', 'tracker.json')
t = json.load(open(tracker))
profiles = t.get('profiles', {})
available = []
limited = []
for name, info in profiles.items():
    if info.get('limit_resets_at'):
        reset = datetime.fromisoformat(info['limit_resets_at'].replace('Z','+00:00'))
        now = datetime.now(timezone.utc)
        if now < reset:
            remaining = reset - now
            limited.append(f'  {name}: LIMITED (resets in {remaining.days}d {remaining.seconds//3600}h)')
        else:
            available.append(f'  {name}: AVAILABLE (limit reset)')
    else:
        available.append(f'  {name}: AVAILABLE')

print('Available:')
for a in available:
    print(a)
if not available:
    print('  None!')
print()
print('Rate Limited:')
for l in limited:
    print(l)
if not limited:
    print('  None')
"
}

cmd_delete() {
    local name="$1"
    if [ -z "$name" ]; then
        echo -e "${RED}Error: Profile name required${NC}"
        return 1
    fi

    local profile_dir="$PROFILES_DIR/$name"
    if [ -d "$profile_dir" ]; then
        rm -rf "$profile_dir"
        python -c "
import json, os
tracker = os.path.join(os.path.expanduser('~'), '.codex', 'profiles', 'tracker.json')
t = json.load(open(tracker))
t['profiles'].pop('$name', None)
if t.get('active_profile') == '$name':
    t['active_profile'] = None
json.dump(t, open(tracker, 'w'), indent=2)
"
        echo -e "${GREEN}Deleted profile '$name'${NC}"
    else
        echo -e "${RED}Profile '$name' not found${NC}"
    fi
}

# Helper: returns name of next available profile (no side effects, no printing to stderr)
_get_next_available() {
    python -c "
import json, os
from datetime import datetime, timezone
tracker = os.path.join(os.path.expanduser('~'), '.codex', 'profiles', 'tracker.json')
t = json.load(open(tracker))
active = t.get('active_profile')
for name, info in t.get('profiles', {}).items():
    if name == active:
        continue
    reset_at = info.get('limit_resets_at')
    if not reset_at:
        print(name)
        break
    else:
        reset = datetime.fromisoformat(reset_at.replace('Z','+00:00'))
        if datetime.now(timezone.utc) >= reset:
            print(name)
            break
"
}

# Helper: count total profiles
_count_profiles() {
    python -c "
import json, os
tracker = os.path.join(os.path.expanduser('~'), '.codex', 'profiles', 'tracker.json')
t = json.load(open(tracker))
print(len(t.get('profiles', {})))
"
}

cmd_next() {
    local next_profile=$(_get_next_available)

    if [ -z "$next_profile" ]; then
        echo -e "${RED}No available profiles! All are rate-limited.${NC}"
        cmd_limits
        return 1
    fi

    echo -e "${YELLOW}Auto-switching to next available profile: $next_profile${NC}"
    cmd_switch "$next_profile"
}

# Auto-switch exec wrapper: runs a codex command, retries with profile rotation on rate limits
# Usage: codex-profile exec <codex command and args...>
# Example: codex-profile exec codex exec --full-auto "fix the bug"
cmd_exec() {
    if [ $# -eq 0 ]; then
        echo -e "${RED}Error: Command required${NC}"
        echo "Usage: codex-profile exec <command...>"
        echo "Example: codex-profile exec codex exec --full-auto \"fix the bug\""
        return 1
    fi

    local max_retries=$(_count_profiles)
    local attempt=0
    local exit_code=0

    while [ $attempt -lt $max_retries ]; do
        local current_profile=$(python -c "
import json, os
tracker = os.path.join(os.path.expanduser('~'), '.codex', 'profiles', 'tracker.json')
t = json.load(open(tracker))
print(t.get('active_profile') or 'unknown')
")

        if [ $attempt -gt 0 ]; then
            echo -e "${CYAN}[auto-switch] Retry #$attempt using profile: $current_profile${NC}"
        fi

        # Run the command, tee output to a temp file for rate-limit detection
        local tmp_out="${USERPROFILE:-$HOME}/.codex/.tmp/exec_check_$$.txt"
        mkdir -p "$(dirname "$tmp_out")"

        "$@" 2>&1 | tee "$tmp_out"
        exit_code=${PIPESTATUS[0]}

        # Check for rate limit signals in output
        if [ $exit_code -ne 0 ] && grep -qiE "usage limit|rate limit|rate_limit|429|too many requests" "$tmp_out" 2>/dev/null; then
            echo ""
            echo -e "${YELLOW}[auto-switch] Rate limit detected on profile '$current_profile'. Marking as limited...${NC}"
            cmd_mark_limited "$current_profile"

            local next_profile=$(_get_next_available)
            if [ -z "$next_profile" ]; then
                echo -e "${RED}[auto-switch] All profiles exhausted! No available profiles left.${NC}"
                cmd_limits
                rm -f "$tmp_out"
                return 1
            fi

            echo -e "${YELLOW}[auto-switch] Switching to profile '$next_profile'...${NC}"
            cmd_switch "$next_profile"
            echo ""

            rm -f "$tmp_out"
            attempt=$((attempt + 1))
            continue
        fi

        # Not rate-limited — done (success or other error)
        rm -f "$tmp_out"
        return $exit_code
    done

    echo -e "${RED}[auto-switch] Exhausted all $max_retries profiles. All rate-limited.${NC}"
    cmd_limits
    return 1
}

# Check if a profile is alive by swapping in its auth.json and running
# a minimal `codex exec` probe. Updates tracker.json fields:
#   last_checked, check_ok, check_message
# NOTE: this consumes a small number of tokens per profile.
cmd_check() {
    local target="${1:-}"
    if [ -z "$target" ] || [ "$target" = "--all" ]; then
        local names
        names=$(python -c "
import json, os
tracker = os.path.join(os.path.expanduser('~'), '.codex', 'profiles', 'tracker.json')
t = json.load(open(tracker))
for name in t.get('profiles', {}):
    print(name)
")
        for name in $names; do
            _check_one "$name"
        done
    else
        _check_one "$target"
    fi
}

_check_one() {
    local name="$1"
    local profile_auth="$PROFILES_DIR/$name/auth.json"

    if [ ! -f "$profile_auth" ]; then
        _record_check "$name" "false" "auth.json missing"
        echo -e "  ${RED}$name: auth.json missing${NC}"
        return 1
    fi

    echo -e "${CYAN}Checking $name...${NC}"

    # Back up current auth, and sync active profile's stored copy first
    # (same pattern as cmd_switch to avoid losing fresh tokens)
    local backup=""
    local current
    current=$(python -c "
import json, os
tracker = os.path.join(os.path.expanduser('~'), '.codex', 'profiles', 'tracker.json')
t = json.load(open(tracker))
print(t.get('active_profile') or '')
")
    if [ -f "$AUTH_FILE" ]; then
        backup="$CODEX_DIR/.auth.backup.$$"
        cp "$AUTH_FILE" "$backup"
        if [ -n "$current" ] && [ "$current" != "$name" ]; then
            mkdir -p "$PROFILES_DIR/$current"
            cp "$AUTH_FILE" "$PROFILES_DIR/$current/auth.json"
        fi
    fi

    # Swap in target profile and probe
    cp "$profile_auth" "$AUTH_FILE"

    local tmp_out="$CODEX_DIR/.tmp/check_$$_$name.txt"
    mkdir -p "$(dirname "$tmp_out")"
    # Hard 45s timeout so a hung codex (bad auth → interactive login prompt,
    # or stalled network) can't lock the dashboard. </dev/null closes stdin
    # so codex can't sit waiting on a TTY prompt.
    timeout 45s codex exec --skip-git-repo-check "reply ok" </dev/null > "$tmp_out" 2>&1
    local exit_code=$?
    local output
    output=$(head -c 2000 "$tmp_out" 2>/dev/null)
    rm -f "$tmp_out"

    # Restore original auth
    if [ -n "$backup" ] && [ -f "$backup" ]; then
        cp "$backup" "$AUTH_FILE"
        rm -f "$backup"
    fi

    # Interpret: same rate-limit patterns as cmd_exec for consistency
    local ok="false"
    local message="unknown"
    if [ $exit_code -eq 0 ]; then
        ok="true"
        message="alive"
    elif [ $exit_code -eq 124 ]; then
        message="timeout (45s) — likely bad auth or network stall"
    elif echo "$output" | grep -qiE "usage limit|rate limit|rate_limit|429|too many requests|quota"; then
        message="rate limited"
    elif echo "$output" | grep -qiE "401|unauthor|invalid.*token|expired"; then
        message="auth invalid"
    else
        message=$(echo "$output" | grep -v '^$' | head -n 1 | head -c 150)
        [ -z "$message" ] && message="error (exit $exit_code)"
    fi

    _record_check "$name" "$ok" "$message"

    if [ "$ok" = "true" ]; then
        echo -e "  ${GREEN}$name: $message${NC}"
    else
        echo -e "  ${YELLOW}$name: $message${NC}"
    fi
}

# Pass strings via env vars so special chars in `message` can't break the Python snippet
_record_check() {
    local name="$1"
    local ok="$2"
    local message="$3"
    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    CHECK_NAME="$name" CHECK_OK="$ok" CHECK_MSG="$message" CHECK_AT="$now" python -c "
import json, os
tracker = os.path.join(os.path.expanduser('~'), '.codex', 'profiles', 'tracker.json')
t = json.load(open(tracker))
name = os.environ['CHECK_NAME']
if name in t.get('profiles', {}):
    t['profiles'][name]['last_checked'] = os.environ['CHECK_AT']
    t['profiles'][name]['check_ok'] = (os.environ['CHECK_OK'] == 'true')
    t['profiles'][name]['check_message'] = os.environ['CHECK_MSG']
    json.dump(t, open(tracker, 'w'), indent=2)
"
}

# --- Main ---
ensure_dirs

case "${1:-}" in
    save)     cmd_save "$2" "$3" ;;
    switch)   cmd_switch "$2" ;;
    list)     cmd_list ;;
    status)   cmd_status ;;
    limits)   cmd_limits ;;
    limited)  cmd_mark_limited "$2" ;;
    next)     cmd_next ;;
    delete)   cmd_delete "$2" ;;
    exec)     shift; cmd_exec "$@" ;;
    check)    shift; cmd_check "$@" ;;
    *)
        echo "Codex Profile Manager"
        echo ""
        echo "Commands:"
        echo "  save <name> [label]  - Save current auth as a profile"
        echo "  switch <name>        - Switch to a profile"
        echo "  list                 - List all profiles"
        echo "  status               - Show active profile info"
        echo "  limits               - Show limit status for all profiles"
        echo "  limited [name]       - Mark profile as rate-limited (7-day reset)"
        echo "  next                 - Auto-switch to next available profile"
        echo "  exec <cmd...>        - Run command with auto-switch on rate limit"
        echo "  check [name|--all]   - Probe profile(s) and record alive/limited (costs tokens)"
        echo "  delete <name>        - Delete a profile"
        ;;
esac