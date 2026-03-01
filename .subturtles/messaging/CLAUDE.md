## Current Task
Wire messaging tab in App.js so `activeTab === "messaging"` renders `<Messaging />` instead of "Coming soon".

## End Goal with Specs
- `conversations` table in Convex schema: participants (array of user IDs), createdAt
- `messages` table: conversationId, senderId, body, createdAt
- Backend: createConversation, sendMessage, listConversations (for current user), listMessages (for a conversation)
- "Messaging" tab in header/bottom-nav already exists (TelegramIcon) — wire it to show messaging view
- Conversation list view: shows each conversation with other participant's name + avatar + last message preview
- Message thread view: shows messages in a conversation, input to send new message
- Real-time message delivery via Convex reactive queries
- Green accent (#2e7d32) consistent with app branding
- `npx convex dev --once` + `npm run build` both pass

## Backlog
- [x] Add `conversations` and `messages` tables to `linkedin-demo/src/convex/schema.ts`. Conversations: `participants` (v.array(v.id("users"))), `createdAt` (v.number()). Messages: `conversationId` (v.id("conversations")), `senderId` (v.id("users")), `body` (v.string()), `createdAt` (v.number()).
- [x] Create `linkedin-demo/src/convex/messaging.ts` with these functions:
  - `createConversation` mutation: args { participantIds: v.array(v.id("users")) }. Check if conversation with same participants already exists (query all conversations, filter). If exists return existing ID. Otherwise insert new conversation.
  - `sendMessage` mutation: args { conversationId: v.id("conversations"), senderId: v.id("users"), body: v.string() }. Insert message.
  - `listConversations` query: args { userId: v.id("users") }. Query all conversations, filter where participants includes userId. For each, join the OTHER participant's user data (displayName, photoURL) and get the latest message. Sort by latest message createdAt desc.
  - `listMessages` query: args { conversationId: v.id("conversations") }. Query all messages for the conversation, join sender data (displayName, photoURL), sort by createdAt asc.
- [x] Create messaging UI component at `linkedin-demo/src/components/messaging/Messaging.js`. Two sub-views:
  1. **ConversationList** — default view. Uses `useQuery(api.messaging.listConversations, { userId: user._id })`. Each item shows: Avatar of other participant, their displayName, last message preview (truncated to 50 chars), time ago. Clicking a conversation opens the thread.
  2. **MessageThread** — shows when a conversation is selected. Header with back arrow + other user's name. Scrollable message list (own messages right-aligned green, others left-aligned grey). Input bar at bottom with text input + Send button.
  Import `useConvexUser` from hooks. Import `useMutation, useQuery` from `convex/react`. Import `api` from convex.
- [x] Create `linkedin-demo/src/components/messaging/Style.js` with Material-UI `makeStyles`. Style the conversation list items (avatar + text + timestamp row), message bubbles (green #2e7d32 for own, #e0e0e0 for others), input bar, and back button.
- [ ] Wire messaging tab in App.js: The `activeTabLabel` map already has "Messaging" as a key but renders "Coming soon." Change it so when `activeTab === "messaging"` (update the key from current mapping), render `<Messaging />` component instead of the "Coming soon" Paper. Note: the bottom nav in Header.js uses `tabItems` array — check if "messaging" key exists there, if not add it (the TelegramIcon is already in the `items` array for desktop nav). <- current
- [ ] Push functions: `cd linkedin-demo && npx convex dev --once`
- [ ] Build: `cd linkedin-demo && npm run build`
- [ ] Commit with message "Add real-time messaging: conversations, messages, chat UI"

## Notes
- All paths from repo root: `/Users/Richard.Mladek/Documents/projects/agentic/`
- Run npm/convex commands from `linkedin-demo/`
- Schema at `linkedin-demo/src/convex/schema.ts` — already has authTables, users, posts, likes, comments
- App.js at `linkedin-demo/src/App.js` — uses `activeTab` state for tab switching
- Header.js at `linkedin-demo/src/components/header/Header.js` — has TelegramIcon in desktop nav items, `tabItems` array for bottom nav
- `useConvexUser()` hook returns the current auth user (with ._id)
- Green colors: primary #2e7d32, light #66bb6a
- The existing "Coming soon" pattern in App.js (lines 113-117) is what we replace for the messaging tab
