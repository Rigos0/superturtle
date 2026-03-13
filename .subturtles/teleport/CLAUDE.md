# Current task
Continue replacing managed VM assumptions with one persistent E2B sandbox per user, now that the local control-plane runtime can emit sandbox-native managed instance identity and teleport targets.

# End goal with specs
A fully working /teleport feature where:
- Any logged-in user can use /teleport (no billing gate for now, open to all authenticated users)
- /teleport from Telegram moves the bot from local to an E2B sandbox (local to cloud)
- /teleport again moves it back (cloud to local)
- Only one runtime is authoritative at a time (lease system already exists)
- Handoff preserves semantic continuity using the existing handoff bundle model
- E2B sandbox is created and managed by the control plane (one persistent sandbox per user)
- Control plane tracks managed instances with sandbox_id + template_id instead of SSH coordinates
- Provider auth (Claude/Codex) is bootstrapped from local machine on first teleport
- superturtle-web deployed on Vercel with all API routes working
- /teleport status shows phase, active owner, destination state, and failure reasons

# Roadmap (Completed)
- Hosted auth and CLI login flow (superturtle login/whoami work)
- Control plane API routes for cloud status, instance resume, teleport target, machine register/heartbeat, runtime lease claim/heartbeat/release
- Durable schema for managed instances, provisioning jobs, runtime leases, machine registration
- Runtime ownership enforcement in superturtle start/stop with lease semantics (claim, heartbeat, release, conflict refusal, fail-open warning)

# Roadmap (Upcoming)
- E2B sandbox lifecycle and managed runtime surfaces in superturtle-web
- Teleport UX with preflight, confirm/cancel, and status
- Local to cloud teleport via E2B
- Cloud to local return teleport
- Provider auth bootstrap for managed sandboxes

# Backlog
- [x] Examine both repos to map what exists: check ../superturtle-web/ for E2B integration, managed instance routes, sandbox adapters, and route handlers; check agentic repo for teleport command handler, handoff code in super_turtle/state/teleport_handoff.py, E2B config, cloud control plane runtime in super_turtle/bin/cloud-control-plane-runtime.js, and provider auth helpers
  - Inventory captured in `.subturtles/teleport/INVENTORY.md`.
- [x] Fix any pre-existing build errors in ../superturtle-web/ (known: simple-import-sort/imports errors in src/app/v1/cli/runtime/lease/claim/route.ts, heartbeat/route.ts, release/route.ts and src/features/cloud/controllers/runtime-lease.ts) so npm run build passes clean
  - Verified `npm run build` passes in `../superturtle-web/` on March 13, 2026.
- [x] Add /teleport preflight summary with confirm/cancel before cutover using ask_user MCP tool for inline Telegram buttons
- [x] Keep /teleport idle-only; reject while work is active or queued with clear error message
- [x] Improve /teleport status with phase, active owner, destination runtime state, and latest failure reason
- [x] Surface clear preflight failures for missing login, missing cloud auth, and destination sandbox issues
- [x] Wire the deployed hosted control plane to real managed-runtime endpoints (/v1/cli/cloud/status, resume, teleport target)
  - Updated the default hosted control-plane origin in `super_turtle/bin/cloud.js` to `https://superturtle-web.vercel.app` so cloud status, resume, and teleport-target calls now hit the live deployed endpoints without requiring `SUPERTURTLE_CLOUD_URL`.
- Replace managed VM assumptions with one persistent E2B sandbox per user <- current
  - Progress: the local control-plane contract now accepts either legacy SSH teleport targets or E2B sandbox targets (`transport`, `sandbox_id`, `template_id`, `project_root`) without breaking the current SSH path, and the manual teleport script now fails explicitly if the hosted API switches to `transport=e2b` before the file/PTY cutover lands.
  - Progress: the local control-plane runtime now supports `provider=e2b`, persists `sandbox_id` and `template_id` on managed instances and machine registration/heartbeat, returns `transport=e2b` teleport targets for E2B-backed instances, and keeps the SSH path unchanged for legacy GCP-backed instances.
- Define managed-runtime lifecycle and idempotent sandbox create/connect-resume/pause/reprovision/delete behavior
- Build the production superturtle-teleport E2B template with pinned toolchain, startup scripts, health checks, log paths, and provider config directories
- Store hosted runtime identity as sandbox_id + template_id in the control plane instead of SSH coordinates
- Use E2B metadata only for non-secret routing (user_id, account_id, sandbox role, driver, environment, teleport session)
- Add a sandbox adapter in ../superturtle-web for create, connect/resume, pause, kill, list, and metadata lookup through the E2B SDK
- Set short active timeouts with onTimeout pause and keep resume control-plane-driven for /teleport, cloud status, and explicit resume
- Default managed sandboxes to secure access with restricted public traffic; front any exposed ports with the control plane and traffic-token checks
- Build sandbox bootstrap, health reporting, and registration back to the control plane: install tmux/rsync/bun, clone repo, configure .superturtle/.env for sandbox paths, register via /v1/machine/register
- Reuse the semantic handoff bundle for managed E2B cutover
- Replace SSH target resolution with a sandbox_id-based hosted teleport target contract
- Upload handoff bundles and required runtime artifacts with E2B file APIs instead of rsync
- Start remote bootstrap and health verification through E2B commands/PTY not SSH and stream logs back through command/PTY output
- Transfer ownership only after the destination runtime is healthy
- Add automatic rollback so local remains authoritative if cloud startup fails
- Prevent duplicate concurrent teleport launches across both local lock state and control-plane ownership
- Keep SSH/manual teleport only as an operator fallback path during migration off the current host-based flow
- Define cloud to local teleport as a first-class flow rather than an operator-only workaround
- Rehydrate the local runtime from cloud handoff state before ownership returns
- Transfer ownership back only after local is healthy
- Add rollback so cloud remains authoritative if local restart fails
- Block teleport before ownership transfer when required destination provider auth is missing
- Productize first-teleport provider setup so the user can reuse existing local Claude/Codex auth when available with browser/device auth only as fallback
- Support user-scoped Claude hosted auth bootstrap from the local machine by reusing existing local auth state or token material instead of requiring direct browser login inside the managed sandbox
- Support user-scoped Codex hosted auth bootstrap from the local machine by reusing existing local auth state or API-key-backed login instead of requiring direct browser login inside the managed sandbox
- Store user-scoped hosted provider auth material securely in the control plane and use it only for that users sandbox/session
- Add reauth/refresh/recovery flows when hosted Claude/Codex auth expires, is revoked, or becomes invalid
- Add managed Claude/Codex settings and secret-deny policy for hosted sandboxes
- Keep secrets out of E2B metadata and out of shared persisted sandbox auth state
- Add production telemetry for provisioning failures, teleport failures, and unhealthy runtimes
- Verify npm run build passes in both repos after all changes
- Commit all changes in both repos separately
