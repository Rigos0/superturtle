# LinkedIn Clone Demo Plan

## Goal
Ship a polished, mobile-first LinkedIn lookalike demo accessible via a Cloudflare tunnel link. It should look and feel like the real LinkedIn app on a phone — feed, nav, dark mode — but run entirely on static/mock data with zero auth required.

## Base Repo
**[phanison898/linked-in-clone](https://github.com/phanison898/linked-in-clone)** (MIT license, 30+ ⭐)
- React + Material-UI + Redux + Firebase
- Already responsive with mobile view, dark mode, Lottie animations
- Live reference: https://phanison-linkedin-clone.web.app/

## What We Keep
- Feed UI with post cards (text, images, video placeholders)
- Top nav bar (logo, search, icons)
- Responsive layout and Material-UI styling
- Dark mode toggle
- Lottie animations

## What We Strip / Replace
- **Firebase auth** → bypass login entirely, hard-code a mock user session
- **Firebase Firestore** → replace with local mock data (JSON array of fake posts, fake user profiles)
- **Firebase Storage** → use local placeholder images or picsum.photos URLs
- **Google sign-in popup** → remove; app loads straight into the feed
- **.env Firebase keys** → not needed; remove the dependency

## What We Add
- **Bottom tab bar** (Home, My Network, Post, Notifications, Jobs) — LinkedIn mobile style, if not already present
- **Realistic mock data** — 8-10 feed posts with varied content (text-only, image, video placeholder), fake user names/avatars/titles
- **Mobile-first polish** — verify touch targets, scroll behavior, viewport meta tag
- **Custom branding tweaks** — make it clearly a demo (e.g. "LinkedOut" or similar) to avoid trademark issues

## Scope Boundaries (Out)
- No real authentication or user accounts
- No real database or API calls
- No messaging, notifications, or job search functionality (tabs exist but show placeholder screens)
- No deployment beyond the Cloudflare tunnel

## Deliverables
1. Working React app cloned into repo root at `linkedin-clone/`
2. `npm install && npm start` works with zero Firebase config
3. App loads directly into the feed (no login wall)
4. Mobile-responsive layout verified via screenshot on phone-sized viewport
5. Cloudflare tunnel URL shared for live preview

## Build Steps
1. Clone `phanison898/linked-in-clone` into `linkedin-clone/` at repo root
2. Install deps, verify it builds (`npm install && npm start`)
3. Strip Firebase auth — mock the user context so the app boots straight to feed
4. Replace Firestore data layer with static mock data (local JSON)
5. Replace Firebase Storage image URLs with placeholder images
6. Add bottom tab bar if missing (Home, My Network, Post, Notifications, Jobs)
7. Seed 8-10 realistic mock posts with varied content types
8. Mobile viewport QA — screenshot at 390×844 (iPhone 14 size)
9. Start dev server + Cloudflare tunnel, share the URL
10. Final polish pass — dark mode works, animations load, no console errors

## Risks / Mitigations
- **Firebase deeply coupled** → If stripping Firebase is too invasive, consider wrapping it with a mock adapter layer rather than ripping it out file-by-file
- **npm dependency rot** → Repo may have outdated deps; run `npm audit fix` early and pin Node version if needed
- **Trademark** → Rename to "LinkedOut" or similar; swap the LinkedIn logo for a custom one
- **Heavy assets** → Audit bundle size; strip unused Lottie animations if they bloat the load
- **No placeholders for inner pages** → Tabs that aren't "Home" should show a simple "Coming soon" card, not crash
