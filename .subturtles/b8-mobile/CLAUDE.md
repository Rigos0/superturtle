## Current Task
All backlog items are complete; append loop control stop marker.

## End Goal with Specs
- All views render correctly on mobile (320px–600px width)
- Bottom nav bar shows on xs breakpoint with icons for: Home, Network, Messaging, Notifications, Profile (me)
- Bottom nav icons highlight the active tab in green (#2e7d32)
- Sidebar and widgets are hidden on small screens (already using MUI `Hidden smDown` in App.js — verify this works)
- Feed posts, profile page, messaging, network, notifications all have proper padding and no horizontal overflow on mobile
- Search input in header works on mobile (already has xs breakpoints)
- Login page is mobile friendly
- No horizontal scroll on any view at 375px width
- Build passes: `npm run build`

## Backlog
- [x] Audit bottom nav in `linkedin-demo/src/components/header/Header.js`: The `header__bottom__nav` class already shows at xs breakpoint (Style.js line ~186). Verify it contains icons for Home, Network, Post (create), Messaging, Notifications. Each icon should call the appropriate `setActiveTab` + `onNavigateHome` handler. Active icon should be colored green (#2e7d32).
- [x] Fix bottom nav in `linkedin-demo/src/components/header/Style.js`: Ensure `header__bottom__nav` has zIndex 100, backgroundColor white, and proper icon spacing. Active icon color should be #2e7d32. Add a top border-line (1px solid #e0e0e0).
- [x] Mobile-fix feed layout in `linkedin-demo/src/Style.js`: Ensure `body__feed` has `padding: "0 8px"` at xs breakpoint instead of 0 (needs a little breathing room). Ensure `app__body` paddingBottom at xs is at least 60px to clear the bottom nav.
- [x] Mobile-fix profile in `linkedin-demo/src/components/profile/Style.js` + `Profile.js`: Ensure the profile header, tabs, and post list don't overflow. Profile cover image should be responsive. Back button should be visible and tappable.
- [x] Mobile-fix messaging in `linkedin-demo/src/components/messaging/Style.js`: At xs breakpoint, set `root` height to `calc(100vh - 110px)` to account for bottom nav. Ensure input bar doesn't get hidden behind bottom nav. Thread header back button needs adequate tap target.
- [x] Mobile-fix network in `linkedin-demo/src/components/network/Style.js` + `Network.js`: Grid of user cards should go to single column on xs. Cards should have full width. Search/filter input should be full width.
- [x] Mobile-fix notifications in `linkedin-demo/src/components/notifications/Style.js` + `Notifications.js`: List items should have adequate padding and tap targets. Mark-all-read button should be visible.
- [x] Push: `cd linkedin-demo && npx convex dev --once`
- [x] Build: `cd linkedin-demo && npm run build`
- [x] Commit: "Mobile responsiveness: bottom nav, layout fixes for all views"

## Notes
- All paths from repo root: `/Users/Richard.Mladek/Documents/projects/agentic/`
- Run npm/convex commands from `linkedin-demo/`
- MUI breakpoints: xs (<600px), sm (600-960px), md (960-1280px)
- App.js already uses `<Hidden smDown>` for sidebar and widgets — they won't show on mobile
- Header Style.js already has xs breakpoints for search and nav
- The bottom nav Paper (`header__bottom__nav`) exists but may need onClick wiring for each icon
- Header.js receives: `activeTab`, `setActiveTab`, `onNavigateProfile`, `onNavigateHome`
- Green colors: primary #2e7d32, light #66bb6a, dark #1b5e20
- Key files to modify:
  - `linkedin-demo/src/components/header/Header.js` (bottom nav wiring)
  - `linkedin-demo/src/components/header/Style.js` (bottom nav styles)
  - `linkedin-demo/src/Style.js` (app layout mobile)
  - `linkedin-demo/src/components/profile/Style.js` (profile mobile)
  - `linkedin-demo/src/components/messaging/Style.js` (messaging mobile)
  - `linkedin-demo/src/components/network/Style.js` (network mobile)
  - `linkedin-demo/src/components/notifications/Style.js` (notifications mobile)

## Loop Control
STOP
