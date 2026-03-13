#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: ./super_turtle/scripts/teleport-manual.sh <ssh_target> <remote_root> [options]
       ./super_turtle/scripts/teleport-manual.sh --managed [options]

Teleport the current Super Turtle repo to a remote Linux host and continue
chatting with the same Telegram bot there.

Remote Claude auth can come from either:
  - an already logged-in remote `claude` session, or
  - `CLAUDE_CODE_OAUTH_TOKEN` in `.superturtle/.env`

Runbook:
  super_turtle/docs/MANUAL_TELEPORT_RUNBOOK.md

Options:
  --managed          Resolve the linked managed runtime from the hosted control plane
  --port <N>         SSH port
  --identity <PATH>  SSH identity file
  --dry-run          Run preflight, export, and rsync dry-run only
  -h, --help         Show this help
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HELPER_PY="${REPO_ROOT}/super_turtle/state/teleport_handoff.py"
CTL_PATH="${SUPERTURTLE_TELEPORT_CTL_PATH:-${REPO_ROOT}/super_turtle/subturtle/ctl}"
E2B_HELPER_PATH="${SUPERTURTLE_TELEPORT_E2B_HELPER_PATH:-${REPO_ROOT}/super_turtle/bin/teleport-e2b.js}"
ENV_FILE="${REPO_ROOT}/.superturtle/.env"
E2B_REMOTE_HOME="${SUPERTURTLE_TELEPORT_E2B_HOME:-/home/user}"
CLAUDE_CREDENTIALS_SOURCE_PATH="${SUPERTURTLE_TELEPORT_CLAUDE_CREDENTIALS_PATH:-}"
CODEX_AUTH_SOURCE_PATH="${SUPERTURTLE_TELEPORT_CODEX_AUTH_PATH:-$HOME/.codex/auth.json}"
MACHINE_HEARTBEAT_INTERVAL_SECONDS="${SUPERTURTLE_TELEPORT_MACHINE_HEARTBEAT_INTERVAL_SECONDS:-30}"
MACHINE_HEARTBEAT_AUTOSTART="${SUPERTURTLE_TELEPORT_E2B_HEARTBEAT_AUTOSTART:-1}"

SSH_TARGET=""
REMOTE_ROOT=""
SSH_PORT=""
SSH_IDENTITY=""
TELEPORT_TRANSPORT="ssh"
E2B_SANDBOX_ID=""
E2B_TEMPLATE_ID=""
CONTROL_PLANE_ORIGIN=""
MACHINE_AUTH_TOKEN=""
DRY_RUN=0
USE_MANAGED_TARGET=0
CURRENT_PHASE="preflight"
LOCAL_BOT_STOPPED=0
REMOTE_START_ATTEMPTED=0
REMOTE_RUNTIME_VERIFIED=0
ROLLBACK_ATTEMPTED=0
LATEST_FAILURE_REASON=""

