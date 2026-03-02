# Super Turtle — Dev Branch

You are Super Turtle 🐢 — a Telegram bot that is actively developing itself. This is the dev branch where the actual building happens.

**Current focus: LinkedIn demo lives in a separate repo:** `https://github.com/Rigos0/linkedin-demo`.
This repository no longer contains the `linkedin-demo/` directory.

---

## Deployment Instructions

Two deployments are needed to get changes live (run these in the `linkedin-demo` repo):

### 1. Convex (backend)
Pushes schema, mutations, and queries to the Convex cloud deployment.
```bash
npx convex dev --once
```

### 2. Vercel (frontend)
Deploys the React app to production. Vercel deploys from the **dev** branch (not main).
```bash
npx vercel --prod
```
This uploads the build and deploys to https://linkedin-demo-iota.vercel.app.

**Always run both** after completing a feature to ensure backend + frontend are in sync.

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
Full LinkedIn feature parity sprint — overnight autonomous build.

## 🤖 FULL-AUTO MODE (overnight)
The meta agent is running autonomously. Cron orchestrator (id `c0ffee`) fires every 20 min.
- Pick next unchecked backlog items, group into parallel SubTurtles (aim for 5 at a time)
- Use `yolo-codex` for all SubTurtles when Codex is available
- Stop finished SubTurtles, commit+push, deploy (Convex + Vercel), spawn next batch
- Only message the user on: completions, stuck states, errors
- Work through the backlog top-to-bottom, respecting phase order
- Deploy after each phase completes

## End goal with specs
A **full-featured LinkedIn clone** (Turtle In 🐢) — live at **https://linkedin-demo-iota.vercel.app**
Feature parity with core LinkedIn: profiles with `/:username` URLs, company pages, jobs board, advanced search, reactions, hashtags, rich posts, groups, and professional UX polish.

## Tech Stack
- **Frontend:** React 17 (CRA) + Material-UI + Redux (theme only)
- **Backend:** Convex (cloud deployment `tough-mosquito-145`)
- **Auth:** Convex Auth (`@convex-dev/auth` + `@auth/core@0.37.0`) — GitHub + Google (anonymous removed)
- **Hosting:** Vercel
- **Convex functions:** `src/convex/` (in `Rigos0/linkedin-demo`)
- **Dashboard:** `https://dashboard.convex.dev/t/richard-8ac4b/bibr-in`
- **OAuth callback base:** `https://tough-mosquito-145.convex.site/api/auth/callback/`

## Constraints
- **No new cloud tools or external services.** Everything must work with the existing stack (Convex + Vercel + React). If a feature requires an external service (e.g., email delivery, push notification service, server-side URL scraping), either implement it client-side only, make it a placeholder UI, or skip it. Update this section with skipped items and why.

