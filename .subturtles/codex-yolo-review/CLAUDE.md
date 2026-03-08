# Current task
Review SubTurtle orchestration changes for isolation regressions using the collected workspace context in `review-context.md`.

# End goal with specs
Produce an actionable review report that prioritizes high-severity issues, includes file/line references, identifies missing tests, and avoids broad stylistic feedback.

# Roadmap (Completed)
- Confirmed review scope is the local repository working state.
- Prepared a dedicated SubTurtle workspace and state contract.

# Roadmap (Upcoming)
- Inspect git diff and recent commits to identify changed areas.
- Review high-risk paths first (process supervision, handlers, session control, logging).
- Validate behavioral expectations against existing tests.
- Summarize findings by severity with precise file/line references.

# Backlog
- [x] Collect changed files and commit context
- [x] Review runtime/session lifecycle changes for crash or stall risks
- [x] Review observability and logging paths for missing failure signals
- [ ] Review SubTurtle orchestration changes for isolation regressions <- current
- [ ] Identify missing or insufficient automated tests
- [ ] Draft concise findings report for Super Turtle
