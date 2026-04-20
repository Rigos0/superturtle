"""State-file and conductor helpers for SubTurtle loops."""

from __future__ import annotations

import datetime
import json
import re
import subprocess
import sys
from pathlib import Path

try:
    from super_turtle.state.conductor_state import ConductorStateStore
    from super_turtle.state.run_state_writer import refresh_handoff_from_conductor
except ModuleNotFoundError:
    from state.conductor_state import ConductorStateStore
    from state.run_state_writer import refresh_handoff_from_conductor

STOP_DIRECTIVE = "## Loop Control\nSTOP"


def resolve_state_ref(state_dir: Path, name: str) -> tuple[Path, str]:
    """Return the state file path and display reference, or exit on error."""
    state_file = state_dir / "CLAUDE.md"

    if not state_file.exists():
        print(
            f"[subturtle:{name}] ERROR: state file not found: {state_file}\n"
            f"[subturtle:{name}] The meta agent must write CLAUDE.md before starting a SubTurtle.",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        rel_state = state_file.relative_to(Path.cwd())
        state_ref = str(rel_state)
    except ValueError:
        state_ref = str(state_file)

    return state_file, state_ref


def utc_now_iso() -> str:
    """Return the current UTC time in conductor-friendly ISO-8601 format."""
    return (
        datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def run_state_dir(project_dir: Path) -> Path:
    """Return the canonical conductor state directory for a project."""
    return project_dir / ".superturtle" / "state"


def result_file_path(project_dir: Path, worker_name: str) -> Path:
    """Return the canonical result file path for a worker."""
    return run_state_dir(project_dir) / "results" / f"{worker_name}.json"


def extract_current_task(state_file: Path) -> str | None:
    """Read the first non-empty line from the Current task section."""
    try:
        text = state_file.read_text(encoding="utf-8")
    except OSError:
        return None

    lines = text.splitlines()
    in_current = False
    for line in lines:
        stripped = line.strip()
        if not in_current:
            if stripped.lower() == "# current task":
                in_current = True
            continue

        if stripped.startswith("#"):
            break

        cleaned = re.sub(r"\s*<-\s*current\s*$", "", stripped).strip()
        if cleaned:
            return cleaned
    return None


def refresh_handoff(project_dir: Path, name: str) -> None:
    """Re-render handoff artifacts from canonical conductor state."""
    try:
        refresh_handoff_from_conductor(run_state_dir(project_dir))
    except (OSError, ValueError, json.JSONDecodeError, RuntimeError) as error:
        print(
            f"[subturtle:{name}] WARNING: failed to refresh handoff: {error}",
            file=sys.stderr,
        )


def git_head_sha(project_dir: Path) -> str | None:
    """Return the current git HEAD SHA for checkpoint metadata when available."""
    try:
        sha = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=project_dir,
            text=True,
        ).strip()
    except (subprocess.CalledProcessError, OSError):
        return None
    return sha or None


def _write_fallback_result(
    project_dir: Path,
    name: str,
    status: str,
    summary: str,
    blockers: list[str] | None = None,
    questions: list[str] | None = None,
    timestamp: str | None = None,
) -> None:
    """Write a minimal result file if the agent did not write one.

    Only writes if no result file already exists — never overwrites an
    agent-written result.
    """
    result_path = result_file_path(project_dir, name)
    if result_path.exists():
        return
    fallback: dict = {
        "schema_version": 1,
        "worker_name": name,
        "completed_at": timestamp or utc_now_iso(),
        "status": status,
        "summary": summary,
        "artifacts": [],
        "key_decisions": [],
        "blockers": blockers or [],
        "questions_for_orchestrator": questions or [],
        "_generated_by": "infrastructure_fallback",
    }
    try:
        result_path.parent.mkdir(parents=True, exist_ok=True)
        result_path.write_text(
            json.dumps(fallback, indent=2) + "\n", encoding="utf-8"
        )
    except OSError:
        pass


def record_completion_pending(state_dir: Path, name: str, project_dir: Path) -> None:
    """Persist a self-stop completion request and enqueue reconciliation."""
    state_file = state_dir / "CLAUDE.md"
    store = ConductorStateStore(run_state_dir(project_dir))
    existing = store.load_worker_state(name) or {}
    completion_requested_at = utc_now_iso()

    event = store.append_event(
        worker_name=name,
        event_type="worker.completion_requested",
        emitted_by="subturtle",
        run_id=existing.get("run_id"),
        lifecycle_state="completion_pending",
        payload={"kind": "self_stop", "stop_directive": True},
    )

    current_task = extract_current_task(state_file) or existing.get("current_task") or ""
    state = store.make_worker_state(
        worker_name=name,
        lifecycle_state="completion_pending",
        updated_by="subturtle",
        run_id=existing.get("run_id"),
        workspace=existing.get("workspace") or str(state_dir),
        loop_type=existing.get("loop_type"),
        pid=existing.get("pid"),
        timeout_seconds=existing.get("timeout_seconds"),
        cron_job_id=existing.get("cron_job_id"),
        current_task=current_task or None,
        stop_reason="completed",
        completion_requested_at=completion_requested_at,
        terminal_at=existing.get("terminal_at"),
        created_at=existing.get("created_at"),
        last_event_id=event["id"],
        last_event_at=event["timestamp"],
        checkpoint=existing.get("checkpoint")
        if isinstance(existing.get("checkpoint"), dict)
        else None,
        metadata=existing.get("metadata")
        if isinstance(existing.get("metadata"), dict)
        else None,
    )
    store.write_worker_state(state)

    # Write a fallback result file if the agent did not write a structured one.
    fallback_summary = (
        f"{name} completed: {current_task}"
        if current_task
        else f"{name} completed all backlog items."
    ) + " (Fallback — no structured agent result written; see CLAUDE.md and git log.)"
    _write_fallback_result(
        project_dir, name, "completed", fallback_summary,
        timestamp=completion_requested_at,
    )

    wakeup = store.make_wakeup(
        worker_name=name,
        category="notable",
        summary=f"SubTurtle {name} completed and needs reconciliation.",
        reason_event_id=event["id"],
        run_id=existing.get("run_id"),
        payload={"kind": "completion_requested"},
    )
    store.write_wakeup(wakeup)
    refresh_handoff(project_dir, name)


def record_checkpoint(
    state_dir: Path,
    name: str,
    project_dir: Path,
    loop_type: str,
    iteration: int,
) -> None:
    """Persist the latest successful iteration checkpoint for a worker."""
    state_file = state_dir / "CLAUDE.md"
    store = ConductorStateStore(run_state_dir(project_dir))

    try:
        existing = store.load_worker_state(name) or {}
        current_task = extract_current_task(state_file) or existing.get("current_task")
        head_sha = git_head_sha(project_dir)
        checkpoint = {
            "recorded_at": utc_now_iso(),
            "iteration": iteration,
            "loop_type": existing.get("loop_type") or loop_type,
        }
        if head_sha:
            checkpoint["head_sha"] = head_sha
        if current_task:
            checkpoint["current_task"] = current_task

        event = store.append_event(
            worker_name=name,
            event_type="worker.checkpoint",
            emitted_by="subturtle",
            run_id=existing.get("run_id"),
            lifecycle_state="running",
            payload={"kind": "iteration_complete", **checkpoint},
        )

        state = store.make_worker_state(
            worker_name=name,
            lifecycle_state="running",
            updated_by="subturtle",
            run_id=existing.get("run_id"),
            workspace=existing.get("workspace") or str(state_dir),
            loop_type=existing.get("loop_type") or loop_type,
            pid=existing.get("pid"),
            timeout_seconds=existing.get("timeout_seconds"),
            cron_job_id=existing.get("cron_job_id"),
            current_task=current_task,
            stop_reason=existing.get("stop_reason"),
            completion_requested_at=existing.get("completion_requested_at"),
            terminal_at=existing.get("terminal_at"),
            created_at=existing.get("created_at"),
            last_event_id=event["id"],
            last_event_at=event["timestamp"],
            checkpoint=checkpoint,
            metadata=existing.get("metadata")
            if isinstance(existing.get("metadata"), dict)
            else None,
        )
        store.write_worker_state(state)
        refresh_handoff(project_dir, name)
    except (OSError, ValueError, json.JSONDecodeError, RuntimeError) as error:
        print(
            f"[subturtle:{name}] WARNING: failed to record checkpoint: {error}",
            file=sys.stderr,
        )


def record_failure_pending(
    state_dir: Path,
    name: str,
    project_dir: Path,
    loop_type: str,
    message: str,
    error_type: str = "ConsecutiveAgentFailure",
) -> None:
    """Persist a fatal worker error and enqueue a reconciliation wakeup."""
    state_file = state_dir / "CLAUDE.md"
    store = ConductorStateStore(run_state_dir(project_dir))

    try:
        existing = store.load_worker_state(name) or {}
        current_task = extract_current_task(state_file) or existing.get("current_task")
        error_payload = {
            "kind": "fatal_error",
            "error_type": error_type,
            "message": message,
        }

        event = store.append_event(
            worker_name=name,
            event_type="worker.fatal_error",
            emitted_by="subturtle",
            run_id=existing.get("run_id"),
            lifecycle_state="failure_pending",
            payload=error_payload,
        )

        metadata = (
            dict(existing.get("metadata"))
            if isinstance(existing.get("metadata"), dict)
            else {}
        )
        metadata["last_error"] = {
            **error_payload,
            "recorded_at": event["timestamp"],
        }

        state = store.make_worker_state(
            worker_name=name,
            lifecycle_state="failure_pending",
            updated_by="subturtle",
            run_id=existing.get("run_id"),
            workspace=existing.get("workspace") or str(state_dir),
            loop_type=existing.get("loop_type") or loop_type,
            pid=existing.get("pid"),
            timeout_seconds=existing.get("timeout_seconds"),
            cron_job_id=existing.get("cron_job_id"),
            current_task=current_task,
            stop_reason="fatal_error",
            completion_requested_at=existing.get("completion_requested_at"),
            terminal_at=existing.get("terminal_at"),
            created_at=existing.get("created_at"),
            last_event_id=event["id"],
            last_event_at=event["timestamp"],
            checkpoint=existing.get("checkpoint")
            if isinstance(existing.get("checkpoint"), dict)
            else None,
            metadata=metadata,
        )
        store.write_worker_state(state)

        # Write a failure result so downstream orchestration sees what went wrong.
        _write_fallback_result(
            project_dir,
            name,
            "failed",
            f"{name} failed after consecutive agent failures: {message}",
            blockers=[message],
            questions=["Worker failed — should this be retried, reassigned, or skipped?"],
            timestamp=event["timestamp"],
        )

        wakeup = store.make_wakeup(
            worker_name=name,
            category="critical",
            summary=f"SubTurtle {name} hit a fatal error and needs reconciliation.",
            reason_event_id=event["id"],
            run_id=existing.get("run_id"),
            payload=error_payload,
        )
        store.write_wakeup(wakeup)
        refresh_handoff(project_dir, name)
    except (OSError, ValueError, json.JSONDecodeError, RuntimeError) as record_error:
        print(
            f"[subturtle:{name}] WARNING: failed to record fatal error state: {record_error}",
            file=sys.stderr,
        )


def record_fatal_error(
    state_dir: Path,
    name: str,
    project_dir: Path,
    loop_type: str,
    error: Exception,
) -> None:
    """Record an unexpected loop exception as a fatal worker failure."""
    record_failure_pending(
        state_dir,
        name,
        project_dir,
        loop_type,
        str(error),
        error_type=type(error).__name__,
    )


def should_stop(state_file: Path, name: str) -> bool:
    """Return True when the SubTurtle wrote the STOP directive to its state file."""
    try:
        state_text = state_file.read_text(encoding="utf-8")
    except OSError as error:
        print(
            f"[subturtle:{name}] WARNING: could not read state file for stop check: {error}",
            file=sys.stderr,
        )
        return False

    if STOP_DIRECTIVE in state_text:
        print(f"[subturtle:{name}] 🛑 agent wrote STOP directive — exiting loop")
        return True

    return False


__all__ = [
    "STOP_DIRECTIVE",
    "extract_current_task",
    "git_head_sha",
    "record_checkpoint",
    "record_completion_pending",
    "record_failure_pending",
    "record_fatal_error",
    "refresh_handoff",
    "resolve_state_ref",
    "result_file_path",
    "run_state_dir",
    "should_stop",
    "utc_now_iso",
]
