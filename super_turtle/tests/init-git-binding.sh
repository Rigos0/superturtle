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

ROOT_REPO_RAW="${TMP_DIR}/repo"
SUBDIR_RAW="${ROOT_REPO_RAW}/nested/worktree"
NO_GIT_DIR_RAW="${TMP_DIR}/plain-dir"
STUB_DIR="${TMP_DIR}/stubs"
mkdir -p "${SUBDIR_RAW}" "${NO_GIT_DIR_RAW}" "${STUB_DIR}"
git init -q "${ROOT_REPO_RAW}"
ROOT_REPO="$(cd "${ROOT_REPO_RAW}" && pwd -P)"
SUBDIR="$(cd "${SUBDIR_RAW}" && pwd -P)"
NO_GIT_DIR="$(cd "${NO_GIT_DIR_RAW}" && pwd -P)"

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

SUBDIR_OUTPUT="$(
  cd "${SUBDIR}"
  PATH="${STUB_DIR}:${PATH}" node "${CLI_PATH}" init --token "123456:token" --user "424242"
)"

if [[ ! -f "${ROOT_REPO}/.superturtle/project.json" ]]; then
  echo "Expected project binding at repo root." >&2
  exit 1
fi

if [[ -e "${SUBDIR}/.superturtle" ]]; then
  echo "Did not expect .superturtle to be created inside the subdirectory." >&2
  exit 1
fi

if ! grep -q "^SUPER_TURTLE_PROJECT_DIR=${ROOT_REPO}$" "${ROOT_REPO}/.superturtle/.env"; then
  echo "Expected SUPER_TURTLE_PROJECT_DIR to point at the repo root." >&2
  exit 1
fi

if ! grep -q "Init was run from subfolder ${SUBDIR}" <<<"${SUBDIR_OUTPUT}"; then
  echo "Expected init output to mention the subfolder invocation." >&2
  exit 1
fi

if ! grep -q "Teleport and sync scope will be the full repo rooted at ${ROOT_REPO}" <<<"${SUBDIR_OUTPUT}"; then
  echo "Expected init output to explain the repo-wide sync scope." >&2
  exit 1
fi

set +e
NO_GIT_OUTPUT="$(
  cd "${NO_GIT_DIR}"
  PATH="${STUB_DIR}:${PATH}" node "${CLI_PATH}" init --token "123456:token" --user "424242" 2>&1
)"
NO_GIT_STATUS=$?
set -e

if [[ ${NO_GIT_STATUS} -eq 0 ]]; then
  echo "Expected init without git to fail by default." >&2
  exit 1
fi

if ! grep -q "No Git repository found" <<<"${NO_GIT_OUTPUT}"; then
  echo "Expected init failure to explain the missing Git repo." >&2
  exit 1
fi

CREATE_GIT_OUTPUT="$(
  cd "${NO_GIT_DIR}"
  PATH="${STUB_DIR}:${PATH}" node "${CLI_PATH}" init --create-git --token "123456:token" --user "424242"
)"

if [[ ! -e "${NO_GIT_DIR}/.git" ]]; then
  echo "Expected --create-git to initialize a Git repo." >&2
  exit 1
fi

if ! grep -q "created via --create-git" <<<"${CREATE_GIT_OUTPUT}"; then
  echo "Expected init output to mention explicit Git creation." >&2
  exit 1
fi

echo "init git binding smoke test passed"
