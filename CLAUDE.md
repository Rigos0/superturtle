# Super Turtle — Dev Branch

You are Super Turtle 🐢 — an autonomous coding agent controlled from Telegram. You spawn SubTurtles to do work, supervise them, and report back. This repo is the agent itself.

## Architecture

- **`super_turtle/claude-telegram-bot/`** — Telegram bot (TypeScript/Bun). The meta agent's runtime. Handles messages, voice, streaming, driver routing (Claude/Codex), MCP tools, session management.
- **`super_turtle/subturtle/`** — SubTurtle orchestration (Python). Loop types: `slow`, `yolo`, `yolo-codex`, `yolo-codex-spark`. Includes `ctl` CLI, watchdog, loop runner, browser screenshot helper, tunnel helper.
- **`super_turtle/meta/`** — Meta agent prompts: `META_SHARED.md` (system prompt) and `DECOMPOSITION_PROMPT.md`.
- **`super_turtle/setup`** — Onboarding setup script for fresh clones.
- **`super_turtle/bin/`** — CLI entry point (`superturtle` npm package).
- **`super_turtle/templates/`** — Templates for CLAUDE.md, etc.
- **`super_turtle/docs/`** — Internal design notes, audits, and implementation references.
- **`../turtlesite/docs/`** — Actual documentation site source for the published docs.

## Tech Stack

- **Bot runtime:** Bun + TypeScript
- **AI drivers:** Claude CLI (primary), Codex CLI (optional)
- **SubTurtle loops:** Python 3.13
- **MCP servers:** send-turtle (stickers), bot-control (session/model/usage), ask-user (inline buttons)
- **Telegram:** Grammy framework
- **Package:** npm (`superturtle`)

## Key Files

- `super_turtle/claude-telegram-bot/src/handlers/text.ts` — text message handler
- `super_turtle/claude-telegram-bot/src/handlers/voice.ts` — voice message handler + transcription
- `super_turtle/claude-telegram-bot/src/handlers/stop.ts` — stop logic (`stopAllRunningWork()`)
- `super_turtle/claude-telegram-bot/src/handlers/driver-routing.ts` — Claude/Codex driver selection
- `super_turtle/claude-telegram-bot/src/session.ts` — session state, process management, query execution
- `super_turtle/claude-telegram-bot/src/deferred-queue.ts` — voice message queue (max 10 per chat)
- `super_turtle/claude-telegram-bot/src/utils.ts` — `isStopIntent()` detection (line ~302)
- `super_turtle/claude-telegram-bot/src/config.ts` — bot configuration, system prompt injection
- `super_turtle/subturtle/ctl` — SubTurtle CLI (spawn, stop, status, logs, list)

## Branch Merge Instructions (dev <-> main)

Use standard merges. No special merge drivers or merge policy is required.

**Merging:**
```bash
# dev -> main
git checkout main && git merge dev && git push origin main

# main -> dev
git checkout dev && git merge main
```

---

## Current task
Managed teleport: turn the current manual teleport flow into a production-ready hosted product, prioritizing `superturtle` browser OAuth login and immediate managed VM provisioning after login, with Stripe/GCP integrated behind real production interfaces rather than demo-only glue.

## Current system baseline

### Shipped
- Telegram bot runtime, Claude/Codex drivers, MCP tools, queueing, and session management
- Current manual teleport path in `super_turtle/scripts/teleport-manual.sh`
- Teleport handoff/import helpers in `super_turtle/state/teleport_handoff.py`
- Manual teleport runbook in `super_turtle/docs/MANUAL_TELEPORT_RUNBOOK.md`
- Token-prefixed runtime isolation for logs, temp dirs, IPC dirs, and tmux sessions
- Existing operator ergonomics: `/status`, `/debug`, `/looplogs`, `superturtle status`, `superturtle logs`

### Known gaps
- No hosted account model yet
- No GitHub/Google user auth for a managed product
- No Stripe subscription or entitlement enforcement
- No GCP control plane or managed VM provisioning
- No hosted CLI login/link flow
- `/teleport` still targets operator-managed SSH hosts, not SuperTurtle-managed infrastructure
- Hosted Claude/Codex credential setup policy is still undefined

## End goal with specs
- A user can sign in on the site with GitHub or Google
- A user can pay for managed hosting with Stripe
- A paid user gets one managed Linux VM on our GCP infrastructure
- A local SuperTurtle install can link to the hosted account with a cloud login flow
- `/teleport` can target the managed VM without manual SSH host setup
- Teleport preserves the existing semantic handoff model and same Telegram bot identity
- The control plane tracks users, subscriptions, managed instances, cloud links, and teleport sessions
- Hosted provider credentials remain user-scoped and are never shared between users
- The hosted product has basic audit logging, entitlement enforcement, and operational status

