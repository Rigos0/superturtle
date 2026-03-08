# Long-Run State Tracking and Conductor V2

## Goal

Make SubTurtle orchestration reliable even when:

- the bot restarts
- the meta agent is mid-conversation with the human
- the active driver changes between Claude and Codex
- silent check-ins are delayed or skipped
- workers finish, fail, or time out in the background

The system must be able to reconstruct exact worker state from disk without relying on chat history, prompt memory, or human-readable summaries.

## Core concept

Workers emit facts. The supervisor reconciles facts. The meta agent explains facts.

This is the control-plane split:

- SubTurtles are execution workers.
- The supervisor is the conductor.
- The meta agent is the human-facing interface.
- Durable state is the score they all read from.

Chat is not the control plane.
Silent check-ins are not the control plane.
`handoff.md` is not the control plane.

## Why SubTurtles exist

SubTurtles exist to give Super Turtle capabilities that the main chat loop should not own directly:

- long-running focused execution
- parallel workstreams
- isolated worker context
- independent worker failure domains
- explicit handoff points between planning and execution

The main agent should stay coherent with the human. The workers should grind through bounded implementation tasks. The supervisor should keep the whole system correct.

## Ownership boundaries

### Human

The human owns product direction, priorities, approvals, and questions that materially change behavior or risk.

The human does not own:

- worker lifecycle bookkeeping
- background completion detection
- restart recovery
- cron cleanup
- internal orchestration state

### Meta agent

The meta agent owns:

- translating human intent into work
- decomposing work into SubTurtles
- explaining progress, completions, and blockers to the human
- reading durable orchestration state and making planning decisions from it

The meta agent does not own:

- being the only place where worker state exists
- remembering whether a worker already completed
- inferring truth from a prompt when the system can read a fact from disk

### Supervisor / conductor

The supervisor owns:

- worker lifecycle reconciliation
- durable event ingestion
- wake-up and notification queueing
- cleanup validation
- recovery after bot or session restart
- turning worker facts into deterministic state transitions

The supervisor is the single authority that decides whether a worker is:

- running
- completed
- failed
- timed_out
- stopped
- archived

### SubTurtle worker

Each SubTurtle owns:

- executing its assigned scope
- updating its local `CLAUDE.md`
- committing its work
- emitting checkpoints after successful iterations
- self-reporting completion
- self-reporting fatal failure when it cannot continue

A worker does not own:

- marking itself globally completed before cleanup is confirmed
- removing its own orchestration history
- deciding whether the human has already been notified

### Rendered views

Rendered views include:

- `handoff.md`
- dashboard summaries
- `/status` formatting
- Telegram notification text

These are outputs of orchestration state, never the source of truth.

## Lifecycle state model

Each worker has one canonical lifecycle state.

### Non-terminal states

- `planned`
  - The supervisor intends for this worker to exist, but spawn has not started.
- `starting`
  - Workspace creation, state seeding, or process launch is in progress.
- `running`
  - The worker process is alive and eligible to emit checkpoints.
- `completion_pending`
  - The worker declared itself done, but the supervisor has not yet reconciled cleanup, cron removal, and completion delivery.
- `failure_pending`
  - The worker reported a fatal error, but the supervisor has not yet reconciled process death, cleanup, and failure delivery.
- `stop_pending`
  - An external stop was requested and cleanup is underway.

### Terminal states

- `completed`
  - Completion was reconciled successfully.
- `failed`
  - The worker cannot continue due to a fatal error.
- `timed_out`
  - The watchdog or supervisor terminated the worker for exceeding its limit.
- `stopped`
  - The worker was intentionally stopped before completion.
- `archived`
  - The workspace has been archived after reaching a terminal state.

## State transition rules

