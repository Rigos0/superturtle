## Current Task
Update `linkedin-demo/src/components/posts/Posts.js` to use `useConvexPosts()` instead of mock imports.

## End Goal with Specs
- App fetches posts and user data from Convex instead of static mock imports
- ConvexProvider wraps the app in index.js
- Posts component uses useQuery to fetch posts from Convex
- Profile component uses useQuery to fetch the featured user
- App seeds data on first load if database is empty
- Build succeeds with no errors

## Backlog
- [x] Convex backend files already exist at `linkedin-demo/convex/schema.ts`, `linkedin-demo/convex/posts.ts`, `linkedin-demo/convex/users.ts`, `linkedin-demo/convex/seed.ts` — VERIFIED, skip this step
- [x] Add ConvexProvider to `linkedin-demo/src/index.js`: import ConvexReactClient from "convex/react", create client with `process.env.REACT_APP_CONVEX_URL`, wrap the existing `<Provider store={store}><App /></Provider>` with `<ConvexProvider client={convex}>...</ConvexProvider>`
- [x] Create `linkedin-demo/src/hooks/useConvexPosts.js` — a custom hook that calls `useQuery(api.posts.listPosts)` and returns the posts array (or empty array while loading). Import `{ useQuery }` from "convex/react" and `{ api }` from "../convex/_generated/api"
- [x] Create `linkedin-demo/src/hooks/useConvexUser.js` — a custom hook that calls `useQuery(api.users.getFeaturedUser)` and returns the featured user object (or null while loading)
- [ ] Update `linkedin-demo/src/components/posts/Posts.js`: replace `import { mockPosts }` with `useConvexPosts()` hook. Map over the returned posts, adapting field names (authorName→username, authorPhotoURL→profile, etc). Keep the same JSX structure <- current
- [ ] Update `linkedin-demo/src/components/profile/Profile.js`: use `useConvexUser()` hook for user data instead of importing from mock/user.js. Fall back to props/defaults while loading
- [ ] Add auto-seed: in `linkedin-demo/src/App.js`, on mount, call the seed mutation via `useMutation(api.seed.seedData)` so the database gets populated on first visit
- [ ] Update `linkedin-demo/src/components/posts/post/Post.js`: the isTadeas check should compare against the featured user's displayName from Convex (import useConvexUser or pass isFeatured as a prop from Posts)
- [ ] Run `cd linkedin-demo && npm run build` to verify build succeeds with Convex integration
- [ ] Commit with message "Wire React frontend to Convex backend"

## Notes
- IMPORTANT: All paths are relative to the repo root `/Users/Richard.Mladek/Documents/projects/agentic/`. The linkedin-demo project is at `linkedin-demo/`. The convex folder is at `linkedin-demo/convex/`. Run all npm commands from `linkedin-demo/`.
- This is a CRA (create-react-app) project, NOT Vite. Env vars use `process.env.REACT_APP_CONVEX_URL` (not import.meta.env)
- The Convex generated API is at `linkedin-demo/convex/_generated/api` — from src/ files, import as `import { api } from "../convex/_generated/api"`
- Keep Redux for theme toggle (util state) — only replace the mock data imports with Convex queries
- The mock/user.js imports a local image (`tadeas-bibr.jpg`) — for Convex, the DB stores "/tadeas-bibr.jpg" for Tadeáš. In the frontend, if photoURL starts with "/" treat it as a local asset and import tadeas-bibr.jpg as fallback
- Posts from Convex `listPosts` return: _id, authorId, description, fileType, fileData, createdAt, likesCount, commentsCount, authorName, authorPhotoURL, authorTitle
- The timestamp field changes from `{ toDate: () => Date }` to a plain epoch number (createdAt). Update ReactTimeago: `new Date(createdAt)` instead of `timestamp?.toDate()`
- Keep the existing UI/styling — only change data sources
- `.env.local` already has REACT_APP_CONVEX_URL set
