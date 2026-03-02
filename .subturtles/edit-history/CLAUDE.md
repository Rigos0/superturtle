## Current Task
Create `linkedin-demo/src/components/posts/editHistory/EditHistoryDialog.js` — dialog listing previous versions with timestamps.

## End Goal with Specs
Item 35 from Phase 2: When a post is edited, show "Edited" indicator. Users can view previous versions.
- "Edited" badge appears next to timestamp on edited posts
- Clicking "Edited" opens a dialog showing edit history (previous versions with timestamps)
- Store edit history in a separate table or as array on post
- Each edit saves the previous version before overwriting

## Backlog
- [x] Add `postEdits` table to schema (`linkedin-demo/src/convex/schema.ts`) — postId, previousDescription, editedAt. Index by postId.
- [x] Update editPost mutation in `linkedin-demo/src/convex/posts.ts` — before overwriting description, save previous version to postEdits table. Set `isEdited: true` on post.
- [x] Add `isEdited` boolean field to posts schema
- [x] Create `linkedin-demo/src/convex/postEdits.ts` — query: getEditHistory(postId) returns all previous versions ordered by editedAt desc
- [x] Show "Edited" badge in Post.js next to timestamp — small text, clickable
- [ ] Create `linkedin-demo/src/components/posts/editHistory/EditHistoryDialog.js` — dialog listing previous versions with timestamps <- current
- [ ] Run `cd linkedin-demo && npx convex dev --once` to push schema
- [ ] Test and commit

## Notes
- Post component: `linkedin-demo/src/components/posts/post/Post.js`
- Posts mutations: `linkedin-demo/src/convex/posts.ts` — editPost mutation
- Schema: `linkedin-demo/src/convex/schema.ts`
