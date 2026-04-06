#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PKG_ROOT}"

PACK_JSON="$(npm pack --json --silent)"
TARBALL="$(node -e 'const data = JSON.parse(process.argv[1]); process.stdout.write(data[0].filename);' "${PACK_JSON}")"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TMP_DIR}"
  rm -f "${PKG_ROOT}/${TARBALL}"
}
trap cleanup EXIT

tar -xzf "${TARBALL}" -C "${TMP_DIR}"
PACKAGE_DIR="${TMP_DIR}/package"
PROJECT_DIR_RAW="${TMP_DIR}/project"
STUB_DIR="${TMP_DIR}/stubs"
mkdir -p "${PROJECT_DIR_RAW}" "${STUB_DIR}"
git init -q "${PROJECT_DIR_RAW}"
PROJECT_DIR="$(cd "${PROJECT_DIR_RAW}" && pwd -P)"

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

chmod +x "${STUB_DIR}/bun" "${STUB_DIR}/tmux"

LEGACY_ENV_PATH="${PACKAGE_DIR}/claude-telegram-bot/.env"
cat > "${LEGACY_ENV_PATH}" <<EOF
TELEGRAM_BOT_TOKEN=123456:legacy-token
TELEGRAM_ALLOWED_USERS=424242
SUPER_TURTLE_PROJECT_DIR=${PROJECT_DIR}
OPENAI_API_KEY=legacy-openai-key
EOF

(
  cd "${PROJECT_DIR}"
  PATH="${STUB_DIR}:${PATH}" node "${PACKAGE_DIR}/bin/superturtle.js" init
)

if [[ ! -f "${PROJECT_DIR}/.superturtle/.env" ]]; then
  echo "Expected imported .superturtle/.env to be created." >&2
  exit 1
fi

if [[ ! -f "${LEGACY_ENV_PATH}" ]]; then
  echo "Expected legacy claude-telegram-bot/.env to remain in place." >&2
  exit 1
fi

if ! cmp -s "${LEGACY_ENV_PATH}" "${PROJECT_DIR}/.superturtle/.env"; then
  echo "Expected imported .superturtle/.env to match the legacy env contents." >&2
  exit 1
fi

echo "legacy env import smoke test passed"
