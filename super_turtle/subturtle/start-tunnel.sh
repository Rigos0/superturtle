#!/bin/bash
set -euo pipefail

# start-tunnel.sh — Start dev server + cloudflared tunnel, write URL to .tunnel-url
#
# Usage:
#   ./start-tunnel.sh <project-dir> [port] [workspace-dir]
#
# Args:
#   project-dir    — Root of the project (where npm run dev runs)
#   port           — Dev server port (default: 3000)
#   workspace-dir  — SubTurtle workspace (where .tunnel-url is written). If not provided,
#                    uses cwd as the workspace directory
#
# Output:
#   Prints the tunnel URL to stdout
#   Writes the URL to workspace-dir/.tunnel-url
#   Keeps tunnel + dev server running in the background
#
# Cleanup:
#   When this script is killed or exits, child processes (dev server + tunnel) are terminated.

PROJECT_DIR="${1:?project-dir required}"
PORT="${2:-3000}"
WORKSPACE_DIR="${3:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${SUPER_TURTLE_PROJECT_DIR:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[start-tunnel] ERROR: required command not found: ${cmd}" >&2
    exit 1
  fi
}

is_within_root() {
  local path="$1"
  case "$path" in
    "$ROOT_DIR" | "$ROOT_DIR"/*) return 0 ;;
    *) return 1 ;;
  esac
}

for cmd in npm curl cloudflared grep head mktemp; do
  require_cmd "$cmd"
done

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "[start-tunnel] ERROR: invalid port '${PORT}'. Expected integer in range 1-65535." >&2
  exit 1
fi

# Resolve to absolute paths.
# Keep both project/workspace paths inside repository root to avoid accidental
# serving or writing outside the agent workspace tree.
if [[ ! -d "$PROJECT_DIR" ]]; then
  ARCHIVE_PROJECT_DIR="${ROOT_DIR}/.superturtle/subturtles/.archive/${PROJECT_DIR}"
  if [[ -d "$ARCHIVE_PROJECT_DIR" ]]; then
    echo "[start-tunnel] INFO: project-dir '${PROJECT_DIR}' not found in cwd; using archived workspace '${ARCHIVE_PROJECT_DIR}'."
    PROJECT_DIR="$ARCHIVE_PROJECT_DIR"
  else
    echo "[start-tunnel] ERROR: project-dir '${PROJECT_DIR}' does not exist." >&2
    exit 1
  fi
fi
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd -P)"
WORKSPACE_DIR="$(cd "$WORKSPACE_DIR" && pwd -P)"

if ! is_within_root "$PROJECT_DIR"; then
  echo "[start-tunnel] ERROR: project-dir must be within repository root (${ROOT_DIR})." >&2
  exit 1
fi
if ! is_within_root "$WORKSPACE_DIR"; then
  echo "[start-tunnel] ERROR: workspace-dir must be within repository root (${ROOT_DIR})." >&2
  exit 1
fi
if [[ ! -w "$WORKSPACE_DIR" ]]; then
  echo "[start-tunnel] ERROR: workspace-dir is not writable: ${WORKSPACE_DIR}" >&2
  exit 1
fi

TUNNEL_URL_FILE="${WORKSPACE_DIR}/.tunnel-url"
rm -f "$TUNNEL_URL_FILE"

# PIDs to track for cleanup
DEV_PID=""
TUNNEL_PID=""
TUNNEL_OUTPUT=""

# Cleanup function: kill tracked processes
cleanup() {
  local exit_code=$?
  if [[ -n "$TUNNEL_OUTPUT" ]] && [[ -f "$TUNNEL_OUTPUT" ]]; then
    rm -f "$TUNNEL_OUTPUT"
  fi
  rm -f "$TUNNEL_URL_FILE"
  if [[ -n "$DEV_PID" ]]; then
    kill -TERM "$DEV_PID" 2>/dev/null || true
    sleep 0.2
    kill -9 "$DEV_PID" 2>/dev/null || true
  fi
  if [[ -n "$TUNNEL_PID" ]]; then
    kill -TERM "$TUNNEL_PID" 2>/dev/null || true
    sleep 0.2
    kill -9 "$TUNNEL_PID" 2>/dev/null || true
  fi
  exit $exit_code
}

# Set trap to run cleanup on EXIT, INT, TERM
trap cleanup EXIT INT TERM

echo "[start-tunnel] Starting npm dev server in ${PROJECT_DIR}:${PORT}..."
cd "$PROJECT_DIR"
npm run dev > /dev/null 2>&1 &
DEV_PID=$!

# Wait for dev server to be ready (poll with timeout)
echo "[start-tunnel] Waiting for dev server to be ready at http://localhost:${PORT}..."
WAIT_TIMEOUT=30
WAIT_START=$(date +%s)
while ! curl -s "http://localhost:${PORT}" > /dev/null 2>&1; do
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    echo "[start-tunnel] ERROR: dev server exited before becoming ready" >&2
    exit 1
  fi
  WAIT_ELAPSED=$(($(date +%s) - WAIT_START))
  if (( WAIT_ELAPSED >= WAIT_TIMEOUT )); then
    echo "[start-tunnel] ERROR: dev server did not respond after ${WAIT_TIMEOUT}s" >&2
    exit 1
  fi
  sleep 0.5
done
echo "[start-tunnel] Dev server ready!"

# Start cloudflared tunnel, capture URL from stderr
echo "[start-tunnel] Starting cloudflared tunnel..."
TUNNEL_OUTPUT=$(mktemp)

cloudflared tunnel --url "http://localhost:${PORT}" > /dev/null 2> "$TUNNEL_OUTPUT" &
TUNNEL_PID=$!

# Wait for tunnel to be ready and extract URL from stderr
# cloudflared outputs: "Your quick tunnel has been created! Opening browser to ... https://xxx.trycloudflare.com"
TUNNEL_WAIT_TIMEOUT=10
TUNNEL_WAIT_START=$(date +%s)
TUNNEL_URL=""
while [[ -z "$TUNNEL_URL" ]] && kill -0 "$TUNNEL_PID" 2>/dev/null; do
  TUNNEL_WAIT_ELAPSED=$(($(date +%s) - TUNNEL_WAIT_START))
  if (( TUNNEL_WAIT_ELAPSED >= TUNNEL_WAIT_TIMEOUT )); then
    echo "[start-tunnel] ERROR: cloudflared did not produce URL after ${TUNNEL_WAIT_TIMEOUT}s" >&2
    exit 1
  fi
  # Extract URL from the output file (cloudflared writes to stderr)
  # Pattern: https://xxxx.trycloudflare.com
  TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$TUNNEL_OUTPUT" | head -1 || echo "")
  if [[ -z "$TUNNEL_URL" ]]; then
    sleep 0.2
  fi
done

if [[ -z "$TUNNEL_URL" ]]; then
  echo "[start-tunnel] ERROR: failed to extract tunnel URL" >&2
  exit 1
fi

# Write URL to workspace file and stdout
umask 077
printf '%s\n' "$TUNNEL_URL" > "$TUNNEL_URL_FILE"
echo "[start-tunnel] Tunnel started! URL written to ${TUNNEL_URL_FILE}"
echo "$TUNNEL_URL"

# Keep the script running to maintain the trap handler.
# The polling loop below monitors both children directly.
while kill -0 "$DEV_PID" 2>/dev/null && kill -0 "$TUNNEL_PID" 2>/dev/null; do
  sleep 1
done

# If we get here, one of the processes died unexpectedly
if ! kill -0 "$DEV_PID" 2>/dev/null; then
  echo "[start-tunnel] Dev server died unexpectedly" >&2
  exit 1
fi
if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
  echo "[start-tunnel] Tunnel died unexpectedly" >&2
  exit 1
fi
