# Super Turtle Codebase Review

Reviewer: Claude (automated)
Date: 2026-03-08
Scope: `super_turtle/claude-telegram-bot/src/` (TypeScript source files)

---

## Findings

### 1. Bug: Voice handler missing `typingController` assignment

**File:** `super_turtle/claude-telegram-bot/src/handlers/voice.ts`, line 88
**Impact:** Stop commands can't kill the typing indicator during voice message processing.

The text handler properly sets `session.typingController = typing` (text.ts:197) and clears it in `finally` (text.ts:393). The deferred queue drain does the same (deferred-queue.ts:156-157). But the voice handler starts the typing indicator without registering it on the session:

```ts
// voice.ts:88 — typing starts
const typing = startTypingIndicator(ctx);
// ... but session.typingController is never set
```

When a user sends "stop" while a voice message is processing, `session.stopTyping()` is a no-op because `_typingController` is null. The typing indicator keeps firing until the voice handler's `finally` block runs.

**Fix:** Add `session.typingController = typing;` after line 88, and `session.typingController = null;` in the finally block (after `typing.stop()` on line 232).

---

### 2. Bug: Markdown blockquote converter strips ALL `#` characters from content

**File:** `super_turtle/claude-telegram-bot/src/formatting.ts`, line 112
**Impact:** Corrupts URLs with fragment identifiers, code containing `#`, and any hash-prefixed content inside blockquotes.

```ts
const content = line.slice(5).replace(/#/g, "");
```

The comment says "Telegram mobile bug workaround" but it removes every `#` in the entire line, not just leading ones. A blockquote containing `> See https://example.com/page#section` becomes `See https://example.com/pagesection`.

**Fix:** Replace `replace(/#/g, "")` with `replace(/^#+\s*/, "")` to only strip leading markdown header markers, which is likely the intended Telegram workaround.

---

### 3. Bug: `sendChunkedMessages` splits formatted HTML at arbitrary character positions

**File:** `super_turtle/claude-telegram-bot/src/handlers/streaming.ts`, lines 853-871
**Impact:** Splitting HTML at arbitrary offsets can cut tags mid-element (e.g., `<a href="ht` / `tp://...`), causing Telegram HTML parse errors. The fallback to plain text catches this, but users see degraded formatting.

```ts
for (let i = 0; i < content.length; i += TELEGRAM_SAFE_LIMIT) {
  const chunk = content.slice(i, i + TELEGRAM_SAFE_LIMIT);
```

The function receives already-formatted HTML but splits it by raw character offset without respecting tag boundaries.

**Fix:** Split the original markdown content into chunks first (by paragraph or line boundaries), then format each chunk independently with `convertMarkdownToHtml()`.

---

### 4. Security: `session.ts` tool safety checks cannot actually block execution

**File:** `super_turtle/claude-telegram-bot/src/session.ts`, lines 706-734
**Impact:** Misleading defense-in-depth. These checks appear to block dangerous Bash commands and file operations, but they run *after* the Claude CLI has already executed the tool.

The bot spawns Claude CLI with `--dangerously-skip-permissions` and reads the `stream-json` output. By the time the bot parses a `tool_use` event, the tool has already run. The `continue` statement just skips displaying the tool status — it doesn't prevent execution.

```ts
if (toolName === "Bash") {
  const [isSafe, reason] = checkCommandSafety(command);
  if (!isSafe) {
    // This logs and skips display, but the command already ran
    continue;
  }
}
```

**Fix:** Either (a) remove these checks and their misleading log messages to avoid false confidence, or (b) add a comment explicitly documenting that these are post-hoc audit checks, not blocking guards. If actual blocking is desired, the bot would need to use Claude's permission system instead of `--dangerously-skip-permissions`.

---

### 5. Dead code: Stall/spawn recovery prompts duplicated in text.ts

**File:** `super_turtle/claude-telegram-bot/src/handlers/text.ts`, lines 58-79
**Impact:** Confusing — two identical copies of `buildStallRecoveryPrompt` and `buildSpawnOrchestrationRecoveryPrompt`.

