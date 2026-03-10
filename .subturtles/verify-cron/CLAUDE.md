# Current task
Grep for callers of `addJob(` to verify they match the new signature (no chat_id param).

# End goal with specs
Confirm no remaining chat_id references in cron job context that should have been removed. Confirm backward compatibility with old cron-jobs.json files. Confirm typecheck and cron-related tests pass.

# Roadmap (Completed)
- chat_id removal committed

# Roadmap (Upcoming)
- Verify the removal is complete and correct

# Backlog
- [x] Run `git show --stat HEAD` and `git diff HEAD~1` to understand the change
- [x] Grep for remaining `chat_id` references in cron.ts, conductor-maintenance.ts, dashboard-types.ts, dashboard/data.ts
- Grep for callers of `addJob(` to verify they match the new signature (no chat_id param) <- current
- Run `bun run --bun tsc --noEmit` in `super_turtle/claude-telegram-bot/` to verify typecheck
- Run `bun test src/cron.test.ts src/conductor-maintenance.test.ts src/conductor-core-flow.test.ts src/conductor-supervisor.test.ts src/handlers/commands.test.ts` in `super_turtle/claude-telegram-bot/` to verify tests pass
- Write a ## Verification Result section in this CLAUDE.md with PASS or FAIL and details
