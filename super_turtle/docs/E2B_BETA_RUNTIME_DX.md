# E2B Beta Runtime Developer Experience

## Goal

Make E2B test the same SuperTurtle artifact we intend to ship: a published npm package, not a source tarball from the local repo.

That gives us one runtime artifact for:

- managed onboarding in `../superturtle-web`
- local `/teleport` and the webhook POC
- E2B launch/background-process iteration
- repeatable rollback and operator debugging

## What Already Exists

The repo already has the core pieces for this model:

- the E2B template can install an exact published npm spec through `SUPERTURTLE_RUNTIME_INSTALL_SPEC`
- the template manifest already records `runtime_install_spec`
- the managed control plane already records `template_id`, `template_version`, and `runtime_version`

Relevant files:

- `super_turtle/teleport/e2b-template/config.mjs`
- `super_turtle/teleport/e2b-template/template.mjs`
- `../superturtle-web/src/features/cloud/controllers/managed-control-plane.ts`

The local teleport/bootstrap path now follows the same artifact model:

- `super_turtle/bin/e2b-webhook-poc-lib.js` installs the published `superturtle` package into the sandbox and starts `superturtle service run`
- it writes only the remote `.superturtle` runtime state needed for launch
- it does not sync the bound repo into E2B

## Target Developer Flow

### 1. Branch push publishes an exact managed-codex package

Each push to the active `managed-codex` branch publishes a prerelease npm version:

- package name: `superturtle`
- dist-tag: `managed-codex`
- exact version shape: `<next-stable>-beta.<run-number>.<run-attempt>`

Example:

- stable on npm: `0.2.5`
- beta from CI: `0.2.6-beta.148.1`

Why:

- `managed-codex` stays a moving human-friendly alias
- the exact prerelease version is what templates and sandboxes should actually consume
- `latest` remains untouched

### 2. Successful publish repoints the managed-codex E2B template

After npm publish succeeds, CI rebuilds the managed-codex template channel with the exact package version:

- template name stays `superturtle-managed-runtime`
- stable channel stays `latest`
- managed-codex channel is `managed-codex`
- install spec is exact, for example `superturtle@0.2.6-beta.148.1`

This keeps the template reproducible while still letting cold starts pick up the newest branch runtime.

### 3. Cold boots use the managed-codex template; warm boots verify runtime freshness

For developer testing:

- new sandboxes should come from `superturtle-managed-runtime:managed-codex`
- reused sandboxes should compare their remote manifest against the desired runtime install spec before cutover

The reuse check should be based on:

- `runtime_install_spec`
- `template_id`
- `template_version`
- remote mode / remote driver when relevant

If the spec does not match, we should either:

1. run an in-place runtime update inside the sandbox, or
2. recycle the sandbox and recreate from the managed-codex template

Preferred policy:

- cold start: template supplies the runtime
- warm reuse: self-update if only the runtime spec changed
- recycle only when the base template/tooling changed

That preserves fast repeat `/teleport` while keeping the runtime artifact exact.

### 4. Teleport and managed onboarding both expose an explicit managed-codex selector

We should treat managed-codex targeting as configuration, not hidden behavior.

Near-term knobs:

- `SUPERTURTLE_E2B_TEMPLATE_CHANNEL=managed-codex`
- `SUPERTURTLE_RUNTIME_INSTALL_SPEC=superturtle@<exact-beta-version>`

Near-term product behavior:

- managed onboarding can stay on `latest` by default and use `managed-codex` only for operator/dev testing
- local teleport/dev helpers can opt into `managed-codex` explicitly

Longer-term CLI UX:

- `superturtle teleport --runtime-channel managed-codex`
- `superturtle teleport --runtime-version 0.2.6-beta.148.1`

## Runtime Contract Changes

To make this robust, the runtime freshness contract should move from "local repo version" to "installed package spec".

### Required manifest/state fields

Remote template manifest and local teleport state should both carry the exact runtime install spec so reuse decisions are exact.

Current state:

- the template manifest records `runtime_install_spec`
- the local teleport state now records `runtimeInstallSpec`
- reuse checks compare the desired install spec against the remote manifest before cutover

### Default launch path

Target default:

1. create or resume E2B sandbox from the published template
2. write the remote `.superturtle/project.json` and `.superturtle/.env`
3. verify or install the exact `superturtle` package spec
4. start `superturtle service run`

## Operational Rules

- Do not build managed-codex templates from a local tarball.
- Do not point E2B at the floating `managed-codex` dist-tag inside the template.
- Do keep `latest` stable and operator-safe.
- Do record the exact runtime version/spec used for each sandbox.
- Do allow sandbox reuse when the manifest still matches.

## Recommended CI Shape

### Workflow A: branch managed-codex runtime

Trigger:

- push to the active `managed-codex` branch
- manual dispatch for republish/recovery

Steps:

1. compute exact prerelease version from `super_turtle/package.json`
2. write that version into the checked-out package manifest
3. run `bash tests/npm-package-smoke.sh`
4. `npm publish --tag managed-codex`
5. rebuild `superturtle-managed-runtime:managed-codex` with:
   - `SUPERTURTLE_E2B_TEMPLATE_VERSION=v<exact-version>`
   - `SUPERTURTLE_E2B_TEMPLATE_CHANNEL=managed-codex`
   - `SUPERTURTLE_RUNTIME_INSTALL_SPEC=superturtle@<exact-version>`

### Workflow B: stable release

Trigger:

- normal tagged release flow

Behavior:

- publish stable npm package
- rebuild `superturtle-managed-runtime:latest`

## Manual Operator Loop

For local testing without waiting on CI:

```bash
cd super_turtle
node scripts/prepare-beta-release.mjs
npm publish --tag managed-codex
SUPERTURTLE_E2B_TEMPLATE_CHANNEL=managed-codex \
SUPERTURTLE_E2B_TEMPLATE_VERSION=v$(node -p "require('./package.json').version") \
SUPERTURTLE_RUNTIME_INSTALL_SPEC=superturtle@$(node -p "require('./package.json').version") \
bun run e2b:template:build
```

After the test, reset the local version file if needed:

```bash
git checkout -- super_turtle/package.json
```

## Immediate Follow-Up Work

1. Make the managed-codex publish workflow the branch default for E2B testing.
2. Add a remote self-update check before webhook cutover.
3. Add a user-facing beta/runtime selector to teleport commands once the low-level path is stable.
4. Decide how much auth bootstrap should remain in the local `/teleport` path versus moving behind managed onboarding only.
