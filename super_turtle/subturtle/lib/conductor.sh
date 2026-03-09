#!/usr/bin/env bash

if [[ -n "${SUBTURTLE_LIB_CONDUCTOR_SH_LOADED:-}" ]]; then
  return 0
fi
SUBTURTLE_LIB_CONDUCTOR_SH_LOADED=1

ensure_run_state_files() {
  mkdir -p "$RUN_STATE_DIR"

  if [[ ! -f "$RUNS_JSONL_FILE" ]]; then
    : > "$RUNS_JSONL_FILE"
  fi

  if [[ ! -f "$HANDOFF_MD_FILE" ]]; then
    cat > "$HANDOFF_MD_FILE" <<'EOF'
# SubTurtle Long-Run Handoff

Last updated: not yet

## Active Workers
- None.

## Pending Wakeups
- None.

## Recent Worker Updates
- None.

## Notes
- Rendered from canonical conductor state.
- Workers without live workspaces are omitted from active sections.
EOF
  fi
}

append_run_event() {
  local name="$1"
  local event="$2"
  local status="${3:-}"
  local -a writer_cmd=(
    "$PYTHON"
    "$RUN_STATE_WRITER"
    --state-dir
    "$RUN_STATE_DIR"
    append
    --run-name
    "$name"
    --event
    "$event"
  )

  if [[ -n "$status" ]]; then
    writer_cmd+=(--status "$status")
  fi

  if ! "${writer_cmd[@]}" >/dev/null 2>&1; then
    echo "[subturtle:${name}] WARNING: failed to append run state event '${event}'" >&2
  fi
}

LAST_CONDUCTOR_EVENT_ID=""
LAST_CONDUCTOR_EVENT_TIMESTAMP=""

load_conductor_run_id() {
  local name="$1"

  RUN_ID=""
  read_meta "$name" || true
  if [[ -n "${RUN_ID:-}" ]]; then
    return 0
  fi

  RUN_ID="$("$PYTHON" - "$RUN_STATE_DIR" "$name" <<'PY' 2>/dev/null || true
import sys
try:
    from super_turtle.state.conductor_state import ConductorStateStore
except ModuleNotFoundError:
    from state.conductor_state import ConductorStateStore

store = ConductorStateStore(sys.argv[1])
state = store.load_worker_state(sys.argv[2]) or {}
print(state.get("run_id") or "")
PY
)"
}

append_conductor_event() {
  local name="$1"
  local event_type="$2"
  local emitted_by="$3"
  local lifecycle_state="${4:-}"
  local payload_json="${5:-}"
  local event_json=""

  LAST_CONDUCTOR_EVENT_ID=""
  LAST_CONDUCTOR_EVENT_TIMESTAMP=""

  load_conductor_run_id "$name"

  local -a writer_cmd=(
    "$PYTHON"
    "$RUN_STATE_WRITER"
    --state-dir
    "$RUN_STATE_DIR"
    append-conductor-event
    --worker-name
    "$name"
    --event-type
    "$event_type"
    --emitted-by
    "$emitted_by"
  )

  if [[ -n "${RUN_ID:-}" ]]; then
    writer_cmd+=(--run-id "$RUN_ID")
  fi
  if [[ -n "$lifecycle_state" ]]; then
    writer_cmd+=(--lifecycle-state "$lifecycle_state")
  fi
  if [[ -n "$payload_json" ]]; then
    writer_cmd+=(--payload-json "$payload_json")
  fi

  if ! event_json="$("${writer_cmd[@]}" 2>/dev/null)"; then
    echo "[subturtle:${name}] WARNING: failed to append conductor event '${event_type}'" >&2
    return 1
  fi

  LAST_CONDUCTOR_EVENT_ID="$(printf '%s' "$event_json" | "$PYTHON" -c 'import json, sys; print(json.load(sys.stdin).get("id", ""))' 2>/dev/null || true)"
  LAST_CONDUCTOR_EVENT_TIMESTAMP="$(printf '%s' "$event_json" | "$PYTHON" -c 'import json, sys; print(json.load(sys.stdin).get("timestamp", ""))' 2>/dev/null || true)"
  return 0
}

