# Current task
Resolve the cross-repo commit boundary between `agentic` and `../superturtle-web/` so the hosted entitlement parity patch can land without mixing unrelated sibling-repo changes.

# End goal with specs
The hosted control plane has a working Stripe integration that:
- Creates Stripe Checkout sessions for new subscribers
- Processes checkout.session.completed, customer.subscription.updated, customer.subscription.deleted webhooks with signature verification
- Syncs subscription state to the subscriptions table
- Exposes an entitlement check helper getEntitlement(userId) returning entitled boolean, status, plan, periodEnd
- Gates managed-runtime endpoints behind entitlement checks
- Returns clear 403 responses with reason no_active_subscription when entitlement fails
- Customer portal session creation for self-service billing management

# Roadmap (Completed)
- Hosted auth, schema, and API surface for users, sessions, managed instances, runtime leases

# Roadmap (Upcoming)
- Stripe billing integration and entitlement enforcement
- Provider auth gates on teleport and managed runtime endpoints

# Backlog
- [x] Examine the existing billing and entitlement surfaces in `super_turtle/bin/cloud-control-plane-runtime.js` and `../superturtle-web/` to map what already exists and what still needs parity
- [x] Normalize managed-runtime entitlement failures in the file-backed control-plane runtime to return `403 { error: "forbidden", reason: "no_active_subscription" }` and gate `/v1/cli/cloud/status` alongside resume/teleport/reprovision
- [ ] Resolve the cross-repo commit boundary between `agentic` and `../superturtle-web/`; keep the prepared entitlement parity patch isolated from unrelated sibling-repo changes <- current
- [ ] Port the same entitlement helper and rejection contract into `../superturtle-web/src/features/cloud/controllers/managed-runtime.ts` and the `/v1/cli` route handlers there
- [ ] Reconcile hosted billing route naming and metadata semantics between the file-backed runtime harness and `../superturtle-web/`
- [ ] Verify the hosted control-plane build/test path after the Next app parity changes land
- [ ] Commit all changes

Prepared-but-uncommitted patch note: `../superturtle-web/` now has a local entitlement parity patch staged in the working tree conceptually for `src/features/cloud/controllers/managed-runtime.ts` plus the `/v1/cli/cloud/status`, `/v1/cli/cloud/instance/resume`, and `/v1/cli/teleport/target` route handlers. `npm run build` there compiles and type-checks those touched files, but still fails on pre-existing `simple-import-sort/imports` errors in `src/app/v1/cli/runtime/lease/{claim,heartbeat,release}/route.ts` and `src/features/cloud/controllers/runtime-lease.ts`.
