# Current task
Finish a testable end-to-end local -> cloud managed teleport path on E2B using the existing working pieces, and do not spend time broadening transport abstractions unless they directly block the E2B test path. Current focus: clear the remaining live-cutover blockers after local Claude/Codex auth seeding is in place for managed sandboxes, with rollback now added for post-cutover verification failures and the post-final-sync dependency reinstall already restored for E2B cutover.

# End goal with specs
- `/teleport` from Telegram can move the live bot from local -> E2B managed sandbox end to end
- The active path for this worker is the hosted managed E2B sandbox flow, not generic transport work
- The same Telegram bot identity is preserved through the semantic handoff bundle model
- The destination runtime is verified healthy before ownership transfer completes
- Existing local Claude/Codex auth is reused to seed the managed sandbox when available
- Hosted control-plane endpoints used by the test flow return the data the runtime actually needs
- The repo ends with a concrete operator test recipe and explicit known gaps
- Cloud -> local return remains in scope, but local -> cloud testability is the immediate priority

# Roadmap (Completed)
- Hosted browser login and CLI account linking are working against the live control plane
- Linked local startup ownership enforcement exists with lease claim, heartbeat, release, and conflict refusal
- `/teleport` preflight confirm/cancel, idle-only rejection, and richer status reporting exist
- The current implementation already has E2B helper commands, archive sync, auth bootstrap, and sandbox runtime bootstrap pieces
- Local tests already cover the E2B helper path and managed teleport bootstrap path

# Roadmap (Upcoming)
- Make the current local -> cloud E2B teleport path runnable end to end against live infrastructure
- Tighten destination health verification, failure handling, and operator feedback around cutover
- Validate that hosted cloud-status, teleport-target, machine-register, and machine-heartbeat compose cleanly in the real flow
- Leave a concise operator test recipe plus known limitations after the path works
- Only after local -> cloud is testable, close the largest blocker on cloud -> local return

# Backlog
- [x] Inventory the existing managed teleport, cloud control-plane, and E2B helper pieces already in the repo
- [x] Add `/teleport` preflight confirm/cancel, idle-only checks, and better status reporting
- [x] Build the E2B helper path for archive sync, script execution, and auth/bootstrap support
- [ ] Finish the live local -> cloud E2B teleport path end to end, fix whatever blocks a real test, and leave it runnable by the human <- current
  - Progress: `teleport-manual.sh` no longer drops `~/.codex` from `ALLOWED_PATHS` during the remote start rewrite, so an E2B sandbox that was seeded with local Codex auth stays able to start and verify the teleported runtime instead of losing access to the codex config dir at the last step.
  - Progress: `teleport-manual.sh --managed` now discovers reusable local Claude auth from env/keychain/credentials files, stages it into the E2B sandbox after final sync, merges it into the sandbox `.superturtle/.env`, and removes the temporary bootstrap file so first live cutovers do not depend solely on preconfigured hosted Claude auth.
  - Progress: managed teleport integration coverage now proves both local Codex auth and local Claude auth are seeded into the sandbox during the E2B path.
  - Progress: the E2B path now reruns `bun install` after the final archive sync, so the last sync no longer wipes the remote dependencies that the managed sandbox needs immediately before import/start/verify.
  - Progress: if local -> cloud cutover fails after the local bot has been stopped but before the remote runtime is verified healthy, `teleport-manual.sh` now stops the partially started remote bot, restarts the local tmux runtime, and keeps the failure surfaced in the teleport log instead of leaving the bot down.
- [ ] Verify destination health and ownership-transfer behavior under success and failure, adding rollback or failure surfacing only where needed to make testing reliable
- [ ] Validate the hosted control-plane contract used by the test flow (`cloud status`, `instance resume`, `teleport target`, `machine register`, `machine heartbeat`) and fix mismatches
- [ ] Write a concise operator test recipe plus known limitations for the current E2E teleport path
- [ ] If local -> cloud is working, implement the smallest viable cloud -> local return path needed for another real test pass
