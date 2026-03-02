## Current Task
Update Network connections UX: self-filtered list, real status-aware action buttons, pending incoming requests, and real connection counts.

## End Goal with Specs
- Connect button on Profile and Network calls `sendConnectionRequest` mutation
- Button states: "Connect" (none), "Pending" (sent), "Accept/Reject" (received), "Connected ✓" (accepted), "Remove" on hover when connected
- No self-connect: hide Connect button when viewing own profile, exclude self from Network list
- Profile page shows real connection count from `getConnectionCount` query (not hardcoded 500)
- Clickable "X connections" link on profiles opens a connections list view
- Connections list shows user cards (avatar, name, title) — clickable to navigate to that user's profile
- Pending incoming requests shown in Network tab with Accept/Reject buttons
- Remove hardcoded `connections` and `followers` numbers — use real queries
- `npm run build` passes

## Backlog
- [x] Update `linkedin-demo/src/components/profile/Profile.js`:
  - Import `useQuery, useMutation` from `convex/react`, `api` from convex
  - Query `api.connections.getConnectionStatus({ userId1: authUser._id, userId2: profileUserId })` to get button state
  - Query `api.connections.getConnectionCount({ userId: profileUserId })` for real count
  - Replace hardcoded `connections` (fallback 500) with real count
  - Remove hardcoded `followers` display or keep as cosmetic "0 followers"
  - Connect button: if status="none" show "Connect" → calls `sendConnectionRequest({ fromUserId: authUser._id, toUserId: profileUserId })`; if status="pending" and direction="sent" show "Pending" (disabled); if status="pending" and direction="received" show "Accept" + "Reject" buttons; if status="accepted" show "Connected ✓" with "Remove" on hover → calls `removeConnection({ connectionId })`
  - Hide Connect button entirely when `authUser._id === profileUserId` (own profile)
  - Make "X connections" text clickable — onClick sets a `showConnections` state to true
  - When `showConnections` is true, render a connections list panel (query `api.connections.listConnections({ userId: profileUserId })`). Each item: Avatar + displayName + title, clickable to navigate to that user's profile via `onViewProfile(user._id)`.
- [ ] Update `linkedin-demo/src/components/network/Network.js`: <- current
  - Filter out current user from the users list: `filteredUsers = users.filter(u => u._id !== user?._id)`
  - For each user card, query `api.connections.getConnectionStatus` to show correct button state
  - Wire Connect button to `sendConnectionRequest` mutation
  - Add a "Pending Requests" section at top: query `api.connections.listPendingRequests({ userId: user._id })`. Show Accept/Reject buttons for each.
  - Show connection count on each user card
- [ ] Update `linkedin-demo/src/components/sidebar/sidebarTop/SidebarTop.js`:
  - Import `useQuery` and query `api.connections.getConnectionCount({ userId: user._id })` for real count
  - Replace `user?.connections ?? 0` with the real query result
- [ ] Run `cd linkedin-demo && npm run build` to verify build passes
- [ ] Commit: "Wire connections frontend: real mutations, status states, connections list, real counts"

## Notes
- All paths from repo root: `/Users/Richard.Mladek/Documents/projects/agentic/`
- Run npm commands from `linkedin-demo/`
- Backend API (already deployed at `linkedin-demo/src/convex/connections.ts`):
  - `api.connections.sendConnectionRequest({ fromUserId, toUserId })` — returns connectionId
  - `api.connections.acceptConnection({ connectionId })`
  - `api.connections.rejectConnection({ connectionId })`
  - `api.connections.removeConnection({ connectionId })`
  - `api.connections.getConnectionStatus({ userId1, userId2 })` — returns { status: "none"|"pending"|"accepted", connectionId?, direction?: "sent"|"received" }
  - `api.connections.listConnections({ userId })` — returns [{ connectionId, user: { _id, displayName, photoURL, title, location } }]
  - `api.connections.listPendingRequests({ userId })` — returns [{ connectionId, user: { _id, displayName, photoURL, title, location } }]
  - `api.connections.getConnectionCount({ userId })` — returns number
- Profile.js at `linkedin-demo/src/components/profile/Profile.js`
- Network.js at `linkedin-demo/src/components/network/Network.js`
- SidebarTop.js at `linkedin-demo/src/components/sidebar/sidebarTop/SidebarTop.js`
- `useConvexUser()` returns the auth user or null
- Green colors: primary #2e7d32, light #66bb6a, dark #1b5e20
- Skip queries when user is null (unauthenticated): use `useQuery(api.connections.X, user?._id ? { ... } : "skip")`
