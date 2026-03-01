## Current Task
Add delete button for own posts in `Post.js` (three-dot menu), auth-gated to post author only.

## End Goal with Specs
- Like button calls `toggleLike` mutation with current user ID, shows filled/unfilled state
- Real like count from Convex (not random), updates in real-time
- Expandable comment section under each post with real comments from Convex
- Comment form to add a comment (uses auth user ID)
- Comment count from Convex, updates in real-time
- Delete button on own posts only (three-dot menu → Delete)
- Form.js posts as the authenticated user (currently uses `featuredUser._id` — needs to use auth user)
- `npx convex dev --once` + `npm run build` both pass

## Backlog
- [x] Pass `postId` and `likesCount` props from `Posts.js` → `Post.js`. In `linkedin-demo/src/components/posts/Posts.js`, add `postId={post._id}` and `likesCount={post.likesCount}` and `commentsCount={post.commentsCount}` to each `<Post>` component. The `listPosts` query already returns real `likesCount` from the likes table.
- [x] Wire like button in `Post.js`. Remove the random `likesCount`/`commentsCount` useState + useEffect. Accept `postId`, `likesCount`, `commentsCount` as props. Import `useMutation, useQuery` from `convex/react` and `api` from convex. Import `useConvexUser` from `../../hooks/useConvexUser`. Get current user via `useConvexUser()`. Add `liked` state using `useQuery(api.likes.getLikeStatus, { userId: user?._id, postId })`. On Like button click: call `toggleLike({ userId: user._id, postId })`. Show `ThumbUpAltOutlinedIcon` when not liked, `ThumbUpAltIcon` (solid, import from `@material-ui/icons/ThumbUpAlt`) when liked. Display real `likesCount` prop.
- [x] Add expandable comment section below the footer actions in `Post.js`. Add a `showComments` boolean state (default false). Clicking "Comment" action toggles `showComments`. When open: query `useQuery(api.comments.listComments, { postId })`. Render each comment as: Avatar (author.photoURL) + author.displayName + comment body + ReactTimeago timestamp. Add a comment input form at bottom: text input + Send button. On submit: call `addComment({ postId, authorId: user._id, body: commentText })`. Display real `commentsCount` prop (not random).
- [ ] Add delete button for own posts. In `Post.js`, accept `authorId` prop (passed from Posts.js as `post.authorId`). Compare `authorId === user?._id`. If match, show a Delete option in the three-dot menu (replace the static `MoreHorizOutlinedIcon` with a clickable menu). On delete click: call `deletePost({ postId })`. Import `deletePost` mutation. <- current
- [ ] Update `Posts.js` to pass new props: `postId={post._id}`, `likesCount={post.likesCount}`, `commentsCount={post.commentsCount}`, `authorId={post.authorId}`.
- [ ] Push functions to Convex: `cd linkedin-demo && npx convex dev --once`
- [ ] Build: `cd linkedin-demo && npm run build`
- [ ] Commit with message "Wire interactive posts: likes, comments, delete with auth user"

## Notes
- All paths from repo root: `/Users/Richard.Mladek/Documents/projects/agentic/`
- Run npm/convex commands from `linkedin-demo/`
- Backend mutations already exist: `likes.ts` (toggleLike, getLikeStatus), `comments.ts` (addComment, listComments), `posts.ts` (deletePost)
- `useConvexUser()` hook at `src/hooks/useConvexUser.js` returns the current auth user (with fallback to featured user)
- The `listPosts` query already joins author data and counts real likes from the likes table
- Post.js currently uses RANDOM likes/comments counts — remove those entirely
- Post.js is a `forwardRef` component used by FlipMove — keep the forwardRef wrapper
- Import solid thumb icon: `import ThumbUpAltIcon from "@material-ui/icons/ThumbUpAlt"`
- Green accent color: #2e7d32