These functions are defined in both `text.ts` (lines 58-79) and `driver-routing.ts` (lines 27-48). The text handler now delegates to `driver-routing.ts` via `runMessageWithActiveDriver()`, which has its own retry logic with these same prompts. The copies in `text.ts` are used in the text handler's own retry loop (lines 257-313), which is a second layer of retry on top of the driver-routing retry.

**Fix:** Remove the duplicate functions from `text.ts` and either import from `driver-routing.ts` or (better) remove the text handler's redundant retry loop entirely, since `runMessageWithActiveDriver` already retries with the same logic.

---

### 6. Dead code: Unused `PINO_LOG_PATH` import in streaming.ts

**File:** `super_turtle/claude-telegram-bot/src/handlers/streaming.ts`, line 27
**Impact:** Minor — unused import adds noise.

```ts
import { PINO_LOG_PATH, streamLog } from "../logger";
```

`PINO_LOG_PATH` is imported but never referenced in `streaming.ts`. The pino log reading logic uses `readPinoLogLines` from `log-reader.ts` which handles its own path.

**Fix:** Remove `PINO_LOG_PATH` from the import.

---

### 7. Code duplication: Shared utilities copy-pasted across 4+ files

**Files:**
- `isObjectRecord`: conductor-supervisor.ts:167, conductor-maintenance.ts:46, conductor-inbox.ts:96, dashboard.ts:178
- `readJsonObject`: conductor-supervisor.ts:171, conductor-maintenance.ts:50, conductor-inbox.ts:100
- `atomicWriteText` / `atomicWriteJson`: conductor-supervisor.ts:156-164, conductor-inbox.ts:85-93
- `utcNowIso`: conductor-supervisor.ts:148, conductor-inbox.ts:77
- `getErrorMessage`: session.ts:174, text.ts:44, index.ts:146

**Impact:** Maintenance burden — fixing a bug in one copy requires finding and updating all copies.

**Fix:** Extract these into a shared utility module (e.g., `src/conductor-utils.ts` for the conductor helpers, or add `getErrorMessage` to existing `utils.ts`) and import everywhere.

---

### 8. Bug: Double retry loop for text messages

**File:** `super_turtle/claude-telegram-bot/src/handlers/text.ts`, lines 207-388
**Impact:** The text handler has its own retry loop (lines 209-388) with `MAX_RETRIES = 1`, wrapping `driver.runMessage()`. But `driver.runMessage()` resolves to `runMessageWithActiveDriver()` which calls `runMessageWithDriver()` in `driver-routing.ts` — which has its *own* retry loop with `MAX_RETRIES = 1`. This means a stall or crash can trigger up to 4 total attempts (2 retries x 2 levels), not the intended 2.

```
text.ts retry loop (attempt 0, 1)
  └── driver-routing.ts retry loop (attempt 0, 1)
```

**Fix:** Remove the retry loop from `text.ts` and let `driver-routing.ts` handle all retry logic. The text handler already delegates to the driver abstraction for this.

---

### 9. Race: Instance lock has TOCTOU window

**File:** `super_turtle/claude-telegram-bot/src/index.ts`, lines 126-129
**Impact:** Low — only matters if two bot instances start simultaneously.

Between `unlinkSync(INSTANCE_LOCK_FILE)` and `writeLock()`, another process could also detect the stale lock, unlink it, and write its own. Both processes would think they acquired the lock.

```ts
try { unlinkSync(INSTANCE_LOCK_FILE); } catch {}
writeLock(); // Another process could race here
```

**Fix:** Use a rename-based approach: write a new lock file with a temp name, then `renameSync` over the old lock atomically. Or use `flock`/advisory locking.

---

### 10. Missing error handling: `checkCommandSafety` rm path parsing is easily bypassed

**File:** `super_turtle/claude-telegram-bot/src/security.ts`, lines 133-153
**Impact:** Combined with finding #4, this is low-severity since these checks are post-hoc anyway. But the rm path parsing can be bypassed with shell features like quotes, variables, subshells, semicolons, or pipes.