- Only the supervisor may transition a worker into a terminal orchestration state.
- A worker may request completion or report failure, but that is not the same as the system declaring final completion.
- `failure_pending` is the failure-side analog of `completion_pending`: it means the worker emitted a fatal fact, but supervisor reconciliation still owns the terminal `failed` transition.
- `completed` means all of the following are true:
  - the worker reported completion
  - the process is no longer running
  - recurring supervision for that worker has been removed
  - the completion event was persisted
  - a completion notification was queued
- `archived` is always downstream of another terminal state.
- Silent cron checks may observe or trigger reconciliation, but they do not define truth on their own.

## Event model

The event log is append-only and records facts, not prose.

### Event categories

#### Intent events

- `worker.planned`
- `worker.spawn_requested`
- `worker.stop_requested`

#### Lifecycle events

- `worker.starting`
- `worker.started`
- `worker.running_confirmed`
- `worker.stop_started`
- `worker.stopped`
- `worker.timed_out`
- `worker.archived`

#### Worker fact events

- `worker.checkpoint`
- `worker.completion_requested`
- `worker.fatal_error`

#### Supervisor reconciliation events

- `worker.completed`
- `worker.failed`
- `worker.recovered`
- `worker.cron_removed`
- `worker.cleanup_verified`

#### Delivery events

- `worker.wakeup_requested`
- `worker.notification_enqueued`
- `worker.notification_sent`
- `worker.notification_suppressed`
- `worker.inbox_enqueued`

### Event requirements

Every event must include enough structure to answer:

- which worker did this affect?
- when did it happen?
- who emitted it?
- what state transition or fact does it represent?
- is it idempotent or retryable?

The exact schema is a follow-up design task. The invariant is more important than the field names: events must be machine-usable without reading surrounding chat context.

## Wake-up model

The system needs a durable way to wake the meta agent without depending on the current conversation turn.

### Required behavior

- Background worker events must land safely while the meta agent is busy with the human.
- High-priority events must not be lost just because the current chat turn is still running.
- Low-priority events must not interrupt a human conversation unnecessarily.
- Delivery must be retryable and idempotent.

### Conceptual model

The supervisor creates wake-up records when notable worker transitions occur.

Examples:

- completion became `completion_pending`
- worker transitioned to `failed`
- worker transitioned to `timed_out`
- milestone policy says a user-visible update is due
- a dependency was unblocked and new work can now be spawned

Those wake-up records are consumed separately from the human chat transcript. The active chat session may later receive a compact summary, but the event itself already exists durably before any message is sent.

### Delivery classes

- `critical`
  - failures, timeouts, stuck workers, cleanup corruption
  - may send a standalone Telegram message immediately
- `notable`
  - completion, important milestone, dependency release
  - should enqueue for near-term delivery without depending on conversational memory
- `silent`
  - routine confirmations with no human-facing consequence
  - persisted for audit/recovery, not sent to the human

## Silent check-ins in V2

Silent check-ins still have value, but their role changes.

In V1, silent check-ins were asked to infer what was happening.

In V2, silent check-ins should:

- reconcile durable worker state against live process facts
- detect missing cleanup
- detect missing notifications
- trigger wake-up records when needed
- collect extra diagnostics only when structured state is insufficient

They should not be the primary source of worker truth.

## Recovery model

After any restart, the supervisor must be able to:

1. load the canonical worker states
2. replay or scan the event log
3. inspect live processes and worker workspaces
4. repair stale states
5. re-enqueue any unsent wake-ups or notifications

If the bot crashes while the meta agent is mid-conversation, worker correctness must remain intact. At worst, delivery of a notification is delayed. The event itself cannot disappear.

## Invariants

These are the core conductor guarantees.

1. Durable state beats conversational state.
2. A worker cannot be both terminal and running after reconciliation.
3. No worker completion is considered final until cleanup is verified.
4. A notable background event may be delayed, but it may not be lost.
5. Replaying supervisor reconciliation after a restart must be safe and idempotent.
6. Derived views may be stale, but canonical worker state may not depend on them.
7. Silent check-ins may fail completely without corrupting the source of truth.
8. Multi-instance isolation must apply to orchestration artifacts just like logs and IPC.

