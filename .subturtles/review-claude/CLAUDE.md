# Current task
Review `super_turtle/meta/` — prompt files for inconsistencies or stale references. Append findings to `reviews/claude-review.md`.

# End goal with specs
A concise review document listing the biggest issues found across the codebase that would be straightforward to fix. Focus on:
- Bugs (logic errors, race conditions, unhandled edge cases)
- Security issues (exposed secrets, missing validation, injection risks)
- Dead code or unused imports that add confusion
- Obvious performance problems
- Error handling gaps that would cause silent failures

DO NOT fix anything. Only report findings. Each finding should include: file path, line range, what the issue is, and a one-liner on how to fix it.

Skip nitpicks, style issues, and minor refactors. Only report issues where the impact is significant and the fix is straightforward (< 30 min of work each).

# Roadmap (Completed)
- Nothing yet

# Roadmap (Upcoming)
- Code review sweep of the full Super Turtle codebase

# Backlog
- [x] Review `super_turtle/claude-telegram-bot/src/` — all TypeScript source files (10 findings)
- [x] Review `super_turtle/subturtle/` — Python loop runner, ctl CLI, helpers (10 findings)
- [ ] Review `super_turtle/meta/` — prompt files for inconsistencies or stale references <- current
- [ ] Review root config files (CLAUDE.md, package.json, tsconfig, etc.)
- [ ] Write final `reviews/claude-review.md` with prioritized findings
- [ ] Commit the review file
