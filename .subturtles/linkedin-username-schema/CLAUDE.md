## Current Task
All backlog items complete for username slug support.

## End Goal with Specs
- Users table has `username` (lowercase, URL-safe) with index.
- Backend provides:
  - `getUserByUsername({ username })`
  - `isUsernameAvailable({ username })`
  - `ensureUsername()` mutation that sets username for current user if missing by slugging displayName/name, ensuring uniqueness.
- Seed users have usernames (stable, slugged).
- No breaking changes to existing queries.

## Backlog
- [x] Update `linkedin-demo/src/convex/schema.ts` to add `username` field + index on `username`.
- [x] Add helpers + new query/mutation in `linkedin-demo/src/convex/users.ts`:
  - `getUserByUsername`
  - `isUsernameAvailable`
  - `ensureUsername` (use `getAuthUserId`, slugify displayName/name, de-dupe with numeric suffix).
- [x] Update `linkedin-demo/src/convex/seed.ts` to set `username` for seeded users (slugged).
- [x] Run quick type check by regenerating Convex types if needed (no tests required).
- [x] Commit with message: `add user username slug support`

## Notes
- Keep slug lowercase, URL-safe: `[a-z0-9-]` only; trim dashes.
- Ensure uniqueness by checking existing usernames and appending `-2`, `-3`, etc.
- Only set username when missing; do not overwrite existing.

## Loop Control
STOP
