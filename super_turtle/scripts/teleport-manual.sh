#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./super_turtle/scripts/teleport-manual.sh <ssh_target> <remote_root> [options]

Teleport the current Super Turtle repo to a remote Linux host and continue
chatting with the same Telegram bot there.

Remote Claude auth can come from either:
  - an already logged-in remote `claude` session, or
  - `CLAUDE_CODE_OAUTH_TOKEN` in `.superturtle/.env`

Runbook:
  super_turtle/docs/MANUAL_TELEPORT_RUNBOOK.md

Options:
  --port <N>         SSH port
  --identity <PATH>  SSH identity file
  --dry-run          Run preflight, export, and rsync dry-run only
  -h, --help         Show this help
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HELPER_PY="${REPO_ROOT}/super_turtle/state/teleport_handoff.py"
CTL_PATH="${REPO_ROOT}/super_turtle/subturtle/ctl"
ENV_FILE="${REPO_ROOT}/.superturtle/.env"

SSH_TARGET=""
REMOTE_ROOT=""
SSH_PORT=""
SSH_IDENTITY=""
DRY_RUN=0

if [[ $# -eq 1 && ( "$1" == "--help" || "$1" == "-h" ) ]]; then
  usage
  exit 0
fi

if [[ $# -lt 2 ]]; then
  usage
  exit 1
fi

SSH_TARGET="$1"
REMOTE_ROOT="$2"
shift 2

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      SSH_PORT="${2:?missing value for --port}"
      shift 2
      ;;
    --identity)
      SSH_IDENTITY="${2:?missing value for --identity}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[teleport] Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[teleport] Missing required command: ${cmd}" >&2
    exit 1
  fi
}

sanitize_name() {
  printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9_-' '-' | sed -e 's/^-*//' -e 's/-*$//'
}

derive_token_prefix() {
  local token="$1"
  local prefix="${token%%:*}"
  prefix="${prefix:-default}"
  sanitize_name "$prefix"
}

derive_tmux_session_name() {
  local token_prefix="$1"
  local project_root="$2"
  local project_slug
  project_slug="$(sanitize_name "$(basename "$project_root")")"
  project_slug="${project_slug:-project}"
  printf 'superturtle-%s-%s' "${token_prefix:-default}" "$project_slug"
}

run_python() {
  python3 "$HELPER_PY" "$@"
}

read_json_field() {
  local path="$1"
  local field="$2"
  python3 - "$path" "$field" <<'PY'
import json
import sys

path, field = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as handle:
    loaded = json.load(handle)

value = loaded
for segment in field.split("."):
    if not isinstance(value, dict):
        value = ""
        break
    value = value.get(segment, "")

if isinstance(value, bool):
    print("true" if value else "false")
elif value is None:
    print("")
else:
    print(value)
PY
}

SSH_ARGS=()
if [[ -n "$SSH_PORT" ]]; then
  SSH_ARGS+=("-p" "$SSH_PORT")
fi
if [[ -n "$SSH_IDENTITY" ]]; then
  SSH_ARGS+=("-i" "$SSH_IDENTITY")
fi

ssh_run() {
  local -a cmd=(ssh)
  if (( ${#SSH_ARGS[@]} > 0 )); then
    cmd+=("${SSH_ARGS[@]}")
  fi
  cmd+=("$SSH_TARGET")
  cmd+=("$@")
  "${cmd[@]}"
}

local_preflight() {
  require_cmd ssh
  require_cmd rsync
  require_cmd bun
  require_cmd python3

  if [[ ! -f "$ENV_FILE" ]]; then
    echo "[teleport] Missing project env file: ${ENV_FILE}" >&2
    exit 1
  fi
  if [[ ! -f "$HELPER_PY" ]]; then
    echo "[teleport] Missing helper script: ${HELPER_PY}" >&2
    exit 1
  fi
}

build_rsync_cmd() {
  local -a cmd=(rsync -az --delete)
  if (( DRY_RUN == 1 )); then
    cmd+=("--dry-run")
  fi
  cmd+=(
    "--exclude" ".DS_Store"
    "--exclude" "node_modules"
    "--exclude" ".venv"
    "--exclude" "__pycache__"
    "--exclude" ".pytest_cache"
    "--exclude" ".mypy_cache"
    "--exclude" ".next"
    "--exclude" "dist"
    "--exclude" "build"
    "--exclude" ".turbo"
    "--exclude" ".tmp"
    "--exclude" "*.pyc"
    "-e"
  )
  local ssh_cmd="ssh"
  if [[ -n "$SSH_PORT" ]]; then
    ssh_cmd+=" -p ${SSH_PORT}"
  fi
  if [[ -n "$SSH_IDENTITY" ]]; then
    ssh_cmd+=" -i ${SSH_IDENTITY}"
  fi
  cmd+=("$ssh_cmd" "${REPO_ROOT}/" "${SSH_TARGET}:${REMOTE_ROOT}/")
  printf '%s\0' "${cmd[@]}"
}

run_rsync() {
  local -a cmd=()
  while IFS= read -r -d '' part; do
    cmd+=("$part")
  done < <(build_rsync_cmd)
  "${cmd[@]}"
}

remote_preflight() {
  local active_driver="$1"
  ssh_run bash -s -- "$REMOTE_ROOT" "$active_driver" <<'EOF'
set -euo pipefail
remote_root="$1"
active_driver="$2"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[teleport][remote] Missing required command: ${cmd}" >&2
    exit 1
  fi
}

os_name="$(uname -s)"
if [[ "$os_name" != "Linux" ]]; then
  echo "[teleport][remote] Expected Linux but found ${os_name}" >&2
  exit 1
fi

require_cmd git
require_cmd rsync
require_cmd bun
require_cmd python3
require_cmd tmux

case "$active_driver" in
  codex)
    require_cmd codex
    ;;
  claude|*)
    require_cmd claude
    ;;
esac

mkdir -p "$remote_root"
echo "[teleport][remote] preflight ok (${active_driver})"
EOF
}

remote_install_dependencies() {
  ssh_run bash -s -- "$REMOTE_ROOT" <<'EOF'
set -euo pipefail
remote_root="$1"
cd "$remote_root/super_turtle/claude-telegram-bot"
bun install
EOF
}

stop_local_subturtles() {
  if [[ ! -x "$CTL_PATH" ]]; then
    return 0
  fi

  local -a running_names=()
  while IFS= read -r name; do
    [[ -n "$name" ]] && running_names+=("$name")
  done < <("$CTL_PATH" list 2>/dev/null | awk '$2 == "running" {print $1}')
  if (( ${#running_names[@]} == 0 )); then
    return 0
  fi

  for name in "${running_names[@]}"; do
    echo "[teleport] stopping SubTurtle ${name}"
    "$CTL_PATH" stop "$name"
  done
}

stop_local_bot() {
  local tmux_session
  tmux_session="$(derive_tmux_session_name "$TOKEN_PREFIX" "$REPO_ROOT")"
  if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$tmux_session" 2>/dev/null; then
    echo "[teleport] stopping local bot tmux session ${tmux_session}"
    tmux kill-session -t "$tmux_session"
  fi
}

remote_import_runtime() {
  ssh_run bash -s -- "$REMOTE_ROOT" <<'EOF'
set -euo pipefail
remote_root="$1"
python3 "$remote_root/super_turtle/state/teleport_handoff.py" import --project-root "$remote_root"
EOF
}

start_remote_bot() {
  ssh_run bash -s -- "$REMOTE_ROOT" <<'EOF'
set -euo pipefail
remote_root="$1"
env_file="$remote_root/.superturtle/.env"
if [[ ! -f "$env_file" ]]; then
  echo "[teleport][remote] Missing env file: $env_file" >&2
  exit 1
fi

python3 - "$env_file" "$remote_root" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
remote_root = sys.argv[2]
home = str(Path.home())

desired = {
    "CLAUDE_WORKING_DIR": remote_root,
    "ALLOWED_PATHS": f"{remote_root},{home}/.claude",
}

lines = env_path.read_text().splitlines()
updated = []
seen = set()

for raw in lines:
    stripped = raw.strip()
    if not stripped or stripped.startswith("#") or "=" not in raw:
        updated.append(raw)
        continue
    key, _, _ = raw.partition("=")
    if key in desired:
        updated.append(f"{key}={desired[key]}")
        seen.add(key)
    else:
        updated.append(raw)

for key, value in desired.items():
    if key not in seen:
        updated.append(f"{key}={value}")

env_path.write_text("\n".join(updated) + "\n")
PY

set -a
source "$env_file"
set +a

sanitize_name() {
  printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9_-' '-' | sed -e 's/^-*//' -e 's/-*$//'
}

token_prefix="$(sanitize_name "${TELEGRAM_BOT_TOKEN%%:*}")"
token_prefix="${token_prefix:-default}"
project_slug="$(sanitize_name "$(basename "$remote_root")")"
project_slug="${project_slug:-project}"
tmux_session="superturtle-${token_prefix}-${project_slug}"

if tmux has-session -t "$tmux_session" 2>/dev/null; then
  tmux kill-session -t "$tmux_session"
fi

cd "$remote_root"
bun super_turtle/bin/superturtle.js start
EOF
}

verify_remote_bot() {
  ssh_run bash -s -- "$REMOTE_ROOT" <<'EOF'
set -euo pipefail
remote_root="$1"
cd "$remote_root"
status_output="$(bun super_turtle/bin/superturtle.js status)"
printf '%s\n' "$status_output"
if ! grep -q "Bot: running" <<<"$status_output"; then
  echo "[teleport][remote] Bot did not report running status" >&2
  exit 1
fi
EOF
}

send_remote_notification() {
  local message="$1"
  local message_b64
  message_b64="$(printf '%s' "$message" | base64 | tr -d '\n')"
  ssh_run bash -s -- "$REMOTE_ROOT" "$message_b64" <<'EOF'
set -euo pipefail
remote_root="$1"
message_b64="$2"
message="$(printf '%s' "$message_b64" | base64 --decode)"
python3 "$remote_root/super_turtle/state/teleport_handoff.py" notify --project-root "$remote_root" --text "$message"
EOF
}

echo "[teleport] repo root: ${REPO_ROOT}"
echo "[teleport] ssh target: ${SSH_TARGET}"
echo "[teleport] remote root: ${REMOTE_ROOT}"

local_preflight

run_python export --project-root "$REPO_ROOT" --remote-root "$REMOTE_ROOT" --ssh-target "$SSH_TARGET" >/dev/null
CONTEXT_FILE="${REPO_ROOT}/.superturtle/teleport/context.json"
TOKEN_PREFIX="$(read_json_field "$CONTEXT_FILE" "token_prefix")"
ACTIVE_DRIVER="$(read_json_field "$CONTEXT_FILE" "active_driver")"
ACTIVE_DRIVER="${ACTIVE_DRIVER:-claude}"

echo "[teleport] active driver: ${ACTIVE_DRIVER}"
remote_preflight "$ACTIVE_DRIVER"

echo "[teleport] initial sync"
run_rsync

if (( DRY_RUN == 1 )); then
  echo "[teleport] dry-run complete"
  exit 0
fi

echo "[teleport] remote dependency install"
remote_install_dependencies

stop_local_subturtles

echo "[teleport] exporting final handoff state"
run_python export --project-root "$REPO_ROOT" --remote-root "$REMOTE_ROOT" --ssh-target "$SSH_TARGET" >/dev/null

stop_local_bot

echo "[teleport] final sync"
run_rsync

echo "[teleport] importing portable runtime state on remote"
remote_import_runtime

echo "[teleport] starting remote bot"
start_remote_bot

echo "[teleport] verifying remote bot"
verify_remote_bot

send_remote_notification "Teleport complete. Super Turtle is now running on ${SSH_TARGET}."

echo "[teleport] success"
