# Current task
Remove orchestrator code from `super_turtle/subturtle/ctl`: delete `build_orchestrator_prompt()` function, remove `--cron-mode` flag and its argument parsing, remove the orchestrator branch in `register_spawn_cron_job()`. Keep silent mode as the only supervision mode. Commit after each change.

# End goal with specs
Remove all orchestrator-mode code paths, the prompt file, related ctl flags, META_SHARED.md docs, and type definitions. The conductor handles all worker lifecycle management now.

IMPORTANT: Other SubTurtles are currently running and editing some of these files.
- fix-prompts may be editing META_SHARED.md and ORCHESTRATOR_PROMPT.md — do those files LAST
- fix-shell may be editing ctl — do ctl SECOND TO LAST
- fix-deadcode already removed ORCHESTRATOR_PROMPT from config.ts — that is done, skip it
Do the safe files first, then come back to the shared ones after checking git log to see if the other turtles committed.

# Roadmap (Completed)
- config.ts ORCHESTRATOR_PROMPT export already removed by fix-deadcode

# Roadmap (Upcoming)
- Full orchestrator removal

# Backlog
- [x] Remove `"orchestrator"` from `CronSupervisionMode` type in `super_turtle/claude-telegram-bot/src/cron.ts` (line ~17). Change to just `type CronSupervisionMode = "silent"`. Also remove any orchestrator-specific fields or branches in the CronJob interface or cron logic in that file.
- [x] Search entire `super_turtle/claude-telegram-bot/src/` for any remaining imports or references to `ORCHESTRATOR_PROMPT` or `orchestrator` mode — clean up any stale references (config.ts export is already removed)
- [ ] Remove orchestrator code from `super_turtle/subturtle/ctl`: delete `build_orchestrator_prompt()` function, remove `--cron-mode` flag and its argument parsing, remove the orchestrator branch in `register_spawn_cron_job()`. Keep silent mode as the only supervision mode. <- current
- [ ] Remove the "Full-auto overnight mode (orchestrator cron)" section from `super_turtle/meta/META_SHARED.md` (starts around line 348, the section with `--cron-mode orchestrator`). Check git log first to confirm fix-prompts has finished editing this file.
- [ ] Delete the file `super_turtle/meta/ORCHESTRATOR_PROMPT.md` entirely. Check git log first to confirm fix-prompts is done with it.
- [ ] Search for any remaining references to `orchestrator` across the repo (grep for "orchestrator" in .ts, .md, .sh, .py files) and clean up stale references. Skip review files in `reviews/`.
