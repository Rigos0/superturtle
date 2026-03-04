# SubTurtle Infrastructure Review

## ctl script (~1225 lines)

### Critical

1. **`do_stop` exits instead of returning (line 876)** — `do_stop` calls `exit 0` when process is not running. When `do_spawn` calls `do_stop` on cron failure (line 836), the `exit 0` terminates the entire script before the `exit 1` on line 838 executes. The spawn appears successful when it should report failure.

2. **Undefined variable `CRON_JOBS_FILE_REL` (lines 749, 833)** — Error messages reference `${CRON_JOBS_FILE_REL}` which is never defined. Only `CRON_JOBS_FILE` exists. These error paths silently produce empty strings instead of useful paths.

3. **`do_gc` doesn't skip `.archive` directory (line 1021)** — The glob `"$SUBTURTLES_DIR"/*/` matches `.archive/`. `do_list` explicitly skips it (line 1103) but `do_gc` does not. If `.archive` is old enough, `do_archive ".archive"` tries to move `.subturtles/.archive` into itself — undefined behavior.

### Medium

4. **No process group kill on stop** — Only the main PID is killed (lines 883, 898). The SubTurtle spawns with `start_new_session=True` (line 479), creating its own process group. Child processes (claude/codex CLI) are not killed and become orphans. Should use `kill -- -$pgid` or `kill -TERM -$pid` to kill the entire process group.

5. **No SubTurtle name sanitization** — User-supplied name goes directly into path construction via `workspace_dir()`. Names like `../foo`, names with spaces, or names matching `.archive` could cause path traversal or collisions. Should validate: alphanumeric + hyphens only.

6. **Watchdog/stop race on PID and meta files** — The watchdog (lines 511-523) and `do_stop` both delete PID/meta files. If both fire concurrently (timeout fires during manual stop), they race on file removal. Low probability but could cause confusing error messages.

7. **Watchdog doesn't clean up tunnels** — Watchdog kills process and removes PID/meta files but doesn't stop any tunnel processes. If a SubTurtle started a tunnel, the cloudflared process survives timeout.

### Low

8. **`read_meta` uses global variables** — All callers share the same globals (SPAWNED_AT, TIMEOUT_SECONDS, etc.). Two calls to `read_meta` in the same function can overwrite each other's state. Currently no bugs from this but fragile pattern.

9. **Python log_fd leak on spawn failure** — In the inline Python launcher (line 468), if `Popen` raises, `log_fd` is never closed. Minor — the process exits anyway.

10. **`stat` portability handled well** — Lines 1029-1033 try macOS `stat -f` then Linux `stat -c`. Good defensive coding.

## __main__.py

(pending review)
