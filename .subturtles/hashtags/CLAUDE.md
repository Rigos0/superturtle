## Current Task
Render hashtags as clickable links in post text — in Post.js, regex-replace #word with a styled clickable span that navigates to `/hashtag/:tag`.

## End Goal with Specs
Items 23-24 from Phase 2: #hashtag in posts becomes clickable link to `/hashtag/:tag` page showing all posts with that hashtag.

## Backlog
- [x] Add `hashtags` table to Convex schema: `linkedin-demo/src/convex/schema.ts` — fields: tag (string, indexed), postId (Id<"posts">). Or store tags as array field on posts table.
- [x] Create `linkedin-demo/src/convex/hashtags.ts` — query: getPostsByHashtag(tag) returns posts with that hashtag
- [x] Parse hashtags from post description on save — extract #words in `linkedin-demo/src/convex/posts.ts` createPost mutation, store in hashtags table
- [ ] Render hashtags as clickable links in post text — in Post.js, regex-replace #word with a styled clickable span that navigates to `/hashtag/:tag` <- current
- [ ] Add `/hashtag/:tag` route in `linkedin-demo/src/App.js` — new page component showing filtered posts
- [ ] Create `linkedin-demo/src/components/hashtag/HashtagFeed.js` — shows tag name + list of posts
- [ ] Run `cd linkedin-demo && npx convex dev --once` to push schema
- [ ] Test and commit

## Notes
- Router is in App.js using react-router-dom BrowserRouter
- Posts are rendered by `linkedin-demo/src/components/posts/post/Post.js`
- Post creation in `linkedin-demo/src/convex/posts.ts` createPost mutation
