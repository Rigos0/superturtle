## Current Task
Remove Apps nav item from Header.js — remove item + import.

## End Goal with Specs
- No dead/fake UI elements remain in the app
- Every visible button either works or is gone
- Sidebar shows only real data
- Build passes: `npm run build`

## Backlog
- [x] Remove Jobs tab: Delete `jobs: "Jobs"` from tab mapping in `linkedin-demo/src/App.js` (line ~54). Delete `{ Icon: <WorkIcon />, title: "Jobs", arrow: false, onClick: () => setActiveTab("jobs") }` from nav items in `linkedin-demo/src/components/header/Header.js` (line ~130). Also remove `import WorkIcon from "@material-ui/icons/Work"` if that's the only usage.
- [ ] Remove Apps nav item: Delete `{ Icon: <AppsIcon />, title: "Apps", arrow: true }` from nav items in Header.js (line ~148). Remove `import AppsIcon from "@material-ui/icons/Apps"` (line ~23). <- current
- [ ] Remove Share button from posts: In `linkedin-demo/src/components/posts/post/Post.js`, delete the div containing `<ReplyOutlinedIcon style={{ transform: "scaleX(-1)" }} />` and `<h4>Share</h4>` (lines ~295-297). Remove `import ReplyOutlinedIcon from "@material-ui/icons/ReplyOutlined"` (line ~10) if not used elsewhere.
- [ ] Remove Send button from posts: In Post.js, delete the div containing `<SendIcon style={{ transform: "rotate(-45deg)" }} />` and `<h4>Send</h4>` (lines ~299-302). Check if SendIcon is used elsewhere before removing the import (it IS used in comment form's send button text — keep import if so).
- [ ] Remove fake "Who viewed" stat from sidebar: In `linkedin-demo/src/components/sidebar/sidebarTop/SidebarTop.js`, delete `const viewed = Math.floor((user?.connections ?? 100) / 2)` (line ~11) and delete the `<h4>Who viewed your profile</h4><p>{viewed}</p>` block (lines ~27-28). Keep the Connections stat.
- [ ] Clean up fake sidebar bottom: In `linkedin-demo/src/components/sidebar/sidebarBottom/SidebarBottom.js`, the hardcoded `sectionRecent`, `sectionGroups`, `sectionHashTags` arrays (lines ~79-88) have no backend. Replace the entire SidebarBottom content with a simple "Discover more" or turtle-themed placeholder, or remove the component entirely. If removing, also remove it from wherever it's imported (likely `linkedin-demo/src/components/sidebar/Sidebar.js`).
- [ ] Build: `cd linkedin-demo && npm run build`
- [ ] Commit: "Remove dead UI: Jobs tab, Apps nav, Share/Send buttons, fake sidebar stats"

## Notes
- Repo root: `/Users/Richard.Mladek/Documents/projects/agentic/`
- Run npm commands from `linkedin-demo/`
- WorkIcon import in Header.js is ONLY for Jobs — safe to remove
- AppsIcon import in Header.js is ONLY for Apps — safe to remove
- ReplyOutlinedIcon in Post.js is ONLY for Share — safe to remove
- SendIcon in Post.js is used in BOTH the action bar Send button AND the comment form send button — keep the import, only remove the action bar div
- SidebarBottom.js is imported in `linkedin-demo/src/components/sidebar/Sidebar.js`
