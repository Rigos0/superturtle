## Current Task
Update all components to import from shared modules instead of defining locally.

## End Goal with Specs
All duplicated helpers (resolvePhoto, resolveUserPhotoURL, buildAuthorSummary, REACTION_ITEMS) extracted into shared files. Each utility defined once, imported everywhere.

## Backlog
- [x] Create `linkedin-demo/src/utils/photo.js` — extract `resolvePhoto(url)` and `resolveUserPhotoURL(user)` helpers. Currently duplicated in: Post.js, HashtagFeed.js, SavedPosts.js, ArticleView.js, Network.js, Messaging.js, Profile.js
- [x] Create `linkedin-demo/src/utils/reactions.js` — extract `REACTION_ITEMS` constant. Currently duplicated in Post.js and ArticleView.js.
- [x] Create `linkedin-demo/src/convex/helpers.ts` — extract `resolveUserPhotoURL` and `buildAuthorSummary` server-side helpers. Currently duplicated in bookmarks.ts, articles.ts, posts.ts.
- [ ] Update all components to import from shared modules instead of defining locally <- current
- [ ] Update all Convex functions to import from shared helpers
- [ ] Verify no unused local copies remain (grep for old function definitions)
- [ ] Test build: `cd linkedin-demo && npm run build`
- [ ] Run `cd linkedin-demo && npx convex dev --once` to verify Convex functions still work
- [ ] Commit

## Notes
- Client-side shared utils go in `linkedin-demo/src/utils/`
- Server-side (Convex) shared helpers go in `linkedin-demo/src/convex/helpers.ts`
- resolvePhoto pattern: takes URL string, returns Convex storage URL or fallback
- REACTION_ITEMS: array of {type, emoji, label} objects for the 5 reaction types
- buildAuthorSummary: takes user doc, returns {displayName, photoURL, username}
- Be careful with Convex imports — server-side code uses different import paths than client
