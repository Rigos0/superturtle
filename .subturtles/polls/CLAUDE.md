## Current Task
Run `cd linkedin-demo && npx convex dev --once` to push schema.

## End Goal with Specs
Item 31 from Phase 2: Poll posts with 2-4 options, voting, and percentage results display.
- New "Create Poll" option in post composer
- Poll UI: question + 2-4 option fields
- Users vote once per poll, can change vote
- Results show vote counts and percentages with progress bars
- Poll stored in Convex with votes table

## Backlog
- [x] Add `polls` and `pollVotes` tables to schema (`linkedin-demo/src/convex/schema.ts`) — polls: postId, question, options (array of strings); pollVotes: pollId, userId, optionIndex
- [x] Create `linkedin-demo/src/convex/polls.ts` — mutations: createPoll(postId, question, options), vote(pollId, optionIndex), changeVote(pollId, optionIndex); queries: getPoll(postId), getResults(pollId), getUserVote(pollId)
- [x] Add "Create Poll" toggle to post composer (`linkedin-demo/src/components/posts/postMaker/PostMaker.js`) — shows poll form fields when toggled
- [x] Create `linkedin-demo/src/components/posts/poll/PollDisplay.js` — renders poll in feed: question, options as clickable bars, vote counts/percentages after voting
- [x] Wire PollDisplay into Post.js — if post has associated poll, render PollDisplay below post text
- [ ] Run `cd linkedin-demo && npx convex dev --once` to push schema <- current
- [ ] Test and commit

## Notes
- Post composer: `linkedin-demo/src/components/posts/postMaker/PostMaker.js`
- Post component: `linkedin-demo/src/components/posts/post/Post.js`
- Schema: `linkedin-demo/src/convex/schema.ts`
- Follow existing patterns in likes.ts for vote mutations
- Progress: Added `linkedin-demo/src/convex/polls.ts` with create/vote/changeVote mutations and poll result/user-vote queries.
- Verification: `cd linkedin-demo && npx convex codegen` completes successfully after adding poll functions.
