## Current Task
Create `linkedin-demo/src/convex/bookmarks.ts` with toggle/query logic for bookmarks.

## End Goal with Specs
Item 33 from Phase 2: Users can bookmark posts and access them from a "Saved" section.
- Bookmark icon button on each post (next to like/comment/repost)
- Toggle bookmark on/off
- "Saved" tab or page accessible from profile or navigation
- Saved posts listed in reverse chronological order

## Backlog
- [x] Add `bookmarks` table to schema (`linkedin-demo/src/convex/schema.ts`) — userId, postId, createdAt. Index by userId.
- [ ] Create `linkedin-demo/src/convex/bookmarks.ts` — mutations: toggleBookmark(postId); queries: isBookmarked(postId), getUserBookmarks() <- current
- [ ] Add bookmark button to post footer in `linkedin-demo/src/components/posts/post/Post.js` — filled/outline icon toggle
- [ ] Create `linkedin-demo/src/components/bookmarks/SavedPosts.js` — page listing all bookmarked posts
- [ ] Add `/saved` route in App.js and link from profile or sidebar
- [ ] Run `cd linkedin-demo && npx convex dev --once` to push schema
- [ ] Test and commit

## Notes
- Post footer actions: `linkedin-demo/src/components/posts/post/Post.js` around line 490+
- Schema: `linkedin-demo/src/convex/schema.ts`
- Router: `linkedin-demo/src/App.js`
- Follow existing patterns in likes.ts for toggle mutations
