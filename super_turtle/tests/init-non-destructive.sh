#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLI_PATH="${PKG_ROOT}/bin/superturtle.js"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

PROJECT_DIR="${TMP_DIR}/project"
STUB_DIR="${TMP_DIR}/stubs"
mkdir -p "${PROJECT_DIR}/.claude" "${STUB_DIR}"

cat > "${STUB_DIR}/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
  echo "1.3.5"
  exit 0
fi
if [[ "${1:-}" == "install" ]]; then
  exit 0
fi
echo "unexpected bun args: $*" >&2
exit 1
EOF

cat > "${STUB_DIR}/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "-V" ]]; then
  echo "tmux 3.4"
  exit 0
fi
echo "unexpected tmux args: $*" >&2
exit 1
EOF

cat > "${STUB_DIR}/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
  echo "claude 1.0.0"
  exit 0
fi
exit 0
EOF

chmod +x "${STUB_DIR}/bun" "${STUB_DIR}/tmux" "${STUB_DIR}/claude"

cat > "${PROJECT_DIR}/CLAUDE.md" <<'EOF'
USER CLAUDE FILE
EOF

cat > "${PROJECT_DIR}/AGENTS.md" <<'EOF'
USER AGENTS FILE
EOF

cat > "${PROJECT_DIR}/.claude/custom-user-file.txt" <<'EOF'
KEEP THIS
EOF

(
  cd "${PROJECT_DIR}"
  PATH="${STUB_DIR}:${PATH}" node "${CLI_PATH}" init --token "123456:token" --user "424242"
)

if [[ "$(cat "${PROJECT_DIR}/CLAUDE.md")" != "USER CLAUDE FILE" ]]; then
  echo "Expected existing CLAUDE.md to remain unchanged." >&2
  exit 1
fi

if [[ "$(cat "${PROJECT_DIR}/AGENTS.md")" != "USER AGENTS FILE" ]]; then
  echo "Expected existing AGENTS.md to remain unchanged." >&2
  exit 1
fi

if [[ "$(cat "${PROJECT_DIR}/.claude/custom-user-file.txt")" != "KEEP THIS" ]]; then
  echo "Expected existing .claude contents to remain unchanged." >&2
  exit 1
fi

if [[ ! -d "${PROJECT_DIR}/.superturtle-claude" ]]; then
  echo "Expected fallback .superturtle-claude directory when .claude already exists." >&2
  exit 1
fi

if [[ ! -f "${PROJECT_DIR}/.superturtle-claude/settings.json" ]]; then
  echo "Expected template files to be copied into .superturtle-claude." >&2
  exit 1
fi

if [[ ! -f "${PROJECT_DIR}/.superturtle/.env" ]]; then
  echo "Expected .superturtle/.env to be created." >&2
  exit 1
fi

if ! grep -q '^TELEGRAM_BOT_TOKEN=123456:token$' "${PROJECT_DIR}/.superturtle/.env"; then
  echo "Expected TELEGRAM_BOT_TOKEN in .superturtle/.env." >&2
  exit 1
fi

if ! grep -q '^TELEGRAM_ALLOWED_USERS=424242$' "${PROJECT_DIR}/.superturtle/.env"; then
  echo "Expected TELEGRAM_ALLOWED_USERS in .superturtle/.env." >&2
  exit 1
fi

echo "init non-destructive smoke test passed"
