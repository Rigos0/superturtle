from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys

import pytest

from super_turtle.subturtle import __main__ as subturtle_main
from super_turtle.subturtle import loops as subturtle_loops
from super_turtle.subturtle import prompts as subturtle_prompts
from super_turtle.subturtle import statefile as subturtle_statefile
from super_turtle.state.conductor_state import ConductorStateStore

REPO_ROOT = Path(__file__).resolve().parents[3]
SUPER_TURTLE_ROOT = REPO_ROOT / "super_turtle"


def _write_state_file(tmp_path) -> None:
    (tmp_path / "CLAUDE.md").write_text("# Current task\n\nTest task\n", encoding="utf-8")


def _assert_imports_succeed(tmp_path, pythonpath_root: Path, module_names: list[str]) -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(pythonpath_root)

    code = "\n".join(f"import {module_name}" for module_name in module_names)
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr or result.stdout


def test_yolo_prompt_allows_rewriting_blocked_backlog_items() -> None:
    prompt = subturtle_prompts.YOLO_PROMPT.format(state_file=".subturtles/demo/CLAUDE.md")

    assert "If it is blocked, too vague, or not feasible with the current repo/context, rewrite the backlog" in prompt
    assert "move `<- current` to the next actionable item" in prompt
    assert "MUST NOT leave a blocked current item unchanged" in prompt


def test_slow_loop_prompts_allow_blocked_item_replanning() -> None:
    prompts = subturtle_prompts.build_prompts(".subturtles/demo/CLAUDE.md")

    assert "plan the smallest\n  actionable unblocker or backlog rewrite needed to restore forward progress" in prompts["planner"]
    assert "rewrite it\n     into concrete unblocker tasks" in prompts["groomer"]
    assert "Rewrite the backlog so the next iteration has a concrete unblocker" in prompts["reviewer"]


def test_main_dispatches_to_run_loop(monkeypatch, tmp_path) -> None:
    state_dir = tmp_path / ".subturtles" / "worker-cli"
    state_dir.mkdir(parents=True)
    called = {}

    def fake_run_loop(*, state_dir, name, loop_type, skills) -> None:
        called["state_dir"] = state_dir
        called["name"] = name
        called["loop_type"] = loop_type
        called["skills"] = skills

    monkeypatch.setattr(subturtle_main, "run_loop", fake_run_loop)
    monkeypatch.setattr(
        subturtle_main.argparse.ArgumentParser,
        "parse_args",
        lambda self: argparse.Namespace(
            state_dir=str(state_dir),
            name="worker-cli",
            type="yolo-codex",
            skills=["frontend", "qa"],
        ),
    )

    subturtle_main.main()

    assert called == {
        "state_dir": state_dir.resolve(),
        "name": "worker-cli",
        "loop_type": "yolo-codex",
        "skills": ["frontend", "qa"],
    }


def test_monorepo_import_path_smoke(tmp_path) -> None:
    _assert_imports_succeed(
        tmp_path,
        REPO_ROOT,
        [
            "super_turtle.subturtle.__main__",
            "super_turtle.subturtle.loops",
            "super_turtle.subturtle.prompts",
            "super_turtle.subturtle.statefile",
        ],
    )


def test_packaged_import_path_smoke(tmp_path) -> None:
    _assert_imports_succeed(
        tmp_path,
        SUPER_TURTLE_ROOT,
        [
            "subturtle.__main__",
            "subturtle.loops",
            "subturtle.prompts",
            "subturtle.statefile",
        ],
    )


def test_require_cli_exits_with_clear_error(monkeypatch, capsys) -> None:
    monkeypatch.setattr(subturtle_loops.shutil, "which", lambda _cli: None)

    with pytest.raises(SystemExit) as excinfo:
        subturtle_loops._require_cli("default", "claude")

    assert excinfo.value.code == 1
    assert "'claude' not found on PATH" in capsys.readouterr().err


