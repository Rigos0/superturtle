## Current Task
All backlog items are complete.

## End Goal with Specs
- Profile "Message" button creates/opens a conversation with that user and navigates to Messaging
- Profile "Connect" button shows visual feedback (toggles to "Pending" with disabled state)
- Notification clicks navigate to the source: like/comment → scroll to post on home feed, message → open messaging
- Network "Connect" button shows visual feedback (toggles to "Pending")
- Build passes: `npm run build`

## Backlog
- [x] Wire Profile "Message" button in `linkedin-demo/src/components/profile/Profile.js`: The button at ~line 162-175 needs an `onClick`. It should: (1) call a new `getOrCreateConversation` mutation with the current user ID and the profile user ID, (2) navigate to messaging tab by calling a new prop `onNavigateMessaging` or setting activeTab. Profile.js needs a new prop from App.js for this. In App.js, pass `onNavigateMessaging={() => { setActiveTab("messaging"); setView("feed"); }}` as a prop to Profile.
- [x] Create `getOrCreateConversation` mutation in `linkedin-demo/src/convex/messaging.ts`: Args: `{ userId1: v.id("users"), userId2: v.id("users") }`. Check if a conversation with both participants exists (filter conversations where participants array contains both IDs). If yes, return its ID. If no, create a new conversation with `participants: [userId1, userId2], createdAt: Date.now()` and return its ID. Export as `getOrCreateConversation`.
- [x] Wire Profile "Connect" button in `linkedin-demo/src/components/profile/Profile.js`: Add local state `const [connectPending, setConnectPending] = useState(false)`. On click, toggle to "Pending" (disabled, grey outline). This is cosmetic — no backend needed. Button text: connectPending ? "Pending" : "Connect". Style: pending gets `opacity: 0.6, cursor: "default"`.
- [x] Wire notification click-through in `linkedin-demo/src/components/notifications/Notifications.js`: Pass `onViewPost` and `onViewProfile` props from App.js. In `handleItemClick`, after marking as read: if `notification.type === "like" || notification.type === "comment"`, call `onViewPost(notification.postId)` — which should navigate to home and scroll to post. If `notification.type === "message"`, call `onNavigateMessaging()` (set activeTab to messaging). Add these props: `onViewPost`, `onViewProfile`, `onNavigateMessaging`.
- [x] Add `onViewPost` handler in `linkedin-demo/src/App.js`: Create `const onViewPost = (postId) => { setActiveTab("home"); setView("feed"); setTimeout(() => { const el = document.getElementById("post-" + postId); if (el) el.scrollIntoView({ behavior: "smooth", block: "center" }); }, 200); }`. Pass to Notifications component.
- [x] Wire Network "Connect" button in `linkedin-demo/src/components/network/Network.js`: Currently at line 102-109 the button has `onClick={(event) => event.stopPropagation()}`. Add local state tracking which user IDs have been "connected" (`const [pendingIds, setPendingIds] = useState(new Set())`). On click, add user ID to pendingIds set. Button text: `pendingIds.has(user._id) ? "Pending" : "Connect"`. Pending style: `opacity: 0.6`.
- [x] Pass new props through App.js: Notifications needs `onViewPost`, `onNavigateMessaging`. Profile needs `onNavigateMessaging`. Verify these are threaded through correctly.
- [x] Push: `cd linkedin-demo && npx convex dev --once`
- [x] Build: `cd linkedin-demo && npm run build`
- [x] Commit: "Wire dead buttons: profile message, notification links, connect feedback"

## Notes
- Repo root: `/Users/Richard.Mladek/Documents/projects/agentic/`
- Run npm/convex commands from `linkedin-demo/`
- App.js at `linkedin-demo/src/App.js` — main routing, state management, prop threading
- Profile.js at `linkedin-demo/src/components/profile/Profile.js`
- Notifications.js at `linkedin-demo/src/components/notifications/Notifications.js`
- Network.js at `linkedin-demo/src/components/network/Network.js`
- messaging.ts at `linkedin-demo/src/convex/messaging.ts` — add getOrCreateConversation
- Posts have `id={\`post-${postId}\`}` on the Paper element — scrollIntoView target
- Profile receives props: `userId`, `onBack`, `onViewProfile` — needs new: `onNavigateMessaging`
- Notifications receives no navigation props currently — needs: `onViewPost`, `onNavigateMessaging`
- Green colors: primary #2e7d32

## Loop Control
STOP
