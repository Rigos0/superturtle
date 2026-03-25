# Managed Runtime E2B Fix

## Problem

`superturtle@0.2.8` can fail to start inside the hosted E2B managed sandbox even though:

- the sandbox image contains `superturtle`
- the managed `.superturtle/.env` is correct
- `TELEGRAM_TRANSPORT=webhook`
- `SUPERTURTLE_RUNTIME_ROLE=teleport-remote`
- `SUPERTURTLE_REMOTE_MODE=agent`

Observed behavior in the live sandbox:

- `superturtle service run` exits with code `1`
- nothing listens on port `3000`
- `/readyz` never comes up
- `superturtle-web` hangs during `/api/managed/telegram/configure` while waiting for readiness

The only visible log line before exit is:

```text
Failed to connect to system scope bus via local transport: No such file or directory
```

## Root Cause

In `super_turtle/bin/superturtle.js`, Linux uses:

```text
systemd-inhibit --what=idle --who=superturtle --why='Bot running' --mode=block
```

whenever `systemd-inhibit` exists in `PATH`.

That assumption is wrong for E2B managed sandboxes:

- the binary can exist
- but the system bus is not actually available
- so the wrapper exits immediately before `run-loop.sh` keeps the service alive

Relevant code path:

- `super_turtle/bin/superturtle.js`
- `getKeepAwakeCommand()`
- `buildPlatformServiceCommand()`
- `serviceRun()`

## Temporary Hotfix Already Shipped

`superturtle-web` now installs a no-op `systemd-inhibit` shim into managed sandboxes before starting the runtime.

That unblocks production immediately, but it is only a compatibility workaround.

## Proper Upstream Fix Needed Here

Fix `agentic` so managed E2B runtimes do not depend on the shim.

Recommended direction:

1. Do not use `systemd-inhibit` in managed/E2B environments.
2. Gate sleep-prevention by environment capability, not by binary presence alone.
3. Keep existing macOS `caffeinate` behavior for local machines.

Good options:

- Skip `systemd-inhibit` when `SUPERTURTLE_RUNTIME_ROLE=teleport-remote`
- or skip it when `TELEGRAM_TRANSPORT=webhook`
- or add an explicit env guard like `SUPERTURTLE_DISABLE_SLEEP_PREVENTION=true`
- or probe whether `systemd-inhibit` is actually usable before wrapping `run-loop.sh`

The safest immediate upstream change is probably:

```text
if Linux && SUPERTURTLE_RUNTIME_ROLE === "teleport-remote" => no systemd-inhibit
```

## Repro

Inside a managed sandbox with:

```text
SUPERTURTLE_RUNTIME_ROLE=teleport-remote
SUPERTURTLE_REMOTE_MODE=agent
TELEGRAM_TRANSPORT=webhook
PORT=3000
```

run:

```bash
superturtle service run
```

Broken result:

- exits immediately
- prints the system bus error above

Working result:

- process stays alive
- webhook transport starts
- `curl http://127.0.0.1:3000/readyz` returns `200 ok`

## Validation After Upstream Fix

After fixing `agentic`, verify:

1. `superturtle service run` stays alive in an E2B managed sandbox without any shim.
2. Port `3000` is listening.
3. `/healthz` and `/readyz` return `200`.
4. Telegram webhook setup in `superturtle-web` finishes without hanging.
5. Existing local Linux sleep-prevention behavior is still acceptable outside managed sandboxes.
