## Current Task
All backlog items are complete.

## End Goal with Specs
Modern, professional icons that match LinkedIn's visual language. Replace generic icons with more appropriate MUI icon variants. Improve post action bar, header nav, and sidebar icons.

## Backlog
- [x] **Header nav icons** in `linkedin-demo/src/components/header/Header.js`:
  - `TelegramIcon` → `ChatBubbleOutlineIcon` or `ForumOutlinedIcon` (Messaging — TelegramIcon is literally the Telegram logo, wrong app)
  - `GroupIcon` → `PeopleAltOutlinedIcon` or `SupervisorAccountOutlinedIcon` (My Network)
  - `HomeIcon` → `HomeOutlinedIcon` (outlined style for inactive, filled for active)
  - `NotificationsIcon` → `NotificationsOutlinedIcon` (outlined when inactive)
  - `PersonIcon` → `PersonOutlineIcon` (Sign In)
  - `Brightness4Icon`/`BrightnessHighIcon` → `DarkModeOutlined`/`LightModeOutlined` (or keep if MUI v4 doesn't have these — check first, use `NightsStayOutlined`/`WbSunnyOutlined` as fallback)
- [x] **Post action icons** in `linkedin-demo/src/components/posts/post/PostActions.js`:
  - `RepeatIcon` → `ShareOutlinedIcon` or `ReplyOutlinedIcon` (Repost — RepeatIcon looks like a music repeat button)
  - `CommentOutlinedIcon` is fine — keep
  - `BookmarkBorderOutlinedIcon` is fine — keep
  - Ensure Like/ThumbUp icons use outlined when not active, filled when active (verify this works)
- [x] **Post header** in `linkedin-demo/src/components/posts/post/PostHeader.js`:
  - `MoreHorizOutlinedIcon` is fine — keep
- [x] **Form/composer icons** in `linkedin-demo/src/components/form/Form.js`:
  - `VideocamRoundedIcon` → `VideocamOutlinedIcon` (consistent outlined style)
  - `YouTubeIcon` → `OndemandVideoOutlinedIcon` or `PlayCircleOutlineIcon` (YouTubeIcon is a branded logo)
  - `PhotoSizeSelectActualIcon` → `ImageOutlinedIcon` or `PhotoOutlinedIcon` (cleaner)
  - `CreateIcon` → `EditOutlinedIcon` or `CreateOutlinedIcon`
  - `InsertLinkIcon` → `LinkOutlinedIcon` (if available) or keep
- [x] **Sidebar icons** in `linkedin-demo/src/components/sidebar/sidebarTop/SidebarTop.js`:
  - `LabelImportantIcon` → `BookmarkBorderIcon` or `LabelOutlinedIcon`
  - `BookmarkIcon` — check if using outlined variant
- [x] **Widgets icons** in `linkedin-demo/src/components/widgets/Widgets.js`:
  - `FiberManualRecordIcon` (dot) — is fine for bullet points
  - `ErrorOutlineSharpIcon` → `InfoOutlinedIcon` (less alarming for info display)
  - `ExpandMoreIcon` is fine — keep
- [x] **Comment delete icon** in `linkedin-demo/src/components/posts/post/PostComments.js`:
  - `DeleteOutlineIcon` is fine — keep
- [x] **Bottom nav (mobile)** in Header.js `tabItems` array:
  - Same icon updates as header nav — apply outlined variants
  - Active state should use filled variant, inactive should use outlined
- [x] Test build: `cd linkedin-demo && npm run build`
- [x] Commit

## Notes
- Using MUI v4: `@material-ui/icons` — check availability of each icon before using
- To find available icons: the naming convention is `<Name>Icon` (filled), `<Name>OutlinedIcon` (outlined), `<Name>RoundedIcon` (rounded)
- LinkedIn uses outlined icons for inactive states, filled for active — follow this pattern
- Keep the green theme color for active states
- Do NOT change component structure — only swap icon imports and references
- Run `npm run build` at the end to verify all imports resolve

## Loop Control
STOP