def test_run_slow_loop_checks_codex_before_start(monkeypatch, tmp_path, capsys) -> None:
    _write_state_file(tmp_path)

    def fake_which(cli: str) -> str | None:
        return "/usr/bin/claude" if cli == "claude" else None

    monkeypatch.setattr(subturtle_loops.shutil, "which", fake_which)

    with pytest.raises(SystemExit) as excinfo:
        subturtle_loops.run_slow_loop(tmp_path, "default")

    assert excinfo.value.code == 1
    assert "'codex' not found on PATH" in capsys.readouterr().err


def test_run_yolo_loop_retries_on_oserror(monkeypatch, tmp_path, capsys) -> None:
    _write_state_file(tmp_path)
    monkeypatch.setattr(subturtle_loops, "_require_cli", lambda _name, _cli: None)

    class BrokenClaude:
        def execute(self, _prompt: str) -> str:
            raise OSError("launch failed")

    class StopLoop(Exception):
        pass

    def stop_after_retry(_delay: int) -> None:
        raise StopLoop

    monkeypatch.setattr(subturtle_loops, "Claude", lambda **_kwargs: BrokenClaude())
    monkeypatch.setattr(subturtle_loops.time, "sleep", stop_after_retry)

    with pytest.raises(StopLoop):
        subturtle_loops.run_yolo_loop(tmp_path, "default")

    assert "retrying in" in capsys.readouterr().err


