# Handler Review Notes

Reviewed:
- `super_turtle/claude-telegram-bot/src/handlers/text.ts`
- `super_turtle/claude-telegram-bot/src/handlers/stop.ts`

Findings:
1. Retry logic drift risk (medium)
   - `text.ts` implements its own stall/crash retry flow (`text.ts:195-333`) while similar logic also exists in `driver-routing.ts:87-143`.
   - This duplicates recovery prompts/conditions and can diverge over time.
   - Improvement: centralize retry behavior in `driver-routing` and keep `text.ts` focused on handler UX.

2. `ctl list` failure path is not checked (medium)
   - `stopAllRunningSubturtles()` parses stdout/stderr from `Bun.spawnSync([CTL_PATH, "list"])` without checking `exitCode` (`stop.ts:43-46`).
   - If `ctl list` fails, stderr noise is still parsed; stop outcome can be misleading.
   - Improvement: gate parsing on `exitCode === 0`, otherwise log and return empty attempted/stopped/failed.

3. Stop confirmation message hides partial failures (low)
   - `handleStop()` always replies `🛑 Stopped.` (+ queue count) (`stop.ts:133-149`) even when some SubTurtles failed to stop.
   - Improvement: include compact failure detail (e.g. `Stopped 2/3 SubTurtles; failed: gamma`) for operator clarity.

Positive note:
- Stop flow ordering is solid: suppress drain first, stop active driver, then clear queue (`stop.ts:75-86`), which avoids post-stop queue races.
