## Current Task
Add loading state to OAuth buttons in `linkedin-demo/src/components/login/loginCard/LoginCard.js`.

## End Goal with Specs
- All hardcoded white/black colors replaced with theme-aware values
- Empty states show proper messages (not loading dots)
- Dead CSS for removed features cleaned up
- OAuth buttons show loading state when clicked
- Desktop nav shows active tab indication
- ErrorBoundary respects dark mode
- DEFAULT_PROFILE fallback cleaned up (no "Alex Turner" leaking)
- `npm run build` passes

## Backlog
- [x] Fix empty posts feed bug in `linkedin-demo/src/components/posts/Posts.js`: When `posts.length === 0`, show "No posts yet" message instead of loading animation. The loading state should only show when `posts === undefined` (still loading from Convex), not when it's an empty array.
- [x] Fix ErrorBoundary dark mode in `linkedin-demo/src/components/ErrorBoundary.js`: Replace hardcoded `background: "#ffffff"`, `color` values with theme-aware colors. Use `useTheme` hook or pass theme via context. The error page should look good in both light and dark mode.
- [x] Fix dark mode colors in `linkedin-demo/src/components/posts/post/Style.js`:
  - Line ~86: Save button `color: "white"` — change to `color: theme.palette.common.white` (this is intentional white-on-green)
  - Line ~275: Comment input `backgroundColor: "white"` → use `theme.palette.background.paper`
  - Line ~292: Comment submit button text color — verify contrast in dark mode
- [x] Fix dark mode in `linkedin-demo/src/components/messaging/Style.js`:
  - Line ~150: Other user bubble `backgroundColor: "#e0e0e0"` → use `theme.palette.type === "dark" ? "#37474f" : "#e0e0e0"`
- [x] Fix dark mode in `linkedin-demo/src/components/profile/Style.js`:
  - Line ~56: Avatar border `border: "4px solid #fff"` → use `theme.palette.background.paper`
- [x] Fix dark mode in `linkedin-demo/src/components/header/menuItem/Style.js`:
  - Line ~19: `color: "black"` → use `theme.palette.text.primary`
- [x] Clean up dead guestBtn styles in `linkedin-demo/src/components/login/loginCard/Style.js`:
  - Remove `.guestBtn` styles (lines ~75-81) since guest auth button was removed.
- [x] Add active tab indication to desktop nav in `linkedin-demo/src/components/header/Header.js` and `linkedin-demo/src/components/header/Style.js`:
  - Add a green bottom border or underline (#2e7d32) to the active tab icon in the desktop header nav. The `activeTab` state is available — use it to conditionally apply a style.
- [ ] Add loading state to OAuth buttons in `linkedin-demo/src/components/login/loginCard/LoginCard.js`: <- current
  - When a sign-in button is clicked, show a small spinner or "Signing in..." text and disable both buttons to prevent double-clicks. Use a `signingIn` state.
- [ ] Clean up DEFAULT_PROFILE in `linkedin-demo/src/components/profile/Profile.js`: The fallback object has "Alex Turner", "TurtleIn builder", "San Francisco, CA" — replace with generic fallbacks: displayName → "User", title → "", location → "". Or better, show a minimal profile when data is missing.
- [ ] Run `cd linkedin-demo && npm run build` to verify build passes
- [ ] Commit: "UI polish: dark mode fixes, empty states, loading UX, dead code cleanup"

## Notes
- All paths from repo root: `/Users/Richard.Mladek/Documents/projects/agentic/`
- Run npm commands from `linkedin-demo/`
- Material-UI v4: `makeStyles` receives `theme` param. Use `theme.palette.type === "dark"` for conditional colors
- `theme.palette.background.paper` = white in light, dark gray in dark
- `theme.palette.text.primary` = black in light, white in dark
- `theme.palette.background.default` = light gray in light, darker gray in dark
- Green colors: primary #2e7d32, light #66bb6a, dark #1b5e20
- ErrorBoundary is a class component — may need to use `withTheme` HOC or `ThemeProvider` context to access theme