## Current implementation gap

Current state tracking already has useful pieces:

- per-worker runtime metadata in `.subturtles/<name>/subturtle.meta`
- an append-only ledger in `.superturtle/state/runs.jsonl`
- a rendered summary in `.superturtle/state/handoff.md`

Those pieces are not yet enough to serve as the conductor control plane because:

- `subturtle.meta` is mostly spawn-time metadata
- `runs.jsonl` is too sparse for deterministic orchestration
- `handoff.md` is rendered summary, not canonical state
- silent check-ins still infer too much from prompts and repo state

## What stays the same

- `CLAUDE.md` remains the worker's task and progress document
- SubTurtles still self-stop via `## Loop Control` + `STOP`
- isolated workspaces remain the execution unit
- `ctl list`, `ctl status`, logs, dashboard, and Telegram updates remain operator-facing surfaces

## What changes

- orchestration truth moves out of prompts and summaries into structured state
- completion handoff becomes a deterministic supervisor path
- background wake-ups become queue-driven, not prompt-driven
- `handoff.md` becomes optional or purely rendered
- silent cron becomes reconciliation, not inference

## Minimal durable data model

The first control-plane scaffold now exists in `super_turtle/state/conductor_state.py`.

### File layout

Under `.superturtle/state/`:

- `events.jsonl`
  - canonical append-only conductor event log
- `workers/<name>.json`
  - canonical mutable worker state
- `wakeups/<id>.json`
  - durable wake-up and delivery records
- `inbox/<id>.json`
  - durable meta-agent inbox items for background worker events that need to be surfaced on the next interactive turn
- `runs.jsonl`
  - legacy ledger kept for compatibility during migration
- `handoff.md`
  - rendered summary view

### Worker state record

Each worker state file currently tracks:

- `worker_name`
- `run_id`
- `lifecycle_state`
- `workspace`
- `loop_type`
- `pid`
- `timeout_seconds`
- `cron_job_id`
- `current_task`
- `stop_reason`
- `completion_requested_at`
- `terminal_at`
- `created_at`
- `updated_at`
- `updated_by`
- `last_event_id`
- `last_event_at`
- `checkpoint`
- `metadata`

### Event record

Each event record currently tracks:

- `id`
- `timestamp`
- `worker_name`
- `run_id`
- `event_type`
- `emitted_by`
- `lifecycle_state`
- `idempotency_key`
- `payload`

### Wake-up record

Each wake-up record currently tracks:

- `id`
- `worker_name`
- `run_id`
- `reason_event_id`
- `category`
- `delivery_state`
- `summary`
- `created_at`
- `updated_at`
- `delivery`
- `payload`
- `metadata`

### Meta-agent inbox record

Each inbox record currently tracks:

- `id`
- `chat_id`
- `worker_name`
- `run_id`
- `priority`
- `category`
- `title`
- `text`
- `delivery_state`
- `source_event_id`
- `source_wakeup_id`
- `created_at`

## Core flow validation matrix

These are the 15 user-shaped pathways the conductor must keep correct.

