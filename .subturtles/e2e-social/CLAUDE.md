## Current Task
Write dark mode + mobile tests (tests 11-12).

## End Goal with Specs
Playwright e2e tests at `linkedin-demo/e2e/social.spec.ts` covering all social features against the live app. Tests must pass reliably in headless Chromium.

**Test URL:** `https://linkedin-demo-iota.vercel.app`
**Auth method:** Click "Continue as Guest" button — no credentials needed.

**IMPORTANT: Shared infrastructure dependency**
The sibling SubTurtle `e2e-core` is creating the Playwright config and helpers. Before writing tests:
1. Check if `linkedin-demo/playwright.config.ts` exists
2. Check if `linkedin-demo/e2e/helpers.ts` exists with `loginAsGuest()`
3. If they don't exist yet, create them yourself:
   - Config: baseURL `https://linkedin-demo-iota.vercel.app`, testDir `./e2e`, Chromium only, 30s timeout, retries 1
   - Helper: `loginAsGuest(page)` that navigates to `/`, clicks "Continue as Guest", waits for "Start a post" text
4. If they already exist, reuse them — do NOT overwrite.
5. Install playwright if not already installed: `cd linkedin-demo && npm install --save-dev @playwright/test --legacy-peer-deps && npx playwright install chromium`

**Tests to write in `linkedin-demo/e2e/social.spec.ts`:**

1. **Profile navigation** — click on a post author's avatar or name, verify profile page loads with "Back to feed" button, user name, title, and tabs (Posts/About). Click "Back to feed" to return.

2. **Profile About tab** — navigate to a profile, click "About" tab, verify about text and experience section render.

3. **Network page** — click "My Network" tab, verify user cards load (at least "Avery Chen", "Devin Carter", or "Sofia Morales" visible). Verify each card has a Connect button.

4. **Network search** — on Network page, type "Avery" in the search field, verify filtered results show Avery Chen and hide others. Clear search, verify all users return.

5. **Connect button feedback** — on Network page, click Connect on a user card, verify button changes to "Pending" and becomes disabled.

6. **Messaging — empty state** — click Messaging tab, verify "No conversations yet" or messaging list loads.

7. **Message from profile** — navigate to a seed user's profile (click their name on a post), click "Message" button, verify redirected to messaging tab.

8. **Notifications page** — click Notifications tab, verify page loads with "Notifications" heading and "Mark all as read" button.

9. **Search users** — click in the header search field, type "Devin", verify search dropdown appears with "Devin Carter" in results. Click the result, verify navigated to profile.

10. **Search posts** — click in the header search field, type "design system", verify search dropdown shows matching post results.

11. **Dark mode toggle** — click Theme button in header nav, verify the page background changes (body or Paper elements get dark background). Toggle back.

12. **Mobile bottom nav** — set viewport to 375x812, verify bottom navigation bar is visible with icons. Click each icon, verify view changes.

**Important implementation notes:**
- Use `getByText()`, `getByRole()`, `getByPlaceholder()` — avoid CSS class selectors
- Use Playwright auto-waiting, minimize `waitForTimeout`
- Each test independent (login fresh via beforeEach using `loginAsGuest`)
- After writing tests, run them: `cd linkedin-demo && npx playwright test e2e/social.spec.ts --reporter=list`
- Fix any failures before marking complete
- Commit when done

## Backlog
- [x] Check/create shared Playwright infrastructure (config + helpers)
- [x] Write profile tests (tests 1-2)
- [x] Write network tests (tests 3-5)
- [x] Write messaging + notifications tests (tests 6-8)
- [x] Write search tests (tests 9-10)
- [ ] Write dark mode + mobile tests (tests 11-12) <- current
- [ ] Run full suite, fix failures, commit
