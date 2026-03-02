## Current Task
Add three-dot overflow menu to post header with a "Report" action.

## End Goal with Specs
Item 34 from Phase 2: Users can report posts with a reason. Reports stored in database for admin review.
- "Report" option in post overflow menu (three-dot menu)
- Report dialog with reason dropdown: Spam, Harassment, Misinformation, Inappropriate content, Other
- Optional additional details text field
- Store report in DB, show confirmation toast
- Prevent duplicate reports from same user on same post

## Backlog
- [x] Add `reports` table to schema (`linkedin-demo/src/convex/schema.ts`) — userId, postId, reason (string), details (optional string), createdAt. Index by postId, userId.
- [x] Create `linkedin-demo/src/convex/reports.ts` — mutations: reportPost(postId, reason, details?); queries: hasReported(postId)
- [ ] Add three-dot overflow menu to post header in `linkedin-demo/src/components/posts/post/Post.js` with "Report" option <- current
- [ ] Create `linkedin-demo/src/components/posts/report/ReportDialog.js` — dialog with reason dropdown + details textarea + submit button
- [ ] Wire report submission — call mutation, show success Snackbar, disable re-report
- [ ] Run `cd linkedin-demo && npx convex dev --once` to push schema
- [ ] Test and commit

## Notes
- Post component: `linkedin-demo/src/components/posts/post/Post.js`
- Schema: `linkedin-demo/src/convex/schema.ts`
- Use MUI Dialog, Select, TextField, Snackbar components
