# SuperTurtle User Notes

This file is for humans and turtles working in this repo after installing or upgrading SuperTurtle.

## Latest release highlights

- Updated model line-up: Claude **Opus 4.8** / **Sonnet 5** (with new `xhigh` effort), and Codex **GPT-5.6** Sol/Terra/Luna (default: `gpt-5.6-terra`); SDKs bumped to current releases
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

## Notes for the turtle

- Prefer `.superturtle/.env` for live config
- Prefer repo-root `.env.example` when looking up optional env variables
- Check `super_turtle/CHANGELOG.md` first when behavior changed after an upgrade
