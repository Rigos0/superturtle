# SuperTurtle User Notes

This file is for humans and turtles working in this repo after installing or upgrading SuperTurtle.

## Latest release highlights

- Fixed a Codex stalling issue around pending tool output delivery
- Reduced Telegram push noiwdym se: intermediate updates are silent, while the final reply still notifies normally
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

## Managed Dev Flow

- `../agentic` is the runtime repo. `../superturtle-web` is the hosted control-plane repo.
- Use 2 loops:
  - Runtime validation: publish an exact `superturtle@<version>` beta, point `../superturtle-web/.env.local` at that exact spec, then run `bun run dev:managed-recreate-sandbox -- --email <you@example.com> --version superturtle@<exact-version>` from `../superturtle-web` or rerun onboarding from a clean reset
  - Web app dev: change `../superturtle-web` locally against the shared `test` backend
- Use `bun run dev:managed-recreate-sandbox -- --email <you@example.com>` from `../superturtle-web` when you want a fresh managed sandbox without resetting hosted state.
- Do not use source-sync or warm-sandbox runtime patch flows. Real managed validation should use the published exact runtime artifact.
- `bun run dev:reset-onboarding -- --email <you@example.com>` only clears hosted app state.
- Add `--delete-sandbox` if you also want the current managed E2B sandbox removed.
- `main` stays the only long-lived runtime branch. Use `feat/unify-managed-runtime` only as the temporary integration branch until it lands back on `main`.

## Communication Preference

When summarizing work for the user:

- keep it very short
- prefer 1-3 bullets or 2-4 short sentences
- lead with the outcome, not the background
- avoid long setup, caveats, or repeated context unless the user asks for detail

## Notes for the turtle

- Prefer `.superturtle/.env` for live config
- Prefer repo-root `.env.example` when looking up optional env variables
- Check `super_turtle/CHANGELOG.md` first when behavior changed after an upgrade
