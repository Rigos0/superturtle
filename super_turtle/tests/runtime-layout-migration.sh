#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
PROJECT_DIR="${TMP_DIR}/project"
trap 'rm -rf "${TMP_DIR}"' EXIT

mkdir -p "${PROJECT_DIR}/.git"
mkdir -p "${PROJECT_DIR}/.superturtle"
mkdir -p "${PROJECT_DIR}/.subturtles/worker-a"
mkdir -p "${PROJECT_DIR}/-s/.superturtle/teleport/runtime-import"

cat > "${PROJECT_DIR}/.superturtle/.env" <<EOF
TELEGRAM_BOT_TOKEN=123456:test-token
TELEGRAM_ALLOWED_USERS=424242
SUPER_TURTLE_PROJECT_DIR=${PROJECT_DIR}
EOF

cat > "${PROJECT_DIR}/.subturtles/worker-a/CLAUDE.md" <<'EOF'
# Current task
- migrate workspace layout
EOF

cat > "${PROJECT_DIR}/-s/.superturtle/teleport/context.json" <<'EOF'
{"ok":true}
EOF

cat > "${PROJECT_DIR}/-s/.superturtle/teleport/runtime-import/turn-log.jsonl" <<'EOF'
{"event":"imported"}
EOF

SUPER_TURTLE_PROJECT_DIR="${PROJECT_DIR}" "${ROOT_DIR}/super_turtle/subturtle/ctl" list >/dev/null

test ! -e "${PROJECT_DIR}/.subturtles"
test ! -e "${PROJECT_DIR}/-s/.superturtle/teleport"
test -f "${PROJECT_DIR}/.superturtle/subturtles/worker-a/CLAUDE.md"
test -f "${PROJECT_DIR}/.superturtle/teleport/context.json"
test -f "${PROJECT_DIR}/.superturtle/teleport/runtime-import/turn-log.jsonl"

echo "runtime layout migration test passed"
