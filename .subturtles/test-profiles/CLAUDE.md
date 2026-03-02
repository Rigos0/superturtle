## Current Task
Add test: Profile education section renders school/degree entries on About tab.

## End Goal with Specs
Comprehensive E2E test coverage for profile system features: photo display, skills, featured posts, mutual connections, profile completeness indicator. Tests run against live deployment at `https://linkedin-demo-iota.vercel.app`.

## Backlog
- [x] Read existing test patterns in `linkedin-demo/e2e/social.spec.ts` (especially `openProfileFromFirstPost`, profile tab tests) and `linkedin-demo/e2e/helpers.ts` (loginAsGuest)
- [x] Add test: Profile photo and cover photo are visible on profile page (check for `img` elements in profile header area)
- [x] Add test: Profile skills section displays skill tags on About tab
- [ ] Add test: Profile education section renders school/degree entries on About tab <- current
- [ ] Add test: Featured posts section visible on profile (if user has pinned posts)
- [ ] Add test: Mutual connections count shown on profile ("X mutual connections" text)
- [ ] Add test: Profile completeness indicator (progress bar or percentage) visible on own profile
- [ ] Add test: Profile edit modal opens and fields are editable (displayName, title, location, about)
- [ ] Run tests: `cd linkedin-demo && npx playwright test e2e/profiles.spec.ts`
- [ ] Commit

## Notes
- All tests go in a NEW file: `linkedin-demo/e2e/profiles.spec.ts`
- Use `loginAsGuest(page)` from `./helpers` for auth
- Use existing patterns: `openProfileFromFirstPost(page)`, tab clicking, `ensureFeedReady(page)`
- Copy helper functions from social.spec.ts as needed (or import from helpers.ts)
- Playwright config: `linkedin-demo/playwright.config.ts` — baseURL is `https://linkedin-demo-iota.vercel.app`
- Tests should be resilient: use `test.skip()` with descriptive messages when live data isn't available
- DO NOT modify existing test files — only create new ones
