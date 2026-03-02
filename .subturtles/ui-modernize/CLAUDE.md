## Current Task
Replace raw button elements in Network.js (lines ~237-258, ~376-397) with MUI Button.

## End Goal with Specs
All raw HTML buttons, inputs, textareas replaced with MUI equivalents. Consistent styling. No sweetalert. No hardcoded colors. Skeleton loaders instead of spinners.

## Backlog
- [x] Replace sweetalert (swal) in Form.js (lines 167-258) with MUI Snackbar/Alert pattern. Remove `@sweetalert/with-react` import.
- [x] Replace raw `<textarea>` in Post.js (lines ~986-1010) with MUI TextField multiline
- [x] Replace raw `<input>` in Form.js (lines ~368-376) with MUI TextField
- [x] Replace raw `<button>` elements in Messaging.js (lines ~159-175) with MUI Button/IconButton
- [x] Replace raw `<button>` elements in Notifications.js (lines ~148-170) with MUI Button
- [ ] Replace raw button elements in Network.js (lines ~237-258, ~376-397) with MUI Button <- current
- [ ] Move inline styles from ErrorBoundary.js (lines 26-95) to makeStyles
- [ ] Replace all hardcoded `#2e7d32` colors with `theme.palette.primary.main` — check ArticleEditor.js:33, ArticleView.js:115, HashtagFeed.js:55, and grep for others
- [ ] Add MUI Skeleton loaders to replace CircularProgress spinners in: Profile.js, Network.js, Notifications.js feed loading states (import Skeleton from @material-ui/lab)
- [ ] Test build: `cd linkedin-demo && npm run build`
- [ ] Commit

## Notes
- MUI v4 is used: `@material-ui/core`, `@material-ui/icons`, `@material-ui/lab`
- Theme: green primary (#2e7d32) — use `theme.palette.primary.main` everywhere
- Skeleton is in `@material-ui/lab`: `import { Skeleton } from '@material-ui/lab'`
- Keep functionality identical — only change presentation layer
- Test that dark mode still works after all changes
