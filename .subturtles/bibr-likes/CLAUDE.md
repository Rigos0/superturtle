## Current Task
Create `linkedin-demo/src/convex/comments.ts`: export `addComment` mutation (args: postId, authorId, body). Inserts into comments table with createdAt = Date.now(), increments `commentsCount` on the post. Export `listComments` query (args: postId) that returns all comments for a post sorted by createdAt asc, with author info joined from users table.

## End Goal with Specs
- `likes` table with userId + postId (enforce uniqueness in mutation)
- `toggleLike` mutation — inserts or deletes a like
- `comments` table: postId, authorId, body, createdAt
- `addComment` mutation, `listComments` query (by postId)
- Like/comment counts update reactively in listPosts query
- All pushed to Convex cloud

## Backlog
- [x] Update schema at `linkedin-demo/src/convex/schema.ts`: add `likes` table with fields { userId: v.id("users"), postId: v.id("posts") } and `comments` table with fields { postId: v.id("posts"), authorId: v.id("users"), body: v.string(), createdAt: v.number() }
- [x] Create `linkedin-demo/src/convex/likes.ts`: export `toggleLike` mutation (args: userId, postId). Check if a like exists for this user+post pair using `ctx.db.query("likes").filter(...)`. If exists, delete it and decrement `likesCount` on the post. If not, insert and increment `likesCount`. Also export `getLikeStatus` query (args: userId, postId) that returns boolean.
- [ ] Create `linkedin-demo/src/convex/comments.ts`: export `addComment` mutation (args: postId, authorId, body). Inserts into comments table with createdAt = Date.now(), increments `commentsCount` on the post. Export `listComments` query (args: postId) that returns all comments for a post sorted by createdAt asc, with author info joined from users table. <- current
- [ ] Update `listPosts` in `linkedin-demo/src/convex/posts.ts`: for each post, also query the likes table to get the actual count (or keep using the denormalized likesCount field — either way ensure consistency)
- [ ] Run `cd linkedin-demo && npx convex dev --once` to push all new functions
- [ ] Run `cd linkedin-demo && npm run build` to verify no import errors
- [ ] Commit with message "Add likes and comments tables with mutations and queries"

## Notes
- All Convex function files are in `linkedin-demo/src/convex/` (NOT `linkedin-demo/convex/`)
- Import patterns: `import { query, mutation } from "./_generated/server"` and `import { v } from "convex/values"`
- The posts table already has `likesCount` and `commentsCount` fields (numbers) — use these as denormalized counters, update them in the toggle/add mutations
- For `toggleLike`, use `ctx.db.query("likes").filter(q => q.and(q.eq(q.field("userId"), args.userId), q.eq(q.field("postId"), args.postId))).first()` to check existence
- To update a post's count: `ctx.db.patch(args.postId, { likesCount: post.likesCount + 1 })`
- Run all npm/convex commands from the `linkedin-demo/` directory