## Managed user flow
- User signs in on the site with GitHub or Google
- User chooses the managed hosting plan and pays via Stripe
- Control plane provisions exactly one SuperTurtle-managed Linux VM for that paid account
- User links a local `superturtle` install to the hosted account through a browser or device login flow
- User runs `/teleport` from the existing Telegram bot identity
- Bot resolves the user’s managed VM via the control plane and performs the existing semantic teleport handoff onto that managed machine

## Recommended MVP architecture
- **Marketing/site app**: landing page, auth, billing entrypoint, account settings, instance status
- **Control plane API + database**: users, auth identities, subscriptions, entitlements, managed instances, CLI links, teleport sessions, audit log
- **Billing integration**: Stripe checkout, customer portal, webhook processing, subscription state sync
- **Provisioner**: GCP project/region-scoped VM creation, bootstrap, health checks, suspend/reprovision hooks
- **Managed VM runtime**: one Linux VM per paid account, running SuperTurtle in hosted mode with user-scoped provider credentials
- **CLI cloud link flow**: `superturtle login` / `whoami` / cloud status backed by short-lived auth tokens and device or browser login
- **Teleport resolution layer**: `/teleport` resolves managed target metadata from the control plane instead of operator-maintained SSH config

## Execution phases
- **Phase 0 — product contract**: lock v1 scope, billing semantics, credential policy, support posture, and Codex beta boundary
- **Phase 1 — auth and identity foundation**: choose stack/repo boundaries, define schema, build site OAuth, CLI browser login, token/session model, and audit logging
- **Phase 2 — provisioning control plane**: create managed-instance state machine, provisioning jobs, machine registration, health reporting, and reprovision path
- **Phase 3 — billing and entitlements**: Stripe checkout, subscriptions, webhooks, entitlement enforcement, and suspended-state behavior without weakening the auth/provisioning design
- **Phase 4 — managed teleport**: resolve hosted VM target from control plane and reuse the current semantic handoff path
- **Phase 5 — provider setup and operations**: hosted Claude setup/validation, Codex beta decision, admin tooling, telemetry, support workflows, and production hardening

## Production priorities
- The first production-critical path is `superturtle login`: local CLI opens the browser, user completes OAuth on the hosted site, the CLI receives a device/browser completion signal, and the control plane issues a user-bound cloud session
- The second production-critical path is post-login provisioning: once a user is authenticated and entitled, the control plane can create or resume exactly one managed VM and report durable provisioning state back to the CLI and site
- Billing matters for launch, but auth/session integrity and provisioning correctness come first because they define the contract every later paid flow depends on
- Every interface must be production-shaped now: typed APIs, durable state transitions, idempotent jobs, webhook signature verification, and auditable operator actions

## Overnight implementation plan
- **Worker 1 — `cloud-auth` (Codex)**: define the hosted auth architecture, CLI browser login flow, token/session model, callback semantics, and required `superturtle` commands
- **Worker 2 — `cloud-schema` (Codex)**: define the control-plane schema and API surface for users, identities, sessions, entitlements, managed instances, provisioning jobs, and audit log
- **Worker 3 — `cloud-provisioning` (Codex)**: design the managed-instance lifecycle, GCP provisioner contract, bootstrap/registration flow, and idempotent reprovision/suspend behavior
- **Worker 4 — `cloud-billing` (Codex)**: define Stripe subscription lifecycle, entitlement transitions, webhook handling, and how billing gates provisioning without coupling core auth too tightly to Stripe
- **Worker 5 — `teleport-integration` (Codex)**: map how `/teleport` resolves managed targets from the control plane and how existing handoff/import code is reused without weakening current semantics
- Supervisor wakeups should run on Thursday, March 12, 2026 UTC every 30 minutes for all workers, with an additional 90-minute milestone wakeup that forces cross-worker dependency review
- First wakeup pass should check for contract drift between auth, schema, and provisioning; second pass should check that CLI login and provisioning state machines still compose cleanly; later passes should push unfinished work toward concrete docs, interfaces, and implementation-ready tickets
- If any worker gets blocked by missing real Stripe/GCP credentials, that worker must switch to production-interface design, test harnesses, stub adapters, and explicit cutover checklists instead of stalling
- If the auth worker finishes first, it becomes the integration lead and reviews all other worker outputs against the `login -> entitlement -> provision -> status -> teleport` path

