# E2B Managed Runtime Template

This directory owns the managed E2B template for hosted SuperTurtle users.

The template is intentionally infrastructure-only:

- Bun is preinstalled from an E2B Bun image
- system tools needed by the runtime are preinstalled
- `claude`, `codex`, and the published `superturtle` npm package are preinstalled
- user auth and project files are not baked into the template

That split is deliberate. The template should change rarely, while runtime state setup and auth refresh happen later at launch time.

## Build

From the repo root:

```bash
cd super_turtle
bun run e2b:template:build
```

The build script reads `E2B_API_KEY` from the environment, the repo root `.env`, or `.superturtle/.env`.

## Defaults

- Template name: `superturtle-managed-runtime`
- Template tags: `v<package-version>`, `latest`
- Runtime package install spec: `superturtle@<package-version>`

## Useful overrides

```bash
SUPERTURTLE_E2B_TEMPLATE_NAME=superturtle-managed-runtime \
SUPERTURTLE_E2B_TEMPLATE_CHANNEL=dev \
SUPERTURTLE_E2B_TEMPLATE_TAGS=latest,dev \
SUPERTURTLE_RUNTIME_INSTALL_SPEC=superturtle@0.2.5 \
SUPERTURTLE_CODEX_INSTALL_SPEC=@openai/codex \
bun run e2b:template:build
```

## Managed Codex runtime loop

Use an exact prerelease package version inside the template when testing E2B runtime changes.

Example:

```bash
SUPERTURTLE_E2B_TEMPLATE_NAME=superturtle-managed-runtime \
SUPERTURTLE_E2B_TEMPLATE_CHANNEL=managed-codex \
SUPERTURTLE_E2B_TEMPLATE_VERSION=v0.2.6-beta.148.1 \
SUPERTURTLE_E2B_TEMPLATE_TAGS=sha-abc1234 \
SUPERTURTLE_RUNTIME_INSTALL_SPEC=superturtle@0.2.6-beta.148.1 \
bun run e2b:template:build
```

Guidelines:

- Keep `latest` for stable/operator-safe builds.
- Use `managed-codex` for branch/runtime testing.
- Prefer exact prerelease versions over the floating `managed-codex` dist-tag so template builds stay reproducible.
- The published npm package is the runtime artifact. Do not build E2B templates from a local repo tarball.

## Maintenance model

- Treat the template as a repo-owned artifact.
- Rebuild it when base image/runtime dependencies change.
- Keep app/runtime freshness separate from template freshness.
- Use the template for provisioning at `superturtle login`.
- Let `/teleport` update user-scoped runtime files and auth, not the base image.
