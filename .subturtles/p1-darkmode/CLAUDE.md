## Current Task
All backlog items complete.

## End Goal with Specs
- Toggle dark mode via Theme button in header
- ALL views (feed, messaging, network, notifications, profile, login) render correctly in dark mode
- No white backgrounds stuck on dark screens
- No invisible text (dark text on dark background)
- Search dropdown, edit textarea, comment form all adapt to dark mode
- Green branding (#2e7d32) stays consistent in both modes
- Build passes: `npm run build`

## Backlog
- [x] Fix messaging dark mode in `linkedin-demo/src/components/messaging/Style.js`: Replace all `backgroundColor: "#fff"` with `theme.palette.background.paper`. Replace `#f4f8f4` hover with `theme.palette.action.hover`. Replace `#f1f3f4` borders with `theme.palette.divider`. Replace `#fafafa` message list bg with `theme.palette.background.default`. Replace `#1d2226` text colors with `theme.palette.text.primary`. Replace `#5f6368`/`#6b7280` with `theme.palette.text.secondary`. Keep green (#2e7d32) as-is for own bubbles.
- [x] Fix notifications dark mode in `linkedin-demo/src/components/notifications/Style.js`: Replace `backgroundColor: "#fff"` in items with `theme.palette.background.paper`. Replace `#f8fcf8` unread bg with a dark-mode-friendly subtle green tint: `theme.palette.type === "dark" ? "rgba(46,125,50,0.08)" : "#f8fcf8"`. Replace `#f4f8f4` hover with `theme.palette.action.hover`. Fix `#1d2226` text to `theme.palette.text.primary`. Fix borders `#eceff1`/`#f1f3f4` to `theme.palette.divider`.
- [x] Fix network cards dark mode in `linkedin-demo/src/components/network/Style.js`: Replace card `backgroundColor: "#fff"` with `theme.palette.background.paper`. Replace search field `backgroundColor: "#fff"` with `theme.palette.background.paper`.
- [x] Fix post edit textarea dark mode in `linkedin-demo/src/components/posts/post/Style.js`: In `editTextarea` class, add dark mode: `backgroundColor: theme.palette.background.paper`, `color: theme.palette.text.primary`, `border: "1px solid " + theme.palette.divider`. In `cancelButton`, adapt border color. In `comment__form`, check input colors (line 261-262 already has dark mode — verify it works).
- [x] Fix search dropdown dark mode in `linkedin-demo/src/components/header/Style.js`: The `searchDropdown` class (line 89) has no background color set — needs `backgroundColor: theme.palette.background.paper`. Verify `searchResultItem` hover colors use theme.
- [x] Fix login card dark mode in `linkedin-demo/src/components/login/loginCard/LoginCard.js` and its Style.js: Ensure login card background adapts. Check text colors.
- [x] Push: `cd linkedin-demo && npx convex dev --once`
- [x] Build: `cd linkedin-demo && npm run build`
- [x] Commit: "Fix dark mode: theme-aware colors across all components"

## Notes
- Repo root: `/Users/Richard.Mladek/Documents/projects/agentic/`
- Run npm/convex commands from `linkedin-demo/`
- MUI dark theme: `theme.palette.background.paper` = dark card bg, `theme.palette.background.default` = dark page bg, `theme.palette.text.primary` = light text, `theme.palette.text.secondary` = muted light text, `theme.palette.divider` = subtle border, `theme.palette.action.hover` = hover bg
- The theme is toggled in Header.js via Redux `ChangeTheme()` action — it flips `mode` which feeds into `createMuiTheme({ palette: { type: mode ? "dark" : "light" } })` in App.js
- Style files use `makeStyles((theme) => ({...}))` so `theme` is available everywhere
- GREEN stays constant: #2e7d32 primary, #1b5e20 dark, #66bb6a light — these don't change with dark mode
- Key files to modify:
  - `linkedin-demo/src/components/messaging/Style.js`
  - `linkedin-demo/src/components/notifications/Style.js`
  - `linkedin-demo/src/components/network/Style.js`
  - `linkedin-demo/src/components/posts/post/Style.js`
  - `linkedin-demo/src/components/header/Style.js`
  - `linkedin-demo/src/components/login/loginCard/` (Style.js and/or LoginCard.js)

## Loop Control
STOP