write_conductor_worker_state() {
  local name="$1"
  local lifecycle_state="$2"
  local updated_by="$3"
  local stop_reason="${4:-}"
  local completion_requested_at="${5:-}"
  local terminal_at="${6:-}"
  local last_event_id="${7:-${LAST_CONDUCTOR_EVENT_ID:-}}"
  local last_event_at="${8:-${LAST_CONDUCTOR_EVENT_TIMESTAMP:-}}"
  local ws
  ws="$(workspace_dir "$name")"
  if [[ "$lifecycle_state" == "archived" ]]; then
    local archive_ws="${SUBTURTLES_DIR}/.archive/${name}"
    if [[ -d "$archive_ws" ]]; then
      ws="$archive_ws"
    fi
  fi

  local current_task=""
  if [[ -f "${ws}/CLAUDE.md" ]]; then
    current_task="$(current_task_from_state_file "${ws}/CLAUDE.md")"
  fi

  RUN_ID=""
  TIMEOUT_SECONDS=""
  LOOP_TYPE=""
  CRON_JOB_ID=""
  read_meta "$name" || true

  local pid=""
  if is_running "$name"; then
    pid="$(read_pid "$name")"
  fi

  local -a writer_cmd=(
    "$PYTHON"
    "$RUN_STATE_WRITER"
    --state-dir
    "$RUN_STATE_DIR"
    put-worker
    --worker-name
    "$name"
    --lifecycle-state
    "$lifecycle_state"
    --updated-by
    "$updated_by"
    --workspace
    "$ws"
  )

  if [[ -n "${RUN_ID:-}" ]]; then
    writer_cmd+=(--run-id "$RUN_ID")
  fi
  if [[ -n "${LOOP_TYPE:-}" ]]; then
    writer_cmd+=(--loop-type "$LOOP_TYPE")
  fi
  if [[ -n "${pid:-}" ]]; then
    writer_cmd+=(--pid "$pid")
  fi
  if [[ -n "${TIMEOUT_SECONDS:-}" ]]; then
    writer_cmd+=(--timeout-seconds "$TIMEOUT_SECONDS")
  fi
  writer_cmd+=(--cron-job-id "${CRON_JOB_ID:-}")
  if [[ -n "$current_task" ]]; then
    writer_cmd+=(--current-task "$current_task")
  fi
  if [[ -n "$stop_reason" ]]; then
    writer_cmd+=(--stop-reason "$stop_reason")
  fi
  if [[ -n "$completion_requested_at" ]]; then
    writer_cmd+=(--completion-requested-at "$completion_requested_at")
  fi
  if [[ -n "$terminal_at" ]]; then
    writer_cmd+=(--terminal-at "$terminal_at")
  fi
  if [[ -n "$last_event_id" ]]; then
    writer_cmd+=(--last-event-id "$last_event_id")
  fi
  if [[ -n "$last_event_at" ]]; then
    writer_cmd+=(--last-event-at "$last_event_at")
  fi

  if ! "${writer_cmd[@]}" >/dev/null 2>&1; then
    echo "[subturtle:${name}] WARNING: failed to write conductor worker state '${lifecycle_state}'" >&2
    return 1
  fi
}

enqueue_conductor_wakeup() {
  local name="$1"
  local category="$2"
  local summary="$3"
  local reason_event_id="${4:-}"
  local payload_json="${5:-}"
  local metadata_json="${6:-}"

  load_conductor_run_id "$name"

  local -a writer_cmd=(
    "$PYTHON"
    "$RUN_STATE_WRITER"
    --state-dir
    "$RUN_STATE_DIR"
    enqueue-wakeup
    --worker-name
    "$name"
    --category
    "$category"
    --summary
    "$summary"
  )

  if [[ -n "${RUN_ID:-}" ]]; then
    writer_cmd+=(--run-id "$RUN_ID")
  fi
  if [[ -n "$reason_event_id" ]]; then
    writer_cmd+=(--reason-event-id "$reason_event_id")
  fi
  if [[ -n "$payload_json" ]]; then
    writer_cmd+=(--payload-json "$payload_json")
  fi
  if [[ -n "$metadata_json" ]]; then
    writer_cmd+=(--metadata-json "$metadata_json")
  fi

  if ! "${writer_cmd[@]}" >/dev/null 2>&1; then
    echo "[subturtle:${name}] WARNING: failed to enqueue wakeup '${category}'" >&2
    return 1
  fi
}