## SubTurtle spawn strategy
- Before any spawn, the main agent writes a canonical `.subturtles/<name>/CLAUDE.md` for each worker using the required state contract: `# Current task`, `# End goal with specs`, `# Roadmap (Completed)`, `# Roadmap (Upcoming)`, and `# Backlog`
- Each worker state file should keep exactly one open backlog item marked `<- current`, and that item should match the worker’s overnight scope
- Spawn all five workers immediately to maximize overnight parallelism, but make `cloud-auth`, `cloud-schema`, and `cloud-provisioning` the contract owners the main agent reconciles first
- Default loop type should be `yolo-codex`; default timeout should be `7h`; recurring supervision should be `30m`
- Spawn commands should use repo-native `ctl spawn` so the workspace, validation, process metadata, and recurring silent supervision job are created atomically

```bash
./super_turtle/subturtle/ctl spawn cloud-auth --type yolo-codex --timeout 7h --cron-interval 30m --state-file .subturtles/cloud-auth/CLAUDE.md
./super_turtle/subturtle/ctl spawn cloud-schema --type yolo-codex --timeout 7h --cron-interval 30m --state-file .subturtles/cloud-schema/CLAUDE.md
./super_turtle/subturtle/ctl spawn cloud-provisioning --type yolo-codex --timeout 7h --cron-interval 30m --state-file .subturtles/cloud-provisioning/CLAUDE.md
./super_turtle/subturtle/ctl spawn cloud-billing --type yolo-codex --timeout 7h --cron-interval 30m --state-file .subturtles/cloud-billing/CLAUDE.md
./super_turtle/subturtle/ctl spawn teleport-integration --type yolo-codex --timeout 7h --cron-interval 30m --state-file .subturtles/teleport-integration/CLAUDE.md
```

- `ctl spawn` already auto-registers one recurring `subturtle_supervision` cron job per worker in `.superturtle/cron-jobs.json`; these jobs are silent and should remain the low-level worker health/milestone mechanism
- If one worker proves noisier or more dependency-sensitive than the others, the main agent should adjust only that worker with `./super_turtle/subturtle/ctl reschedule-cron <name> <interval>` instead of changing the whole fleet

## Main-agent cron wakeup plan
- Worker supervision cron is not enough on its own because it checks each worker independently; the main agent still needs scheduled synthesis turns that reconcile cross-worker contracts and reprioritize work
- Main-agent wakeups should be scheduled as one-shot generic cron jobs, not recurring jobs, so each wakeup has a specific purpose and does not drift into duplicate review loops
- These wakeups should be non-silent so they run through the main driver as `cron_scheduled` work; if the driver is busy, the bot already defers them until idle instead of losing them
- Use the repo-native cron store via Bun and `addJob(...)` from `super_turtle/claude-telegram-bot/src/cron.ts`; do not hand-edit `.superturtle/cron-jobs.json` unless the cron module is unavailable

```bash
bun --eval 'import { addJob } from "./super_turtle/claude-telegram-bot/src/cron.ts"; addJob(process.argv[1], "one-shot", Number(process.argv[2]), undefined, false, { job_kind: "generic" });' \
  "Review all managed-teleport workers. Check .superturtle/state/handoff.md, each worker CLAUDE.md, and recent commits. Reconcile auth, schema, and provisioning contracts. If drift exists, update the relevant worker state files and reschedule or stop/restart workers as needed. Respond with concrete orchestration actions only." \
  2700000
```

- Wakeup 1 at `+45m`: contract review across `cloud-auth`, `cloud-schema`, and `cloud-provisioning`; correct interface drift early
- Wakeup 2 at `+90m`: login-to-provision path review; ensure CLI OAuth completion, entitlement gate, and instance state machine compose cleanly
- Wakeup 3 at `+150m`: implementation-shape review; convert open design output into implementation-ready tasks, APIs, and file targets
- Wakeup 4 at `+240m`: dependency and risk sweep; stop or retask any worker that is stuck, redundant, or blocked by missing provider credentials
- Wakeup 5 at `+360m`: morning handoff preparation; collect what is production-ready, what still needs real Stripe/GCP cutover, and what should be the next interactive coding session
- Optional final notification can be a one-shot `BOT_MESSAGE_ONLY:` cron if a human-facing morning summary must be sent even without a synthesis run, but the default plan is to let the main agent synthesize first
- Every main-agent wakeup should read conductor state first, not rely on memory: `.superturtle/state/handoff.md`, `.superturtle/state/workers/`, pending wakeups, worker `CLAUDE.md`, and `ctl status`

