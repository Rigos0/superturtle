"""Loop runtime helpers and dispatch for SubTurtle."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path

from . import prompts
from . import statefile
from .subturtle_loop.agents import Claude, Codex

# Package root (super_turtle/), used for resolving skills directory.
_SUPER_TURTLE_DIR = os.environ.get(
    "SUPER_TURTLE_DIR", str(Path(__file__).resolve().parent.parent)
)
_SKILLS_DIR = os.path.join(_SUPER_TURTLE_DIR, "skills")

STATS_SCRIPT = Path(__file__).resolve().parent / "claude-md-guard" / "stats.sh"

RETRY_DELAY = 10  # seconds to wait after an agent crash before retrying
MAX_CONSECUTIVE_FAILURES = 5
MAX_FAILURES_MESSAGE = "max consecutive failures reached"
LoopExecutor = Callable[[str], str]

_record_checkpoint = statefile.record_checkpoint
_record_completion_pending = statefile.record_completion_pending
_record_failure_pending = statefile.record_failure_pending
_record_fatal_error = statefile.record_fatal_error
_resolve_state_ref = statefile.resolve_state_ref
_should_stop = statefile.should_stop


def _require_cli(name: str, cli_name: str) -> None:
    """Exit with a clear error when a required CLI is missing from PATH."""
    if shutil.which(cli_name) is not None:
        return

    print(
        f"[subturtle:{name}] ERROR: '{cli_name}' not found on PATH",
        file=sys.stderr,
    )
    sys.exit(1)


def _agent_error_detail(error: subprocess.CalledProcessError | OSError) -> str:
    """Return a compact description for a subprocess or launch failure."""
    if isinstance(error, subprocess.CalledProcessError):
        return f"exit {error.returncode}"
    return f"{type(error).__name__}: {error}"


def _log_retry(name: str, error: subprocess.CalledProcessError | OSError) -> None:
    """Log a transient failure and sleep before retrying."""
    print(
        f"[subturtle:{name}] agent failed ({_agent_error_detail(error)}), retrying in {RETRY_DELAY}s...",
        file=sys.stderr,
    )
    time.sleep(RETRY_DELAY)


def _handle_agent_failure(
    state_dir: Path,
    name: str,
    project_dir: Path,
    loop_type: str,
    error: subprocess.CalledProcessError | OSError,
    consecutive_failures: int,
) -> tuple[int, bool]:
    """Track consecutive failures and decide whether the loop must stop."""
    consecutive_failures += 1
    if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
        print(
            (
                f"[subturtle:{name}] FATAL: reached {consecutive_failures} consecutive "
                f"agent failures ({_agent_error_detail(error)}); stopping loop"
            ),
            file=sys.stderr,
        )
        _record_failure_pending(
            state_dir,
            name,
            project_dir,
            loop_type,
            MAX_FAILURES_MESSAGE,
        )
        return consecutive_failures, True

    _log_retry(name, error)
    return consecutive_failures, False


def _archive_workspace(state_dir: Path, name: str) -> None:
    """Finalize a self-stopped SubTurtle workspace via ctl stop."""
    ctl_path = Path(__file__).resolve().with_name("ctl")
    pid_file = state_dir / "subturtle.pid"

    # Self-stop runs inside the SubTurtle process. Clear our own PID marker
    # first so `ctl stop` does not try to kill this process.
    # Keep metadata intact so `ctl stop` can remove the recurring cron job.
    try:
        if pid_file.exists():
            pid_text = pid_file.read_text(encoding="utf-8").strip()
            if pid_text and int(pid_text) == os.getpid():
                pid_file.unlink(missing_ok=True)
    except (OSError, ValueError):
        pass

    try:
        subprocess.run(
            [str(ctl_path), "stop", name],
            cwd=Path.cwd(),
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, OSError) as error:
        print(
            f"[subturtle:{name}] WARNING: failed to archive workspace {state_dir}: {error}",
            file=sys.stderr,
        )


def _skill_dirs(skills: list[str]) -> list[str]:
    """Return the shared skills directory only when skills were requested."""
    return [_SKILLS_DIR] if skills else []


def _log_loop_start(
    name: str,
    loop_description: str,
    state_ref: str,
    skills: list[str],
) -> None:
    """Emit a consistent startup banner for every loop variant."""
    print(f"[subturtle:{name}] 🐢 spawned ({loop_description})")
    print(f"[subturtle:{name}] state file: {state_ref}")
    if skills:
        print(f"[subturtle:{name}] skills: {', '.join(skills)}")


def _finalize_loop(
    state_dir: Path,
    name: str,
    project_dir: Path,
    iteration: int,
    stopped_by_directive: bool,
) -> None:
    """Persist completion and archive the workspace after a self-stop."""
    if not stopped_by_directive:
        return

    if iteration > 0:
        _record_completion_pending(state_dir, name, project_dir)
    _archive_workspace(state_dir, name)


def _run_single_agent_loop(
    state_dir: Path,
    name: str,
    loop_type: str,
    loop_description: str,
    skills: list[str],
    execute_iteration: LoopExecutor,
) -> None:
    """Run the shared retry/checkpoint loop used by single-agent variants."""
    state_file, state_ref = _resolve_state_ref(state_dir, name)
    prompt = prompts.YOLO_PROMPT.format(state_file=state_ref)
    project_dir = Path.cwd()
    iteration = 0
    consecutive_failures = 0
    stopped_by_directive = False

    _log_loop_start(name, loop_description, state_ref, skills)

    while True:
        if _should_stop(state_file, name):
            stopped_by_directive = True
            break
        iteration += 1
        print(f"[subturtle:{name}] === {loop_type} iteration {iteration} ===")
        try:
            execute_iteration(prompt)
            _record_checkpoint(state_dir, name, project_dir, loop_type, iteration)
            consecutive_failures = 0
        except (subprocess.CalledProcessError, OSError) as error:
            consecutive_failures, should_stop = _handle_agent_failure(
                state_dir,
                name,
                project_dir,
                loop_type,
                error,
                consecutive_failures,
            )
            if should_stop:
                break

        if _should_stop(state_file, name):
            stopped_by_directive = True
            break

    _finalize_loop(state_dir, name, project_dir, iteration, stopped_by_directive)


def run_slow_loop(state_dir: Path, name: str, skills: list[str] | None = None) -> None:
    """Slow loop: Plan -> Groom -> Execute -> Review. 4 agent calls per iteration."""
    if skills is None:
        skills = []
    _require_cli(name, "claude")
    _require_cli(name, "codex")

    state_file, state_ref = _resolve_state_ref(state_dir, name)
    prompt_bundle = prompts.build_prompts(state_ref)

    _log_loop_start(name, "slow loop: plan -> groom -> execute -> review", state_ref, skills)

    add_dirs = _skill_dirs(skills)
    claude = Claude(add_dirs=add_dirs)
    codex = Codex(add_dirs=add_dirs)
    project_dir = Path.cwd()
    iteration = 0
    consecutive_failures = 0
    stopped_by_directive = False

    while True:
        if _should_stop(state_file, name):
            stopped_by_directive = True
            break
        iteration += 1
        print(f"[subturtle:{name}] === slow iteration {iteration} ===")
        try:
            plan = claude.plan(prompt_bundle["planner"])

            stats = subprocess.check_output(
                ["bash", str(STATS_SCRIPT), str(state_file)], text=True
            )
            claude.execute(prompt_bundle["groomer"].format(stats=stats, plan=plan))

            codex.execute(prompt_bundle["executor"].format(plan=plan))

            claude.execute(prompt_bundle["reviewer"].format(plan=plan))
            _record_checkpoint(state_dir, name, project_dir, "slow", iteration)
            consecutive_failures = 0
        except (subprocess.CalledProcessError, OSError) as error:
            consecutive_failures, should_stop = _handle_agent_failure(
                state_dir,
                name,
                project_dir,
                "slow",
                error,
                consecutive_failures,
            )
            if should_stop:
                break

        if _should_stop(state_file, name):
            stopped_by_directive = True
            break

    _finalize_loop(state_dir, name, project_dir, iteration, stopped_by_directive)


def run_yolo_loop(state_dir: Path, name: str, skills: list[str] | None = None) -> None:
    """Yolo loop: single Claude call per iteration. Ralph loop style."""
    if skills is None:
        skills = []
    _require_cli(name, "claude")

    claude = Claude(add_dirs=_skill_dirs(skills))
    _run_single_agent_loop(
        state_dir=state_dir,
        name=name,
        loop_type="yolo",
        loop_description="yolo loop: claude",
        skills=skills,
        execute_iteration=claude.execute,
    )


def run_yolo_codex_loop(
    state_dir: Path, name: str, skills: list[str] | None = None
) -> None:
    """Yolo-codex loop: single Codex call per iteration. Ralph loop style."""
    if skills is None:
        skills = []
    _require_cli(name, "codex")

    codex = Codex(add_dirs=_skill_dirs(skills))
    _run_single_agent_loop(
        state_dir=state_dir,
        name=name,
        loop_type="yolo-codex",
        loop_description="yolo-codex loop: codex",
        skills=skills,
        execute_iteration=codex.execute,
    )


def run_yolo_codex_spark_loop(
    state_dir: Path, name: str, skills: list[str] | None = None
) -> None:
    """Yolo-codex-spark loop: single Codex Spark call per iteration."""
    if skills is None:
        skills = []
    _require_cli(name, "codex")

    codex = Codex(add_dirs=_skill_dirs(skills), model="gpt-5.3-codex-spark")
    _run_single_agent_loop(
        state_dir=state_dir,
        name=name,
        loop_type="yolo-codex-spark",
        loop_description="yolo-codex-spark loop: codex spark",
        skills=skills,
        execute_iteration=codex.execute,
    )


LOOP_TYPES = {
    "yolo-codex": run_yolo_codex_loop,
    "yolo-codex-spark": run_yolo_codex_spark_loop,
}


def run_loop(
    state_dir: Path,
    name: str,
    loop_type: str = "yolo-codex",
    skills: list[str] | None = None,
) -> None:
    """Dispatch to the appropriate loop function."""
    if skills is None:
        skills = []
    fn = LOOP_TYPES.get(loop_type)
    if fn is None:
        print(
            f"[subturtle:{name}] ERROR: unknown loop type '{loop_type}'",
            file=sys.stderr,
        )
        sys.exit(1)
    try:
        fn(state_dir, name, skills)
    except Exception as error:
        _record_fatal_error(state_dir, name, Path.cwd(), loop_type, error)
        raise


__all__ = [
    "Claude",
    "Codex",
    "LOOP_TYPES",
    "MAX_CONSECUTIVE_FAILURES",
    "MAX_FAILURES_MESSAGE",
    "run_loop",
    "run_slow_loop",
    "run_yolo_loop",
    "run_yolo_codex_loop",
    "run_yolo_codex_spark_loop",
    "_archive_workspace",
    "_record_checkpoint",
    "_record_failure_pending",
    "_require_cli",
]
