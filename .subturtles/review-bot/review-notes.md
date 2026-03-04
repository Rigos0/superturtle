# Code Review: session.ts, driver-routing.ts, dashboard.ts

## High Priority

**1. Tool safety checks are observational, not blocking** (`session.ts:600-628`)
The Bash/Read/Write/Edit security checks log "BLOCKED" and `continue` past the display, but the CLI subprocess has already executed the tool. The bot reads stream-json events *after* execution. These checks are misleading — they report a block that didn't actually happen. Either remove the false "BLOCKED" label or document this as monitoring-only.

**2. backgroundRunDepth leak on exception** (`driver-routing.ts:62-71`)
`beginBackgroundRun()` increments depth but nothing guarantees `endBackgroundRun()` runs on error. If the caller throws between begin/end, depth stays elevated forever, making `isBackgroundRunActive()` return true and blocking preemption logic. Needs try/finally or RAII-style guard.

**3. Logs join uses literal `\\n` instead of newline** (`dashboard.ts:757,784,804`)
`logs.lines.join("\\n")` in template literals produces the two-char string `\n` between log lines, not actual newlines. In `<pre>` tags this renders as visible `\n` text instead of line breaks. Should be `logs.lines.join("\n")`.

## Medium Priority

**4. `parseInt(value, 10) || null` treats zero as null** (`dashboard.ts:80-82,98`)
`parseMetaFile` uses `parseInt(v) || null` for SPAWNED_AT, TIMEOUT_SECONDS, WATCHDOG_PID. A valid value of `0` becomes `null`. Use `const n = parseInt(v, 10); result.x = Number.isNaN(n) ? null : n;` instead.

**5. stopActiveDriverQuery stops unrelated driver** (`driver-routing.ts:175-184`)
When the current driver returns falsy from stop(), the function tries the fallback driver. If Claude is idle and a user stops, it'll attempt to stop a potentially-unrelated Codex run. The fallback should only trigger when the intent is "stop everything."

**6. Auth token timing-safe comparison missing** (`dashboard.ts:119-134`)
Token comparison uses `===` which is vulnerable to timing attacks. Low severity for local dashboard but easy to fix with `crypto.timingSafeEqual()`.

## Low Priority

**7. Job detail logs name extraction is brittle** (`dashboard.ts:1124-1125`)
`detail.logsLink.split("/")[3]!` assumes URL structure `/api/subturtles/{name}/logs`. If the format changes, this silently extracts the wrong name. Extract the name from `detail.job.ownerId` instead.

**8. loadSessionHistory double-reads file** (`session.ts:940-951`)
Checks `Bun.file(SESSION_FILE).size` then reads with `readFileSync`. Could just try `readFileSync` in one step.

**9. No process ID validation on HTML detail route** (`dashboard.ts:1105-1116`)
`/dashboard/processes/:id` doesn't validate the ID unlike the subturtles route. Safe since `buildProcessDetail` does `.find()`, but inconsistent.

**10. Stall recovery reuses session with partial state** (`driver-routing.ts:123-135`)
After stall with tool use, recovery prompt is sent to the same session that may have partially-executed side effects. The recovery prompt says "verify what already happened" which is good, but the session's internal state (tool tracking, etc.) may be inconsistent.
