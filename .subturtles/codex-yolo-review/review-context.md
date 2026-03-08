# Review Context

Captured on `dev` from the local workspace before deeper review passes.

## Branch baseline

- `main` / `origin/main`: `57602f5` (`release: v0.2.0`)
- `HEAD`: `006c243` (`fix(codex): avoid bootstrap reinjection on resume`)
- Local commits above `main`:
  - `474bcf9` `Add dashboard visual review findings`
  - `006c243` `fix(codex): avoid bootstrap reinjection on resume`

## Dirty workspace inventory

`git status --short` at capture time:

- `D .subturtles/review-dashboard-visuals/CLAUDE.md`
- `D .subturtles/review-dashboard-visuals/review.md`
- `M super_turtle/claude-telegram-bot/src/config.ts`
- `M super_turtle/claude-telegram-bot/src/dashboard.test.ts`
- `M super_turtle/claude-telegram-bot/src/dashboard.ts`
- `M super_turtle/claude-telegram-bot/src/injected-artifacts.ts`
- `M super_turtle/subturtle/claude-md-guard/validate.sh`
- `M super_turtle/subturtle/ctl`
- `M super_turtle/subturtle/tests/smoke_spawn_status.sh`
- `M super_turtle/subturtle/tests/test_ctl_integration.sh`
- `?? super_turtle/meta/CODEX_TELEGRAM_BOOTSTRAP.md`

## Dirty workspace groupings

### Dashboard / bot runtime

- `super_turtle/claude-telegram-bot/src/dashboard.ts`
- `super_turtle/claude-telegram-bot/src/dashboard.test.ts`
- `super_turtle/claude-telegram-bot/src/config.ts`
- `super_turtle/claude-telegram-bot/src/injected-artifacts.ts`

Why this matters:
- Touches dashboard rendering, injected artifacts, and configuration paths.
- Likely review areas: observability regressions, unsafe rendering, route behavior, and config coupling.

### SubTurtle orchestration / guardrails

- `super_turtle/subturtle/ctl`
- `super_turtle/subturtle/claude-md-guard/validate.sh`
- `super_turtle/subturtle/tests/smoke_spawn_status.sh`
- `super_turtle/subturtle/tests/test_ctl_integration.sh`
- `super_turtle/meta/CODEX_TELEGRAM_BOOTSTRAP.md`

Why this matters:
- Touches worker control flow, CLAUDE state validation, bootstrap prompting, and shell/integration coverage.
- Likely review areas: process isolation, failure visibility, shell portability, and test realism.

### Deleted archived review artifacts

- `.subturtles/review-dashboard-visuals/CLAUDE.md`
- `.subturtles/review-dashboard-visuals/review.md`

Why this matters:
- These are not runtime files, but they change the historical review trail and should be treated as separate from product code risk.

## Landed commit context

### `474bcf9` `Add dashboard visual review findings`

Files:
- `.subturtles/review-dashboard-visuals/CLAUDE.md`
- `.subturtles/review-dashboard-visuals/review.md`

Review implication:
- This is prior review output only. It does not change runtime behavior but it establishes already-reported dashboard risks.

### `006c243` `fix(codex): avoid bootstrap reinjection on resume`

Files:
- `super_turtle/claude-telegram-bot/src/codex-session.ts`
- `super_turtle/claude-telegram-bot/src/codex-session.test.ts`
- `super_turtle/claude-telegram-bot/src/session-observability.ts`

Review implication:
- This landed resume/bootstrap fix is adjacent to session lifecycle and observability behavior even though it is not part of the current dirty diff.
- When reviewing runtime/session lifecycle changes, compare current workspace behavior against this recent fix to avoid reintroducing resume-state regressions.

## Review order derived from context

1. `dashboard.ts` and `dashboard.test.ts`
2. `ctl`, `validate.sh`, and the integration/smoke tests
3. `config.ts`, `injected-artifacts.ts`, and the new bootstrap prompt file
4. Archived review-file deletions only after runtime-risk areas are covered
