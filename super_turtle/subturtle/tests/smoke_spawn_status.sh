#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CTL="${ROOT_DIR}/super_turtle/subturtle/ctl"
NAME="smoke-status-$(date +%s)"
WORK_DIR="${ROOT_DIR}/.subturtles/${NAME}"
TMP_DIR="$(mktemp -d)"
TMP_STATE="${TMP_DIR}/CLAUDE.md"
FAKE_BIN_DIR="${TMP_DIR}/bin"
STATE_FILE="${TMP_STATE}"

cleanup() {
  trap - EXIT
  if [ -f "${WORK_DIR}/subturtle.pid" ]; then
    "${CTL}" stop "${NAME}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TMP_DIR}"
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

mkdir -p "${FAKE_BIN_DIR}"
mkdir -p "$(dirname "${STATE_FILE}")"
cat > "${STATE_FILE}" <<'STATE'
# Current task

spawn/status smoke test

# End goal with specs
- Verify spawn/status works end-to-end.

# Roadmap (Completed)
- Prepared fake Codex CLI.

# Roadmap (Upcoming)
- Spawn the worker.
- Check status output.

# Backlog
- [x] 1. Prepare fake Codex CLI
- [x] 2. Seed the worker state
- [ ] 3. Verify process is running <- current
- [ ] 4. Stop the worker cleanly
- [ ] 5. Confirm status reports not running
STATE

cat > "${FAKE_BIN_DIR}/codex" <<'SH'
#!/usr/bin/env bash
echo "[fake codex] $*" >&2
exit 0
SH
chmod +x "${FAKE_BIN_DIR}/codex"

export PATH="${FAKE_BIN_DIR}:$PATH"

cd "${ROOT_DIR}"

printf '[smoke] spawning %s...\n' "${NAME}"
"${CTL}" spawn "${NAME}" --type yolo-codex --timeout 2m --state-file "${STATE_FILE}"

for _ in $(seq 1 20); do
  if "${CTL}" status "${NAME}" | grep -q "running as"; then
    echo "[smoke] status check: running"
    break
  fi
  sleep 0.5
done

if ! "${CTL}" status "${NAME}" | grep -q "running as"; then
  echo "[smoke] spawn status check failed" >&2
  exit 1
fi

"${CTL}" stop "${NAME}" >/dev/null
if ! "${CTL}" status "${NAME}" | grep -q "not running"; then
  echo "[smoke] stop status check failed" >&2
  exit 1
fi

echo "[smoke] pass"
