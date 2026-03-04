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

require_file() {
  local rel="$1"
  if [[ ! -f "${PACKAGE_DIR}/${rel}" ]]; then
    echo "Missing required packaged file: ${rel}" >&2
    exit 1
  fi
}

require_file "bin/superturtle.js"
require_file "subturtle/ctl"
require_file "state/run_state_writer.py"
require_file "meta/META_SHARED.md"
require_file "claude-telegram-bot/src/index.ts"
require_file "README.md"
require_file "LICENSE"

if find "${PACKAGE_DIR}/claude-telegram-bot/src" -name "*.test.ts" -print -quit | grep -q .; then
  echo "Package should not contain TypeScript test files under claude-telegram-bot/src." >&2
  exit 1
fi

node "${PACKAGE_DIR}/bin/superturtle.js" --help >/dev/null

echo "npm package smoke test passed (${TARBALL})"
