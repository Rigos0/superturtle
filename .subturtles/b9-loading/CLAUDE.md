## Current Task
All backlog items complete.

## End Goal with Specs
- Feed shows skeleton post cards while loading (pulsing grey rectangles mimicking post layout)
- Profile page shows a skeleton header + post list while loading
- Messaging shows a skeleton conversation list while loading
- Network page shows skeleton user cards while loading
- Notifications shows skeleton list items while loading
- A top-level React Error Boundary catches render crashes and shows a friendly "Something went wrong" fallback with a Retry button
- All skeletons use MUI's built-in Skeleton component (`@material-ui/lab/Skeleton`)
- Green accent on retry button (#2e7d32)
- Build passes: `npm run build`

## Backlog
- [x] Create skeleton component `linkedin-demo/src/components/skeletons/PostSkeleton.js`: Import `Skeleton` from `@material-ui/lab`. Render a Paper with: circle skeleton (avatar, 40x40), two text skeletons (name + timestamp), one rect skeleton (description, height 60), one rect skeleton (image area, height 200, optional). Export as default. Use `animation="wave"` for Material feel.
- [x] Create skeleton component `linkedin-demo/src/components/skeletons/UserCardSkeleton.js`: Circle skeleton (avatar 56x56), two text skeletons (name + title), rect skeleton (button, height 36). For network page.
- [x] Create skeleton component `linkedin-demo/src/components/skeletons/NotificationSkeleton.js`: Circle skeleton (avatar 36x36), two text lines. For notifications list.
- [x] Wire skeletons into feed: In `linkedin-demo/src/components/posts/Posts.js`, check if posts query is loading (result is `undefined`). If loading, render 3x `<PostSkeleton />`. Import PostSkeleton.
- [x] Wire skeletons into Profile: In `linkedin-demo/src/components/profile/Profile.js`, if user query is `undefined`, show a skeleton header (rect 200px height for cover, circle for avatar, text lines for name/title). If posts are `undefined`, show 2x PostSkeleton.
- [x] Wire skeletons into Messaging: In `linkedin-demo/src/components/messaging/Messaging.js`, if conversations query is `undefined`, show 4 skeleton rows (circle + two text lines each).
- [x] Wire skeletons into Network: In `linkedin-demo/src/components/network/Network.js`, if users query is `undefined`, show 6x UserCardSkeleton.
- [x] Wire skeletons into Notifications: In `linkedin-demo/src/components/notifications/Notifications.js`, if notifications query is `undefined`, show 5x NotificationSkeleton.
- [x] Create Error Boundary: `linkedin-demo/src/components/ErrorBoundary.js`. Class component with `componentDidCatch`. Renders fallback: centered Paper with "Something went wrong" text + green Retry button (onClick resets state). Wrap the main content area in App.js with `<ErrorBoundary>`.
- [x] Push: `cd linkedin-demo && npx convex dev --once`
- [x] Build: `cd linkedin-demo && npm run build`
- [x] Commit: "Add skeleton loaders and error boundary for polished loading states"

## Notes
- All paths from repo root: `/Users/Richard.Mladek/Documents/projects/agentic/`
- Run npm/convex commands from `linkedin-demo/`
- MUI Lab Skeleton: `import Skeleton from "@material-ui/lab/Skeleton"` — already available via `@material-ui/lab` (installed)
- Skeleton variants: `text`, `rect` (rectangular), `circle`
- Skeleton props: `width`, `height`, `animation` ("pulse" default, "wave" for shimmer)
- Convex `useQuery` returns `undefined` while loading, then the actual data. Use `=== undefined` to detect loading state.
- Posts.js at `linkedin-demo/src/components/posts/Posts.js`
- Profile.js at `linkedin-demo/src/components/profile/Profile.js`
- Messaging.js at `linkedin-demo/src/components/messaging/Messaging.js`
- Network.js at `linkedin-demo/src/components/network/Network.js`
- Notifications.js at `linkedin-demo/src/components/notifications/Notifications.js`
- App.js at `linkedin-demo/src/App.js` — wrap content with ErrorBoundary
- Green colors: primary #2e7d32, light #66bb6a
- Create new directory: `linkedin-demo/src/components/skeletons/`

## Loop Control
STOP
