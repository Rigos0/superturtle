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
require_file "__init__.py"
require_file "subturtle/ctl"
require_file "subturtle/__init__.py"
require_file "subturtle/subturtle_loop/__init__.py"
require_file "state/run_state_writer.py"
require_file "state/__init__.py"
require_file "meta/META_SHARED.md"
require_file "claude-telegram-bot/src/index.ts"
require_file "README.md"
require_file "LICENSE"

if find "${PACKAGE_DIR}/claude-telegram-bot/src" -name "*.test.ts" -print -quit | grep -q .; then
  echo "Package should not contain TypeScript test files under claude-telegram-bot/src." >&2
  exit 1
fi

node "${PACKAGE_DIR}/bin/superturtle.js" --help >/dev/null

(
  cd "${PACKAGE_DIR}"
  env -u PYTHONPATH python3 - <<'PY'
import subturtle.__main__
import subturtle.loops
import subturtle.prompts
import subturtle.statefile
PY
  env -u PYTHONPATH python3 -m subturtle --help >/dev/null
  env -u PYTHONPATH python3 state/run_state_writer.py --help >/dev/null
)

node -e '
const fs = require("fs");
const [rootPath, botPath] = process.argv.slice(1);
const root = JSON.parse(fs.readFileSync(rootPath, "utf-8"));
const bot = JSON.parse(fs.readFileSync(botPath, "utf-8"));
const rootDeps = root.dependencies || {};
const botDeps = bot.dependencies || {};
const missing = [];
const mismatched = [];

for (const [name, version] of Object.entries(botDeps)) {
  if (!(name in rootDeps)) {
    missing.push(`${name}@${version}`);
    continue;
  }
  if (rootDeps[name] !== version) {
    mismatched.push(`${name}: root=${rootDeps[name]} bot=${version}`);
  }
}

if (missing.length || mismatched.length) {
  if (missing.length) {
    console.error("Root package.json is missing bot runtime deps:");
    for (const dep of missing) console.error(`  - ${dep}`);
  }
  if (mismatched.length) {
    console.error("Root/package bot dependency versions diverged:");
    for (const item of mismatched) console.error(`  - ${item}`);
  }
  process.exit(1);
}
' "${PACKAGE_DIR}/package.json" "${PACKAGE_DIR}/claude-telegram-bot/package.json"

echo "npm package smoke test passed (${TARBALL})"
