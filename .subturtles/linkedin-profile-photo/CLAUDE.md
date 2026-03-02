## Current Task
All backlog items complete.

## End Goal with Specs
- Users can upload profile photo from profile page.
- File stored in Convex storage; user record stores `photoStorageId` and `photoURL` (if needed).
- Avatar across app uses updated photo.

## Backlog
- [x] Update `linkedin-demo/src/convex/schema.ts` to add `photoStorageId` (optional string or Id) if needed.
- [x] Add `generateUploadUrl` + `saveProfilePhoto` mutations in `linkedin-demo/src/convex/users.ts` (store storageId, set photoURL to `null` or a resolved URL if already used).
- [x] Add UI in `linkedin-demo/src/components/profile/Profile.js` for file picker + upload flow.
- [x] Ensure `useConvexUser` uses new photo field if present.
- [x] Commit: `add profile photo upload`

## Notes
- Use Convex storage APIs; follow existing patterns for file uploads if present.
- Keep backward compatibility with existing `photoURL`.

## Loop Control
STOP
