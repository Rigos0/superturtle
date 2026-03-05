# Dangling Worktree Review (2026-03-05)

## Snapshot
- `git status --short` shows 22 changed paths: 3 bot handler edits, 1 archived state-file edit, and 18 deletions under `.subturtles/*`.
- `git diff --stat` reports `132 insertions(+), 487 deletions(-)`; deletions are almost entirely `.subturtles` state/history files.
- Validation run for code-side candidates: `bun run typecheck` (pass) and `bun test src/handlers/streaming.test.ts` (13 pass).

## Classification

### Commit now (intentional feature change) — Risk: Medium
1. `super_turtle/claude-telegram-bot/src/handlers/streaming.ts`
- Adds heartbeat/status UX and safer Telegram message cleanup/error filtering.
2. `super_turtle/claude-telegram-bot/src/handlers/text.ts`
- Reuses shared `cleanupToolMessages()` for retry cleanup consistency.
3. `super_turtle/claude-telegram-bot/src/handlers/streaming.test.ts`
- Adds regression coverage for benign `deleteMessage` errors.

Rationale: these files are coherent with current streaming/STOP observability work and have passing local typecheck + targeted tests.

### Exclude/restore before any feature commit — Risk: High
1. `.subturtles/.archive/tolkien/CLAUDE.md` (modified)
- Archived loop state churn; unrelated to Telegram bot runtime changes.
2. Deleted `.subturtles/*` state/history files:
- `.subturtles/api-observability-fixes/CLAUDE.md`
- `.subturtles/asimov/CLAUDE.md`
- `.subturtles/dash-cron-session/CLAUDE.md`
- `.subturtles/dash-foundation/CLAUDE.md`
- `.subturtles/dashboard-api-links/CLAUDE.md`
- `.subturtles/dashboard-html-links/CLAUDE.md`
- `.subturtles/factbot/CLAUDE.md`
- `.subturtles/hemingway/CLAUDE.md`
- `.subturtles/poet/CLAUDE.md`
- `.subturtles/review-bot/CLAUDE.md`
- `.subturtles/review-bot/review-notes.md`
- `.subturtles/review-infra/CLAUDE.md`
- `.subturtles/review-infra/review-notes.md`
- `.subturtles/test-alpha/CLAUDE.md`
- `.subturtles/test-alpha/review-notes.md`
- `.subturtles/test-beta/CLAUDE.md`
- `.subturtles/test-beta/review-notes.md`
- `.subturtles/tolkien/CLAUDE.md`

Rationale: broad cross-loop deletion pattern strongly indicates accidental workspace cleanup; committing would destroy audit/history artifacts and interfere with parallel loop continuity.

## Recommended commit scope commands

```bash
# 1) Restore accidental state-file churn/deletions
git restore \
  .subturtles/.archive/tolkien/CLAUDE.md \
  .subturtles/api-observability-fixes/CLAUDE.md \
  .subturtles/asimov/CLAUDE.md \
  .subturtles/dash-cron-session/CLAUDE.md \
  .subturtles/dash-foundation/CLAUDE.md \
  .subturtles/dashboard-api-links/CLAUDE.md \
  .subturtles/dashboard-html-links/CLAUDE.md \
  .subturtles/factbot/CLAUDE.md \
  .subturtles/hemingway/CLAUDE.md \
  .subturtles/poet/CLAUDE.md \
  .subturtles/review-bot/CLAUDE.md \
  .subturtles/review-bot/review-notes.md \
  .subturtles/review-infra/CLAUDE.md \
  .subturtles/review-infra/review-notes.md \
  .subturtles/test-alpha/CLAUDE.md \
  .subturtles/test-alpha/review-notes.md \
  .subturtles/test-beta/CLAUDE.md \
  .subturtles/test-beta/review-notes.md \
  .subturtles/tolkien/CLAUDE.md

# 2) Stage only intentional runtime changes
git add \
  super_turtle/claude-telegram-bot/src/handlers/streaming.ts \
  super_turtle/claude-telegram-bot/src/handlers/text.ts \
  super_turtle/claude-telegram-bot/src/handlers/streaming.test.ts

# 3) Commit
git commit -m "Improve streaming heartbeat UX and harden tool-message cleanup"
```
