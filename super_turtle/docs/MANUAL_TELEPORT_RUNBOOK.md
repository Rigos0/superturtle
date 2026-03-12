# Manual Teleport Runbook

This is the operator runbook for the first manual `teleport` flow:

- source host: local macOS repo
- target host: remote Linux VM over SSH
- continuity model: same Telegram bot identity, semantic Claude/Codex handoff on the next turn

## Remote Prerequisites

Target host assumptions:

- Ubuntu 24.04 or another Linux host with SSH access
- `git`
- `rsync`
- `tmux`
- `python3`
- `bun`
- `claude` if the active driver is Claude
- `codex` if the active driver is Codex

Example check:

```bash
ssh <user>@<host> 'uname -a && command -v git rsync tmux python3 bun claude'
```

## Claude Auth

For teleport testing, the simplest path is to store a Claude OAuth token in the project env file so it gets synced to the remote host with the repo.

### Preferred Flow: `claude setup-token`

Run this from your local machine:

```bash
ssh -t <user>@<host> 'claude setup-token'
```

That command prints a login URL. Open it in your local browser, finish the login flow, then paste the returned authentication code back into the same SSH session. Claude prints a long-lived token when setup completes.

Add that token to the local project env:

```bash
CLAUDE_CODE_OAUTH_TOKEN=<token>
```

File:

- `.superturtle/.env`

Why this works:

- `superturtle start` loads `.superturtle/.env`
- `run-loop.sh` sources the same file on the remote host
- the teleport sync copies the project env file to the Linux machine

### Alternative Flow: interactive remote login

If you do not want to use `CLAUDE_CODE_OAUTH_TOKEN`, the remote host can already be logged into Claude before teleport starts. In that case, normal remote `claude` auth state is enough.

## Codex Auth

Codex uses its own auth cache under `~/.codex/`. For a remote Linux VM, there are two practical paths.

### Preferred Flow: `codex login --device-auth`

Run this from your local machine:

```bash
ssh -t <user>@<host> 'codex login --device-auth'
```

That command prints a URL and one-time code. Open the URL in your local browser, enter the code, and the remote CLI finishes login without needing a local browser on the VM.

Verify:

```bash
ssh <user>@<host> 'codex login status'
```

### Fallback Flow: copy `~/.codex/auth.json`

If the local machine is already logged into Codex, you can copy the auth cache directly:

```bash
ssh <user>@<host> 'mkdir -p ~/.codex && chmod 700 ~/.codex'
scp ~/.codex/auth.json <user>@<host>:~/.codex/auth.json
ssh <user>@<host> 'chmod 600 ~/.codex/auth.json && codex login status'
```

This was the path used for the first Azure validation because it is fast and works cleanly in a headless setup.

## Security Notes

- Do not commit `.superturtle/.env`
- Do not paste OAuth tokens into chat
- If a token is exposed in chat or logs, rotate it after the test
- The current manual teleport is intentionally dangerous and operator-driven; it is not a safe delegated action for the bot loop

## Dry Run

```bash
./super_turtle/scripts/teleport-manual.sh <user>@<host> /home/<user>/project --identity ~/.ssh/<key_name> --dry-run
```

Expected outcome:

- local preflight passes
- remote preflight passes
- initial `rsync` resolves cleanly
- no local bot shutdown happens

## Live Cutover

Run teleport while the bot is idle:

```bash
./super_turtle/scripts/teleport-manual.sh <user>@<host> /home/<user>/project --identity ~/.ssh/<key_name>
```

What it does:

1. preflights local and remote requirements
2. exports a teleport handoff bundle
3. syncs the repo to the remote host
4. installs bot dependencies remotely
5. stops local SubTurtles
6. stops the local bot
7. imports portable runtime state on the remote host
8. rewrites remote path-bound env values for Linux
9. starts the remote bot
10. sends a Telegram completion message from the remote side

## Acceptance Check

After the script reports success:

- local `bun super_turtle/bin/superturtle.js status` shows `Bot: stopped`
- remote `bun super_turtle/bin/superturtle.js status` shows `Bot: running`
- the next Telegram message to the bot is answered by the remote host

## Stop The Remote Bot

If the teleported bot has already finished its work and everything important is committed, the safe operator path is simply to stop the remote instance:

```bash
ssh <user>@<host> 'cd /home/<user>/project && bun super_turtle/bin/superturtle.js stop'
```

Verify:

```bash
ssh <user>@<host> 'cd /home/<user>/project && bun super_turtle/bin/superturtle.js status'
```

Expected result:

- `Bot: stopped`

## Start The Remote Bot Again Later

If you want to bring the same teleported instance back up on the cloud host later:

```bash
ssh <user>@<host> 'cd /home/<user>/project && git pull --ff-only && bun super_turtle/bin/superturtle.js start'
```

Verify:

```bash
ssh <user>@<host> 'cd /home/<user>/project && bun super_turtle/bin/superturtle.js status'
```

Expected result:

- `Bot: running`

## Manual Return To Local

There is no reverse `teleport back` script yet.

Current operator procedure:

1. Stop the remote bot.
2. Make sure any desired work is committed and pushed from the remote machine.
3. On the local machine, `git pull --ff-only` so the local repo has the same commits.
4. Start the local bot normally.

Local restart:

```bash
cd /path/to/project
bun super_turtle/bin/superturtle.js start
```

Local verification:

```bash
bun super_turtle/bin/superturtle.js status
```

This is sufficient when the remote work is already committed and you do not need live semantic handoff back to the local host.

## Current Limitations

- This preserves semantic conversation continuity, not the exact provider-native Claude/Codex thread
- Existing SubTurtle processes are stopped locally and are not auto-restarted remotely in v1
- There is no automatic rollback if the remote start fails after local shutdown
- Reverse teleport back to local is not implemented yet; returning local is currently a manual stop/pull/start flow
