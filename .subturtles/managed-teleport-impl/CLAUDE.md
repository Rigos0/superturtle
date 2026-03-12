# Current task

Continue the hosted auth foundation by tightening durable hosted session semantics for `superturtle login` / `whoami` / `cloud status`, with a focus on the remaining hosted login/session contract work after adding fail-closed control-plane payload validation for login start, login completion, and session refresh responses.

# End goal with specs

- A user can sign in on the site with GitHub or Google
- A user can pay for managed hosting with Stripe
- A paid user gets one managed Linux VM on GCP infrastructure
- A local SuperTurtle install can link to the hosted account with a browser OAuth login flow
- `/teleport` can target the managed VM without manual SSH host setup
- Teleport preserves the existing semantic handoff model and same Telegram bot identity
- The control plane tracks users, subscriptions, managed instances, cloud links, and teleport sessions
- Hosted provider credentials remain user-scoped and are never shared between users
- The hosted product is production-ready rather than demo-only: durable state, idempotent jobs, auditable actions, and clean cutover boundaries for real Stripe/GCP credentials
- Infra posture is concrete in v1: one GCP project, one primary region, one Linux VM template/image, one managed VM per paid account
- Missing live Stripe or GCP accounts are implementation constraints, not excuses for fake architecture: build production-shaped adapters, state machines, APIs, and cutover hooks now
- Implementation order matters: auth and CLI login first, then managed-instance provisioning, then entitlement/billing integration, then `/teleport` target resolution

# Roadmap (Completed)
- Existing Telegram bot runtime, Claude/Codex routing, MCP tools, queueing, and session management are shipped
- Manual teleport exists already and remains the baseline semantic handoff path to reuse
- Runtime isolation for logs, temp dirs, IPC dirs, and tmux sessions is already in place
- Current operator ergonomics exist: `/status`, `/debug`, `/looplogs`, `superturtle status`, and `superturtle logs`
- Managed teleport product framing, constraints, and execution priorities have been written into the root `CLAUDE.md`

# Roadmap (Upcoming)
- Build hosted auth, CLI browser login, device/callback completion, and control-plane identity/session foundations
- Build GCP managed-instance provisioning, bootstrap, machine registration, and cloud status paths
- Build billing and entitlement enforcement behind production-shaped interfaces without coupling core auth/provisioning to Stripe
- Extend `/teleport` to resolve managed targets from the control plane and reuse the current semantic handoff path
- Add provider setup, admin tooling, telemetry, and production hardening

# Backlog
- [ ] Design and implement the hosted auth foundation and `superturtle login` browser OAuth flow, including browser launch, callback completion, local session storage, and `whoami`/cloud status semantics <- current
  Progress: the CLI now has production-shaped `login`, `whoami`, `cloud status`, and `logout` commands backed by a durable local cloud session file, session-pinned control-plane reuse, atomic versioned session writes with `0600` permissions, on-read permission hardening that re-secures supported session files back to `0600`, schema-aware session reads that transparently normalize legacy pre-version files and reject unsupported future formats, explicit corruption recovery guidance, refresh-on-expiry/401 semantics, persisted identity/entitlement/instance/provisioning snapshots, cached snapshot fallback for temporary control-plane outages including transient HTTP failures such as 429/5xx and socket-level disconnects, stubbed control-plane login/session/status/refresh APIs, refresh-aware cached fallback persistence so newly refreshed tokens are still written locally if the pinned control plane becomes unreachable before snapshot fetch completion, initial login snapshot persistence so browser-auth completion immediately seeds cached `whoami` and `cloud status` data before any follow-up API fetch succeeds, per-surface `identity_sync_at` / `cloud_status_sync_at` timestamps so cached fallback messaging reflects the freshness of the specific snapshot being used instead of a coarse global sync time, durable on-read migration of legacy pre-version session files, on-read backfill of missing `control_plane`, `created_at`, `last_sync_at`, `identity_sync_at`, and `cloud_status_sync_at` metadata so cached fallback remains offline-safe across older local session shapes, validation ordering that rejects unsupported future schema files before any migration write or permission repair can silently mutate them, explicit local invalidation of revoked or unauthorized hosted sessions so stale credentials are cleared from disk and the CLI forces a fresh `superturtle login`, and fail-closed validation of login-start, login-completion, and refresh token payloads so malformed control-plane auth responses cannot be persisted into the durable local session.
- [ ] Define and implement the control-plane schema, APIs, and durable state transitions for users, identities, sessions, entitlements, managed instances, provisioning jobs, and audit log
- [ ] Build GCP managed VM provisioning, bootstrap, registration, health reporting, and idempotent reprovision behavior for one VM per paid account
- [ ] Add Stripe checkout, subscriptions, webhook processing, and entitlement enforcement behind production-shaped adapters and verified webhook handling
- [ ] Extend `/teleport` to resolve and use SuperTurtle-managed VM targets from the control plane
- [ ] Add hosted Claude auth setup and validation flow with user-scoped credential boundaries
- [ ] Add basic admin and support tooling for reprovision, suspend, instance inspection, and teleport audit
- [ ] Add production telemetry for provisioning failures, login failures, teleport failures, and unhealthy VMs
