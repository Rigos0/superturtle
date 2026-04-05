#!/bin/bash
set -uo pipefail

# Restart loop for the Telegram bot.
# Exit code 0 = intentional restart (e.g. /restart command) → re-launch.
# Any other exit code = real crash or Ctrl+C → stop.

cd "$(dirname "$0")"

reload_env() {
    # Re-source the project env before every bot start so /restart picks up
    # connector/runtime changes written after the run-loop shell first booted.
    if [ -n "${CLAUDE_WORKING_DIR:-}" ] && [ -f "${CLAUDE_WORKING_DIR}/.superturtle/.env" ]; then
        set -a
        source "${CLAUDE_WORKING_DIR}/.superturtle/.env"
        set +a
    elif [ -f .env ]; then
        echo "[run-loop] WARNING: Using legacy .env in bot dir. Move it to \${CLAUDE_WORKING_DIR}/.superturtle/.env"
        set -a
        source .env
        set +a
    fi
}

while true; do
    reload_env
    echo "[run-loop] Starting bot in $(pwd)..."
    bun run src/index.ts
    EXIT_CODE=$?

    if [ "$EXIT_CODE" -eq 0 ]; then
        echo "[run-loop] Bot exited with code 0 — restarting in 1s..."
        sleep 1
    elif [ "$EXIT_CODE" -eq 130 ] || [ "$EXIT_CODE" -eq 129 ] || [ "$EXIT_CODE" -eq 143 ]; then
        echo "[run-loop] Bot exited with code $EXIT_CODE from an interrupt/termination signal — stopping."
        exit "$EXIT_CODE"
    elif [ "${SUPERTURTLE_RESTART_ON_CRASH:-0}" = "1" ]; then
        echo "[run-loop] Bot exited with code $EXIT_CODE — restarting in 3s because SUPERTURTLE_RESTART_ON_CRASH=1."
        sleep 3
    else
        echo "[run-loop] Bot exited with code $EXIT_CODE — stopping."
        exit "$EXIT_CODE"
    fi
done
