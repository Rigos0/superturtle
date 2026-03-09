# Current task
All backlog items complete

# End goal with specs
- `subturtle/__main__.py` no longer contains all prompts, parsing, loop orchestration, and state helpers in one file.
- Prompt templates, state-file utilities, and loop execution plumbing are split into dedicated modules under `subturtle/`.
- CLI flags and runtime behavior for `slow`, `yolo`, `yolo-codex`, and `yolo-codex-spark` remain compatible.
- Existing Python tests for subturtle continue to pass.
- Module interfaces are explicit and maintainable for future loop/conductor changes.

# Roadmap (Completed)
- Identified `__main__.py` as ~900 lines with mixed concerns.
- Confirmed prompt blocks and helper functions are clear extraction candidates.
- Confirmed runtime imports need to support both monorepo and packaged usage paths.

# Roadmap (Upcoming)
- Extract prompt templates/builders into `subturtle/prompts.py`.
- Extract state-file parsing/validation helpers into `subturtle/statefile.py`.
- Extract loop run helpers into module(s) used by `__main__.py`.
- Keep `__main__.py` as CLI entrypoint + high-level orchestration.
- Run Python subturtle tests and fix any import/behavior regressions.

# Backlog
- [x] Create new Python modules for prompts and wire them from `__main__.py` first
- [x] Extract state-file helper functions into a dedicated module with tests kept green
- [x] Extract loop helper/orchestration utilities into module(s) with minimal API surface
- [x] Reduce `__main__.py` to argument parsing and top-level control flow
- [x] Run `subturtle` Python tests and address refactor regressions
- [x] Clean imports/type hints/docstrings after extraction for readability
- [x] Confirm packaged and monorepo import paths both still work

## Loop Control
STOP
