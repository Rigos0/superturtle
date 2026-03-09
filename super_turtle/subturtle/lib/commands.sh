#!/usr/bin/env bash

if [[ -n "${SUBTURTLE_LIB_COMMANDS_SH_LOADED:-}" ]]; then
  return 0
fi
SUBTURTLE_LIB_COMMANDS_SH_LOADED=1

validate_spawn_state_file() {
  local name="$1"
  local state_path="$2"
  local validation_err
  local validation_status=0

  if [[ ! -x "$CLAUDE_MD_GUARD_VALIDATE" ]]; then
    echo "[subturtle:${name}] ERROR: state validator not found: ${CLAUDE_MD_GUARD_VALIDATE}" >&2
    exit 1
  fi

  validation_err="$(mktemp)"
  "$PYTHON" - "$state_path" <<'PY' \
    | "$CLAUDE_MD_GUARD_VALIDATE" 2>"$validation_err" || validation_status=$?
import json
import sys
from pathlib import Path

state_path = Path(sys.argv[1])
json.dump(
    {
        "tool_name": "Write",
        "tool_input": {
            "file_path": str(state_path),
            "content": state_path.read_text(encoding="utf-8"),
        },
    },
    sys.stdout,
)
sys.stdout.write("\n")
PY

  if (( validation_status != 0 )); then
    echo "[subturtle:${name}] ERROR: generated CLAUDE.md failed validation" >&2
    if [[ -s "$validation_err" ]]; then
      sed 's/^/  /' "$validation_err" >&2
    fi
    rm -f "$validation_err"
    exit 1
  fi

  rm -f "$validation_err"
}

is_running() {
  local pf
  pf="$(pid_file "$1")"
  if [[ -f "$pf" ]]; then
    local pid
    pid="$(cat "$pf")"
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

required_clis_for_loop_type() {
  local loop_type="$1"
  case "$loop_type" in
    slow) echo "claude codex" ;;
    yolo) echo "claude" ;;
    yolo-codex|yolo-codex-spark) echo "codex" ;;
    *) echo "" ;;
  esac
}

is_loop_type_supported_here() {
  local loop_type="$1"
  local cli
  for cli in $(required_clis_for_loop_type "$loop_type"); do
    if ! command -v "$cli" >/dev/null 2>&1; then
      return 1
    fi
  done
  return 0
}