if [[ ! "$MACHINE_HEARTBEAT_INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "[teleport] SUPERTURTLE_TELEPORT_MACHINE_HEARTBEAT_INTERVAL_SECONDS must be a positive integer" >&2
  exit 1
fi

if [[ "$MACHINE_HEARTBEAT_AUTOSTART" != "0" && "$MACHINE_HEARTBEAT_AUTOSTART" != "1" ]]; then
  echo "[teleport] SUPERTURTLE_TELEPORT_E2B_HEARTBEAT_AUTOSTART must be 0 or 1" >&2
  exit 1
fi

emit_status() {
  local key="$1"
  shift || true
  printf '[teleport-status] %s=%s\n' "$key" "$*"
}

set_phase() {
  CURRENT_PHASE="$1"
  emit_status "phase" "$1"
}

set_active_owner() {
  emit_status "active_owner" "$1"
}

set_destination_state() {
  emit_status "destination_state" "$1"
}

set_failure_reason() {
  LATEST_FAILURE_REASON="$*"
  emit_status "failure_reason" "$*"
}

clear_failure_reason() {
  LATEST_FAILURE_REASON=""
  emit_status "failure_reason" ""
}

if [[ $# -eq 1 && ( "$1" == "--help" || "$1" == "-h" ) ]]; then
  usage
  exit 0
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --managed)
      USE_MANAGED_TARGET=1
      shift
      ;;
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
      if [[ "$1" == --* ]]; then
        echo "[teleport] Unknown option: $1" >&2
        usage
        exit 1
      fi
      if [[ -z "$SSH_TARGET" ]]; then
        SSH_TARGET="$1"
      elif [[ -z "$REMOTE_ROOT" ]]; then
        REMOTE_ROOT="$1"
      else
        echo "[teleport] Unexpected argument: $1" >&2
        usage
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ "$USE_MANAGED_TARGET" -eq 1 ]]; then
  if [[ -n "$SSH_TARGET" || -n "$REMOTE_ROOT" ]]; then
    echo "[teleport] Do not pass <ssh_target> or <remote_root> with --managed" >&2
    usage
    exit 1
  fi
else
  if [[ -z "$SSH_TARGET" || -z "$REMOTE_ROOT" ]]; then
    usage
    exit 1
  fi
fi

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

e2b_helper() {
  node "$E2B_HELPER_PATH" "$@"
}

resolve_managed_target() {
  local output
  if ! output="$(
    cd "$REPO_ROOT"
    node - <<'NODE'
const {
  fetchCloudStatus,
  fetchTeleportTarget,
  isRetryableCloudError,
  persistSessionIfChanged,
  readSession,
  resumeManagedInstance,
} = require("./super_turtle/bin/cloud.js");

function readPositiveIntegerEnv(name, fallback) {
  const rawValue = process.env[name];
  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    return fallback;
  }
  if (!/^\d+$/.test(rawValue.trim())) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(rawValue.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatCloudErrorContext(error) {
  const details = [];
  if (error && typeof error === "object") {
    if (Number.isFinite(error.status)) {
      details.push(`status ${error.status}`);
    }
    if (typeof error.code === "string" && error.code.length > 0) {
      details.push(`code ${error.code}`);
    }
    if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) {
      details.push(`retry-after ${error.retryAfterMs}ms`);
    }
  }

  const message = error instanceof Error ? error.message : String(error || "");
  if (message) {
    details.push(message);
  }
  return details.join(", ") || "unknown error";
}

function isTransientControlPlaneError(error) {
  if (isRetryableCloudError(error)) {
    return true;
  }
  const status = error && typeof error === "object" ? error.status : undefined;
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function formatProvisioningContext(status) {
  const instanceState = status?.data?.instance?.state || "unknown";
  const provisioningJob = status?.data?.provisioning_job;
  if (!provisioningJob || typeof provisioningJob !== "object") {
    return `instance state ${instanceState}`;
  }

  const details = [`instance state ${instanceState}`, `job ${provisioningJob.kind || "unknown"} ${provisioningJob.state || "unknown"}`];
  if (typeof provisioningJob.error_code === "string" && provisioningJob.error_code.length > 0) {
    details.push(`error code ${provisioningJob.error_code}`);
  }
  if (typeof provisioningJob.error_message === "string" && provisioningJob.error_message.length > 0) {
    details.push(`error ${provisioningJob.error_message}`);
  }
  return details.join(", ");
}

function getManagedRuntimeLabel(provider) {
  if (provider === "e2b") {
    return "managed sandbox";
  }
  if (provider === "gcp") {
    return "managed instance";
  }
  return "managed runtime";
}

function capitalizeLabel(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

(async () => {
  let session = readSession();
  if (!session) {
    throw new Error("Not logged in to hosted SuperTurtle. Run 'superturtle login' first.");
  }
  const timeoutMs = readPositiveIntegerEnv(
    "SUPERTURTLE_TELEPORT_INSTANCE_READY_TIMEOUT_MS",
    600000
  );
  const intervalMs = readPositiveIntegerEnv(
    "SUPERTURTLE_TELEPORT_INSTANCE_READY_POLL_INTERVAL_MS",
    5000
  );
  const deadline = Date.now() + timeoutMs;
  let resumeRequested = false;
  let lastProvisioningContext = "instance state unknown";
  let currentProvider = null;
  const managedRuntimeLabel = () => getManagedRuntimeLabel(currentProvider);
  const managedRuntimeLabelTitle = () => capitalizeLabel(managedRuntimeLabel());
  const waitForRetryWindow = async (phase, error) => {
    if (!isTransientControlPlaneError(error)) {
      return false;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    const retryAfterMs =
      error && typeof error === "object" && Number.isFinite(error.retryAfterMs)
        ? error.retryAfterMs
        : 0;
    const errorContext = formatCloudErrorContext(error);
    lastProvisioningContext = `${phase} transient error, ${errorContext}`;
    process.stderr.write(
      `[teleport] transient control-plane error during ${phase}; retrying: ${errorContext}\n`
    );
    process.stderr.write(`[teleport-status] failure_reason=${phase} transient error: ${errorContext}\n`);
    await sleep(Math.min(remainingMs, Math.max(intervalMs, retryAfterMs, 1)));
    return true;
  };

  while (true) {
    try {
      const target = await fetchTeleportTarget(session);
      session = persistSessionIfChanged(session, target.session);
      currentProvider = target?.data?.instance?.provider || currentProvider;
      process.stderr.write("[teleport-status] phase=target_ready\n");
      process.stderr.write(
        `[teleport-status] destination_state=${target?.data?.instance?.state || "running"}\n`
      );
      process.stderr.write("[teleport-status] failure_reason=\n");
      process.stdout.write(
        JSON.stringify({
          ...target.data,
          control_plane_origin:
            session && typeof session.control_plane === "string" && session.control_plane.trim().length > 0
              ? session.control_plane
              : null,
        })
      );
      return;
    } catch (error) {
      if (error && typeof error === "object" && error.session) {
        session = persistSessionIfChanged(session, error.session);
      }
      if (!error || typeof error !== "object" || error.status !== 409) {
        if (await waitForRetryWindow("managed target lookup", error)) {
          continue;
        }
        throw error;
      }
      if (!["managed_instance_not_running", "managed_instance_unavailable"].includes(error.message)) {
        throw error;
      }
    }

    if (!resumeRequested) {
      process.stderr.write(`[teleport] ${managedRuntimeLabel()} is not ready; requesting resume\n`);
      process.stderr.write("[teleport-status] phase=resuming_destination\n");
      try {
        const resumed = await resumeManagedInstance(session);
        session = persistSessionIfChanged(session, resumed.session);
        currentProvider = resumed?.data?.instance?.provider || currentProvider;
        process.stderr.write(
          `[teleport-status] destination_state=${resumed?.data?.instance?.state || "provisioning"}\n`
        );
        process.stderr.write("[teleport-status] failure_reason=\n");
        resumeRequested = true;
      } catch (error) {
        if (error && typeof error === "object" && error.session) {
          session = persistSessionIfChanged(session, error.session);
        }
        if (await waitForRetryWindow("managed runtime resume", error)) {
          continue;
        }
        throw error;
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for the ${managedRuntimeLabel()} to become ready after ${timeoutMs}ms.`
      );
    }

    process.stderr.write(`[teleport] waiting for ${managedRuntimeLabel()} to become ready\n`);
    process.stderr.write("[teleport-status] phase=waiting_for_destination\n");
    let lastInstanceState = "";
    while (Date.now() < deadline) {
      let status;
      try {
        status = await fetchCloudStatus(session);
      } catch (error) {
        if (error && typeof error === "object" && error.session) {
          session = persistSessionIfChanged(session, error.session);
        }
        if (await waitForRetryWindow("managed runtime status polling", error)) {
          continue;
        }
        throw error;
      }
      session = persistSessionIfChanged(session, status.session);
      currentProvider = status?.data?.instance?.provider || currentProvider;
      const instanceState = status?.data?.instance?.state || "unknown";
      lastProvisioningContext = formatProvisioningContext(status);
      if (instanceState !== lastInstanceState) {
        process.stderr.write(`[teleport-status] destination_state=${instanceState}\n`);
        lastInstanceState = instanceState;
      }
      if (instanceState === "running") {
        process.stderr.write("[teleport-status] failure_reason=\n");
        break;
      }
      if (["failed", "deleted", "deleting"].includes(instanceState)) {
        process.stderr.write(
          `[teleport-status] failure_reason=${managedRuntimeLabelTitle()} became unavailable while waiting for teleport readiness: ${lastProvisioningContext}.\n`
        );
        throw new Error(
          `${managedRuntimeLabelTitle()} became unavailable while waiting for teleport readiness: ${lastProvisioningContext}.`
        );
      }
      await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    }

    if (Date.now() >= deadline) {
      process.stderr.write(
        `[teleport-status] failure_reason=Timed out waiting for the ${managedRuntimeLabel()} to become ready after ${timeoutMs}ms (${lastProvisioningContext}).\n`
      );
      throw new Error(
        `Timed out waiting for the ${managedRuntimeLabel()} to become ready after ${timeoutMs}ms (${lastProvisioningContext}).`
      );
    }
  }
})().catch((error) => {
  process.stderr.write(
    `[teleport-status] failure_reason=${String(error instanceof Error ? error.message : error)}\n`
  );
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
  process.exit(1);
});
NODE
  )"; then
    exit 1
  fi

  TELEPORT_TRANSPORT="$(python3 - "$output" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
print(payload.get("transport") or "ssh")
PY
)"

  if [[ "$TELEPORT_TRANSPORT" == "e2b" ]]; then
    E2B_SANDBOX_ID="$(python3 - "$output" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
print(payload.get("sandbox_id", ""))
PY
)"
    E2B_TEMPLATE_ID="$(python3 - "$output" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
print(payload.get("template_id", ""))
PY
)"
    REMOTE_ROOT="$(python3 - "$output" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
print(payload.get("project_root") or payload.get("remote_root") or "")
PY
)"
    CONTROL_PLANE_ORIGIN="$(python3 - "$output" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
print(payload.get("control_plane_origin") or "")
PY
)"
    MACHINE_AUTH_TOKEN="$(python3 - "$output" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
print(payload.get("machine_auth_token") or "")
PY
)"
    if [[ -z "$E2B_SANDBOX_ID" || -z "$E2B_TEMPLATE_ID" || -z "$REMOTE_ROOT" ]]; then
      echo "[teleport-status] failure_reason=Managed teleport target did not include the E2B sandbox identity and project root required for sandbox cutover." >&2
      echo "[teleport] invalid managed target payload for E2B teleport" >&2
      exit 1
    fi
    return
  fi

  SSH_TARGET="$(python3 - "$output" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
print(payload.get("ssh_target", ""))
PY
)"
  REMOTE_ROOT="$(python3 - "$output" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
print(payload.get("project_root") or payload.get("remote_root") or "")
PY
)"

  if [[ -z "$SSH_TARGET" || -z "$REMOTE_ROOT" ]]; then
    echo "[teleport-status] failure_reason=Managed teleport target did not include the SSH target and project root required for SSH cutover." >&2
    echo "[teleport] invalid managed target payload for SSH teleport" >&2
    exit 1
  fi
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

if [[ "$USE_MANAGED_TARGET" -eq 1 ]]; then
  resolve_managed_target
fi

set_phase "preflight"
set_active_owner "local"
set_destination_state "unknown"
clear_failure_reason

ssh_run() {
  local -a cmd=(ssh)
  if (( ${#SSH_ARGS[@]} > 0 )); then
    cmd+=("${SSH_ARGS[@]}")
  fi
  cmd+=("$SSH_TARGET")
  cmd+=("$@")
  "${cmd[@]}"
}

remote_bash() {
  if [[ "$TELEPORT_TRANSPORT" == "e2b" ]]; then
    e2b_helper run-script --sandbox-id "$E2B_SANDBOX_ID" --cwd "/" -- bash -s -- "$@"
    return
  fi
  ssh_run bash -s -- "$@"
}

local_preflight() {
  require_cmd bun
  require_cmd python3
  if [[ "$TELEPORT_TRANSPORT" == "e2b" ]]; then
    require_cmd node
    require_cmd tar
    if [[ ! -f "$E2B_HELPER_PATH" ]]; then
      echo "[teleport] Missing E2B helper script: ${E2B_HELPER_PATH}" >&2
      exit 1
    fi
  else
    require_cmd ssh
    require_cmd rsync
  fi
  if [[ "$USE_MANAGED_TARGET" -eq 1 || "$TELEPORT_TRANSPORT" == "e2b" ]]; then
    require_cmd node
  fi

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

create_repo_archive() {
  local archive_base
  archive_base="$(mktemp "${TMPDIR:-/tmp}/superturtle-teleport.XXXXXX")"
  rm -f "$archive_base"
  local archive_path="${archive_base}.tar.gz"
  tar -czf "$archive_path" \
    --exclude ".DS_Store" \
    --exclude "node_modules" \
    --exclude ".venv" \
    --exclude "__pycache__" \
    --exclude ".pytest_cache" \
    --exclude ".mypy_cache" \
    --exclude ".next" \
    --exclude "dist" \
    --exclude "build" \
    --exclude ".turbo" \
    --exclude ".tmp" \
    --exclude "*.pyc" \
    -C "$REPO_ROOT" .
  printf '%s\n' "$archive_path"
}

create_relative_file_archive() {
  local source_path="$1"
  local relative_path="$2"
  local archive_base archive_path staging_dir target_dir
  archive_base="$(mktemp "${TMPDIR:-/tmp}/superturtle-teleport-auth.XXXXXX")"
  rm -f "$archive_base"
  archive_path="${archive_base}.tar.gz"
  staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/superturtle-teleport-auth-dir.XXXXXX")"
  target_dir="$(dirname "$relative_path")"
  mkdir -p "$staging_dir/$target_dir"
  cp "$source_path" "$staging_dir/$relative_path"
  tar -czf "$archive_path" -C "$staging_dir" .
  rm -rf "$staging_dir"
  printf '%s\n' "$archive_path"
}

discover_local_claude_access_token() {
  node <<'NODE'
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function extractToken(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";

  const candidates = [];
  try {
    const parsed = JSON.parse(trimmed);
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (
          typeof child === "string" &&
          ["accessToken", "access_token", "oauthAccessToken", "token"].includes(key)
        ) {
          candidates.push(child.trim());
        } else {
          visit(child);
        }
      }
    };
    visit(parsed);
  } catch {
    candidates.push(trimmed);
  }

  return candidates.find((candidate) => candidate.length > 0) || "";
}

function readTokenFromFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return "";
    return extractToken(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return "";
  }
}

const envCandidates = [
  process.env.SUPERTURTLE_TELEPORT_CLAUDE_ACCESS_TOKEN,
  process.env.SUPERTURTLE_CLAUDE_ACCESS_TOKEN,
  process.env.CLAUDE_CODE_OAUTH_TOKEN,
];
for (const candidate of envCandidates) {
  const token = extractToken(candidate);
  if (token) {
    process.stdout.write(token);
    process.exit(0);
  }
}

const user = process.env.USER || "unknown";
if (process.platform === "darwin") {
  const attempts = [
    ["security", ["find-generic-password", "-s", "Claude Code-credentials", "-a", user, "-w"]],
    ["security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]],
  ];
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { stdio: "pipe" });
    if (result.status === 0) {
      const token = extractToken(result.stdout.toString("utf-8"));
      if (token) {
        process.stdout.write(token);
        process.exit(0);
      }
    }
  }
}

if (process.platform === "linux" && spawnSync("sh", ["-c", "command -v secret-tool"], { stdio: "ignore" }).status === 0) {
  const attempts = [
    ["secret-tool", ["lookup", "service", "Claude Code-credentials", "username", user]],
    ["secret-tool", ["lookup", "service", "Claude Code-credentials"]],
  ];
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { stdio: "pipe" });
    if (result.status === 0) {
      const token = extractToken(result.stdout.toString("utf-8"));
      if (token) {
        process.stdout.write(token);
        process.exit(0);
      }
    }
  }
}

const home = process.env.HOME || "";
const fileCandidates = [
  process.env.SUPERTURTLE_TELEPORT_CLAUDE_CREDENTIALS_PATH,
  home ? path.resolve(home, ".config", "claude-code", "credentials.json") : "",
  home ? path.resolve(home, ".claude", "credentials.json") : "",
].filter(Boolean);
for (const filePath of fileCandidates) {
  const token = readTokenFromFile(filePath);
  if (token) {
    process.stdout.write(token);
    process.exit(0);
  }
}
NODE
}

e2b_sync_repo() {
  if (( DRY_RUN == 1 )); then
    echo "[teleport] dry-run: skipping sandbox archive upload"
    return
  fi

  local archive_path
  archive_path="$(create_repo_archive)"
  local remote_archive="/tmp/superturtle-teleport-${E2B_SANDBOX_ID}-${CURRENT_PHASE}.tar.gz"
  local status=0

  if ! e2b_helper sync-archive --sandbox-id "$E2B_SANDBOX_ID" --source "$archive_path" --remote-root "$REMOTE_ROOT" --archive-path "$remote_archive"; then
    status=$?
  fi

  rm -f "$archive_path"
  if (( status != 0 )); then
    return "$status"
  fi
}

bootstrap_e2b_codex_auth() {
  if [[ "$TELEPORT_TRANSPORT" != "e2b" ]]; then
    return
  fi

  if [[ ! -f "$CODEX_AUTH_SOURCE_PATH" ]]; then
    echo "[teleport] local Codex auth cache not found at ${CODEX_AUTH_SOURCE_PATH}; reusing any existing sandbox auth"
    return
  fi

  local archive_path
  archive_path="$(create_relative_file_archive "$CODEX_AUTH_SOURCE_PATH" ".codex/auth.json")"
  local remote_archive="/tmp/superturtle-codex-auth-${E2B_SANDBOX_ID}.tar.gz"
  local status=0

  echo "[teleport] bootstrapping local Codex auth into managed sandbox"
  set_phase "bootstrapping_remote_auth"
  if ! e2b_helper extract-archive --sandbox-id "$E2B_SANDBOX_ID" --source "$archive_path" --destination-root "$E2B_REMOTE_HOME" --archive-path "$remote_archive"; then
    status=$?
  fi
  rm -f "$archive_path"
  if (( status != 0 )); then
    return "$status"
  fi

  remote_bash "$E2B_REMOTE_HOME" <<'EOF'
set -euo pipefail
remote_home="$1"
mkdir -p "$remote_home/.codex"
chmod 700 "$remote_home/.codex"
if [[ -f "$remote_home/.codex/auth.json" ]]; then
  chmod 600 "$remote_home/.codex/auth.json"
fi
EOF
}

bootstrap_e2b_claude_auth() {
  if [[ "$TELEPORT_TRANSPORT" != "e2b" ]]; then
    return
  fi

  local claude_token=""
  claude_token="$(discover_local_claude_access_token)"
  if [[ -z "$claude_token" ]]; then
    if [[ -n "$CLAUDE_CREDENTIALS_SOURCE_PATH" ]]; then
      echo "[teleport] local Claude auth was not found at ${CLAUDE_CREDENTIALS_SOURCE_PATH}; reusing any existing sandbox auth"
    else
      echo "[teleport] local Claude auth was not found; reusing any existing sandbox auth"
    fi
    return
  fi

  local token_path archive_path remote_archive status
  token_path="$(mktemp "${TMPDIR:-/tmp}/superturtle-teleport-claude-token.XXXXXX")"
  printf '%s\n' "$claude_token" > "$token_path"
  archive_path="$(create_relative_file_archive "$token_path" ".superturtle/managed-runtime/claude-access-token.txt")"
  rm -f "$token_path"
  remote_archive="/tmp/superturtle-claude-auth-${E2B_SANDBOX_ID}.tar.gz"
  status=0

  echo "[teleport] bootstrapping local Claude auth into managed sandbox"
  set_phase "bootstrapping_remote_auth"
  if ! e2b_helper extract-archive --sandbox-id "$E2B_SANDBOX_ID" --source "$archive_path" --destination-root "$REMOTE_ROOT" --archive-path "$remote_archive"; then
    status=$?
  fi
  rm -f "$archive_path"
  if (( status != 0 )); then
    return "$status"
  fi
}

bootstrap_e2b_runtime() {
  if [[ "$TELEPORT_TRANSPORT" != "e2b" ]]; then
    return
  fi

  echo "[teleport] bootstrapping managed sandbox runtime"
  set_phase "bootstrapping_remote_runtime"
  remote_bash "$REMOTE_ROOT" "$E2B_REMOTE_HOME" "$CONTROL_PLANE_ORIGIN" "$MACHINE_AUTH_TOKEN" "$E2B_SANDBOX_ID" "$E2B_TEMPLATE_ID" "$MACHINE_HEARTBEAT_INTERVAL_SECONDS" "$MACHINE_HEARTBEAT_AUTOSTART" <<'EOF'
set -euo pipefail
remote_root="$1"
remote_home="$2"
control_plane_origin="$3"
machine_auth_token="$4"
sandbox_id="$5"
template_id="$6"
heartbeat_interval_seconds="$7"
heartbeat_autostart="$8"
managed_runtime_dir="$remote_root/.superturtle/managed-runtime"
env_file="$remote_root/.superturtle/.env"
claude_token_path="$managed_runtime_dir/claude-access-token.txt"

mkdir -p "$managed_runtime_dir"
mkdir -p "$(dirname "$env_file")"
touch "$env_file"
chmod 600 "$env_file"

python3 - "$env_file" "$remote_root" "$remote_home" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
remote_root = sys.argv[2]
remote_home = sys.argv[3]
allowed_paths = ",".join(
    [
        remote_root,
        f"{remote_home}/.claude",
        f"{remote_home}/.codex",
    ]
)
desired = {
    "CLAUDE_WORKING_DIR": remote_root,
    "ALLOWED_PATHS": allowed_paths,
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

if [[ -f "$claude_token_path" ]]; then
  python3 - "$env_file" "$claude_token_path" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
token_path = Path(sys.argv[2])
token = token_path.read_text().strip()
if not token:
    raise SystemExit("Missing Claude access token for sandbox bootstrap")

desired = {
    "CLAUDE_CODE_OAUTH_TOKEN": token,
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
  rm -f "$claude_token_path"
fi

mkdir -p "$remote_home/.claude" "$remote_home/.codex"
chmod 700 "$remote_home/.claude" "$remote_home/.codex"

sanitize_name() {
  printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9_-' '-' | sed -e 's/^-*//' -e 's/-*$//'
}

heartbeat_session_suffix="$(sanitize_name "${sandbox_id:-$(basename "$remote_root")}")"
heartbeat_session_suffix="${heartbeat_session_suffix:-default}"
heartbeat_session="superturtle-machine-heartbeat-${heartbeat_session_suffix}"
control_plane_env="$managed_runtime_dir/control-plane.env"
register_script="$managed_runtime_dir/superturtle-machine-register.sh"
heartbeat_script="$managed_runtime_dir/superturtle-machine-heartbeat.sh"
heartbeat_loop_script="$managed_runtime_dir/superturtle-machine-heartbeat-loop.sh"
heartbeat_start_script="$managed_runtime_dir/superturtle-machine-heartbeat-start.sh"

{
  printf 'CONTROL_PLANE_ORIGIN=%q\n' "$control_plane_origin"
  printf 'CONTROL_PLANE_REGISTER_URL=%q\n' "${control_plane_origin%/}/v1/machine/register"
  printf 'CONTROL_PLANE_HEARTBEAT_URL=%q\n' "${control_plane_origin%/}/v1/machine/heartbeat"
  printf 'MACHINE_AUTH_TOKEN=%q\n' "$machine_auth_token"
  printf 'SANDBOX_ID=%q\n' "$sandbox_id"
  printf 'TEMPLATE_ID=%q\n' "$template_id"
  printf 'MACHINE_HEARTBEAT_INTERVAL_SECONDS=%q\n' "$heartbeat_interval_seconds"
  printf 'MACHINE_HEARTBEAT_SESSION=%q\n' "$heartbeat_session"
} > "$control_plane_env"
chmod 600 "$control_plane_env"

cat > "$register_script" <<'EOF_REGISTER'
#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a
source "$script_dir/control-plane.env"
set +a
python3 - <<'PY'
import json
import os
import socket
import sys
import urllib.request

payload = {
    "hostname": socket.gethostname(),
    "sandbox_id": os.environ["SANDBOX_ID"],
    "template_id": os.environ["TEMPLATE_ID"],
}
request = urllib.request.Request(
    os.environ["CONTROL_PLANE_REGISTER_URL"],
    data=json.dumps(payload).encode("utf-8"),
    headers={
        "Authorization": f'Bearer {os.environ["MACHINE_AUTH_TOKEN"]}',
        "Content-Type": "application/json",
    },
    method="POST",
)
with urllib.request.urlopen(request, timeout=30) as response:
    sys.stdout.write(response.read().decode("utf-8"))
PY
EOF_REGISTER
chmod 700 "$register_script"

cat > "$heartbeat_script" <<'EOF_HEARTBEAT'
#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a
source "$script_dir/control-plane.env"
set +a
python3 - <<'PY'
import json
import os
import socket
import sys
import urllib.request

payload = {
    "hostname": socket.gethostname(),
    "sandbox_id": os.environ["SANDBOX_ID"],
    "template_id": os.environ["TEMPLATE_ID"],
    "health_status": "healthy",
}
request = urllib.request.Request(
    os.environ["CONTROL_PLANE_HEARTBEAT_URL"],
    data=json.dumps(payload).encode("utf-8"),
    headers={
        "Authorization": f'Bearer {os.environ["MACHINE_AUTH_TOKEN"]}',
        "Content-Type": "application/json",
    },
    method="POST",
)
with urllib.request.urlopen(request, timeout=30) as response:
    sys.stdout.write(response.read().decode("utf-8"))
PY
EOF_HEARTBEAT
chmod 700 "$heartbeat_script"

cat > "$heartbeat_loop_script" <<'EOF_HEARTBEAT_LOOP'
#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a
source "$script_dir/control-plane.env"
set +a

interval="${MACHINE_HEARTBEAT_INTERVAL_SECONDS:-30}"
if [[ ! "$interval" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid MACHINE_HEARTBEAT_INTERVAL_SECONDS: $interval" >&2
  exit 1
fi

log_path="$script_dir/superturtle-machine-heartbeat.log"
while true; do
  if ! "$script_dir/superturtle-machine-heartbeat.sh" >>"$log_path" 2>&1; then
    printf '[%s] machine heartbeat failed\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$log_path"
  fi
  sleep "$interval"
done
EOF_HEARTBEAT_LOOP
chmod 700 "$heartbeat_loop_script"

cat > "$heartbeat_start_script" <<'EOF_HEARTBEAT_START'
#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a
source "$script_dir/control-plane.env"
set +a

session_name="${MACHINE_HEARTBEAT_SESSION:-superturtle-machine-heartbeat-default}"
if tmux has-session -t "$session_name" 2>/dev/null; then
  exit 0
fi

tmux new-session -d -s "$session_name" "$script_dir/superturtle-machine-heartbeat-loop.sh"
EOF_HEARTBEAT_START
chmod 700 "$heartbeat_start_script"

if [[ -n "$control_plane_origin" && -n "$machine_auth_token" ]]; then
  "$register_script" >/dev/null
  "$heartbeat_script" >/dev/null
  if [[ "$heartbeat_autostart" == "1" ]]; then
    "$heartbeat_start_script" >/dev/null
  else
    echo "[teleport][remote] machine heartbeat autostart disabled; leaving helper scripts in place"
  fi
else
  echo "[teleport][remote] control-plane bootstrap token unavailable; skipping initial machine register/heartbeat"
fi
EOF
}

remote_preflight() {
  local active_driver="$1"
  local transport="$2"
  if [[ "$transport" == "e2b" ]]; then
    remote_bash "$REMOTE_ROOT" "$active_driver" <<'EOF'
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
require_cmd bun
require_cmd python3
require_cmd tmux
require_cmd tar

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
    return
  fi

  remote_bash "$REMOTE_ROOT" "$active_driver" <<'EOF'
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
require_cmd tar

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
  remote_bash "$REMOTE_ROOT" <<'EOF'
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
    LOCAL_BOT_STOPPED=1
  fi
}

restart_local_bot() {
  echo "[teleport] restarting local bot after failed cutover"
  (
    cd "$REPO_ROOT"
    node "$REPO_ROOT/super_turtle/bin/superturtle.js" start
  )
}

remote_import_runtime() {
  remote_bash "$REMOTE_ROOT" <<'EOF'
set -euo pipefail
remote_root="$1"
python3 "$remote_root/super_turtle/state/teleport_handoff.py" import --project-root "$remote_root"
EOF
}

start_remote_bot() {
  remote_bash "$REMOTE_ROOT" <<'EOF'
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
allowed_paths = ",".join(
    [
        remote_root,
        f"{home}/.claude",
        f"{home}/.codex",
    ]
)

desired = {
    "CLAUDE_WORKING_DIR": remote_root,
    "ALLOWED_PATHS": allowed_paths,
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

stop_remote_bot() {
  remote_bash "$REMOTE_ROOT" <<'EOF'
set -euo pipefail
remote_root="$1"
env_file="$remote_root/.superturtle/.env"
if [[ ! -f "$env_file" ]]; then
  exit 0
fi

python3 - "$env_file" "$remote_root" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
remote_root = sys.argv[2]
home = str(Path.home())
allowed_paths = ",".join(
    [
        remote_root,
        f"{home}/.claude",
        f"{home}/.codex",
    ]
)

desired = {
    "CLAUDE_WORKING_DIR": remote_root,
    "ALLOWED_PATHS": allowed_paths,
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
EOF
}

verify_remote_bot() {
  remote_bash "$REMOTE_ROOT" <<'EOF'
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
  remote_bash "$REMOTE_ROOT" "$message_b64" <<'EOF'
set -euo pipefail
remote_root="$1"
message_b64="$2"
message="$(printf '%s' "$message_b64" | base64 --decode)"
python3 "$remote_root/super_turtle/state/teleport_handoff.py" notify --project-root "$remote_root" --text "$message"
EOF
}

rollback_failed_cutover() {
  local exit_code="$1"
  if (( exit_code == 0 || DRY_RUN == 1 || LOCAL_BOT_STOPPED == 0 || REMOTE_RUNTIME_VERIFIED == 1 || ROLLBACK_ATTEMPTED == 1 )); then
    return
  fi

  ROLLBACK_ATTEMPTED=1
  set +e

  echo "[teleport] cutover failed during ${CURRENT_PHASE}; attempting rollback to local runtime"
  set_phase "rolling_back_local_runtime"
  set_active_owner "local"

  if (( REMOTE_START_ATTEMPTED == 1 )); then
    echo "[teleport] stopping remote bot before local rollback"
    if ! stop_remote_bot; then
      echo "[teleport] warning: failed to stop remote bot during rollback"
    fi
  fi

  if restart_local_bot; then
    set_destination_state "rollback_local_running"
    set_failure_reason "Teleport failed during ${CURRENT_PHASE}. Local bot restarted."
    echo "[teleport] rollback complete: local bot restarted"
    return
  fi

  set_destination_state "rollback_failed"
  set_failure_reason "Teleport failed during ${CURRENT_PHASE}. Local bot restart failed; manual recovery required."
  echo "[teleport] rollback failed: local bot did not restart"
}

run_transport_sync() {
  if [[ "$TELEPORT_TRANSPORT" == "e2b" ]]; then
    e2b_sync_repo
    return
  fi
  run_rsync
}

run_handoff_export() {
  local destination_label
  destination_label="$SSH_TARGET"
  if [[ "$TELEPORT_TRANSPORT" == "e2b" ]]; then
    destination_label="sandbox:${E2B_SANDBOX_ID}"
    run_python export --project-root "$REPO_ROOT" --remote-root "$REMOTE_ROOT" --transport "$TELEPORT_TRANSPORT" --destination-label "$destination_label" >/dev/null
    return
  fi
  run_python export --project-root "$REPO_ROOT" --remote-root "$REMOTE_ROOT" --transport "$TELEPORT_TRANSPORT" --destination-label "$destination_label" --ssh-target "$SSH_TARGET" >/dev/null
}

echo "[teleport] repo root: ${REPO_ROOT}"
if [[ "$TELEPORT_TRANSPORT" == "e2b" ]]; then
  echo "[teleport] managed sandbox: ${E2B_SANDBOX_ID}"
  echo "[teleport] template id: ${E2B_TEMPLATE_ID}"
  echo "[teleport] project root: ${REMOTE_ROOT}"
else
  echo "[teleport] ssh target: ${SSH_TARGET}"
  echo "[teleport] remote root: ${REMOTE_ROOT}"
fi

set_phase "local_preflight"
local_preflight

run_handoff_export
CONTEXT_FILE="${REPO_ROOT}/.superturtle/teleport/context.json"
TOKEN_PREFIX="$(read_json_field "$CONTEXT_FILE" "token_prefix")"
ACTIVE_DRIVER="$(read_json_field "$CONTEXT_FILE" "active_driver")"
ACTIVE_DRIVER="${ACTIVE_DRIVER:-claude}"
trap 'rollback_failed_cutover "$?"' EXIT

echo "[teleport] active driver: ${ACTIVE_DRIVER}"
set_phase "remote_preflight"
remote_preflight "$ACTIVE_DRIVER" "$TELEPORT_TRANSPORT"
bootstrap_e2b_codex_auth

echo "[teleport] initial sync"
set_phase "initial_sync"
run_transport_sync

if (( DRY_RUN == 1 )); then
  echo "[teleport] dry-run complete"
  set_phase "dry_run_complete"
  clear_failure_reason
  exit 0
fi

echo "[teleport] remote dependency install"
set_phase "remote_dependency_install"
remote_install_dependencies

stop_local_subturtles

echo "[teleport] exporting final handoff state"
set_phase "exporting_final_handoff"
run_handoff_export

stop_local_bot

echo "[teleport] final sync"
set_phase "final_sync"
run_transport_sync

if [[ "$TELEPORT_TRANSPORT" == "e2b" ]]; then
  echo "[teleport] restoring remote dependencies after final sandbox sync"
  set_phase "restoring_remote_dependencies"
  remote_install_dependencies
fi

bootstrap_e2b_claude_auth

bootstrap_e2b_runtime

echo "[teleport] importing portable runtime state on remote"
set_phase "importing_remote_state"
remote_import_runtime

echo "[teleport] starting remote bot"
set_phase "starting_remote_bot"
REMOTE_START_ATTEMPTED=1
start_remote_bot

echo "[teleport] verifying remote bot"
set_phase "verifying_remote_bot"
verify_remote_bot
REMOTE_RUNTIME_VERIFIED=1
set_active_owner "cloud"
set_destination_state "running"
clear_failure_reason

if [[ "$TELEPORT_TRANSPORT" == "e2b" ]]; then
  if ! send_remote_notification "Teleport complete. Super Turtle is now running on managed sandbox ${E2B_SANDBOX_ID}."; then
    echo "[teleport] warning: failed to write remote teleport completion notice"
  fi
else
  if ! send_remote_notification "Teleport complete. Super Turtle is now running on ${SSH_TARGET}."; then
    echo "[teleport] warning: failed to write remote teleport completion notice"
  fi
fi

echo "[teleport] success"
set_phase "complete"
