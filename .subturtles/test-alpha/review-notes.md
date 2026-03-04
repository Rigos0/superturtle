# SubTurtle Infrastructure Review — ctl + __main__.py

## ctl (bash, ~1225 lines)
Well-structured CLI with commands: start, spawn, stop, status, logs, list, archive, gc, reschedule-cron.

**Strengths:**
- `set -euo pipefail` throughout; safe meta file parsing via `grep` (never sources)
- Watchdog is fire-and-forget with `disown`; SIGTERM → SIGKILL escalation
- Inline Python for spawn (env sanitization, writable-HOME fallback) is thorough
- Duration parsing handles m/h/d suffixes + raw seconds with validation
- Cron registration + removal properly handles unique ID generation

**Issues found:**
1. **PID race (medium):** `is_running` reads PID and checks `kill -0` non-atomically — stale PID could match a recycled process
2. **`do_spawn` references undefined var:** Line 833 uses `CRON_JOBS_FILE_REL` but only `CRON_JOBS_FILE` is defined (line 12)
3. **Watchdog orphan cleanup:** If the main process dies before watchdog PID is written to meta, `do_stop` can't kill the watchdog
4. **`stat` portability:** `do_gc` tries BSD `stat -f '%m'` then GNU `stat -c '%Y'` — works but fragile

## __main__.py (Python, ~643 lines)
Clean loop dispatcher with 4 loop types: slow, yolo, yolo-codex, yolo-codex-spark.

**Strengths:**
- STOP directive detection is simple and reliable (string search in state file)
- Completion notification queues two cron jobs (immediate UX ping + meta-agent follow-up)
- `_archive_workspace` safely clears own PID before calling `ctl stop`
- Retry logic with delay prevents tight crash loops

**Issues found:**
1. **Code duplication (low):** `run_yolo_loop`, `run_yolo_codex_loop`, `run_yolo_codex_spark_loop` are nearly identical — could be one function parameterized by agent type
2. **No iteration cap:** Loops run forever until STOP directive; a runaway agent that never writes STOP will loop until watchdog timeout (by design, but worth noting)
3. **`_write_completion_notification` is ~100 lines** for what is essentially "append two JSON objects" — inline cron-job creation duplicates logic from ctl's `register_spawn_cron_job`

## Summary
Architecture is sound. Main risks are timing/concurrency in PID management and the undefined `CRON_JOBS_FILE_REL` variable in `do_spawn`. Code duplication across yolo loop variants is the biggest cleanup opportunity.
