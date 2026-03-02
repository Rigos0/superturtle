## Current Task
Add visibility toggle to post composer (Public vs Connections Only).

## End Goal with Specs
Items 26-30 from Phase 2: Post visibility (public/connections only), feed algorithm (Recent/Top/Following), follow system, infinite scroll pagination.

## Backlog
- [x] Add `visibility` field to posts schema (`linkedin-demo/src/convex/schema.ts`) — "public" | "connections" default "public"
- [ ] Add visibility toggle to post composer (`linkedin-demo/src/components/posts/postMaker/PostMaker.js`) — dropdown/switch: Public or Connections Only <- current
- [ ] Filter posts by visibility in listPosts query (`linkedin-demo/src/convex/posts.ts`) — connections-only posts visible only to author's connections
- [ ] Add `follows` table to schema — followerId, followedId, createdAt. Indexed by both.
- [ ] Create `linkedin-demo/src/convex/follows.ts` — followUser, unfollowUser, getFollowerCount, getFollowingCount, isFollowing queries/mutations
- [ ] Add Follow button to profile page and user cards (alongside Connect button)
- [ ] Feed sort tabs — Recent (default, by createdAt), Top (most reactions+comments), Following (only from connections+followed users)
- [ ] Add feed sort UI — tabs or dropdown above feed in `linkedin-demo/src/App.js` or feed component
- [ ] Pagination — load 10 posts at a time in listPosts, add "Load more" button or infinite scroll with intersection observer
- [ ] Run `cd linkedin-demo && npx convex dev --once` to push schema
- [ ] Test and commit

## Notes
- Posts query: `linkedin-demo/src/convex/posts.ts` listPosts
- Connections system already exists in `linkedin-demo/src/convex/connections.ts`
- Feed rendering in App.js around the posts map area
