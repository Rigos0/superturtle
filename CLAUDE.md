# SuperTurtle User Notes

This file is for humans and turtles working in this repo after installing or upgrading SuperTurtle.

## Latest release highlights

- Fixed a Codex stalling issue around pending tool output delivery
- Reduced Telegram push noise: intermediate updates are silent, while the final reply still notifies normally
- Improved process startup and shutdown reliability to reduce duplicate runners and restart cleanup issues
- Added short Telegram startup messages when the turtle process boots

For the full release history, see `super_turtle/CHANGELOG.md`.

## Important migration info

SuperTurtle now keeps its live project state under:

```text
.superturtle/
```

The active env file is:

```text
.superturtle/.env
```

The repo-root `.env.example` is only a reference template. It is not the live runtime env file.

If you are upgrading from an older layout:

- move any active bot env values into `.superturtle/.env`
- treat `.env.example` as documentation for available options
- use `superturtle init` as the canonical setup/update path
- do not use the old `setup` script

## Common commands

```bash
superturtle init
superturtle start
superturtle stop
superturtle status
superturtle doctor
```

## Managed Codex runtime publishing

The `managed-codex` branch is the working branch for the SuperTurtle Cloud managed runtime that is Codex-only.

Publishing model:

- keep the npm package name as `superturtle`
- do not create a separate npm package for each iteration
- publish a new prerelease version for each iteration from `managed-codex`
- use a moving branch dist-tag for convenience, but install exact versions in E2B

Important npm rule:

- npm versions are immutable, so each iteration must publish a new version

Recommended versioning/runtime flow:

- publish versions like `0.2.9-beta.<run>.<attempt>` or another branch-scoped prerelease form
- optionally move a dist-tag such as `beta-managed-codex` to the newest published version
- have E2B templates and sandboxes install an exact version such as `superturtle@0.2.9-beta.143.1`
- do not point E2B at a floating dist-tag inside the template

When to split into a separate package:

- only do that if the managed runtime becomes a genuinely different artifact with a different CLI surface, dependency set, or shipped file set

## Notes for the turtle

- Prefer `.superturtle/.env` for live config
- Prefer repo-root `.env.example` when looking up optional env variables
- Check `super_turtle/CHANGELOG.md` first when behavior changed after an upgrade