```ts
// This won't catch: rm -rf "$(echo /)"
// Or: rm -rf /tmp/../../../
// Or: cat /dev/null | rm -rf /
const args = rmMatch[1]!.split(/\s+/);
```

**Fix:** If keeping these as audit checks, document that they're best-effort heuristics. For actual safety, rely on Claude's built-in permission system or containerization.

---

## Summary — TypeScript bot

| # | Severity | Type | File | Fix effort |
|---|----------|------|------|------------|
| 1 | Medium | Bug | voice.ts | 5 min |
| 2 | Medium | Bug | formatting.ts | 5 min |
| 3 | Low | Bug | streaming.ts | 20 min |
| 4 | Medium | Security | session.ts | 10 min |
| 5 | Low | Dead code | text.ts | 10 min |
| 6 | Low | Dead code | streaming.ts | 1 min |
| 7 | Low | Duplication | 4+ files | 20 min |
| 8 | Medium | Bug | text.ts + driver-routing.ts | 15 min |
| 9 | Low | Race condition | index.ts | 10 min |
| 10 | Low | Error handling | security.ts | 5 min |

---

## Findings — `super_turtle/subturtle/` (Python loop runner, ctl CLI, helpers)

Scope: `ctl` (bash CLI, 1581 lines), `__main__.py` (Python loop runner, 909 lines), `subturtle_loop/agents.py` (agent wrappers), `start-tunnel.sh`, `browser-screenshot.sh`, `claude-md-guard/` (validate, stats, config), tests.

### 11. Bug: `start-tunnel.sh` subshell `wait` cannot wait on parent's children

**File:** `super_turtle/subturtle/start-tunnel.sh`, lines 177-192
**Impact:** The monitoring loop at the bottom of the script is broken. The `wait $DEV_PID` and `wait $TUNNEL_PID` calls are inside subshells `(...)`, but a subshell cannot wait on the parent shell's child processes — `wait` only works on children of the current shell. These subshells exit immediately (wait returns non-zero for unknown PIDs), making `DEV_WAIT_PID` and `TUNNEL_WAIT_PID` useless.

```bash
(
  wait $DEV_PID 2>/dev/null   # Can't wait — DEV_PID is parent's child
  DEV_EXIT=$?
) &
```

The `while kill -0 ... sleep 1` polling loop on line 190 does the actual monitoring, so the script still works — but the subshell indirection is dead code that obscures this.

**Fix:** Remove the two subshell blocks (lines 177-187) and `DEV_WAIT_PID`/`TUNNEL_WAIT_PID`. The `kill -0` polling loop already handles process monitoring correctly.

---

### 12. Bug: `validate.sh` passes content through CLI args — breaks on special characters

**File:** `super_turtle/subturtle/claude-md-guard/validate.sh`, lines 70-83
**Impact:** The Edit tool handler passes `OLD_STRING` and `NEW_STRING` as `sys.argv` to Python via inline `python3 -c "..."`. Content containing single quotes, double quotes, backslashes, dollar signs, or null bytes will break the shell quoting or Python string parsing. Since CLAUDE.md content regularly contains code blocks with these characters, this will cause false validation failures or silent data corruption.

```bash
python3 -c "
import sys
with open(sys.argv[1]) as f:
    content = f.read()
print(content.replace(sys.argv[2], sys.argv[3], 1), end='')
" "$FILE_PATH" "$OLD_STRING" "$NEW_STRING" > "$TMP"
```

The `$OLD_STRING` and `$NEW_STRING` come from `json_value` which writes to stdout — they lose their original JSON escaping and go through shell expansion. A string containing `$HOME` or backticks would be interpreted by the shell.

**Fix:** Pass the strings via environment variables or temp files instead of positional args. Or better, do the entire Edit simulation in a single Python script that reads the JSON input directly rather than extracting fields via shell.

---

### 13. Bug: `ctl` watchdog runs in a subshell — `read_meta`, `append_conductor_event` may fail

