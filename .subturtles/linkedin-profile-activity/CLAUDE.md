## Current Task
Commit: `add profile activity feed`.

## End Goal with Specs
- Profile page shows a tab/section listing recent activity by the user.
- Include recent posts, comments, and likes (at least posts + comments if likes are heavy).

## Backlog
- [x] Add Convex query in `linkedin-demo/src/convex/users.ts` (or new file) to fetch recent activity for a user.
- [x] Update `linkedin-demo/src/components/profile/Profile.js` to render activity feed.
- [ ] Commit: `add profile activity feed` <- current

## Notes
- Keep it light: limit to ~10 items.
- Implemented with recent posts + comments. Likes are excluded because `likes` currently has no timestamp, so recency ordering is not reliable.
