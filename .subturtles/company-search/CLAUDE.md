## Current Task
Integrate company results into the existing search UI with a dedicated "Companies" section.

## End Goal with Specs
Companies appear in search results alongside users/posts. Sidebar shows "Companies you may want to follow" suggestions. Users can create companies via a form with name, industry, size, description, logo upload.

## Backlog
- [x] Add company search to `src/convex/companies.ts`: `searchCompanies` query — takes search term, filters companies by name (case-insensitive substring match using string includes). Return name, slug, industry, follower count, logoStorageId.
- [ ] Integrate company results into existing search UI. File: `src/components/header/Header.js` or wherever search results render. Add a "Companies" section to search results showing company cards (logo, name, industry, follower count). Click navigates to /company/:slug. <- current
- [ ] Create `src/components/company/CompanySuggestions.js` widget — query up to 5 companies the user does NOT follow, show cards with logo, name, industry, "Follow" button. Style like existing sidebar widgets.
- [ ] Add CompanySuggestions widget to the sidebar/widgets area (check src/components/widgets/ or sidebar/).
- [ ] Create `src/components/company/CreateCompany.js` page — form fields: name (required), industry (required, dropdown with common options), size (required, dropdown: 1-10, 11-50, 51-200, 201-500, 501-1000, 1000+), description (textarea), website (optional), logo upload (file picker, use generateUploadUrl from Convex storage). On submit, call companies:createCompany mutation with auto-generated slug from name. Route: `/create-company`.
- [ ] Add `/create-company` route to App.js, add a "Create Company" link somewhere accessible (e.g., in sidebar or profile dropdown).
- [ ] Run `cd linkedin-demo && npx convex dev --once && npm run build` to verify.
- [ ] Commit with descriptive message.

## Notes
- Project root: /Users/Richard.Mladek/Documents/projects/agentic/linkedin-demo
- Convex functions: src/convex/companies.ts (created by company-core SubTurtle)
- Schema: src/convex/schema.ts
- Existing search is in Header.js — look for the search input/results logic
- Sidebar widgets: src/components/widgets/ or src/components/sidebar/
- Logo upload: use same pattern as profile photo — generateUploadUrl mutation + storage
- Use getAuthUserId(ctx) for mutations
- MUI v4: @material-ui/core, @material-ui/icons
- IMPORTANT: Only modify files in linkedin-demo/ directory
