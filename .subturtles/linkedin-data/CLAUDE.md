## Current Task
All backlog items are complete.

## End Goal with Specs
- No Firebase imports in `Posts.js` or `Form.js`.
- Local mock posts (8-10) render in the feed immediately.
- Mock user is Tadeáš Bíbr, avatar from `src/assets/tadeas-bibr.jpg`.
- Form shows a demo-only behavior (no uploads, no network calls).
- Firebase storage URL in `src/assets/images/images.js` replaced with a placeholder.

## Backlog
- [x] Create `linkedin-demo/src/mock/user.js` exporting `mockUser` (displayName "Tadeáš Bíbr", photoURL import from `src/assets/tadeas-bibr.jpg`, title string)
- [x] Create `linkedin-demo/src/mock/posts.js` with 8-10 posts using mixed content (text-only, image URL, video placeholder text) and multiple mock users
- [x] Update `linkedin-demo/src/components/posts/Posts.js` to import `mockPosts` and render them (no Firebase)
- [x] Update `linkedin-demo/src/components/form/Form.js` to remove Firebase/storage usage and show a demo-only alert on submit
- [x] Replace `LinkedInJobAdd` in `linkedin-demo/src/assets/images/images.js` with a local or placeholder URL (non-Firebase)

## Notes
- Do not edit `App.js` or Header components.
- Use ASCII text in mock content except the user's name (keep diacritics for Tadeáš Bíbr).

## Loop Control
STOP
