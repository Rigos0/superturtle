# Managed Control Plane Contract

This document defines the first production-shaped contract for the hosted managed-teleport control plane.

## CLI API surfaces

- `POST /v1/cli/login/poll`
  Returns bearer tokens plus optional identity, entitlement, instance, provisioning-job, and audit-log snapshots.
- `GET /v1/cli/session`
  Returns the signed-in user, linked OAuth identities, active hosted session metadata, and entitlement summary.
- `GET /v1/cli/cloud/status`
  Returns the managed instance record, the latest provisioning job, and recent audit entries relevant to the hosted VM lifecycle.
- `POST /v1/cli/cloud/instance/resume`
  Enqueues or deduplicates a managed-instance resume/provisioning job and returns the updated instance, latest provisioning job, and recent audit entries.

## Resource schema

- `user`
  `id`, `email`, `created_at`
- `identity`
  `id`, `provider`, `provider_user_id`, optional `email`, `created_at`, `last_used_at`
- `session`
  `id`, `state`, `scopes[]`, `created_at`, optional `expires_at`, `last_authenticated_at`
- `entitlement`
  `plan`, `state`, optional `subscription_id`, `current_period_end`, `cancel_at_period_end`
- `managed_instance`
  `id`, `provider`, `state`, optional `region`, `zone`, `hostname`, `vm_name`, `machine_token_id`, `last_seen_at`, `resume_requested_at`
- `provisioning_job`
  `id`, `kind`, `state`, optional `attempt`, `created_at`, `started_at`, `updated_at`, `completed_at`, `error_code`, `error_message`
- `audit_log`
  `id`, `actor_type`, `actor_id`, `action`, `target_type`, `target_id`, `created_at`, optional `metadata`

## Enumerated states

- Identity providers: `github`, `google`
- Session states: `pending`, `active`, `expired`, `revoked`
- Entitlement states: `inactive`, `trialing`, `active`, `past_due`, `suspended`, `canceled`
- Instance providers: `gcp`
- Managed instance states: `requested`, `provisioning`, `running`, `stopped`, `suspended`, `failed`, `deleting`, `deleted`
- Provisioning job kinds: `provision`, `resume`, `suspend`, `reprovision`, `delete`, `repair`
- Provisioning job states: `queued`, `running`, `succeeded`, `failed`, `canceled`

## Durable lifecycle rules

- Managed instance transitions:
  `requested -> provisioning -> running`
  Recovery and teardown: `provisioning -> failed|deleted`, `running -> stopped|suspended|failed|deleting`, `stopped -> running|suspended|failed|deleting`, `suspended -> running|deleting`, `failed -> provisioning|deleting`, `deleting -> deleted`
- Provisioning job transitions:
  `queued -> running -> succeeded|failed|canceled`
  Retry semantics: `failed -> queued`, `canceled -> queued`

These rules are implemented in [cloud-control-plane-contract.js](/home/azureuser/agentic/super_turtle/bin/cloud-control-plane-contract.js) and covered by [cloud-control-plane-contract.test.js](/home/azureuser/agentic/super_turtle/tests/cloud-control-plane-contract.test.js).