## Roadmap (Completed)
- ✅ Core bot runtime: Telegram integration, streaming, Claude/Codex routing, MCP tools
- ✅ Existing local operator model: CLI setup, queueing, logs, dashboard, stop/status flows
- ✅ Manual teleport v1: handoff bundle export/import, remote Linux cutover, semantic continuity
- ✅ Multi-instance runtime isolation: token-prefixed temp files, IPC, logs, and tmux sessions
- ✅ Current teleport docs: README section plus manual teleport runbook
- ✅ Initial Codex stream-disconnect hardening for cloud-hosted instability

## Roadmap (Upcoming)
- Lock the managed teleport v1 product contract and hosted credential policy
- Build hosted site auth plus production-grade `superturtle login`
- Build managed VM provisioning, machine registration, and cloud status surfaces
- Add Stripe entitlement enforcement without compromising auth/provisioning contracts
- Add managed `/teleport` target resolution
- Add hosted provider setup flow and basic operator/admin tooling

## Manual Teleport Status

- Manual operator-run teleport is implemented via `super_turtle/scripts/teleport-manual.sh`
- The validated direction is local macOS repo -> remote Linux VM over SSH
- Successful cutover keeps the same Telegram bot identity and resumes via semantic handoff on the next turn
- Reverse teleport back to local is not automated yet; current operator flow is: stop remote bot, ensure work is committed and pushed, `git pull --ff-only` locally, then start the local bot
- Remote stop/restart steps and auth notes live in `super_turtle/docs/MANUAL_TELEPORT_RUNBOOK.md`

## Backlog
- [ ] Write the production-ready hosted auth + provisioning PRD, including CLI browser OAuth and post-login VM lifecycle <- current
- [ ] Decide billing semantics: always-on VM vs suspend-on-idle
- [ ] Define control-plane schema for users, subscriptions, managed instances, cloud links, and teleport sessions
- [ ] Choose site/control-plane stack and repo boundaries
- [ ] Design `superturtle login` browser OAuth flow, callback contract, session storage, and `whoami` semantics
- [ ] Define managed-instance provisioning state machine and idempotent job model
- [ ] Build site auth with GitHub + Google
- [ ] Add Stripe checkout, subscriptions, and webhook processing
- [ ] Add entitlement checks for paid vs unpaid vs suspended users
- [ ] Create initial GCP Terraform for one managed Linux VM per paid account
- [ ] Build VM bootstrap and machine registration back to control plane
- [ ] Add `superturtle login` hosted-account flow
- [ ] Add `superturtle cloud status` / `superturtle whoami`
- [ ] Extend `/teleport` to resolve a managed target VM from the control plane
- [ ] Add hosted Claude auth setup and validation flow
- [ ] Decide whether hosted Codex support ships in v1 or beta
- [ ] Add basic admin/support tooling for reprovision, suspend, and teleport audit
- [ ] Add production telemetry for provisioning failures, teleport failures, and unhealthy VMs

## Notes
- Managed teleport should target only SuperTurtle-managed Linux VMs in v1
- Recommended hosted account model: GitHub/Google OAuth on the site plus a CLI browser/device login flow
- Recommended pricing shape: monthly subscription, one user, one managed VM, one bot
- Highest-risk product question: hosted provider credential policy, especially Claude auth on the managed VM
- Recommended v1 launch posture: Claude-first hosted support, Codex explicitly beta
- Recommended infra posture: one GCP project, one primary region, one VM template/image, one VM per paid account
- Existing manual teleport implementation remains the baseline cutover path to reuse
- Current manual teleport preserves semantic continuity, not exact provider-native thread continuity
- The actual docs repo lives in sibling path `../turtlesite/`; edit `../turtlesite/docs/` for public docs when we are ready to publish managed teleport docs

## Skippable limitations
- There are currently no live production GCP or Stripe accounts attached to this workspace, so early implementation must use production-shaped provider interfaces, test-mode billing flows, provisioning adapters, and explicit cutover checklists instead of blocking on missing accounts
- Development is running in a sandbox environment, so browser OAuth callbacks, webhook delivery, and cloud provisioning must be designed to work with local/test harnesses first and then promote cleanly to real infrastructure
- These are skippable implementation limitations, not product-scope limitations: they should never justify demo-grade contracts, fake persistence, or one-off flows we would later need to replace
- Any code that depends on real cloud or billing credentials should ship behind clear adapter boundaries, feature flags, and health/status reporting so the production path remains auditable once credentials exist

## Open decisions
- Hosted credential policy for Claude on managed VMs, including setup UX, storage model, and support boundaries
- Whether v1 billing is always-on monthly infrastructure or suspend-on-idle with resume semantics
- Whether hosted Codex support launches in v1 or remains explicit beta behind separate validation
- Final repo boundary choice for site/control plane versus bot/runtime code