**File:** `super_turtle/subturtle/ctl`, lines 815-838
**Impact:** The watchdog timeout handler runs in a background subshell `(...)`. Inside that subshell, it calls `append_conductor_event`, `write_conductor_worker_state`, and `enqueue_conductor_wakeup` — which call `read_meta` to get `RUN_ID`. But the subshell inherits the parent's environment at spawn time, not the current state. If the meta file was updated after spawn (e.g., `CRON_JOB_ID` was appended on line 1162), the watchdog's `read_meta` will read the correct file since it re-reads from disk. However, the `>> "$lf"` log writes race with the SubTurtle process that also writes to the same log file without any locking, which can produce interleaved/corrupted log lines.

```bash
(
  sleep "$timeout_secs"
  # These log writes race with the SubTurtle process writing to the same file
  echo "[subturtle:${name}] TIMEOUT ..." >> "$lf"
  ...
  echo "[subturtle:${name}] timed out and killed" >> "$lf"
) &
```

**Fix:** Use `flock` on the log file for appends, or redirect watchdog output through a separate channel (e.g., stderr or a `.watchdog.log` file).

---

### 14. Bug: `_write_completion_notification` in `__main__.py` is dead code

**File:** `super_turtle/subturtle/__main__.py`, lines 210-326
**Impact:** The function `_write_completion_notification` creates cron-based one-shot jobs for completion notification, but it is never called anywhere. The completion path now uses `_record_completion_pending` (line 374) which writes conductor wakeups instead. This 116-line function adds confusion about which completion path is canonical.

Searching for call sites:
- `_record_completion_pending` is called in all 4 loop types on self-stop
- `_write_completion_notification` has zero callers

**Fix:** Delete `_write_completion_notification` entirely. The conductor wakeup path is the canonical completion mechanism.

---

### 15. Bug: Infinite retry loop on repeated agent crashes

**File:** `super_turtle/subturtle/__main__.py`, lines 738-757 (and similar in all loop variants)
**Impact:** If the agent CLI consistently crashes (e.g., auth expired, binary missing, network down), the loop retries forever with only a 10-second delay. There is no max-retry counter — the only way out is the watchdog timeout or manual `ctl stop`. This can waste significant compute/API quota on a broken loop.

```python
while True:
    ...
    try:
        claude.execute(prompt)
    except (subprocess.CalledProcessError, OSError) as e:
        _log_retry(name, e)  # sleeps 10s, then loops forever
    ...
```

**Fix:** Add a `MAX_CONSECUTIVE_FAILURES` counter (e.g., 5). After N consecutive failures without a successful iteration, emit a `worker.fatal_error` event and exit. The watchdog already handles timeouts; this addresses the fast-crash scenario.

---

### 16. Bug: `do_reschedule_cron` references undefined `CRON_JOBS_FILE_REL`

**File:** `super_turtle/subturtle/ctl`, line 1069
**Impact:** If the Python reschedule script fails with a non-42 exit code, the error message prints `$CRON_JOBS_FILE_REL` which is never defined. Under `set -u` (from `set -euo pipefail`), this would cause the script to crash with an "unbound variable" error instead of printing the intended error message. However, `set -u` is active here, so this is actually a latent crash bug on the error path.

```bash
echo "ERROR: failed to update cron jobs in ${CRON_JOBS_FILE_REL}" >&2
```

**Fix:** Change `$CRON_JOBS_FILE_REL` to `$CRON_JOBS_FILE`.

---

### 17. Security: `validate.sh` passes JSON via environment variable to Python

**File:** `super_turtle/subturtle/claude-md-guard/validate.sh`, lines 12-38
**Impact:** The `json_value` function passes the full JSON input (which includes file content) via the `INPUT_JSON` environment variable. Environment variables have platform-specific size limits (typically 128KB–2MB). A large CLAUDE.md content in the JSON payload could silently truncate, causing malformed JSON parsing that either errors or silently accepts invalid content.

