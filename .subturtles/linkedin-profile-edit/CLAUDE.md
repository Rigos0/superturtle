## Current Task
All backlog items completed for profile edit modal and profile update mutation.

## End Goal with Specs
- Profile page has an edit button that opens a modal with fields: displayName, title, headline, location, about.
- Save calls Convex mutation to update current user fields.
- UI updates on save; errors shown in console (no toast requirement yet).

## Backlog
- [x] Add `updateCurrentUserProfile` mutation in `linkedin-demo/src/convex/users.ts` (auth required; patch fields).
- [x] Add edit modal UI in `linkedin-demo/src/components/profile/Profile.js` (Material-UI dialog) and wire to mutation.
- [x] Update `useConvexUser`/profile rendering to reflect updated fields (if needed).
- [x] Commit: `add profile edit modal`

## Notes
- Keep fields optional; only update provided values.
- Do not change other files outside `linkedin-demo/`.

## Loop Control
STOP
