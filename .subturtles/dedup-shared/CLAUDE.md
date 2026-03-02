## Current Task
Run `cd linkedin-demo && npx convex dev --once` to verify Convex functions still work

## End Goal with Specs
All duplicated helpers (resolvePhoto, resolveUserPhotoURL, buildAuthorSummary, REACTION_ITEMS) extracted into shared files. Each utility defined once, imported everywhere.

## Backlog
- [x] Create `linkedin-demo/src/utils/photo.js` — extract `resolvePhoto(url)` and `resolveUserPhotoURL(user)` helpers. Currently duplicated in: Post.js, HashtagFeed.js, SavedPosts.js, ArticleView.js, Network.js, Messaging.js, Profile.js
- [x] Create `linkedin-demo/src/utils/reactions.js` — extract `REACTION_ITEMS` constant. Currently duplicated in Post.js and ArticleView.js.
- [x] Create `linkedin-demo/src/convex/helpers.ts` — extract `resolveUserPhotoURL` and `buildAuthorSummary` server-side helpers. Currently duplicated in bookmarks.ts, articles.ts, posts.ts.
- [x] Update all components to import from shared modules instead of defining locally
- [x] Update all Convex functions to import from shared helpers
- [x] Verify no unused local copies remain (grep for old function definitions)
- [x] Test build: `cd linkedin-demo && npm run build`
- [ ] Run `cd linkedin-demo && npx convex dev --once` to verify Convex functions still work <- current
- [ ] Commit

## Notes
- 2026-03-02: Shared photo helper import migration is complete across components; `npm run build` passes.
- 2026-03-02: Convex helper migration completed in `users.ts`, `comments.ts`, `hashtags.ts`, `messaging.ts`, `notifications.ts`, and `connections.ts`; author/photo helpers now import from `src/convex/helpers.ts`.
- 2026-03-02: `cd linkedin-demo && npm run build` passes after helper migration.
- 2026-03-02: Verified with `rg` that local definitions of `resolvePhoto`, `resolveUserPhotoURL`, `buildAuthorSummary`, and `REACTION_ITEMS` only remain in shared helper files.
- Client-side shared utils go in `linkedin-demo/src/utils/`
- Server-side (Convex) shared helpers go in `linkedin-demo/src/convex/helpers.ts`
- resolvePhoto pattern: takes URL string, returns Convex storage URL or fallback
- REACTION_ITEMS: array of {type, emoji, label} objects for the 5 reaction types
- buildAuthorSummary: takes user doc, returns {displayName, photoURL, username}
- Be careful with Convex imports — server-side code uses different import paths than client