list_supported_loop_types() {
  local -a supported=()
  local candidate
  for candidate in slow yolo yolo-codex yolo-codex-spark; do
    if is_loop_type_supported_here "$candidate"; then
      supported+=("$candidate")
    fi
  done

  if (( ${#supported[@]} == 0 )); then
    echo "none"
    return
  fi
  printf '%s' "${supported[*]}"
}

validate_loop_type_prereqs() {
  local name="$1"
  local loop_type="$2"
  local -a missing_clis=()
  local cli

  for cli in $(required_clis_for_loop_type "$loop_type"); do
    if ! command -v "$cli" >/dev/null 2>&1; then
      missing_clis+=("$cli")
    fi
  done

  if (( ${#missing_clis[@]} == 0 )); then
    return 0
  fi

  local supported_types suggestion
  supported_types="$(list_supported_loop_types)"
  suggestion=""

  if [[ "$loop_type" == "slow" ]] && is_loop_type_supported_here "yolo"; then
    suggestion="Try --type yolo (Claude-only) on this machine."
  elif [[ "$loop_type" == "slow" ]] && is_loop_type_supported_here "yolo-codex"; then
    suggestion="Try --type yolo-codex (Codex-only) on this machine."
  elif [[ "$loop_type" == "yolo-codex" || "$loop_type" == "yolo-codex-spark" ]]; then
    if is_loop_type_supported_here "yolo"; then
      suggestion="Try --type yolo (Claude) until Codex CLI is installed."
    fi
  elif [[ "$loop_type" == "yolo" ]] && is_loop_type_supported_here "yolo-codex"; then
    suggestion="Try --type yolo-codex (Codex) until Claude CLI is installed."
  fi

  echo "[subturtle:${name}] ERROR: loop type '${loop_type}' requires missing CLI(s): ${missing_clis[*]}" >&2
  echo "[subturtle:${name}] Supported loop types on this host: ${supported_types}" >&2
  if [[ -n "$suggestion" ]]; then
    echo "[subturtle:${name}] ${suggestion}" >&2
  fi
  exit 1
}

validate_known_loop_type() {
  local loop_type="$1"
  case "$loop_type" in
    slow|yolo|yolo-codex|yolo-codex-spark) ;;
    *)
      echo "ERROR: unknown SubTurtle type '${loop_type}' (must be: slow, yolo, yolo-codex, yolo-codex-spark)" >&2
      exit 1
      ;;
  esac
}

skills_to_json() {
  if (( $# == 0 )); then
    echo "[]"
    return
  fi

  printf '%s\n' "$@" | "$PYTHON" -c 'import json, sys; print(json.dumps([line.strip() for line in sys.stdin if line.strip()]))' 2>/dev/null || echo '[]'
}

finalize_stop_and_archive() {
  local name="$1"
  local run_status="$2"
  local stop_reason="$3"
  local stopped_at
  stopped_at="$(utc_now_iso)"

  if [[ -n "$run_status" && -d "$(workspace_dir "$name")" ]]; then
    append_run_event "$name" "stop" "$run_status"
  fi

  append_conductor_event "$name" "worker.stopped" "supervisor" "stopped" "{\"reason\":\"${stop_reason}\"}" || true
  write_conductor_worker_state "$name" "stopped" "supervisor" "$stop_reason" "" "$stopped_at" || true
  rm -f "$(pid_file "$name")"
  do_archive "$name"
}

do_start() {
  local name="${1:-default}"
  local timeout_str="${DEFAULT_TIMEOUT}"
  local loop_type="yolo-codex"
  local -a skills=()

  shift || true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --timeout) timeout_str="${2:?missing timeout value}"; shift 2 ;;
      --type)    loop_type="${2:?missing type value}"; shift 2 ;;
      --skill)   skills+=("${2:?missing skill name}"); shift 2 ;;
      *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
  done

  validate_known_loop_type "$loop_type"
  validate_loop_type_prereqs "$name" "$loop_type"

  local timeout_secs
  timeout_secs="$(parse_duration "$timeout_str")" || exit 1

  local skills_json="[]"
  if (( ${#skills[@]} > 0 )); then
    skills_json="$(skills_to_json "${skills[@]}")"
  fi

  ensure_workspace "$name"

  if is_running "$name"; then
    echo "[subturtle:${name}] already running (PID $(read_pid "$name"))"
    exit 0
  fi

  local pf lf mf ws
  pf="$(pid_file "$name")"
  lf="$(log_file "$name")"
  mf="$(meta_file "$name")"
  ws="$(workspace_dir "$name")"

  rm -f "$pf" "$mf"

  echo "[subturtle:${name}] spawning (type: ${loop_type}, timeout: ${timeout_str})..."
  echo "[subturtle:${name}] workspace: ${ws}"
  echo "[subturtle:${name}] log: ${lf}"

  export PYTHONPATH="${SUPER_TURTLE_DIR}:${SUPER_TURTLE_DIR%/*}${PYTHONPATH:+:$PYTHONPATH}"

  "$PYTHON" -c "
import importlib.util, subprocess, sys, os, json

pid_file   = sys.argv[1]
log_file   = sys.argv[2]
python     = sys.argv[3]
cwd        = sys.argv[4]
state_dir  = sys.argv[5]
name       = sys.argv[6]
loop_type  = sys.argv[7]
skills_json = sys.argv[8] if len(sys.argv) > 8 else '[]'

try:
    skills = json.loads(skills_json)
except (ValueError, TypeError):
    skills = []

def _can_write_home(path: str | None) -> bool:
    if not path:
        return False
    try:
        os.makedirs(path, exist_ok=True)
        probe = os.path.join(path, \".subturtle-home-write-test\")
        with open(probe, \"w\", encoding=\"utf-8\") as f:
            f.write(\"ok\")
        os.remove(probe)
        return True
    except OSError:
        return False

env = os.environ.copy()
for key in list(env):
    if key.startswith('CLAUDECODE'):
        del env[key]
for key in list(env):
    if key.startswith('CODEX'):
        del env[key]

real_codex_home = os.path.join(os.path.expanduser(\"~\"), \".codex\")
if os.path.isdir(real_codex_home):
    env[\"CODEX_HOME\"] = real_codex_home

original_home = env.get(\"HOME\")
if not _can_write_home(original_home):
    # Some callers run inside sandboxes with a read-only HOME, so give the loop
    # a writable per-workspace home instead of letting CLI auth/config writes fail.
    runtime_home = os.path.join(state_dir, \".runtime-home\")
    os.makedirs(runtime_home, exist_ok=True)
    env[\"HOME\"] = runtime_home
    env[\"CLAUDE_CONFIG_DIR\"] = os.path.join(runtime_home, \".claude\")
    env[\"XDG_CONFIG_HOME\"] = os.path.join(runtime_home, \".config\")
    env[\"XDG_DATA_HOME\"] = os.path.join(runtime_home, \".local\", \"share\")
    env[\"XDG_STATE_HOME\"] = os.path.join(runtime_home, \".local\", \"state\")
    env[\"XDG_CACHE_HOME\"] = os.path.join(runtime_home, \".cache\")
    env[\"TMPDIR\"] = os.path.join(runtime_home, \".tmp\")
    for d in (
        env[\"CLAUDE_CONFIG_DIR\"],
        env[\"XDG_CONFIG_HOME\"],
        env[\"XDG_DATA_HOME\"],
        env[\"XDG_STATE_HOME\"],
        env[\"XDG_CACHE_HOME\"],
        env[\"TMPDIR\"],
    ):
        os.makedirs(d, exist_ok=True)

log_fd = open(log_file, 'w')
module_name = None
for candidate in ('super_turtle.subturtle', 'subturtle'):
    try:
        if importlib.util.find_spec(candidate) is not None:
            module_name = candidate
            break
    except (ImportError, ModuleNotFoundError, ValueError):
        continue

if module_name is None:
    raise RuntimeError(
        'No importable SubTurtle module found. Tried super_turtle.subturtle and subturtle.'
    )

cmd = [python, '-u', '-m', module_name, '--state-dir', state_dir, '--name', name, '--type', loop_type]
if skills:
    cmd.extend(['--skills'] + skills)

proc = subprocess.Popen(
    cmd,
    cwd=cwd,
    stdin=subprocess.DEVNULL,
    stdout=log_fd,
    stderr=log_fd,
    start_new_session=True,
    env=env,
)
log_fd.close()

with open(pid_file, 'w') as f:
    f.write(str(proc.pid))

print(f'[subturtle:{name}] spawned as {loop_type} (PID {proc.pid})')
" "$pf" "$lf" "$PYTHON" "$PROJECT_DIR" "$ws" "$name" "$loop_type" "$skills_json"

  local turtle_pid
  if [[ ! -f "$pf" ]]; then
    echo "[subturtle:${name}] ERROR: spawn failed — no PID file written" >&2
    exit 1
  fi
  turtle_pid="$(read_pid "$name")"

  local spawned_at run_id
  spawned_at="$(date +%s)"
  run_id="run-${spawned_at}-${RANDOM}"
  cat > "$mf" <<METAEOF
RUN_ID=${run_id}
SPAWNED_AT=${spawned_at}
TIMEOUT_SECONDS=${timeout_secs}
LOOP_TYPE=${loop_type}
SKILLS=${skills_json}
METAEOF

  (
    sleep "$timeout_secs"
    if kill -0 "$turtle_pid" 2>/dev/null; then
      local timed_out_at
      timed_out_at="$(utc_now_iso)"
      echo "[subturtle:${name}] TIMEOUT ($(format_duration "$timeout_secs")) — sending SIGTERM to PID ${turtle_pid}" >> "$lf"
      append_conductor_event "$name" "worker.timed_out" "watchdog" "timed_out" || true
      write_conductor_worker_state "$name" "timed_out" "watchdog" "timed_out" "" "$timed_out_at" || true
      enqueue_conductor_wakeup \
        "$name" \
        "critical" \
        "SubTurtle ${name} timed out." \
        "${LAST_CONDUCTOR_EVENT_ID:-}" \
        '{"kind":"timeout"}' || true
      kill "$turtle_pid" 2>/dev/null || true
      sleep 5
      if kill -0 "$turtle_pid" 2>/dev/null; then
        echo "[subturtle:${name}] SIGTERM didn't work — sending SIGKILL" >> "$lf"
        kill -9 "$turtle_pid" 2>/dev/null || true
      fi
      rm -f "$pf" "$mf"
      echo "[subturtle:${name}] timed out and killed" >> "$lf"
    fi
  ) &
  local watchdog_pid=$!
  disown "$watchdog_pid"

  echo "WATCHDOG_PID=${watchdog_pid}" >> "$mf"

  echo "[subturtle:${name}] watchdog armed (${timeout_str}, PID ${watchdog_pid})"
  append_run_event "$name" "spawn" "running"
  append_conductor_event "$name" "worker.started" "supervisor" "running" || true
  write_conductor_worker_state "$name" "running" "supervisor" || true
}

register_spawn_cron_job() {
  local name="$1"
  local interval_ms="$2"
  local cron_jobs_file="$CRON_JOBS_FILE"

  "$PYTHON" - "$cron_jobs_file" "$name" "$interval_ms" "${SCRIPT_DIR}/ctl" <<'PY'
import datetime
import json
import secrets
import sys
from pathlib import Path

cron_jobs_path = Path(sys.argv[1])
name = sys.argv[2]
interval_ms = int(sys.argv[3])
ctl_path = sys.argv[4] if len(sys.argv) > 4 else "./super_turtle/subturtle/ctl"
prompt = (
    f"[SILENT CHECK-IN] Check SubTurtle {name}: run `{ctl_path} status {name}`, "
    f"inspect `.subturtles/{name}/CLAUDE.md`, and review `git log --oneline -10`.\n"
    "Rules: Do NOT message the user unless one of these conditions is met:\n"
    f"- 🎉 SubTurtle completed all backlog items -> stop SubTurtle {name} and report what shipped\n"
    f"- ⚠️ SubTurtle appears stuck (no meaningful progress across 2+ checks) -> stop it, diagnose, and report\n"
    "- ❌ SubTurtle errored, crashed, or is otherwise broken -> report the error clearly\n"
    "- 🚀 New milestone reached (significant backlog progress) -> send one brief update\n"
    "If SubTurtle is progressing normally without notable events, respond with only: [SILENT]"
)

jobs = []
if cron_jobs_path.exists():
    raw = cron_jobs_path.read_text(encoding="utf-8").strip()
    if raw:
        parsed = json.loads(raw)
        if not isinstance(parsed, list):
            raise ValueError("cron-jobs.json must contain a JSON array")
        jobs = parsed

existing_ids = {
    str(job.get("id"))
    for job in jobs
    if isinstance(job, dict) and "id" in job
}

job_id = ""
for _ in range(32):
    candidate = secrets.token_hex(3)
    if candidate not in existing_ids:
        job_id = candidate
        break
if not job_id:
    raise RuntimeError("failed to generate unique cron job id")

now_ms = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
job = {
    "id": job_id,
    "prompt": prompt,
    "silent": True,
    "job_kind": "subturtle_supervision",
    "worker_name": name,
    "supervision_mode": "silent",
    "type": "recurring",
    "fire_at": now_ms + interval_ms,
    "interval_ms": interval_ms,
    "created_at": datetime.datetime.now(datetime.timezone.utc)
    .replace(microsecond=0)
    .isoformat()
    .replace("+00:00", "Z"),
}

jobs.append(job)
cron_jobs_path.write_text(json.dumps(jobs, indent=2) + "\n", encoding="utf-8")
print(job_id)
PY
}

remove_spawn_cron_job() {
  local cron_job_id="$1"
  local cron_jobs_file="$CRON_JOBS_FILE"

  "$PYTHON" - "$cron_jobs_file" "$cron_job_id" <<'PY'
import json
import sys
from pathlib import Path

cron_jobs_path = Path(sys.argv[1])
cron_job_id = sys.argv[2]

if not cron_jobs_path.exists():
    raise FileNotFoundError(f"cron jobs file not found: {cron_jobs_path}")

raw = cron_jobs_path.read_text(encoding="utf-8").strip()
jobs = []
if raw:
    parsed = json.loads(raw)
    if not isinstance(parsed, list):
        raise ValueError("cron-jobs.json must contain a JSON array")
    jobs = parsed

new_jobs = []
removed = False
for job in jobs:
    if isinstance(job, dict) and str(job.get("id")) == cron_job_id:
        removed = True
        continue
    new_jobs.append(job)

if not removed:
    raise RuntimeError(f"cron job id not found: {cron_job_id}")

cron_jobs_path.write_text(json.dumps(new_jobs, indent=2) + "\n", encoding="utf-8")
PY
}

do_reschedule_cron() {
  local name="${1:-}"
  local interval_str="${2:-}"

  if [[ -z "$name" ]]; then
    echo "ERROR: missing SubTurtle name" >&2
    echo "Usage: ./super_turtle/subturtle/ctl reschedule-cron <name> <interval>" >&2
    exit 1
  fi

  if [[ -z "$interval_str" ]]; then
    echo "ERROR: missing interval" >&2
    echo "Usage: ./super_turtle/subturtle/ctl reschedule-cron <name> <interval>" >&2
    exit 1
  fi

  local interval_secs
  interval_secs="$(parse_duration "$interval_str")" || exit 1
  if (( interval_secs <= 0 )); then
    echo "ERROR: interval must be greater than zero" >&2
    exit 1
  fi
  local interval_ms=$(( interval_secs * 1000 ))

  CRON_JOB_ID=""
  if ! read_meta "$name"; then
    echo "ERROR: SubTurtle metadata not found for '${name}'" >&2
    exit 1
  fi
  if [[ -z "${CRON_JOB_ID:-}" ]]; then
    echo "ERROR: no CRON_JOB_ID found for SubTurtle '${name}'" >&2
    exit 1
  fi

  local py_status=0
  "$PYTHON" - "$CRON_JOBS_FILE" "$CRON_JOB_ID" "$interval_ms" <<'PY' || py_status=$?
import datetime
import json
import sys
from pathlib import Path

cron_jobs_path = Path(sys.argv[1])
cron_job_id = sys.argv[2]
interval_ms = int(sys.argv[3])

if not cron_jobs_path.exists():
    raise FileNotFoundError(f"cron jobs file not found: {cron_jobs_path}")

raw = cron_jobs_path.read_text(encoding="utf-8").strip()
jobs = []
if raw:
    parsed = json.loads(raw)
    if not isinstance(parsed, list):
        raise ValueError("cron-jobs.json must contain a JSON array")
    jobs = parsed

now_ms = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
updated = False
for job in jobs:
    if isinstance(job, dict) and str(job.get("id")) == cron_job_id:
        job["interval_ms"] = interval_ms
        job["fire_at"] = now_ms + interval_ms
        updated = True
        break

if not updated:
    sys.exit(42)

cron_jobs_path.write_text(json.dumps(jobs, indent=2) + "\n", encoding="utf-8")
PY
  if (( py_status != 0 )); then
    if (( py_status == 42 )); then
      echo "ERROR: no cron job found for id '${CRON_JOB_ID}'" >&2
    else
      echo "ERROR: failed to update cron jobs in ${CRON_JOBS_FILE}" >&2
    fi
    exit 1
  fi

  echo "[subturtle:${name}] cron job ${CRON_JOB_ID} rescheduled to every ${interval_str}"
}

do_spawn() {
  local name="${1:-default}"
  local timeout_str="${DEFAULT_TIMEOUT}"
  local loop_type="yolo-codex"
  local cron_interval="10m"
  local state_file=""
  local -a skills=()

  shift || true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --timeout) timeout_str="${2:?missing timeout value}"; shift 2 ;;
      --type)    loop_type="${2:?missing type value}"; shift 2 ;;
      --state-file) state_file="${2:?missing state file path}"; shift 2 ;;
      --cron-interval) cron_interval="${2:?missing cron interval}"; shift 2 ;;
      --skill)   skills+=("${2:?missing skill name}"); shift 2 ;;
      *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
  done

  local cron_interval_secs
  cron_interval_secs="$(parse_duration "$cron_interval")" || exit 1
  if (( cron_interval_secs <= 0 )); then
    echo "[subturtle:${name}] ERROR: --cron-interval must be greater than zero" >&2
    exit 1
  fi
  local cron_interval_ms=$(( cron_interval_secs * 1000 ))

  local ws
  ws="$(workspace_dir "$name")"
  mkdir -p "$ws"

  if [[ -n "$state_file" ]]; then
    if [[ "$state_file" == "-" ]]; then
      if ! cat > "$ws/CLAUDE.md"; then
        echo "[subturtle:${name}] ERROR: failed reading state from stdin" >&2
        exit 1
      fi
    else
      if [[ ! -f "$state_file" ]]; then
        echo "[subturtle:${name}] ERROR: state file not found: ${state_file}" >&2
        exit 1
      fi
      cp "$state_file" "$ws/CLAUDE.md"
    fi
  elif [[ ! -t 0 ]]; then
    if ! cat > "$ws/CLAUDE.md"; then
      echo "[subturtle:${name}] ERROR: failed reading state from stdin" >&2
      exit 1
    fi
  else
    echo "[subturtle:${name}] ERROR: missing state input (use --state-file PATH or pipe stdin)" >&2
    exit 1
  fi

  validate_spawn_state_file "$name" "$ws/CLAUDE.md"
  ln -sf CLAUDE.md "$ws/AGENTS.md"

  local -a start_args=("$name" --type "$loop_type" --timeout "$timeout_str")
  local skill
  if (( ${#skills[@]} > 0 )); then
    for skill in "${skills[@]}"; do
      start_args+=(--skill "$skill")
    done
  fi
  do_start "${start_args[@]}"

  local cron_job_id
  if ! cron_job_id="$(register_spawn_cron_job "$name" "$cron_interval_ms")"; then
    echo "[subturtle:${name}] ERROR: failed to register cron job in ${CRON_JOBS_FILE}" >&2
    echo "[subturtle:${name}] stopping SubTurtle because cron registration failed" >&2
    if is_running "$name"; then
      do_stop "$name" >/dev/null 2>&1 || true
    fi
    exit 1
  fi

  echo "CRON_JOB_ID=${cron_job_id}" >> "$(meta_file "$name")"

  echo "[subturtle:${name}] cron registered (${cron_job_id}, every ${cron_interval})"
  write_conductor_worker_state "$name" "running" "supervisor" || true
  echo ""
  do_list
}

do_stop() {
  local name="${1:-default}"
  local ws
  ws="$(workspace_dir "$name")"
  if [[ -d "$ws" || -f "$(meta_file "$name")" || -f "$(pid_file "$name")" ]]; then
    local stop_requested_at
    stop_requested_at="$(utc_now_iso)"
    append_conductor_event "$name" "worker.stop_requested" "supervisor" "stop_pending" || true
    write_conductor_worker_state "$name" "stop_pending" "supervisor" "stop_requested" "" "$stop_requested_at" || true
  fi

  CRON_JOB_ID=""
  if read_meta "$name" && [[ -n "${CRON_JOB_ID:-}" ]]; then
    local removed_cron_job_id="${CRON_JOB_ID}"
    if remove_spawn_cron_job "$CRON_JOB_ID"; then
      echo "[subturtle:${name}] cron job ${CRON_JOB_ID} removed"
      if ! remove_meta_key "$name" "CRON_JOB_ID"; then
        echo "[subturtle:${name}] WARNING: failed to clear CRON_JOB_ID from meta file" >&2
      fi
      CRON_JOB_ID=""
      append_conductor_event \
        "$name" \
        "worker.cron_removed" \
        "supervisor" \
        "stop_pending" \
        "{\"cron_job_id\":\"${removed_cron_job_id}\",\"removal_reason\":\"stop_requested\"}" || true
      write_conductor_worker_state "$name" "stop_pending" "supervisor" "stop_requested" "" "$stop_requested_at" || true
    else
      echo "[subturtle:${name}] WARNING: failed to remove cron job ${CRON_JOB_ID}" >&2
    fi
  fi

  WATCHDOG_PID=""
  if read_meta "$name" && [[ -n "${WATCHDOG_PID:-}" ]]; then
    kill "$WATCHDOG_PID" 2>/dev/null || true
  fi

  if ! is_running "$name"; then
    echo "[subturtle:${name}] not running"
    finalize_stop_and_archive "$name" "not_running" "not_running"
    exit 0
  fi

  local pid
  pid="$(read_pid "$name")"
  echo "[subturtle:${name}] stopping (PID ${pid})..."

  kill "$pid" 2>/dev/null || true

  local i
  for i in $(seq 1 10); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[subturtle:${name}] stopped"
      finalize_stop_and_archive "$name" "stopped" "stopped"
      return
    fi
    sleep 1
  done

  echo "[subturtle:${name}] sending SIGKILL..."
  kill -9 "$pid" 2>/dev/null || true
  echo "[subturtle:${name}] killed"
  finalize_stop_and_archive "$name" "killed" "killed"
}

do_status() {
  local name="${1:-default}"

  if is_running "$name"; then
    local pid remaining_secs
    pid="$(read_pid "$name")"

    remaining_secs="$(time_remaining "$name")"

    LOOP_TYPE=""
    SKILLS=""
    read_meta "$name" || true
    local type_info="${LOOP_TYPE:-yolo-codex}"

    local time_info=""
    if [[ -n "$remaining_secs" && -n "$SPAWNED_AT" ]]; then
      local now elapsed
      now="$(date +%s)"
      elapsed=$(( now - SPAWNED_AT ))
      time_info=" — $(format_duration "$elapsed") elapsed, $(format_time_remaining "$remaining_secs")"
    fi

    echo "[subturtle:${name}] running as ${type_info} (PID ${pid})${time_info}"

    if [[ -n "$SKILLS" && "$SKILLS" != "[]" ]]; then
      echo "[subturtle:${name}] skills: ${SKILLS}"
    fi

    ps -o pid,ppid,pgid,sess,state,etime,command -p "$pid" 2>/dev/null || true

    local tunnel_url
    if tunnel_url="$(tunnel_url_for_subturtle "$name" 2>/dev/null)"; then
      echo "[subturtle:${name}] tunnel URL: ${tunnel_url}"
    fi
  else
    echo "[subturtle:${name}] not running"
    local pf
    pf="$(pid_file "$name")"
    if [[ -f "$pf" ]]; then
      rm -f "$pf"
    fi
  fi
}

do_logs() {
  local name="${1:-default}"
  local lf
  lf="$(log_file "$name")"

  if [[ ! -f "$lf" ]]; then
    echo "[subturtle:${name}] no log file found at ${lf}"
    exit 1
  fi
  tail -n "${LINES:-50}" -f "$lf"
}

do_archive() {
  local name="${1:-default}"
  local ws archive_root archive_ws
  ws="$(workspace_dir "$name")"
  archive_root="${SUBTURTLES_DIR}/.archive"
  archive_ws="${archive_root}/${name}"

  if is_running "$name"; then
    echo "[subturtle:${name}] ERROR: cannot archive while running (PID $(read_pid "$name"))" >&2
    exit 1
  fi

  if [[ ! -d "$ws" ]]; then
    if [[ -d "$archive_ws" ]]; then
      echo "[subturtle:${name}] already archived at ${archive_ws}"
      return 0
    fi
    echo "[subturtle:${name}] ERROR: workspace not found at ${ws}" >&2
    exit 1
  fi

  mkdir -p "$archive_root"
  rm -rf "$archive_ws"
  mv "$ws" "$archive_ws"

  local archived_at
  archived_at="$(utc_now_iso)"
  echo "[subturtle:${name}] archived to ${archive_ws}"
  append_conductor_event "$name" "worker.archived" "supervisor" "archived" || true
  write_conductor_worker_state "$name" "archived" "supervisor" "" "" "$archived_at" || true
}

do_gc() {
  local max_age_str="1d"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --max-age)
        max_age_str="${2:?missing duration for --max-age}"
        shift 2
        ;;
      *)
        echo "ERROR: unknown option for gc: $1" >&2
        echo "Usage: ./super_turtle/subturtle/ctl gc [--max-age DURATION]" >&2
        exit 1
        ;;
    esac
  done

  local max_age_seconds
  max_age_seconds="$(parse_duration "$max_age_str")" || exit 1

  local now cutoff
  now="$(date +%s)"
  cutoff=$(( now - max_age_seconds ))

  if [[ ! -d "$SUBTURTLES_DIR" ]]; then
    return
  fi

  local ws name mtime
  for ws in "$SUBTURTLES_DIR"/*/; do
    [[ -d "$ws" ]] || continue
    name="$(basename "$ws")"

    if is_running "$name"; then
      continue
    fi

    if ! mtime="$(stat -f '%m' "$ws" 2>/dev/null)"; then
      mtime="$(stat -c '%Y' "$ws" 2>/dev/null)" || {
        echo "[subturtle:${name}] ERROR: unable to read workspace mtime" >&2
        continue
      }
    fi

    if (( mtime <= cutoff )); then
      do_archive "$name"
    fi
  done
}

do_list() {
  local show_archived=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --archived)
        show_archived=1
        shift
        ;;
      *)
        echo "ERROR: unknown option for list: $1" >&2
        echo "Usage: ./super_turtle/subturtle/ctl list [--archived]" >&2
        exit 1
        ;;
    esac
  done

  if (( show_archived == 1 )); then
    local archive_root
    archive_root="${SUBTURTLES_DIR}/.archive"
    if [[ ! -d "$archive_root" ]]; then
      echo "No archived SubTurtles found."
      return
    fi

    local archived_found=0
    local ws name archived_epoch archived_at
    for ws in "$archive_root"/*/; do
      [[ -d "$ws" ]] || continue
      name="$(basename "$ws")"
      archived_found=1

      if ! archived_epoch="$(stat -f '%c' "$ws" 2>/dev/null)"; then
        archived_epoch="$(stat -c '%Z' "$ws" 2>/dev/null || true)"
      fi

      archived_at="unknown"
      if [[ -n "$archived_epoch" ]]; then
        if ! archived_at="$(date -r "$archived_epoch" '+%Y-%m-%d %H:%M:%S' 2>/dev/null)"; then
          archived_at="$(date -d "@$archived_epoch" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "unknown")"
        fi
      fi

      printf "  %-15s %s\n" "$name" "$archived_at"
    done

    if [[ $archived_found -eq 0 ]]; then
      echo "No archived SubTurtles found."
    fi
    return
  fi

  if [[ ! -d "$SUBTURTLES_DIR" ]]; then
    echo "No SubTurtles found."
    return
  fi

  local found=0
  for ws in "$SUBTURTLES_DIR"/*/; do
    [[ -d "$ws" ]] || continue
    local name
    name="$(basename "$ws")"
    [[ "$name" == ".archive" ]] && continue
    found=1

    local status_str="stopped"
    local pid_str=""
    local time_str=""
    local type_str=""
    local skills_str=""
    local pf="${ws}subturtle.pid"
    if [[ -f "$pf" ]]; then
      local pid
      pid="$(cat "$pf")"
      if kill -0 "$pid" 2>/dev/null; then
        status_str="running"
        pid_str=" (PID ${pid})"

        local remaining_secs
        remaining_secs="$(time_remaining "$name")"
        time_str="$(format_time_remaining "$remaining_secs")"

        LOOP_TYPE=""
        SKILLS=""
        read_meta "$name" || true
        type_str="${LOOP_TYPE:-yolo-codex}"
        if [[ -n "$SKILLS" && "$SKILLS" != "[]" ]]; then
          skills_str=" [skills: ${SKILLS}]"
        fi
      fi
    fi

    local task="(no task)"
    task="$(current_task_for_subturtle "$name")"
    [[ -z "$task" ]] && task="(no task)"

    if [[ -n "$time_str" ]]; then
      printf "  %-15s %-8s %-12s %-14s %-14s %s%s\n" "$name" "$status_str" "$type_str" "$pid_str" "$time_str" "$task" "$skills_str"
    else
      printf "  %-15s %-8s %-12s %-14s %-14s %s%s\n" "$name" "$status_str" "" "$pid_str" "" "$task" "$skills_str"
    fi

    local tunnel_url
    if tunnel_url="$(tunnel_url_for_subturtle "$name" 2>/dev/null)"; then
      printf "  %-15s → %s\n" "" "$tunnel_url"
    fi
  done

  if [[ $found -eq 0 ]]; then
    echo "No SubTurtles found."
  fi
}
