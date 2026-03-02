## Current Task
Show repost count on original post (next to reactions and comments count).

## End Goal with Specs
Items 21-22 from Phase 2: Users can repost to their feed with optional commentary. Original post shows repost count.

## Backlog
- [x] Add `reposts` table to Convex schema: `linkedin-demo/src/convex/schema.ts` — fields: userId, originalPostId, commentary (optional string), createdAt
- [x] Create `linkedin-demo/src/convex/reposts.ts` — mutations: repostPost(postId, commentary?), removeRepost(repostId); queries: getRepostCount(postId), getUserRepost(postId)
- [x] Add "Repost" button to post footer in `linkedin-demo/src/components/posts/post/Post.js` (next to Like and Comment)
- [x] Repost dialog — small modal with optional commentary text field + "Repost" button
- [ ] Show repost count on original post (next to reactions and comments count) <- current
- [ ] Reposted posts appear in feed with "X reposted" header and original post embedded
- [ ] Run `cd linkedin-demo && npx convex dev --once` to push schema
- [ ] Test and commit

## Notes
- Follow existing patterns in likes.ts and comments.ts for mutation structure
- Feed query is in `linkedin-demo/src/convex/posts.ts` — listPosts query
- Post footer actions are in Post.js around line 490+