## Roadmap (Completed)
- ✅ Scaffold, Convex backend, React frontend, Vercel deploy
- ✅ Rebrand to **Turtle In** 🐢 — green theme (#2e7d32), turtle assets
- ✅ Auth: GitHub OAuth + Google OAuth, guest read-only browsing
- ✅ Core features: posts (CRUD), likes, comments, messaging, profiles, network, notifications, search, sidebar, widgets
- ✅ Connections system: send/accept/reject/remove, real counts, no self-connect, viewable connections list
- ✅ Mobile responsive with bottom nav, dark mode, production polish

## Backlog — Phase 1: Profile System (items 1–15)
- [x] 1. Add `username` (slug) field to users schema — unique, URL-safe, auto-generated from displayName on first login
- [x] 2. First-login onboarding page — after OAuth, if user has no username, show a one-page setup: pick username (validate uniqueness in real-time), set displayName, title, location. Save all fields in one mutation. Only shown once.
-- [x] 3. Create `/:username` route — React Router, profile page loads by username lookup instead of userId
-- [x] 4. Profile vanity URL — clicking any user link navigates to `/:username` everywhere (feed, network, search, notifications)
- [x] 5. Profile edit modal — edit displayName, title, headline, location, about, with save mutation
- [x] 6. Profile photo upload — file picker, store in Convex storage, display as avatar everywhere
- [x] 7. Cover photo upload — file picker, store in Convex storage, display on profile header
- [x] 8. Experience section — structured entries: title, company, startDate, endDate, description (CRUD)
- [x] 9. Education section — structured entries: school, degree, field, startYear, endYear (CRUD)
- [x] 10. Skills section — add/remove skills, display as tags on profile
- [x] 11. Profile "About" rich text — multiline with basic formatting, save/edit
- [x] 12. Profile activity feed — show user's recent posts, comments, and likes on their profile
-- [x] 13. Profile "Featured" section — pin up to 3 posts to top of profile
-- [x] 14. Mutual connections display — "X mutual connections" on profile and network cards
-- [x] 15. Profile completeness indicator — progress bar showing % of fields filled
- SKIPPED: Profile SEO/share meta (og:tags need server-side rendering; CRA is client-only)

## Backlog — Phase 2: Rich Posts & Feed (items 16–35)
- [ ] 16. Image upload in posts — file picker, store in Convex storage, display in feed
- [ ] 17. Multi-image posts — upload up to 4 images, grid display layout
- [ ] 18. Link preview in posts — detect URLs in post text, display as clickable styled links (no server-side og:tag fetching — would need external service, skipped per constraints)
- [ ] 19. Post reactions (beyond like) — 👍 Like, ❤️ Love, 🎉 Celebrate, 💡 Insightful, 😂 Funny — reaction picker
- [ ] 20. Reaction counts per type — show breakdown on hover (like LinkedIn's icon row)
- [ ] 21. Post sharing/repost — repost to your feed with optional commentary
- [ ] 22. Repost count display on original post
- [ ] 23. Hashtag support — #hashtag in posts becomes clickable, links to hashtag feed
- [ ] 24. Hashtag feed page — `/hashtag/:tag` shows all posts with that hashtag
- [ ] 25. @mention support — type @username in posts/comments, autocomplete dropdown, creates notification
- [ ] 26. Post visibility setting — Public / Connections Only toggle when creating post
- [ ] 27. Feed algorithm — sort by: Recent (default), Top (most engagement), Following (connections only)
- [ ] 28. Feed "Follow" vs "Connect" — follow someone to see their posts without connecting
- [ ] 29. followers table + followUser/unfollowUser mutations + follower count query
- [ ] 30. Infinite scroll / pagination — load 10 posts at a time, fetch more on scroll
- [ ] 31. Poll posts — create a poll with 2-4 options, users vote, show results with percentages
- [ ] 32. Article/long-form posts — separate "Write article" flow, rich text editor, full-page article view
- [ ] 33. Post save/bookmark — save posts to a "Saved" tab accessible from profile
- [ ] 34. Report post — report button with reason dropdown, store reports in DB
- [ ] 35. Edit post history — show "Edited" badge, optional view of edit history

## Backlog — Phase 3: Company Pages (items 36–55)
- [ ] 36. Companies schema — table: name, slug, logo, cover, description, website, industry, size, founded, locations
- [ ] 37. Company CRUD mutations — createCompany, updateCompany (admin only)
- [ ] 38. Company page UI — `/company/:slug` route, header with logo+cover, about section, posts feed
- [ ] 39. Company admin system — creator is admin, can add other admins
- [ ] 40. Company followers — followCompany/unfollowCompany mutations, follower count
- [ ] 41. Company posts — company admins can post as the company (shows company logo/name)
- [ ] 42. Company page "About" tab — full description, industry, size, website, specialties
- [ ] 43. Company page "People" tab — list employees (users who added this company to experience)
- [ ] 44. Company page "Posts" tab — all posts by company admins
- [ ] 45. Company logo in experience entries — when user adds experience, match company name to show logo
- [ ] 46. Company search — search for companies by name, show in search results alongside users/posts
- [ ] 47. Company suggestions widget — "Companies you may want to follow" in sidebar
- [ ] 48. Create company flow — form with name, industry, size, description, logo upload
- [ ] 49. Company page dark mode — theme-aware colors throughout
- [ ] 50. Company analytics (admin view) — follower growth chart (simple), post engagement stats
- [ ] 51. Company page "Jobs" tab — list job postings by this company
- [ ] 52. Company verified badge — visual indicator for verified companies
- [ ] 53. Link experience to company — dropdown autocomplete when adding experience
- [ ] 54. Company page mobile responsive — stacked layout, collapsible sections
- [ ] 55. Company notifications — "X started following your company"

## Backlog — Phase 4: Jobs Board (items 56–70)
- [ ] 56. Jobs schema — table: title, company, location, type (full-time/part-time/contract), description, salary, postedBy, createdAt, status
- [ ] 57. Jobs tab in header nav — icon + "Jobs" label, replace or add to existing nav
- [ ] 58. Job listing page — `/jobs` route, list all open jobs with filters
- [ ] 59. Job detail page — `/jobs/:id` with full description, company info, apply button
- [ ] 60. Post a job flow — form for company admins: title, description, location, type, salary range
- [ ] 61. Job search — filter by title, company, location, type
- [ ] 62. Job save/bookmark — save jobs to "Saved Jobs" list
- [ ] 63. Easy apply — one-click apply using profile data, store application in DB
- [ ] 64. Job applications table — applicantId, jobId, status (applied/reviewed/rejected/accepted), appliedAt
- [ ] 65. Application tracking for job seekers — "Applied Jobs" tab showing status
- [ ] 66. Application tracking for recruiters — view applicants per job, change status
- [ ] 67. Job recommendations — "Jobs for you" based on title/skills/location match
- [ ] 68. Job alerts — opt-in notifications for new jobs matching criteria
- [ ] 69. Remote/hybrid/onsite filter — location type enum on jobs
- [ ] 70. Job sharing — share a job posting as a post on your feed

## Backlog — Phase 5: Advanced Search (items 71–80)
- [ ] 71. Unified search page — `/search?q=term` route with tabs: All, People, Posts, Companies, Jobs
- [ ] 72. People search — filter by name, title, company, location, connection degree
- [ ] 73. Posts search — full-text search across post descriptions
- [ ] 74. Company search results — show company cards with logo, name, industry, follower count
- [ ] 75. Job search results — show job cards with title, company, location, posted date
- [ ] 76. Search result pagination — load more results on scroll
- [ ] 77. Recent searches — store and display last 5 searches for quick re-access
- [ ] 78. Search suggestions/autocomplete — dropdown with top matches as user types
- [ ] 79. "People you may know" — suggest connections based on mutual connections, shared companies
- [ ] 80. Search filters UI — sidebar with checkboxes/dropdowns for refining results

## Backlog — Phase 6: Messaging Enhancements (items 81–90)
- [ ] 81. Message read receipts — show "Seen" indicator when recipient opens message
- [ ] 82. Typing indicator — show "X is typing..." in conversation
- [ ] 83. Message reactions — react to individual messages with emoji
- [ ] 84. Image sharing in messages — send photos in DMs
- [ ] 85. Group conversations — create a conversation with 3+ people, group name/avatar
- [ ] 86. Message search — search within conversations by keyword
- [ ] 87. Message delete — delete your own messages (show "This message was deleted")
- [ ] 88. Online status indicator — green dot on avatar for recently active users
- [ ] 89. Connection request message — add a personal note when sending connection request
- [ ] 90. Message link preview — detect and style URLs as clickable links in messages (no server-side og:tag fetching per constraints)

## Backlog — Phase 7: Notifications & Activity (items 91–100)
- [ ] 91. Notification types — connection_request, connection_accepted, like, comment, mention, follow, job_alert, company_post
- [ ] 92. Notification grouping — "John and 3 others liked your post" instead of 4 separate notifications
- [ ] 93. Notification settings page — toggle on/off per notification type
- [ ] 94. Email notification preferences — placeholder UI (no actual email sending)
- [ ] 95. Activity log page — all your actions: posts, likes, comments, connections, follows
- [ ] 96. "Who viewed your profile" — log profile views, show viewers list (anonymized option)
- [ ] 97. In-app notification sound toggle — play a subtle sound on new notifications (browser Audio API only, no push service)
- [ ] 98. Notification deep links — clicking notification navigates to exact post/profile/conversation
- [ ] 99. Unread notification badge on all tabs — not just bell, also messaging count
- [ ] 100. Weekly digest — in-app summary card on feed showing profile views, post engagement, new connections (no email — per constraints)

## Backlog — Phase 8: Polish & Infrastructure (items 101–115)
- [ ] 101. React Router integration — proper URL routing for all pages (/feed, /:username, /company/:slug, /jobs, /search, /messaging)
- [ ] 102. Browser back/forward navigation — works correctly across all views
- [ ] 103. 404 page — friendly "Page not found" for invalid URLs
- [ ] 104. Loading skeletons — shimmer placeholders for all data-loading states (not just spinner)
- [ ] 105. Optimistic UI everywhere — likes, comments, connection requests respond instantly
- [ ] 106. Error toasts — user-facing Snackbar messages when mutations fail (not silent console.error)
- [ ] 107. Confirm dialogs — delete post, remove connection, leave group all require confirmation
- [ ] 108. Image lazy loading — images load on scroll into viewport
- [ ] 109. Keyboard accessibility — all interactive elements focusable and operable via keyboard
- [ ] 110. Responsive breakpoints audit — test all views at 320px, 375px, 768px, 1024px, 1440px
- [ ] 111. Performance audit — bundle size analysis, code splitting for routes, lazy-loaded components
- [ ] 112. E2E tests for connections flow — send request, accept, view connections list, remove
- [ ] 113. E2E tests for guest read-only — verify all interactive elements are disabled/hidden
- [ ] 114. E2E tests for company pages — create company, view page, follow, post as company
- [ ] 115. E2E tests for jobs — post job, search, apply, track application

## Notes
- Convex schema: users (with email index), posts, likes, comments, conversations, messages, connections, notifications + authTables
- Convex functions: posts.ts, users.ts, seed.ts, likes.ts, comments.ts, auth.ts, http.ts, messaging.ts, notifications.ts, connections.ts
- Hooks: useConvexPosts.js, useConvexUser.js
- CI on `main` runs typecheck + unit tests; Codex integration tests gated behind `CODEX_INTEGRATION=1`
