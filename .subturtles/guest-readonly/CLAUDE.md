## Current Task
Update `linkedin-demo/src/components/header/Header.js`: when user is null (unauthenticated), show a "Sign In" Button (green #2e7d32, white text) on the right side instead of the sign-out button and avatar. Clicking it sets `onSignInClick()` prop which App.js uses to show the login modal. Hide notification badge for unauthenticated.

## End Goal with Specs
- Remove the Anonymous provider from Convex Auth (auth.ts)
- Remove the "Continue as Turtle" guest button from LoginCard.js
- Login page shows only GitHub + Google sign-in buttons
- Unauthenticated visitors land on the feed directly (NO login gate) but in read-only mode:
  - Post creation form (Form.js) is hidden for unauthenticated users
  - Like buttons are visible but clicking shows a "Sign in to like" prompt or is disabled
  - Comment input is hidden for unauthenticated users
  - "Connect" buttons show "Sign in to connect" or are hidden
  - Messaging tab shows "Sign in to message" prompt
  - Network tab is browsable (read-only)
  - Profile is viewable but no Connect/Message actions
- The Header shows a "Sign In" button (green, #2e7d32) instead of sign-out when unauthenticated
- useConvexUser hook returns null for unauthenticated visitors (no fallback to featuredUser)
- All Convex mutations remain unchanged (frontend gates the actions)
- `npm run build` passes
- `npx convex dev --once` passes

## Backlog
- [x] Remove Anonymous provider from `linkedin-demo/src/convex/auth.ts`: remove the `import { Anonymous }` and remove `Anonymous` from providers array. Keep GitHub + Google only.
- [x] Remove "Continue as Turtle" button from `linkedin-demo/src/components/login/loginCard/LoginCard.js`: delete the guest sign-in button. Keep GitHub + Google buttons.
- [x] Update `linkedin-demo/src/App.js`: remove the auth gate that shows Login when not authenticated. Instead, always show the main feed layout. The Login component should only show when user explicitly clicks "Sign In". Add a `showLogin` state. When `showLogin` is true, show a modal/overlay with LoginCard. Pass `onClose` to LoginCard so it can dismiss.
- [ ] Update `linkedin-demo/src/components/header/Header.js`: when user is null (unauthenticated), show a "Sign In" Button (green #2e7d32, white text) on the right side instead of the sign-out button and avatar. Clicking it sets `onSignInClick()` prop which App.js uses to show the login modal. Hide notification badge for unauthenticated. <- current
- [ ] Update `linkedin-demo/src/components/form/Form.js`: wrap the entire form in a check — if `!user?._id`, don't render the form at all (return null or a small "Sign in to post" prompt).
- [ ] Update `linkedin-demo/src/components/posts/post/Post.js`: for unauthenticated users (no user._id): disable the like button (grey it out), hide the comment input field, hide the edit/delete menu. The post content remains fully visible and readable.
- [ ] Update `linkedin-demo/src/hooks/useConvexUser.js`: remove the fallback to `featuredUser`. If not authenticated, return null. Components must handle null user gracefully.
- [ ] Update `linkedin-demo/src/components/profile/Profile.js`: hide Connect and Message buttons when user is null (unauthenticated).
- [ ] Update `linkedin-demo/src/components/network/Network.js`: hide Connect buttons when user is null. Keep the user cards visible (read-only browsing).
- [x] Run `npx convex dev --once` to push the auth.ts change
- [x] Run `cd linkedin-demo && npm run build` to verify build passes
- [ ] Commit: "Remove guest auth, add read-only browsing for unauthenticated visitors"

## Notes
- All paths from repo root: `/Users/Richard.Mladek/Documents/projects/agentic/`
- Run npm/convex commands from `linkedin-demo/`
- auth.ts at `linkedin-demo/src/convex/auth.ts`
- LoginCard at `linkedin-demo/src/components/login/loginCard/LoginCard.js`
- App.js at `linkedin-demo/src/App.js` — now always renders feed layout and opens `LoginCard` in a modal when `showLogin` is true
- useConvexUser at `linkedin-demo/src/hooks/useConvexUser.js` — currently falls back to featuredUser
- Form.js at `linkedin-demo/src/components/form/Form.js`
- Post.js at `linkedin-demo/src/components/posts/post/Post.js`
- Header.js at `linkedin-demo/src/components/header/Header.js`
- Profile.js at `linkedin-demo/src/components/profile/Profile.js`
- Network.js at `linkedin-demo/src/components/network/Network.js`
- Green colors: primary #2e7d32, light #66bb6a, dark #1b5e20
- `isAnonymous` field exists in schema but don't need to remove it (harmless)
- The `Authenticated`/`Unauthenticated` components from `convex/react` can help gate UI
- `useConvexAuth()` from `convex/react` returns `{ isAuthenticated, isLoading }`
