## Current Task
Create `src/components/company/CompanyAboutTab.js` — displays: description, industry, size, website (clickable link), founded year, locations list, specialties.

## End Goal with Specs
Users can follow companies. Company admins post as the company (shows company logo/name). Company page has 3 tabs: About (full details), People (employees from experience), Posts (company posts feed).

## Backlog
- [x] Create `src/convex/companyFollowers.ts` with mutations: followCompany (auth required, no duplicate), unfollowCompany, getFollowerCount query, isFollowing query. Use the `companyFollowers` table from schema (company-core SubTurtle adds it — if not present yet, add it yourself).
- [x] Add `companyPosts` concept: In `src/convex/posts.ts`, add optional `companyId` field to posts schema (v.optional(v.id("companies"))). Add `createCompanyPost` mutation — verify user is in company admins array, set companyId on the post. Add `getCompanyPosts` query filtered by companyId.
- [ ] Create `src/components/company/CompanyAboutTab.js` — displays: description, industry, size, website (clickable link), founded year, locations list, specialties. Use MUI Typography, List, ListItem, Link. <- current
- [ ] Create `src/components/company/CompanyPeopleTab.js` — query users whose experienceEntries contain an entry matching the company name (case-insensitive). Display user cards with avatar, name, title. Click navigates to /:username.
- [ ] Create `src/components/company/CompanyPostsTab.js` — list posts where companyId matches. Reuse existing Post component. Show "No posts yet" empty state.
- [ ] Wire tabs into CompanyPage.js using MUI Tabs component. Three tabs: About, People, Posts. Default to About tab.
- [ ] Run `cd linkedin-demo && npx convex dev --once && npm run build` to verify.
- [ ] Commit with descriptive message.

## Notes
- Project root: /Users/Richard.Mladek/Documents/projects/agentic/linkedin-demo
- Convex functions: src/convex/
- Components: src/components/
- Schema: src/convex/schema.ts — company-core adds companies + companyFollowers tables
- Posts schema already has: authorId, description, type, visibility, imageStorageIds, etc.
- Need to add companyId optional field to posts table
- Use getAuthUserId(ctx) for all mutations
- MUI v4: @material-ui/core, @material-ui/icons
- IMPORTANT: Only modify files in linkedin-demo/ directory
