## Current Task
Update `linkedin-demo/src/components/header/Header.js` to remove `auth` usage/signout, and wire the bottom nav icons to update `activeTab`.

## End Goal with Specs
- App always renders feed (no Login screen).
- Mock user is injected on mount from `src/mock/user.js`.
- Header has no sign-out and no Firebase calls.
- Bottom tab bar shows: Home, My Network, Post, Notifications, Jobs.
- Non-Home tabs show a simple "Coming soon" card instead of the feed.

## Backlog
- [x] Update `linkedin-demo/src/App.js` to import `mockUser` from `src/mock/user.js`, dispatch `LoginAction(mockUser)` on mount, and remove `auth.onAuthStateChanged` + Login gating
- [x] Add simple `activeTab` state in `linkedin-demo/src/App.js` and render a placeholder card when `activeTab` is not `home`
- [ ] Update `linkedin-demo/src/components/header/Header.js` to remove `auth` usage/signout, and wire the bottom nav icons to update `activeTab` <- current
- [ ] Ensure Header logo is text-based "LinkedOut" (remove image) to avoid trademarked logo
- [ ] Verify the app renders without Firebase auth or login components

## Notes
- Files to touch: `linkedin-demo/src/App.js`, `linkedin-demo/src/components/header/Header.js`
- Avoid editing mock data files (`src/mock/*`); those are owned by another SubTurtle
- Progress: `App.js` now imports `mockUser` from `src/mock/user.js` and dispatches it on mount.
