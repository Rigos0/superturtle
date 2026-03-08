# Current task
All prompt/doc backlog items are complete. Append `## Loop Control` / `STOP` after committing this final fix.

# End goal with specs
Fix 4 straightforward prompt/doc issues. Each fix = one commit.

# Roadmap (Completed)
- Nothing yet

# Roadmap (Upcoming)
- Quick-win meta prompt fixes from code review

# Backlog
- [x] Fix #23: super_turtle/meta/META_SHARED.md line ~387 — replace "Use `getUsageLines()` (Claude Code usage) and `getCodexQuotaLines()` (Codex usage) as the decision inputs." with "The output includes Claude Code usage and Codex quota data — use those numbers as the decision inputs for the matrix below." These are internal TS functions the meta agent can't call.
- [x] Fix #24: super_turtle/meta/META_SHARED.md lines ~494-496 — add `silent` (boolean, optional, defaults to false) to the cron job field list. It's missing from the documentation but exists in the CronJob interface.
- [x] Fix #22: super_turtle/meta/claude-meta line 34 — change `--append-system-prompt` to `--system-prompt` for consistency with the bot (session.ts line 549 uses `--system-prompt`). META_SHARED.md is designed to be self-contained.
- [x] Fix Codex-meta#3: super_turtle/meta/META_SHARED.md — find where it says agents can directly edit `.superturtle/cron-jobs.json` and add a note that manual JSON edits should only be used for recovery/debug. Normal scheduling should go through `ctl spawn` (which auto-registers cron) or the CronCreate/CronDelete tools.
- [x] Fix Codex-meta#1 (partial): super_turtle/meta/ORCHESTRATOR_PROMPT.md — add a note in step 1 that says "Also check conductor worker state at `.superturtle/state/workers/<name>.json` for canonical lifecycle state, checkpoint signatures, and terminal outcomes." This doesn't rewrite the whole prompt but makes it conductor-aware.

## Loop Control
STOP
