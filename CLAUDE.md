# Super Turtle — Dev Branch

You are Super Turtle 🐢 — a Telegram bot that is actively developing itself. This is the dev branch where the actual building happens.

---

## Branch Merge Instructions (dev → main)

`CLAUDE.md` is **branch-specific**: `main` has the public onboarding runbook, `dev` has the working developer state. The `.gitattributes` file uses Git's `merge=ours` driver to prevent merges from overwriting the target branch's `CLAUDE.md`.

### One-time setup (per clone)

Every developer who clones this repo must run this once:

```bash
git config merge.ours.driver true
```

This registers the "ours" merge driver locally. Without it, Git won't know how to handle the `merge=ours` attribute and will fall back to default (which could overwrite).

### Merging dev → main

Always use `--no-ff` to ensure the merge driver is invoked:

```bash
git checkout main
git merge --no-ff dev
git push origin main
```

This will merge all code changes from dev into main, but `CLAUDE.md` on main will stay untouched.

### Merging main → dev (syncing back)

Same pattern — dev's `CLAUDE.md` is preserved:

```bash
git checkout dev
git merge --no-ff main
```

### Why `--no-ff` is required

Fast-forward merges skip the merge machinery entirely (no merge commit = no merge drivers). If Git can fast-forward, the `merge=ours` rule is never evaluated and `CLAUDE.md` gets overwritten. Always use `--no-ff`.

### If something goes wrong

If `CLAUDE.md` does get overwritten during a merge:

```bash
# Restore the version from before the merge
git checkout HEAD~1 -- CLAUDE.md
git commit -m "restore branch-specific CLAUDE.md"
```

---

## Current task
Production polish sprint wrapping up. LoadingGate universal spinner shipped. P6 (final QA) remaining.

## End goal with specs
A **production-grade** LinkedIn-style demo app (Turtle In 🐢) where every button works, dark mode is usable, no fake data, no dead code, and every interaction feels intentional. Specifically:
- Real authentication (Convex Auth — anonymous guest, GitHub OAuth, Google OAuth)
- Users can create, edit, and delete their own posts
- Like/react to posts with real counts (computed from DB, not stored stale)
- Comment on posts (with delete own comments)
- Direct messaging between users — startable from profile "Message" button
- User profiles (any user, not just featured)
- Network/connections page (single column, clean layout)
- Notifications feed — clicking a notification navigates to the source post/profile
- Search (posts + users)
- Sidebar showing auth user info + stats
- Widgets panel with turtle-themed news
- Mobile responsive with working bottom nav
- Dark mode that actually works across all views
- No dead buttons, no fake data, no placeholder features
- Live on Vercel with Convex cloud backend
- Green branding (#2e7d32)

## Tech Stack
- **Frontend:** React 17 (CRA) + Material-UI + Redux (theme only)
- **Backend:** Convex (cloud deployment `tough-mosquito-145`)
- **Auth:** Convex Auth (`@convex-dev/auth` + `@auth/core@0.37.0`) — Anonymous + GitHub + Google providers
- **Hosting:** Vercel (`https://linkedin-demo-iota.vercel.app`)
- **Convex functions:** `linkedin-demo/src/convex/`
- **Dashboard:** `https://dashboard.convex.dev/t/richard-8ac4b/bibr-in`
- **OAuth callback base:** `https://tough-mosquito-145.convex.site/api/auth/callback/`

## Roadmap (Completed)
- ✅ Scaffold LinkedIn clone from open-source template
- ✅ Strip Firebase, inject mock data, original branding
- ✅ Profile page with clickable avatars
- ✅ Convex backend — schema, queries, seed data (users + posts tables)
- ✅ React frontend wired to Convex (ConvexProvider, useQuery hooks)
- ✅ Deployed to Vercel with Convex env vars
- ✅ Rebrand to **Turtle In** 🐢 — green theme, Alex Turner demo user, generic professional content
- ✅ Backend mutations: createPost, deletePost, toggleLike, getLikeStatus, addComment, listComments
- ✅ Auth backend: auth.ts, auth.config.ts, http.ts, schema with authTables, JWT keys + JWKS configured
- ✅ Auth frontend: ConvexAuthProvider, login UI (Guest/GitHub/Google), auth gate, sign-out, useConvexUser hook
- ✅ Interactive posts: likes wired to toggleLike with auth user, real-time comments, delete own posts
- ✅ Messaging: conversations + messages tables, chat UI, real-time delivery
- ✅ Deployed to Vercel with all features live

## Backlog — Feature Build (DONE)
- [x] B1–B10: All core features shipped (profiles, sidebar, widgets, network, notifications, search, edit post, mobile, loading states, deploy)

## Backlog — Production Polish (ordered)
- [x] P0: Fix post timestamps (`toDate()` → direct number), delete dead `firebase.js`
- [x] P1: Dark mode — theme-aware colors across messaging, notifications, network, posts, search, login ✅
- [x] P2: Wire dead buttons — Profile Message opens conversation, notification click navigates to source, Connect shows Pending ✅ (SubTurtle p2-wire-buttons)
- [x] P3: Delete own comments — `deleteComment` mutation + delete icon in comment UI, auth-gated ✅
- [x] P4: Clean up dead UI — removed Jobs tab, Apps nav, Share/Send buttons, fake sidebar stats, fake sidebar bottom ✅
- [x] P5: Navigation cleanup — merged onNavigateProfile/onViewProfile, centralized DEFAULT_PHOTO, post success toast, ErrorBoundary real error page ✅
- [x] P5.5: Universal LoadingGate component — green spinner, 2s min duration, replaced all skeletons across Posts/Network/Notifications/Messaging/Profile ✅
- [ ] P6: Final deploy + full manual QA

## Notes
- Convex schema at `linkedin-demo/src/convex/schema.ts` — tables: users, posts, likes, comments, conversations, messages + authTables
- Auth env vars on Convex: SITE_URL, JWT_PRIVATE_KEY, JWKS ✅
- OAuth env vars on Convex: AUTH_GITHUB_ID + AUTH_GITHUB_SECRET ✅ (GitHub login working); AUTH_GOOGLE_ID + AUTH_GOOGLE_SECRET ✅ (Google login working)
- Anonymous auth works without OAuth credentials — app is functional for demo immediately
- Convex functions: posts.ts, users.ts, seed.ts, likes.ts, comments.ts, auth.ts, http.ts, messaging.ts
- Hooks: useConvexPosts.js, useConvexUser.js
- CI on `main` runs typecheck + unit tests; Codex integration tests are gated behind `CODEX_INTEGRATION=1`.
