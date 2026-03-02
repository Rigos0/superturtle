## Current Task
Add test: Bookmark toggle — use Convex client to bookmark a post (`bookmarks:toggleBookmark`), verify `bookmarks:isBookmarked` returns true, toggle again to unbookmark.

## End Goal with Specs
E2E test coverage for the Phase 2 batch 2 features currently being built. These tests should be written now so they're ready when features ship. Tests run against `https://linkedin-demo-iota.vercel.app`. Use Convex HTTP client for backend-level assertions where UI may not be fully deployed yet.

## Backlog
- [x] Read existing test patterns in `linkedin-demo/e2e/core.spec.ts` — understand ConvexHttpClient usage, createTextPost, cleanup patterns
- [x] Add test: Poll creation and voting — use Convex client to create poll post, vote on option, verify results (via `polls:getPoll`, `polls:getResults`, `polls:vote`)
- [x] Add test: Article creation — use Convex client to create article post, verify it has articleTitle and articleBody fields
- [ ] Add test: Bookmark toggle — use Convex client to bookmark a post (`bookmarks:toggleBookmark`), verify `bookmarks:isBookmarked` returns true, toggle again to unbookmark <- current
- [ ] Add test: Report post — use Convex client to report a post (`reports:reportPost`), verify `reports:hasReported` returns true, verify duplicate report is prevented
- [ ] Add test: Edit history — use Convex client to create post, edit it (`posts:editPost`), verify `postEdits:getEditHistory` returns previous version
- [ ] Add UI smoke tests: if features are deployed, verify poll UI renders in feed, article page loads at `/article/:id`, bookmark icon appears on posts, report option in post menu, "Edited" badge on edited posts
- [x] Run tests: `cd linkedin-demo && npx playwright test e2e/phase2-new.spec.ts`
- [x] Commit

## Notes
- All tests go in a NEW file: `linkedin-demo/e2e/phase2-new.spec.ts`
- Use `loginAsGuest(page)` from `./helpers` for auth
- ConvexHttpClient URL: `https://tough-mosquito-145.convex.cloud`
- These features are being built RIGHT NOW by other SubTurtles — the Convex functions may or may not exist yet
- Strategy: try Convex client calls, if the function doesn't exist yet, `test.skip()` with message "Function not yet deployed"
- Wrap each Convex call in try/catch and skip gracefully on 404/not-found errors
- DO NOT modify existing test files — only create new ones
- Clean up any test data created (delete posts, etc.) in `finally` blocks
