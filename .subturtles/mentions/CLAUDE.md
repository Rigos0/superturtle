## Current Task
Test: create post with @mention, verify autocomplete works, verify notification created, verify link navigates to profile.

## End Goal with Specs
Item 25 from Phase 2: Type @username in posts/comments, autocomplete dropdown appears, selecting creates a notification for the mentioned user.

## Backlog
- [x] Create username search query in `linkedin-demo/src/convex/users.ts` — searchUsersByPrefix(prefix) returns matching users (username, displayName, photoURL)
- [x] Build MentionAutocomplete component — `linkedin-demo/src/components/mentions/MentionAutocomplete.js` — dropdown that appears when typing @ in a text field, shows matching users
- [x] Integrate autocomplete into post composer — `linkedin-demo/src/components/posts/postMaker/PostMaker.js` — detect @ in textarea, show dropdown, insert @username on select
- [x] Render @mentions as styled links in post text — in Post.js, regex-replace @username with clickable link to `/:username`
- [x] Create notification on mention — in createPost mutation (`linkedin-demo/src/convex/posts.ts`), parse @usernames, create notification for each mentioned user
- [ ] Test: create post with @mention, verify autocomplete works, verify notification created, verify link navigates to profile <- current
- [ ] Commit

## Notes
- Notifications mutations in `linkedin-demo/src/convex/notifications.ts`
- Users table has `username` field with index
- Post composer is in `linkedin-demo/src/components/posts/postMaker/PostMaker.js`
