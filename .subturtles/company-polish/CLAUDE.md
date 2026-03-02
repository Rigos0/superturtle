## Current Task
Create `src/components/company/CompanyAnalytics.js` admin-only stats view (followers, posts, total post likes).

## End Goal with Specs
Company pages are fully theme-aware (dark mode works). Company admins see basic analytics (follower count, post engagement). Jobs tab exists as a placeholder. Verified companies show a badge.

## Backlog
- [x] Add `isVerified` boolean field (optional) to companies table in schema.ts.
- [ ] Create `src/components/company/CompanyAnalytics.js` — admin-only view: total followers (number), total posts (number), total post likes (sum across company posts). Use MUI Card with simple stat display (number + label). No charts needed — just clean stat cards. <- current
- [ ] Add analytics tab to CompanyPage.js — only visible to admins. Show CompanyAnalytics component.
- [ ] Create `src/components/company/CompanyJobsTab.js` — placeholder tab showing "No job postings yet. Check back soon!" with a WorkOutlineIcon. This will be populated in Phase 4.
- [ ] Add Jobs tab to CompanyPage.js tabs (after Posts tab).
- [ ] Add verified badge display: in CompanyPage.js header, if company.isVerified is true, show a VerifiedIcon (MUI) in blue next to the company name. Also show in search results and suggestion cards.
- [ ] Ensure all company components use `theme.palette` tokens instead of hardcoded colors. Use `useTheme()` hook. Background, text, borders should all be theme-aware for dark mode.
- [ ] Run `cd linkedin-demo && npx convex dev --once && npm run build` to verify.
- [ ] Commit with descriptive message.

## Notes
- Project root: /Users/Richard.Mladek/Documents/projects/agentic/linkedin-demo
- Company components: src/components/company/ (created by other SubTurtles)
- Schema: src/convex/schema.ts
- Dark mode: app uses MUI theme with palette.type 'dark'/'light'. Use theme.palette.background.paper, theme.palette.text.primary, etc.
- Verified badge: use VerifiedUser icon from @material-ui/icons, color primary or blue
- Analytics queries need to be in src/convex/companies.ts
- Use getAuthUserId(ctx) for admin checks
- MUI v4: @material-ui/core, @material-ui/icons
- IMPORTANT: Only modify files in linkedin-demo/ directory
