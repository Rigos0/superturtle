# Task Decomposition Protocol

Use this guide when a user gives a high-level build request and the work should be split across parallel SubTurtles.

## Goal

Turn "build X" requests into a clear execution plan that:
- Runs safe work in parallel
- Preserves dependency order when needed
- Keeps user-facing updates simple ("what's running" and major milestones)

## When To Decompose

Decompose when at least one of these is true:
- The request contains multiple features or surfaces (for example: search, filters, export).
- A single backlog would likely exceed 3 items for one focused SubTurtle chunk.
- Work can be safely parallelized across independent files/domains.

## When NOT To Decompose

Do not decompose when any of these apply:
- Simple fix or tiny change (single-file edit, typo, one-function bug fix).
- Strong sequential dependency chain where parallel workers would idle.
- High coupling where splitting would increase merge risk more than speed.

## Hard Constraints

- Maximum 5 SubTurtles per user request.
- Each SubTurtle should have 3-7 backlog items.
- Naming format: `<project>-<feature>` (lowercase, hyphenated).
- Example names: `dashboard-search`, `dashboard-filters`, `billing-void-endpoint`.
- Respect runtime loop-type capabilities: when Codex is disabled/unavailable, decompose assuming Claude loop types (`yolo`/`slow`) only.

## Decomposition Workflow

1. Extract requested capabilities from the user message.
2. Group capabilities into independent workstreams.
3. Mark dependencies (`A -> B`) and split into:
   - Parallel set: tasks with no blockers
   - Queued set: tasks blocked on earlier work
4. Enforce limits:
   - If >5 workstreams, merge smallest related streams or queue extras.
   - If a stream has <3 backlog items, merge it into a related stream.
5. Spawn ready SubTurtles first; queue blocked SubTurtles until dependency completion.
6. Tell the user what started now and what is queued.

## Dependency Handling Rule

If B depends on A:
- Spawn A first and record B as queued.
- When A completes, read `.superturtle/state/results/<A-name>.json` before spawning B.
- Inject A's results into B's CLAUDE.md using the format below.
- Never spawn a blocked SubTurtle "just in case."

## Result-Passing Pattern

Workers write a structured result file at `.superturtle/state/results/<worker-name>.json` when
they complete all backlog items. When spawning a dependent worker B after A completes, always
read A's result file first, then inject A's output into B's `# End goal with specs` section
as a `## Inputs from upstream workers` subsection:

```markdown
## Inputs from upstream workers

**<A-name>** completed at <completed_at from result file>.
Summary: <summary field>

Key decisions your work must conform to:
- <key_decisions[0]>
- <key_decisions[1]>

Artifacts to read before starting:
- <artifacts[0]>
- <artifacts[1]>

Open questions from upstream (address each or note N/A):
- <questions_for_orchestrator[0]>
```

Rules for injection:
- Always read the actual result file — never rely on memory or assumption about what A built.
- `key_decisions` define interfaces B must conform to — mandatory reading.
- `artifacts` are the files B will integrate with — read them before coding.
- If the result file does not exist yet, check A's CLAUDE.md and `git log` as a fallback
  and note that structured results were unavailable.

## Pattern 1: Frontend Feature (Component-per-SubTurtle)

User request:
"Build a dashboard with search, filters, and export."

Decomposition:
- `dashboard-search` (parallel)
- `dashboard-filters` (parallel)
- `dashboard-export` (queued, depends on `dashboard-search`)

Why:
- Search and filters can ship independently.
- Export reuses search query state, so it depends on search contracts.

## Pattern 2: API Work (Endpoint-per-SubTurtle)

User request:
"Add billing APIs for create invoice, list invoices, and void invoice."

Decomposition:
- `billing-create-invoice-endpoint` (parallel)
- `billing-list-invoices-endpoint` (parallel)
- `billing-void-invoice-endpoint` (parallel)

Why:
- Endpoints are isolated by route/handler/service path.
- Shared validation/utilities can be handled via a small shared checklist in each backlog.

## Pattern 3: Full-Stack Feature (Frontend + Backend + Tests)

User request:
"Add team invitations with UI, API, and coverage."

Decomposition:
- `teams-invitations-backend` (spawn first)
- `teams-invitations-frontend` (queued, depends on backend API contract)
- `teams-invitations-tests` (queued, depends on backend + frontend completion)

Why:
- Backend defines invitation model and endpoints.
- Frontend integrates against stable API response shape.
- Tests validate full flow after both layers are implemented.

## User-Facing Response Template

When decomposing, keep user messaging brief:

1. State decomposition count.
2. List running SubTurtles.
3. List queued SubTurtles with dependencies.
4. Confirm you'll report milestones only.

Example:
"I split this into 3 SubTurtles. Running now: `dashboard-search`, `dashboard-filters`. Queued: `dashboard-export` (after `dashboard-search`). I'll report milestones as each completes."
