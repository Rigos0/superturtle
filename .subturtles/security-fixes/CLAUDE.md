## Current Task
Fix `linkedin-demo/src/convex/posts.ts` deletePost auth check — verify `post.authorId === getAuthUserId(ctx)` before deleting.

## End Goal with Specs
All Convex mutations properly authenticate the calling user and reject unauthorized operations. No mutation should trust client-supplied userId.

## Backlog
- [x] Fix `linkedin-demo/src/convex/posts.ts` createPost (line ~337): use `getAuthUserId(ctx)` instead of trusting `args.authorId`. Reject if mismatch. Keep guest user fallback working (guests can still create posts if the app allows).
- [ ] Fix `linkedin-demo/src/convex/posts.ts` deletePost (line ~431): add auth check — verify `post.authorId === getAuthUserId(ctx)` before deleting <- current
- [ ] Fix `linkedin-demo/src/convex/posts.ts` updatePost (line ~445): add auth check — verify `existingPost.authorId === getAuthUserId(ctx)` before editing
- [ ] Fix `linkedin-demo/src/convex/likes.ts` toggleLike (line ~35): use `getAuthUserId(ctx)` instead of `args.userId`
- [ ] Fix `linkedin-demo/src/convex/likes.ts` setReaction + removeReaction (line ~82): same auth fix
- [ ] Fix `linkedin-demo/src/convex/articles.ts` getArticle: add visibility check for connections-only articles
- [ ] Fix `linkedin-demo/src/convex/postEdits.ts` getEditHistory: consider access control (at minimum, don't expose edits of connections-only posts to non-connections)
- [ ] Wire poll creation: `linkedin-demo/src/components/form/Form.js` line ~196-262 — pollDraft data is never sent to backend. After createPost, call `polls:createPoll` with postId + poll data
- [ ] Run `cd linkedin-demo && npx convex dev --once` to push fixes
- [ ] Test build passes: `cd linkedin-demo && npm run build`
- [ ] Commit

## Notes
- Auth helper: `getAuthUserId(ctx)` from `@convex-dev/auth/server`
- Guest users: the app supports anonymous/guest browsing — mutations should handle `userId === null` gracefully (return early or throw)
- Schema: `linkedin-demo/src/convex/schema.ts`
- The app uses `@convex-dev/auth` for auth — check existing patterns in `linkedin-demo/src/convex/connections.ts` or `linkedin-demo/src/convex/messaging.ts` for how they do auth checks
