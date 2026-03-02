## Current Task
All backlog items complete.

## End Goal with Specs
- Users can upload a cover photo from profile page header area.
- File stored in Convex storage; user record stores `coverStorageId` and/or `coverURL`.
- Profile header renders cover image if present, otherwise default styling.

## Backlog
- [x] Update `linkedin-demo/src/convex/schema.ts` to add `coverStorageId` (optional).
- [x] Add `generateCoverUploadUrl` + `saveCoverPhoto` mutations in `linkedin-demo/src/convex/users.ts`.
- [x] Update `linkedin-demo/src/components/profile/Profile.js` to render cover image + upload UI.
- [x] Commit: `add profile cover photo upload`

## Notes
- Use Convex storage APIs; ensure only current user can update their cover.
- Keep UI simple: camera/edit icon overlay.

## Loop Control
STOP
