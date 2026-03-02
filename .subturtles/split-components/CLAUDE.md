## Current Task
Read `linkedin-demo/src/components/profile/Profile.js` (2162 lines) and map sections

## End Goal with Specs
Break Post.js and Profile.js into smaller, focused components. Post.js → 5-6 files. Profile.js sections → extracted components.

## Backlog
- [x] Read `linkedin-demo/src/components/posts/post/Post.js` and map all logical sections
- [x] Extract PostHeader.js — author avatar, name, timestamp, "Edited" badge, overflow menu (report, delete, edit triggers)
- [x] Extract PostActions.js — like/reaction button, comment toggle, repost button, bookmark button, share. Include reaction picker logic.
- [x] Extract PostComments.js — comment list + comment input form. Move comment state and handlers.
- [x] Extract RepostCard.js — the embedded original post display for reposts
- [x] Update Post.js to compose from extracted subcomponents — verify same behavior
- [ ] Read `linkedin-demo/src/components/profile/Profile.js` (2162 lines) and map sections <- current
- [ ] Extract ExperienceSection.js from Profile.js — experience list + add/edit dialog
- [ ] Extract EducationSection.js from Profile.js — education list + add/edit dialog
- [ ] Extract SkillsSection.js from Profile.js — skills tags + add/remove
- [ ] Update Profile.js to compose from extracted subcomponents
- [ ] Test build: `cd linkedin-demo && npm run build`
- [ ] Commit

## Notes
- Post.js: `linkedin-demo/src/components/posts/post/Post.js`
- Post styles: `linkedin-demo/src/components/posts/post/Style.js` — shared styles stay here, component-specific styles move with component
- Profile.js: `linkedin-demo/src/components/profile/Profile.js`
- Keep all imports working — extracted components should be in same directory or nearby
- Do NOT change behavior — pure refactoring. All features must work identically after.
- Post.js section map:
- `37-130`: file-local helpers/constants (`resolvePhoto`, image resolvers, reaction config, regexes, article preview helper)
- `132-350`: component setup, mutations/queries, local state/refs, derived memoized data
- `351-701`: event handlers (reactions, comments, repost/bookmark, menu/report/edit, profile/hashtag/article nav)
- `702-755`: mention text renderer helper
- `757-898`: reaction count normalization + `Reactions` summary renderer
- `900-981`: top/post header UI (repost ribbon, author block, timestamp, edited badge, overflow menu)
- `982-1120`: post body UI (edit mode, article card, text/hashtags/mentions, link preview, poll, repost embed, media)
- `1121-1217`: footer action row + reaction picker interactions
- `1219-1264`: comments list + add-comment form
- `1268-1326`: repost dialog + report/edit-history dialogs + report snackbar
