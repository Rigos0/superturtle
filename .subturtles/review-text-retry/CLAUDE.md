## Current Task
All backlog items complete; append loop-control STOP after commit.

## End Goal with Specs
Create `.subturtles/review-text-retry/review-notes.md` with ranked findings about retry safety, ask-user prompt preservation, cleanup side effects, and interaction with streaming state.

## Backlog
- [x] Inspect `handleText()` error/retry flow and compare old vs new cleanup behavior
- [x] Verify whether `cleanupToolMessages()` deletes messages that should persist (e.g. ask-user prompt)
- [x] Check idempotency across repeated retries and stale sessions
- [x] Write findings with file/line references in `review-notes.md`
- [x] Commit review notes

## Notes
Review-only task focused on correctness and UX regressions.

## Loop Control
STOP
