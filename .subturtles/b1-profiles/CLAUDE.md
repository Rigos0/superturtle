## Current Task
All B1 profile tasks are complete.

## End Goal with Specs
- Clicking ANY user's name or avatar in the feed opens their profile (not just Alex Turner)
- Profile page accepts a userId prop, queries that user from Convex
- "My posts" tab on profile shows only that user's posts
- Auth user's own profile shows their auth info (name, avatar from session)
- Profile page uses green branding (#2e7d32)
- Build passes: `npm run build`

## Backlog
- [x] Add `listPostsByUser` query to `linkedin-demo/src/convex/posts.ts`: args { authorId: v.id("users") }, returns posts filtered by authorId, sorted by createdAt desc, with author join (same pattern as listPosts but filtered).
- [x] Update `Posts.js` to pass `authorId={post.authorId}` to each `<Post>` (already passing it — verify).
- [x] Update `Post.js`: make ALL user names/avatars clickable (not just "Alex Turner"). Remove the `isFeaturedUser` check. On click, call a new `onViewProfile(authorId)` callback passed as prop. Keep the `onNavigateProfile` for backward compat but prefer `onViewProfile` when available.
- [x] Update `Posts.js`: accept an `onViewProfile` prop, pass it to each Post. In `App.js`, pass `onViewProfile={(userId) => { setProfileUserId(userId); setView("profile"); }}`.
- [x] Update `App.js`: add `profileUserId` state. Pass it to `<Profile userId={profileUserId} />`. When navigating to profile, set the userId.
- [x] Rewrite `Profile.js` to accept `userId` prop. When userId is provided, query `api.users.getUser({ id: userId })`. When not provided, fall back to auth user. Add a "Posts" tab that queries `api.posts.listPostsByUser({ authorId: userId })` and renders them. Keep About + Experience sections. Keep green gradient cover, Connect/Message buttons.
- [x] Push: `cd linkedin-demo && npx convex dev --once`
- [x] Build: `cd linkedin-demo && npm run build`
- [x] Commit: "User profiles: view any user, my-posts tab, click-to-profile from feed"

## Notes
- All paths from repo root: `/Users/Richard.Mladek/Documents/projects/agentic/`
- Run npm/convex commands from `linkedin-demo/`
- Profile.js at `linkedin-demo/src/components/profile/Profile.js` — currently only shows featured user
- Post.js currently has `isFeaturedUser = username === "Alex Turner"` check — REMOVE this, make all clickable
- users.ts already has `getUser` query that accepts an id
- Green colors: primary #2e7d32, light #66bb6a, dark #1b5e20

## Loop Control
STOP
