# Current task
All backlog items complete; stopping loop

# End goal with specs
- `subturtle/ctl` becomes a compact command dispatcher with shared initialization.
- Large helper/command blocks are moved into `subturtle/lib/*.sh` (or similar) with clear responsibilities.
- Existing CLI behavior and output format for `start/spawn/stop/status/logs/list/archive/gc/reschedule-cron` are preserved.
- Existing integration/smoke tests continue to pass.
- Refactor is auditable: no hidden behavior changes beyond import/path-safe restructuring.

# Roadmap (Completed)
- Identified `ctl` as a 1500+ line mixed script with parsing, state IO, and command handlers combined.
- Confirmed `ctl` already has internal function boundaries suitable for extraction.
- Confirmed spawn/start contract requires prewritten `CLAUDE.md` and should not be changed.

# Roadmap (Upcoming)
- Define module split (`env`, `state`, `conductor`, `commands`) and stable function interfaces.
- Move shared helpers first, then command handlers one-by-one.
- Keep strict `set -euo pipefail` semantics and shellcheck-friendly patterns.
- Re-run integration scripts and adjust only for path/source correctness.
- Leave codebase with cleaner ownership for future conductor/dashboard work.

# Backlog
- [x] Create shell module files and source wiring from `ctl` without behavior changes
- [x] Move shared path/meta/time/parse helpers into a shared lib module
- [x] Move conductor/run-state writer helpers into dedicated module
- [x] Move command handlers into command modules and keep dispatcher in `ctl`
- [x] Verify command output parity for key flows (`spawn`, `stop`, `list`, `status`)
- [x] Run `subturtle` integration/smoke tests and fix extraction regressions
- [x] Trim duplicated logic and add concise comments only where flow is non-obvious

## Loop Control
STOP
