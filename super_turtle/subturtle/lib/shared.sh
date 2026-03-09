#!/usr/bin/env bash

if [[ -n "${SUBTURTLE_LIB_SHARED_SH_LOADED:-}" ]]; then
  return 0
fi
SUBTURTLE_LIB_SHARED_SH_LOADED=1

# Resolve the workspace directory for a named SubTurtle.
workspace_dir() {
  local name="${1:-default}"
  echo "${SUBTURTLES_DIR}/${name}"
}

pid_file() { echo "$(workspace_dir "$1")/subturtle.pid"; }
log_file() { echo "$(workspace_dir "$1")/subturtle.log"; }
meta_file() { echo "$(workspace_dir "$1")/subturtle.meta"; }
tunnel_url_file() { echo "$(workspace_dir "$1")/.tunnel-url"; }

read_file_if_exists() {
  local path="$1"
  [[ -f "$path" ]] || return 1
  cat "$path"
}

utc_now_iso() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

current_task_from_state_file() {
  local state_file="$1"
  [[ -f "$state_file" ]] || return 0

  awk '
    /^# Current task$/ { in_current=1; next }
    in_current && /^# / { exit }
    in_current {
      line = $0
      sub(/[[:space:]]*<- current[[:space:]]*$/, "", line)
      if (line ~ /[^[:space:]]/) {
        print line
        exit
      }
    }
  ' "$state_file"
}

current_task_for_subturtle() {
  local name="$1"
  current_task_from_state_file "$(workspace_dir "$name")/CLAUDE.md"
}

# Parse a human duration string (30m, 1h, 2h, 4h) into seconds.
# Falls back to raw seconds if no suffix.
parse_duration() {
  local input="$1"
  local suffix="${input: -1}"

  case "$suffix" in
    m|M|h|H|d|D)
      local num="${input%[mMhHdD]}"
      if ! [[ "$num" =~ ^[0-9]+$ ]]; then
        echo "ERROR: invalid duration '${input}'" >&2
        return 1
      fi
      case "$suffix" in
        m|M) echo $(( num * 60 )) ;;
        h|H) echo $(( num * 3600 )) ;;
        d|D) echo $(( num * 86400 )) ;;
      esac
      ;;
    *)
      if ! [[ "$input" =~ ^[0-9]+$ ]]; then
        echo "ERROR: invalid duration '${input}'" >&2
        return 1
      fi
      echo "$input"
      ;;
  esac
}

format_duration() {
  local secs="$1"
  if (( secs < 0 )); then secs=0; fi
  local h=$(( secs / 3600 ))
  local m=$(( (secs % 3600) / 60 ))
  if (( h > 0 )); then
    echo "${h}h ${m}m"
  else
    echo "${m}m"
  fi
}

# Read the .meta file into shell variables. Returns 1 if the file is missing.
read_meta() {
  local mf
  mf="$(meta_file "$1")"
  if [[ -f "$mf" ]]; then
    RUN_ID="$(grep -m1 '^RUN_ID=' "$mf" 2>/dev/null | cut -d= -f2-)" || true
    SPAWNED_AT="$(grep -m1 '^SPAWNED_AT=' "$mf" 2>/dev/null | cut -d= -f2-)" || true
    TIMEOUT_SECONDS="$(grep -m1 '^TIMEOUT_SECONDS=' "$mf" 2>/dev/null | cut -d= -f2-)" || true
    WATCHDOG_PID="$(grep -m1 '^WATCHDOG_PID=' "$mf" 2>/dev/null | cut -d= -f2-)" || true
    LOOP_TYPE="$(grep -m1 '^LOOP_TYPE=' "$mf" 2>/dev/null | cut -d= -f2-)" || true
    SKILLS="$(grep -m1 '^SKILLS=' "$mf" 2>/dev/null | cut -d= -f2-)" || true
    CRON_JOB_ID="$(grep -m1 '^CRON_JOB_ID=' "$mf" 2>/dev/null | cut -d= -f2-)" || true
    return 0
  fi
  return 1
}

remove_meta_key() {
  local name="$1"
  local key="$2"
  local mf tmp_file
  mf="$(meta_file "$name")"
  [[ -f "$mf" ]] || return 0

  tmp_file="$(mktemp "${mf}.XXXXXX")" || return 1
  if awk -v prefix="${key}=" 'index($0, prefix) != 1 { print }' "$mf" > "$tmp_file"; then
    mv "$tmp_file" "$mf"
    return 0
  fi

  rm -f "$tmp_file"
  return 1
}

time_remaining() {
  local name="$1"
  SPAWNED_AT="" TIMEOUT_SECONDS=""
  if ! read_meta "$name"; then
    echo ""
    return
  fi
  if [[ -z "$SPAWNED_AT" || -z "$TIMEOUT_SECONDS" ]]; then
    echo ""
    return
  fi
  local now elapsed remaining
  now="$(date +%s)"
  elapsed=$(( now - SPAWNED_AT ))
  remaining=$(( TIMEOUT_SECONDS - elapsed ))
  echo "$remaining"
}

format_time_remaining() {
  local remaining="$1"
  if [[ -z "$remaining" ]]; then
    echo "no timeout"
    return
  fi
  if (( remaining <= 0 )); then
    echo "OVERDUE"
  else
    echo "$(format_duration "$remaining") left"
  fi
}

ensure_workspace() {
  local name="${1:-default}"
  local ws
  ws="$(workspace_dir "$name")"

  mkdir -p "$ws"

  if [[ ! -f "$ws/CLAUDE.md" ]]; then
    echo "[subturtle:${name}] ERROR: CLAUDE.md not found in workspace (${ws}/CLAUDE.md)" >&2
    echo "[subturtle:${name}] The meta agent must write CLAUDE.md before starting a SubTurtle." >&2
    exit 1
  fi

  if [[ ! -L "$ws/AGENTS.md" ]]; then
    ln -sf CLAUDE.md "$ws/AGENTS.md"
  fi
}

read_pid() {
  read_file_if_exists "$(pid_file "$1")" 2>/dev/null || echo ""
}

tunnel_url_for_subturtle() {
  read_file_if_exists "$(tunnel_url_file "$1")"
}
