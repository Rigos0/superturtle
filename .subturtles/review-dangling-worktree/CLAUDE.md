## Current Task
Backlog complete: review notes produced with commit/include-exclude guidance.

## End Goal with Specs
Write `.subturtles/review-dangling-worktree/review-notes.md` listing what should be committed now vs excluded/restored, with risk level and rationale.

## Backlog
- [x] Inspect `git status --short` and `git diff --stat`
- [x] Classify changed files into intentional feature changes vs likely workspace artifacts
- [x] Flag risky deletions (especially `.subturtles/*` state/history files)
- [x] Produce actionable commit-scope recommendation in `review-notes.md`
- [x] Commit review notes

## Notes
No production code edits required unless adding minimal guardrails/tests that support the review claim.

## Loop Control
STOP
