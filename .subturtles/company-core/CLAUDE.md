## Current Task
Create `src/convex/companies.ts` with mutations: createCompany (auth required, creator becomes admin), updateCompany (admin-only check — verify userId is in admins array), getCompanyBySlug query, addAdmin mutation (admin-only).

## End Goal with Specs
Full company entity: schema table, create/update mutations (admin-only updates), public page at /company/:slug with header (logo + cover), about section, and posts feed. Creator is auto-admin, can add other admins.

## Backlog
- [x] Add `companies` table to schema.ts: name (string), slug (string, indexed), logoStorageId (optional storage), coverStorageId (optional storage), description (string), website (optional string), industry (string), size (string), founded (optional string), locations (optional array of strings), createdBy (users id), admins (array of users ids), createdAt (number). Index on slug.
- [x] Add `companyFollowers` table to schema.ts: companyId (companies id), userId (users id), createdAt (number). Index on companyId and byCompanyAndUser.
- [ ] Create `src/convex/companies.ts` with mutations: createCompany (auth required, creator becomes admin), updateCompany (admin-only check — verify userId is in admins array), getCompanyBySlug query, addAdmin mutation (admin-only). <- current
- [ ] Create `src/components/company/CompanyPage.js` — route `/company/:slug`, loads company by slug, displays: cover photo, logo, name, industry, size, follower count, admin actions dropdown. Use MUI Card, Avatar, Typography. Match the green theme (#2e7d32 / theme.palette.primary).
- [ ] Add `/company/:slug` route to App.js (import CompanyPage lazily).
- [ ] Run `cd linkedin-demo && npx convex dev --once` to push schema + functions, then `cd linkedin-demo && npm run build` to verify no build errors.
- [ ] Commit with descriptive message.

## Notes
- Project root: /Users/Richard.Mladek/Documents/projects/agentic/linkedin-demo
- Convex functions: src/convex/
- Components: src/components/
- App routes: src/App.js
- Schema: src/convex/schema.ts
- Use getAuthUserId(ctx) for auth checks in all mutations
- MUI v4: @material-ui/core, @material-ui/icons
- IMPORTANT: Only modify files in linkedin-demo/ directory
