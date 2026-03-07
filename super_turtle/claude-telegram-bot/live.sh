#!/usr/bin/env bash
set -uo pipefail

cd "$(dirname "$0")"

# Default CLAUDE_WORKING_DIR to repo root (two levels up from claude-telegram-bot/)
export CLAUDE_WORKING_DIR="${CLAUDE_WORKING_DIR:-$(cd ../.. && pwd)}"

# Load project env before deriving token/session/log names.
if [ -f "${CLAUDE_WORKING_DIR}/.superturtle/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "${CLAUDE_WORKING_DIR}/.superturtle/.env"
  set +a
elif [ -f .env ]; then
  echo "[live] WARNING: Using legacy .env in bot dir. Move it to \${CLAUDE_WORKING_DIR}/.superturtle/.env"
  set -a
  source .env
  set +a
fi

WINDOW_NAME="${SUPERTURTLE_TMUX_WINDOW:-bot}"
TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TOKEN_PREFIX="${TELEGRAM_TOKEN%%:*}"
TOKEN_PREFIX="${TOKEN_PREFIX:-default}"
TOKEN_PREFIX="$(echo "$TOKEN_PREFIX" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9_-' '-')"
TOKEN_PREFIX="${TOKEN_PREFIX#-}"
TOKEN_PREFIX="${TOKEN_PREFIX%-}"
TOKEN_PREFIX="${TOKEN_PREFIX:-default}"
PROJECT_SLUG="$(basename "$CLAUDE_WORKING_DIR" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9_-' '-')"
PROJECT_SLUG="${PROJECT_SLUG#-}"
PROJECT_SLUG="${PROJECT_SLUG%-}"
PROJECT_SLUG="${PROJECT_SLUG:-project}"
DEFAULT_SESSION_NAME="superturtle-${TOKEN_PREFIX}-${PROJECT_SLUG}"
SESSION_NAME="${SUPERTURTLE_TMUX_SESSION:-$DEFAULT_SESSION_NAME}"
LOOP_LOG_PATH="${SUPERTURTLE_LOOP_LOG_PATH:-/tmp/claude-telegram-${TOKEN_PREFIX}-bot-ts.log}"

# Platform-aware sleep prevention wrapper.
# macOS: caffeinate -s (prevent system sleep while process runs)
# Linux: systemd-inhibit (if available), otherwise run without sleep prevention
# Servers/CI: skip entirely — headless machines don't sleep
KEEP_AWAKE_CMD=""
case "$(uname -s)" in
  Darwin)
    if command -v caffeinate >/dev/null 2>&1; then
      KEEP_AWAKE_CMD="caffeinate -s"
    else
      echo "[live] WARNING: caffeinate not found on macOS. System may sleep during long runs."
    fi
    ;;
  Linux)
    if command -v systemd-inhibit >/dev/null 2>&1; then
      KEEP_AWAKE_CMD="systemd-inhibit --what=idle --who=superturtle --why='Bot running' --mode=block"
    else
      echo "[live] INFO: systemd-inhibit not found. Running without sleep prevention (OK for servers)."
    fi
    ;;
  *)
    echo "[live] INFO: Unknown OS ($(uname -s)). Running without sleep prevention."
    ;;
esac

RUN_CMD="cd \"$PWD\" && export CLAUDE_WORKING_DIR=\"$CLAUDE_WORKING_DIR\" && export SUPERTURTLE_RUN_LOOP=1 && export SUPERTURTLE_LOOP_LOG_PATH=\"$LOOP_LOG_PATH\" && ${KEEP_AWAKE_CMD:+$KEEP_AWAKE_CMD }./run-loop.sh 2>&1 | tee -a \"$LOOP_LOG_PATH\""

if ! command -v tmux >/dev/null 2>&1; then
  echo "[live] ERROR: tmux is required."
  echo "  macOS:  brew install tmux"
  echo "  Ubuntu: sudo apt install tmux"
  echo "  Fedora: sudo dnf install tmux"
  exit 1
fi

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "[live] Reusing session: $SESSION_NAME"
else
  echo "[live] Creating session: $SESSION_NAME"
  tmux new-session -d -s "$SESSION_NAME" -n "$WINDOW_NAME" "$RUN_CMD"
fi

if [[ -n "${TMUX:-}" ]]; then
  exec tmux switch-client -t "$SESSION_NAME"
fi

exec tmux attach -t "$SESSION_NAME"