| # | Pathway | Expected behavior | Primary coverage |
| --- | --- | --- | --- |
| 1 | Single worker first silent check | Baseline is recorded, no Telegram noise, no inbox item, cron stays armed | `src/conductor-core-flow.test.ts`, `src/conductor-supervisor.test.ts` |
| 2 | Single worker milestone | Deterministic milestone wakeup, Telegram update, inbox item, cron stays armed | `src/conductor-core-flow.test.ts`, `src/conductor-supervisor.test.ts` |
| 3 | Single worker self-stop completion | Completion wakeup reconciles to terminal state, cleanup is verified, notification is sent, inbox item is queued | `src/conductor-core-flow.test.ts`, `src/conductor-supervisor.test.ts` |
| 4 | Single worker fatal error | Fatal wakeup reconciles to failed state, notification is sent, inbox item is queued | `src/conductor-supervisor.test.ts` |
| 5 | Single worker timeout | Timeout wakeup reconciles to `timed_out`, cleanup is verified, notification is sent, inbox item is queued | `src/conductor-core-flow.test.ts` |
| 6 | Single worker stuck path | Repeated no-progress checks emit one stuck wakeup without terminal cleanup side effects | `src/conductor-supervisor.test.ts` |
| 7 | Reused worker name on a new run | Old checkpoint/supervisor/wakeup state does not corrupt the new run | `src/conductor-supervisor.test.ts`, `src/conductor-maintenance.test.ts`, `super_turtle/state/test_run_state_writer.py` |
| 8 | Missing wakeup recovery | Canonical worker state recreates missing completion/failure/timeout wakeups after interruption | `src/conductor-supervisor.test.ts` |
| 9 | Interrupted wakeup delivery replay | Wakeups stranded in `processing` are safely requeued and replayed | `src/conductor-supervisor.test.ts`, `src/conductor-maintenance.test.ts` |
| 10 | Stale recurring cron cleanup | Recurring SubTurtle cron is removed exactly once when the worker is gone | `src/conductor-supervisor.test.ts`, `super_turtle/subturtle/tests/test_ctl_integration.sh` |
| 11 | Parallel SubTurtles with mixed outcomes | One worker can milestone while others complete/fail without cross-worker mutation or cron corruption | `src/conductor-core-flow.test.ts` |
| 12 | Parallel worker inbox ordering | Multiple background events remain ordered and pending until the next interactive ack | `src/conductor-core-flow.test.ts`, `src/conductor-supervisor.test.ts` |
| 13 | Next Claude turn consumes background worker events | Pending inbox items are injected into the next interactive Claude turn and only acknowledged after success | `src/session.conductor-inbox.test.ts` |
| 14 | Next Codex turn consumes background worker events | Pending inbox items are injected into the next interactive Codex turn and only acknowledged after success | `src/codex-session.conductor-inbox.test.ts` |
| 15 | Driver/model changes while workers run | Switching driver or model does not lose pending worker events; the next turn on the chosen driver still gets the durable inbox context | `src/handlers/switch-new-session.trace.test.ts`, `src/handlers/codex.flow.test.ts`, `src/session.conductor-inbox.test.ts`, `src/codex-session.conductor-inbox.test.ts` |

The matrix is meant to be a living contract. When conductor behavior changes, update the matching row and either extend the referenced test or add a new one before changing the runtime logic.
- `updated_at`
- `delivery`
- `metadata`

### Current status

The control-plane scaffold is now live in runtime paths.

Current producer coverage:

- `subturtle/ctl` writes canonical worker state and events for:
  - `worker.started`
  - `worker.stop_requested`
  - `worker.stopped`
  - `worker.timed_out`
  - `worker.archived`
