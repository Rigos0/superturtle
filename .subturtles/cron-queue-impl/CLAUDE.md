# Current task
Update drain loop in `src/deferred-queue.ts` so it handles both queued user messages and queued cron jobs, with user messages always draining before cron jobs.

# End goal with specs
Generalize the existing deferred queue from user-messages-only to a typed queue supporting both user messages and cron jobs. When a non-silent cron job fires and the driver is busy, it should be enqueued and drained when the driver becomes idle — just like user messages. User messages always drain before cron jobs. Recurring jobs coalesce by jobId (at most one queued occurrence). One-shot jobs each get their own slot. Typecheck must pass. All existing tests must still pass. New tests must cover the new behavior.

# Roadmap (Completed)
- Designed the cron job queuing solution (see design below)

# Roadmap (Upcoming)
- Implement the deferred cron queue

# Backlog
- [x] Refactor `src/deferred-queue.ts`: add `DeferredCronJob` type alongside existing `DeferredMessage`, create discriminated union `DeferredQueueItem`, add `enqueueDeferredCronJob(chatId, job)` and `isCronJobQueued(chatId, jobId)` helpers
- [ ] Update drain loop in `src/deferred-queue.ts`: `drainDeferredQueue` must handle both item kinds — user messages call `runMessageWithActiveDriver()` as today, cron items call the non-silent cron execution path. User items always drain before cron items. <- current
- Update `src/index.ts` cron timer (lines ~520-530): when `isAnyDriverRunning()` is true for a non-silent cron job, call `enqueueDeferredCronJob()` instead of `continue`. Do NOT remove/advance the cron record at enqueue time — defer that to drain-time execution. Track queued jobIds in a local Set to avoid re-enqueueing the same due job on every tick.
- Update `src/index.ts` cron timer idle path: after processing due jobs, call `drainDeferredQueue()` for queued cron items so they run even without a new user message arriving.
- Add coalescing logic: recurring jobs coalesce by jobId (keep only the latest scheduledFor). One-shot jobs each get their own queue slot. Cap: 10 cron items per chat, separate from the 10 user message cap.
- Add tests: busy driver causes non-silent cron enqueue instead of skip, queued cron drains once driver idle, user messages drain before cron jobs, recurring jobs coalesce by jobId, one-shot jobs not lost on preemption
- Run `bun run --bun tsc --noEmit` in `super_turtle/claude-telegram-bot/` to verify typecheck
- Run `bun test` in `super_turtle/claude-telegram-bot/` to verify all tests pass (ignore pre-existing failures in driver-routing, stop handlers, pino logs — those are known)
- Commit changes with a clear message

## Design reference

Core idea: Generalize deferred queue from user-messages-only to typed queue with `kind: "user_message"` | `kind: "cron_job"`.

Key files:
- `src/deferred-queue.ts` — existing queue, refactor target
- `src/index.ts` lines 500-800 — cron timer loop, change skip to enqueue
- `src/handlers/text.ts` — text handler that calls drainDeferredQueue in finally

Current behavior: `isAnyDriverRunning()` check at line ~524 does `continue` (skip) for non-silent cron jobs. One-shot jobs removed before execution = lost forever if skipped. Recurring advanced = just tries next interval.

Proposed changes:
1. `DeferredQueueItem = DeferredUserMessage | DeferredCronJob` discriminated union
2. Each `DeferredCronJob` carries: `kind: "cron_job"`, `jobId`, `jobType`, `prompt`, `silent` (false for non-silent), `enqueuedAt`, `scheduledFor`
3. Drain order: all user messages first, then cron jobs (user-first priority)
4. Recurring jobs coalesce by jobId (at most one in queue). One-shot jobs each get own slot.
5. Remove/advance cron record at drain-time execution, NOT at enqueue time
6. Separate caps: 10 user messages + 10 cron items per chat
7. Cron timer idle path triggers drain so cron items run without needing a user message
8. `enqueueDeferredCronJob()` returns boolean (true if enqueued, false if coalesced/capped)
