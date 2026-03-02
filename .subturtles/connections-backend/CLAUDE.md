## Current Task
All backlog items complete.

## End Goal with Specs
- New `connections` table in Convex schema with: userId1, userId2, status ("pending"|"accepted"), requestedBy, createdAt
- Mutations: sendConnectionRequest, acceptConnection, rejectConnection, removeConnection
- Queries: getConnectionStatus (between two users), listConnections (for a user), listPendingRequests (incoming), getConnectionCount
- Self-connect prevention: sendConnectionRequest throws if userId1 === userId2
- Duplicate prevention: can't send a request if one already exists between the two users
- Real connection counts: getConnectionCount query counts accepted connections (replaces hardcoded `connections` field on user)
- Connection request creates a notification (type="connection_request")
- Accepting a connection creates a notification (type="connection_accepted")
- `npx convex dev --once` passes with no errors
- All existing functionality unaffected

## Backlog
- [x] Add `connections` table to `linkedin-demo/src/convex/schema.ts`:
  ```
  connections: defineTable({
    userId1: v.id("users"),    // the user who sent the request
    userId2: v.id("users"),    // the user who received the request
    status: v.string(),        // "pending" | "accepted"
    requestedBy: v.id("users"),// same as userId1 (who initiated)
    createdAt: v.number(),
  }).index("byUsers", ["userId1", "userId2"])
    .index("byUser1", ["userId1", "status"])
    .index("byUser2", ["userId2", "status"]),
  ```
- [x] Create `linkedin-demo/src/convex/connections.ts` with these functions:
  - `sendConnectionRequest` mutation: args { fromUserId: v.id("users"), toUserId: v.id("users") }. Validates fromUserId !== toUserId (throw "Cannot connect with yourself"). Checks no existing connection between the pair (check both directions: userId1/userId2 and userId2/userId1). Inserts with status="pending", requestedBy=fromUserId. Creates notification: type="connection_request", userId=toUserId, fromUserId=fromUserId.
  - `acceptConnection` mutation: args { connectionId: v.id("connections") }. Patches status to "accepted". Creates notification: type="connection_accepted", userId=requestedBy, fromUserId=the other user.
  - `rejectConnection` mutation: args { connectionId: v.id("connections") }. Deletes the connection record.
  - `removeConnection` mutation: args { connectionId: v.id("connections") }. Deletes the connection record (unfriend).
  - `getConnectionStatus` query: args { userId1: v.id("users"), userId2: v.id("users") }. Returns { status: "none"|"pending"|"accepted", connectionId?: Id, direction?: "sent"|"received" }. Checks both directions.
  - `listConnections` query: args { userId: v.id("users") }. Returns all accepted connections for this user (both directions). Joins user data (displayName, photoURL, title, location). Returns array of { connectionId, user: { _id, displayName, photoURL, title, location } }.
  - `listPendingRequests` query: args { userId: v.id("users") }. Returns pending connections where userId2=userId (incoming requests). Joins requester user data.
  - `getConnectionCount` query: args { userId: v.id("users") }. Counts accepted connections (both directions). Returns a number.
- [x] Run `npx convex dev --once` to push schema + functions
- [x] Commit: "Add connections backend: schema, mutations, queries, real counts"

## Notes
- All paths from repo root: `/Users/Richard.Mladek/Documents/projects/agentic/`
- Run npm/convex commands from `linkedin-demo/`
- Schema at `linkedin-demo/src/convex/schema.ts` — already has users, posts, likes, comments, conversations, messages, notifications + authTables
- notifications.ts at `linkedin-demo/src/convex/notifications.ts` — use `ctx.db.insert("notifications", {...})` directly to create notifications (don't call internal mutations)
- The old `connections: v.optional(v.number())` field on users table can stay — we'll just stop using it in favor of the real count query
- For checking both directions, query once with userId1=A,userId2=B and once with userId1=B,userId2=A using the byUsers index
- Convex doesn't support compound OR queries well, so use collect+filter or two index queries
- Green is irrelevant here — this is pure backend

## Loop Control
STOP