- `subturtle/ctl` enqueues canonical wake-ups for watchdog timeouts
- the Python worker loop writes `worker.checkpoint` after successful iterations and refreshes the mutable worker checkpoint record
- the Python worker loop writes `worker.completion_requested`, transitions the worker to `completion_pending`, and enqueues a notable wake-up before self-stop
- the Python worker loop writes `worker.fatal_error`, transitions the worker to `failure_pending`, and enqueues a critical wake-up when an unhandled loop error escapes
- the bot timer consumes pending wake-ups directly from `.superturtle/state/wakeups/`, appends reconciliation events (`worker.completed`, `worker.failed`, `worker.cleanup_verified`, `worker.cron_removed`, `worker.inbox_enqueued`, `worker.notification_sent`), and sends Telegram notifications without injecting those lifecycle facts into the meta-agent session
- the bot timer also writes `.superturtle/state/inbox/<id>.json` for notable/critical lifecycle wake-ups so the next successful interactive Claude/Codex turn sees those background events as injected context and then acknowledges them durably
- the bot timer now runs deterministic silent supervision for structured SubTurtle cron jobs, comparing canonical checkpoint/backlog signatures across checks and emitting `worker.milestone_reached` / `worker.stuck_detected` plus notable wake-ups when policy thresholds are met
- the bot timer now repairs missing `completion_requested`, `fatal_error`, and `timeout` wake-ups from canonical worker state before delivery, so pending terminal transitions can still complete after a bot restart or partial state loss
- the bot now runs the same conductor maintenance pass once at startup and then on every timer tick, so wake-up recovery and stale recurring-cron cleanup happen immediately after a reboot instead of waiting for the first cron interval
- startup conductor maintenance also requeues wake-ups stranded in `processing`, so a crash between the pre-send write and the final `sent` write becomes replayable recovery state instead of a permanent wedge
- the 10-second bot cron loop is now single-flight and is armed only after boot-time maintenance completes, so restart recovery runs before recurring ticks and slow maintenance/delivery work cannot overlap the next timer tick
- starting a new run with a reused worker name now resets prior checkpoint, supervisor metadata, and terminal residue instead of inheriting the previous run's progress signature
- `ctl stop` now persists `worker.cron_removed` on successful stop-path cron cleanup, removes `CRON_JOB_ID` from the runtime meta file, and clears the canonical worker `cron_job_id` field before archive
- wakeup recovery, stale-cron cleanup gating, and pending wakeup delivery now match by `worker_name` plus `run_id`, so a stale wakeup from an older run with the same worker name cannot reconcile against the current run's state
- stale recurring SubTurtle cron cleanup is now persisted back into conductor state via `worker.cron_removed`, rather than existing only as an operator warning path

The migration is still in a mixed mode:

- legacy `.subturtles/<name>/subturtle.meta` remains the runtime metadata source for PID/timeout/cron details
- legacy `.superturtle/state/runs.jsonl` and `handoff.md` still exist for compatibility and current operator surfaces
- `ctl spawn` now writes structured supervision cron metadata (`job_kind`, `worker_name`, `supervision_mode`) so recurring checks resolve workers from disk state first instead of depending on prompt regexes
- silent SubTurtle cron is now a deterministic reconciliation trigger, not a prompt-driven inference path
- milestone and stuck wake-ups now go through the same inbox + Telegram delivery flow as completion/failure wake-ups, while cron removal and cleanup verification remain terminal-only side effects
- `handoff.md` now renders from canonical worker state plus outstanding pending/processing wakeups, and recent updates render archived completed/failed workers by canonical resolved terminal outcome instead of dropping them entirely
- preview/tunnel URLs are attached to milestone wake-ups when present, but they are not yet a standalone milestone trigger

The next step is to keep expanding restart and multi-worker coverage around the shared maintenance path, not to add another orchestration layer.

## Verification

Focused tests for this slice:

```bash
python3 -m unittest super_turtle.state.test_run_state_writer super_turtle.state.test_conductor_state
python3 -m py_compile super_turtle/state/run_state_writer.py super_turtle/state/conductor_state.py super_turtle/state/test_conductor_state.py
python3 -m pytest super_turtle/subturtle/tests/test_subturtle_main.py
bash super_turtle/subturtle/tests/test_ctl_integration.sh
bun run --bun tsc --noEmit
bun test src/conductor-supervisor.test.ts src/conductor-inbox.test.ts src/session.conductor-inbox.test.ts src/codex-session.conductor-inbox.test.ts
```

## Next implementation slice

Prove the conductor behavior end to end:

- restart recovery with pending wake-ups and pending inbox items
- stale recurring-cron cleanup after worker death
- mid-chat delivery of background worker completion/failure/milestone updates
- multi-worker orchestration and reconciliation ordering