```bash
json_value() {
  local key="$1"
  INPUT_JSON="$INPUT" python3 - "$key" <<'PY'
```

**Fix:** Write the JSON input to a temp file and have Python read from it, or pipe it via stdin. The `$INPUT` on line 8 already reads all of stdin — pass it through a file to avoid env size limits.

---

### 18. Bug: `browser-screenshot.sh` legacy `--app` and `--mode` flags consume next argument

**File:** `super_turtle/subturtle/browser-screenshot.sh`, lines 108-111
**Impact:** The legacy Peekaboo flags `--app`, `--mode`, and `--capture-focus` are documented as "accepted, ignored" but they `shift 2` — consuming the next argument as a value. If a user passes `--app http://localhost:3000`, the URL is swallowed as the ignored flag's value and never set as the target URL. Meanwhile, `--retina` and `--json-output` correctly `shift` only 1.

```bash
--app|--mode|--capture-focus)
  warn "$1 is a legacy Peekaboo flag and will be ignored"
  shift 2  # Eats the next argument even though these are boolean flags
  ;;
```

**Fix:** If these were originally boolean flags in Peekaboo, change to `shift 1`. If they originally took values, keep `shift 2` but document which are boolean vs. value flags. Safest fix: `shift 1` for all, since they're ignored anyway.

---

### 19. Dead code: `subturtle_loop/__main__.py` is a separate unused entrypoint

**File:** `super_turtle/subturtle/subturtle_loop/__main__.py`
**Impact:** This file defines its own `run_once()` function, `GROOMER_INSTRUCTIONS`, `EXECUTOR_PROMPT_TEMPLATE`, and a `main()` CLI entrypoint (`agnt-handoff`). None of this is used by the actual SubTurtle loop system, which runs through `super_turtle/subturtle/__main__.py`. The two files have different prompt templates, different orchestration patterns, and different CLI interfaces. This is confusing for anyone trying to understand the codebase.

**Fix:** Delete `subturtle_loop/__main__.py` if it's truly unused, or if it serves a different purpose (standalone one-shot handoff), move it out of the `subturtle_loop` package and give it a distinct name.

---

### 20. Bug: `ctl` cron-jobs.json writes are not atomic — concurrent writers can corrupt

**File:** `super_turtle/subturtle/ctl`, lines 879-953 (register_spawn_cron_job), 957-993 (remove_spawn_cron_job)
**Impact:** Multiple concurrent operations (spawn, stop, completion notification, reschedule) all read-modify-write `cron-jobs.json` without locking. If two SubTurtles complete at the same time, or a spawn and a stop overlap, one write can clobber the other's changes, losing cron job entries.

The same pattern exists in `__main__.py`'s `_write_completion_notification` (line 316) — though that function is currently dead code (finding #14).

```python
# In register_spawn_cron_job (inline Python):
jobs = json.loads(raw)      # Read
jobs.append(job)            # Modify
cron_jobs_path.write_text(json.dumps(jobs, indent=2))  # Write — no lock
```

**Fix:** Use atomic write (write to temp file + rename) and file-level locking (`flock` in bash or `fcntl` in Python) around all cron-jobs.json mutations.

---

## Summary — Python subturtle

| # | Severity | Type | File | Fix effort |
|---|----------|------|------|------------|
| 11 | Low | Dead code | start-tunnel.sh | 5 min |
| 12 | Medium | Bug | claude-md-guard/validate.sh | 20 min |
| 13 | Low | Race condition | ctl (watchdog) | 15 min |
| 14 | Low | Dead code | __main__.py | 5 min |
| 15 | Medium | Bug | __main__.py (all loops) | 15 min |
| 16 | Medium | Bug | ctl | 1 min |
| 17 | Low | Security | claude-md-guard/validate.sh | 10 min |
| 18 | Low | Bug | browser-screenshot.sh | 2 min |
| 19 | Low | Dead code | subturtle_loop/__main__.py | 5 min |
| 20 | Medium | Bug | ctl (cron-jobs.json) | 20 min |
