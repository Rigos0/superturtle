## Current Task
Wire notification display: in notifications component, handle "company_follow" type — show "X started following your company [CompanyName]".

## End Goal with Specs
When users add experience, they can pick from existing companies (autocomplete dropdown). Company logo shows in experience entries. Company pages are mobile responsive. Users get notifications when someone follows their company.

## Backlog
- [x] In `src/convex/companies.ts`, add `listCompanyNames` query — returns array of {_id, name, slug, logoStorageId} for autocomplete.
- [x] Update experience entry form (in `src/components/profile/ExperienceSection.js` or wherever experience CRUD lives): add autocomplete dropdown for company name that queries listCompanyNames. When user picks a company, store the companyId alongside the company name string in the experience entry. If they type a new name not in the list, just store the string (no companyId).
- [x] Display company logo next to experience entries: if the experience entry has a matching company (by name or companyId), resolve the company's logoStorageId and show the logo as a small avatar next to the entry. Fallback to BusinessIcon if no logo.
- [x] Make CompanyPage.js mobile responsive: on screens < 768px, stack cover/logo vertically, make tabs scrollable, reduce padding. Use MUI useMediaQuery or CSS @media. Test the layout at 375px width.
- [x] Add company follow notification: in `src/convex/companyFollowers.ts` followCompany mutation, after inserting the follow, create a notification for each company admin: type "company_follow", fromUserId = follower, include companyId. Add companyId as optional field to notifications schema if needed.
- [ ] Wire notification display: in notifications component, handle "company_follow" type — show "X started following your company [CompanyName]". <- current
- [ ] Run `cd linkedin-demo && npx convex dev --once && npm run build` to verify.
- [ ] Commit with descriptive message.

## Notes
- Project root: /Users/Richard.Mladek/Documents/projects/agentic/linkedin-demo
- Experience section: src/components/profile/ExperienceSection.js
- Notifications: src/convex/notifications.ts + src/components/notifications/
- Schema: src/convex/schema.ts — may need to add companyId to notifications table
- Company functions: src/convex/companies.ts + src/convex/companyFollowers.ts
- MUI v4 Autocomplete: from @material-ui/lab
- Use getAuthUserId(ctx) for mutations
- MUI v4: @material-ui/core, @material-ui/icons, @material-ui/lab
- IMPORTANT: Only modify files in linkedin-demo/ directory
