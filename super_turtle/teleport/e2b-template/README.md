# E2B Managed Runtime Template

This directory owns the managed E2B template for hosted SuperTurtle users.

The template is intentionally infrastructure-only:

- Bun is preinstalled from an E2B Bun image
- system tools needed by the runtime are preinstalled
- common office/media tools are preinstalled: LibreOffice, Poppler tools, ImageMagick, `python-pptx`, Pillow, and the Remotion CLI stack
- `codex` is preinstalled
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
- Template manifest records a runtime package install spec for observability and cold-boot targeting
- Managed onboarding still installs the exact `superturtle@...` runtime at start time
- Default media stack:
  - native: LibreOffice, Poppler, ImageMagick, `libnss3`, `libnspr4`
  - Python: `python-pptx`, `Pillow`
  - JS: `@remotion/cli`, `remotion`, `react`, `react-dom`

## Useful overrides

```bash
SUPERTURTLE_E2B_TEMPLATE_NAME=superturtle-managed-runtime \
SUPERTURTLE_E2B_TEMPLATE_CHANNEL=dev \
SUPERTURTLE_E2B_TEMPLATE_TAGS=latest,dev \
SUPERTURTLE_RUNTIME_INSTALL_SPEC=superturtle@0.2.5 \
SUPERTURTLE_CODEX_INSTALL_SPEC=@openai/codex \
bun run e2b:template:build
```

## Beta runtime loop

Use an exact prerelease package version inside the template when testing E2B runtime changes.

Example:

```bash
SUPERTURTLE_E2B_TEMPLATE_NAME=superturtle-managed-runtime \
SUPERTURTLE_E2B_TEMPLATE_CHANNEL=beta \
SUPERTURTLE_E2B_TEMPLATE_VERSION=v0.2.6-beta.148.1 \
SUPERTURTLE_E2B_TEMPLATE_TAGS=sha-abc1234 \
SUPERTURTLE_RUNTIME_INSTALL_SPEC=superturtle@0.2.6-beta.148.1 \
bun run e2b:template:build
```

Guidelines:

- Keep `latest` for stable/operator-safe builds.
- Use `beta` for branch/runtime testing.
- Prefer exact prerelease versions over the floating `beta` dist-tag so template builds stay reproducible.
- The published npm package is the runtime artifact. Do not build E2B templates from a local repo tarball.
- For managed onboarding, the exact published `superturtle` version is installed during runtime bootstrap, not baked into the template image.

## Maintenance model

- Treat the template as a repo-owned artifact.
- Rebuild it when base image/runtime dependencies change.
- Keep app/runtime freshness separate from template freshness.
- Use the template for provisioning at `superturtle login`.
- Let `/teleport` update user-scoped runtime files and auth, not the base image.
