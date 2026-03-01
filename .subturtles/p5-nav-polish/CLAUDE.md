## Current Task
Post creation success toast: In `linkedin-demo/src/components/posts/form/Form.js`, after successful `createPost` mutation call, show a brief SweetAlert success message after `resetState()`.

## End Goal with Specs
- Single profile navigation function (no duplicates)
- Centralized DEFAULT_PHOTO constant used everywhere instead of scattered empty-string fallbacks
- Post creation shows success feedback toast
- ErrorBoundary renders a real error page (not blank screen)
- Build passes: `npm run build`

## Backlog
- [x] Merge profile nav functions: In `linkedin-demo/src/App.js`, `onNavigateProfile` (line ~57-60) and `onViewProfile` (line ~62-65) do the same thing. Delete `onViewProfile`. Keep `onNavigateProfile` with the `userId ?? null` fallback. Then replace ALL `onViewProfile` references with `onNavigateProfile` across: Header.js (lines ~29, 107, 147), Post.js (lines ~35-36, 176-177, 181-182), Network.js (lines ~18, 86, 90), Notifications.js (lines ~40, 88-89). Search for "onViewProfile" across all files to catch any others.
- [x] Centralize DEFAULT_PHOTO: Create a constant `export const DEFAULT_PHOTO = ""` (or a turtle placeholder URL) in `linkedin-demo/src/constants.js` (new file). Then replace scattered `photoURL ?? ""`, `image ?? ""`, empty-string avatar fallbacks in Post.js, Profile.js, Notifications.js, Messaging.js, Network.js, comments section. Import and use `DEFAULT_PHOTO` everywhere.
- [ ] Post creation success toast: In `linkedin-demo/src/components/posts/form/Form.js`, after successful `createPost` mutation call (line ~77), show a brief success message. The file already uses SweetAlert (`Swal`) — add `Swal.fire({ icon: "success", title: "Post created!", timer: 1500, showConfirmButton: false })` after `resetState()`. <- current
- [ ] ErrorBoundary real error page: Find `linkedin-demo/src/components/ErrorBoundary.js` (or similar). If it renders nothing useful on error, replace with a styled error page: turtle emoji 🐢, "Something went wrong" heading, "Try refreshing the page" message, a Refresh button that calls `window.location.reload()`. Use inline styles so it works even if MUI breaks.
- [ ] Build: `cd linkedin-demo && npm run build`
- [ ] Commit: "Clean up navigation, add success toast, improve error boundary"

## Notes
- Repo root: `/Users/Richard.Mladek/Documents/projects/agentic/`
- Run npm commands from `linkedin-demo/`
- `onNavigateProfile` is the one to KEEP (has `?? null` fallback)
- `onViewProfile` is the one to DELETE (no fallback)
- SweetAlert is already imported in Form.js as `Swal` from `sweetalert2`
- ErrorBoundary is at `linkedin-demo/src/components/ErrorBoundary.js` — check if it exists, if not create a minimal one and wrap the app root in App.js
- For DEFAULT_PHOTO, an empty string is fine — Avatar component shows initials when src is empty