def test_run_yolo_loop_marks_failure_pending_after_max_consecutive_failures(
    monkeypatch, tmp_path, capsys
) -> None:
    state_dir = tmp_path / ".subturtles" / "worker-max-failures"
    state_dir.mkdir(parents=True)
    (state_dir / "CLAUDE.md").write_text(
        "# Current task\n\nRecover from repeated agent failures <- current\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(subturtle_loops, "_require_cli", lambda _name, _cli: None)
    monkeypatch.setattr(subturtle_loops.time, "sleep", lambda _delay: None)

    attempts = {"count": 0}

    class BrokenClaude:
        def execute(self, _prompt: str) -> str:
            attempts["count"] += 1
            raise OSError("launch failed")

    monkeypatch.setattr(subturtle_loops, "Claude", lambda **_kwargs: BrokenClaude())

    store = ConductorStateStore(tmp_path / ".superturtle" / "state")
    initial = store.make_worker_state(
        worker_name="worker-max-failures",
        lifecycle_state="running",
        updated_by="supervisor",
        run_id="run-max-failures",
        workspace=str(state_dir),
        loop_type="yolo",
        current_task="Recover from repeated agent failures",
    )
    store.write_worker_state(initial)

    subturtle_loops.run_yolo_loop(state_dir, "worker-max-failures")

    assert attempts["count"] == subturtle_loops.MAX_CONSECUTIVE_FAILURES

    worker_state = store.load_worker_state("worker-max-failures")
    assert worker_state is not None
    assert worker_state["lifecycle_state"] == "failure_pending"
    assert worker_state["stop_reason"] == "fatal_error"
    assert worker_state["metadata"]["last_error"]["message"] == subturtle_loops.MAX_FAILURES_MESSAGE
    assert worker_state["metadata"]["last_error"]["error_type"] == "ConsecutiveAgentFailure"

    events = store.paths.events_jsonl_file.read_text(encoding="utf-8")
    assert "worker.fatal_error" in events
    assert subturtle_loops.MAX_FAILURES_MESSAGE in events

    wakeups = store.list_wakeups()
    assert len(wakeups) == 1
    assert wakeups[0]["payload"]["kind"] == "fatal_error"
    assert wakeups[0]["payload"]["message"] == subturtle_loops.MAX_FAILURES_MESSAGE

    assert "FATAL: reached 5 consecutive agent failures" in capsys.readouterr().err


def test_run_yolo_loop_resets_failure_counter_after_success(monkeypatch, tmp_path) -> None:
    _write_state_file(tmp_path)
    monkeypatch.setattr(subturtle_loops, "_require_cli", lambda _name, _cli: None)
    monkeypatch.setattr(subturtle_loops.time, "sleep", lambda _delay: None)

    outcomes = [OSError("launch failed")] * 4 + [None] + [OSError("launch failed")] * 5
    attempts = {"count": 0}
    checkpoint_iterations = []
    failure_records = []

    class SequencedClaude:
        def execute(self, _prompt: str) -> str:
            index = attempts["count"]
            attempts["count"] += 1
            outcome = outcomes[index]
            if isinstance(outcome, Exception):
                raise outcome
            return "ok"

    def fake_record_checkpoint(
        _state_dir, _name, _project_dir, _loop_type: str, iteration: int
    ) -> None:
        checkpoint_iterations.append(iteration)

    def fake_record_failure_pending(
        _state_dir,
        _name,
        _project_dir,
        _loop_type: str,
        message: str,
        error_type: str = "ConsecutiveAgentFailure",
    ) -> None:
        failure_records.append((message, error_type))

    monkeypatch.setattr(subturtle_loops, "Claude", lambda **_kwargs: SequencedClaude())
    monkeypatch.setattr(subturtle_loops, "_record_checkpoint", fake_record_checkpoint)
    monkeypatch.setattr(subturtle_loops, "_record_failure_pending", fake_record_failure_pending)

    subturtle_loops.run_yolo_loop(tmp_path, "default")

    assert attempts["count"] == 10
    assert checkpoint_iterations == [5]
    assert failure_records == [
        (subturtle_loops.MAX_FAILURES_MESSAGE, "ConsecutiveAgentFailure")
    ]


def test_archive_workspace_uses_ctl_stop_and_preserves_meta(monkeypatch, tmp_path) -> None:
    pid_file = tmp_path / "subturtle.pid"
    meta_file = tmp_path / "subturtle.meta"
    pid_file.write_text("4321\n", encoding="utf-8")
    meta_file.write_text("CRON_JOB_ID=abc123\n", encoding="utf-8")

    monkeypatch.setattr(subturtle_loops.os, "getpid", lambda: 4321)

    called = {}

    def fake_run(cmd, **kwargs):
        called["cmd"] = cmd
        called["kwargs"] = kwargs

    monkeypatch.setattr(subturtle_loops.subprocess, "run", fake_run)

    subturtle_loops._archive_workspace(tmp_path, "worker-1")

    assert not pid_file.exists()
    assert meta_file.exists()
    assert called["cmd"][1:] == ["stop", "worker-1"]
    assert called["kwargs"]["check"] is True


def test_extract_current_task_ignores_current_marker(tmp_path) -> None:
    state_file = tmp_path / "CLAUDE.md"
    state_file.write_text(
        "# Current task\n\nShip the feature <- current\n\n# Backlog\n",
        encoding="utf-8",
    )

    assert subturtle_statefile.extract_current_task(state_file) == "Ship the feature"


def test_resolve_state_ref_uses_relative_path_under_project_root(monkeypatch, tmp_path) -> None:
    state_dir = tmp_path / ".subturtles" / "worker-1"
    state_dir.mkdir(parents=True)
    state_file = state_dir / "CLAUDE.md"
    state_file.write_text("# Current task\n\nTest task\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    resolved_file, state_ref = subturtle_statefile.resolve_state_ref(state_dir, "worker-1")

    assert resolved_file == state_file
    assert state_ref == ".subturtles/worker-1/CLAUDE.md"


def test_should_stop_detects_stop_directive(tmp_path, capsys) -> None:
    state_file = tmp_path / "CLAUDE.md"
    state_file.write_text(
        "# Current task\n\nDone\n\n## Loop Control\nSTOP\n",
        encoding="utf-8",
    )

    assert subturtle_statefile.should_stop(state_file, "worker-stop") is True
    assert "STOP directive" in capsys.readouterr().out


def test_record_completion_pending_writes_state_event_and_wakeup(tmp_path) -> None:
    state_dir = tmp_path / ".subturtles" / "worker-2"
    project_dir = tmp_path
    state_dir.mkdir(parents=True)
    (state_dir / "CLAUDE.md").write_text(
        "# Current task\n\nShip the feature <- current\n",
        encoding="utf-8",
    )

    store = ConductorStateStore(project_dir / ".superturtle" / "state")
    initial = store.make_worker_state(
        worker_name="worker-2",
        lifecycle_state="running",
        updated_by="supervisor",
        run_id="run-222",
        workspace=str(state_dir),
        loop_type="yolo-codex",
        current_task="Ship the feature",
    )
    store.write_worker_state(initial)

    subturtle_statefile.record_completion_pending(state_dir, "worker-2", project_dir)

    worker_state = store.load_worker_state("worker-2")
    assert worker_state is not None
    assert worker_state["lifecycle_state"] == "completion_pending"
    assert worker_state["stop_reason"] == "completed"
    assert worker_state["run_id"] == "run-222"

    events = store.paths.events_jsonl_file.read_text(encoding="utf-8")
    assert "worker.completion_requested" in events
    assert "worker-2" in events

    wakeups = store.list_wakeups()
    assert len(wakeups) == 1
    assert wakeups[0]["category"] == "notable"
    assert wakeups[0]["worker_name"] == "worker-2"


def test_record_checkpoint_updates_worker_state_and_event(monkeypatch, tmp_path) -> None:
    state_dir = tmp_path / ".subturtles" / "worker-3"
    project_dir = tmp_path
    state_dir.mkdir(parents=True)
    (state_dir / "CLAUDE.md").write_text(
        "# Current task\n\nRefine checkpoint handling <- current\n",
        encoding="utf-8",
    )

    store = ConductorStateStore(project_dir / ".superturtle" / "state")
    initial = store.make_worker_state(
        worker_name="worker-3",
        lifecycle_state="running",
        updated_by="supervisor",
        run_id="run-333",
        workspace=str(state_dir),
        loop_type="yolo-codex",
        current_task="Refine checkpoint handling",
    )
    store.write_worker_state(initial)
    monkeypatch.setattr(subturtle_statefile, "git_head_sha", lambda _project_dir: "abc123")

    subturtle_statefile.record_checkpoint(
        state_dir,
        "worker-3",
        project_dir,
        "yolo-codex",
        iteration=4,
    )

    worker_state = store.load_worker_state("worker-3")
    assert worker_state is not None
    assert worker_state["lifecycle_state"] == "running"
    assert worker_state["checkpoint"]["iteration"] == 4
    assert worker_state["checkpoint"]["head_sha"] == "abc123"
    assert worker_state["checkpoint"]["current_task"] == "Refine checkpoint handling"

    events = store.paths.events_jsonl_file.read_text(encoding="utf-8")
    assert "worker.checkpoint" in events
    assert "abc123" in events


def test_run_loop_records_fatal_error_as_failure_pending(monkeypatch, tmp_path) -> None:
    state_dir = tmp_path / ".subturtles" / "worker-4"
    state_dir.mkdir(parents=True)
    (state_dir / "CLAUDE.md").write_text(
        "# Current task\n\nRecover from fatal worker error <- current\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    store = ConductorStateStore(tmp_path / ".superturtle" / "state")
    initial = store.make_worker_state(
        worker_name="worker-4",
        lifecycle_state="running",
        updated_by="supervisor",
        run_id="run-444",
        workspace=str(state_dir),
        loop_type="boom",
        current_task="Recover from fatal worker error",
    )
    store.write_worker_state(initial)

    def explode(_state_dir, _name, _skills) -> None:
        raise RuntimeError("boom")

    monkeypatch.setitem(subturtle_loops.LOOP_TYPES, "boom", explode)

    with pytest.raises(RuntimeError, match="boom"):
        subturtle_loops.run_loop(state_dir=state_dir, name="worker-4", loop_type="boom")

    worker_state = store.load_worker_state("worker-4")
    assert worker_state is not None
    assert worker_state["lifecycle_state"] == "failure_pending"
    assert worker_state["stop_reason"] == "fatal_error"
    assert worker_state["metadata"]["last_error"]["error_type"] == "RuntimeError"
    assert worker_state["metadata"]["last_error"]["message"] == "boom"

    events = store.paths.events_jsonl_file.read_text(encoding="utf-8")
    assert "worker.fatal_error" in events
    assert "failure_pending" in events

    wakeups = store.list_wakeups()
    assert len(wakeups) == 1
    assert wakeups[0]["category"] == "critical"
    assert wakeups[0]["payload"]["error_type"] == "RuntimeError"
