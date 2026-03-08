from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from super_turtle.state.run_state_writer import (
    DEFAULT_HANDOFF_NOTE,
    RunStateWriter,
    ensure_state_files,
    main,
)


class RunStateWriterTests(unittest.TestCase):
    def test_ensure_state_files_creates_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            runs_jsonl_file, handoff_md_file = ensure_state_files(tmp_dir)

            self.assertTrue(runs_jsonl_file.exists())
            self.assertTrue(handoff_md_file.exists())
            self.assertEqual(runs_jsonl_file.read_text(encoding="utf-8"), "")

            handoff_content = handoff_md_file.read_text(encoding="utf-8")
            self.assertIn("# SubTurtle Long-Run Handoff", handoff_content)
            self.assertIn("Last updated: not yet", handoff_content)
            self.assertIn("## Active Workers", handoff_content)
            self.assertIn("## Pending Wakeups", handoff_content)
            self.assertIn("## Recent Worker Updates", handoff_content)
            self.assertIn(f"- {DEFAULT_HANDOFF_NOTE}", handoff_content)

    def test_append_event_writes_jsonl_entry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            writer = RunStateWriter(tmp_dir)
            expected_payload = {"source": "unit-test", "count": 1}

            entry = writer.append_event(
                run_name="long-run-alpha",
                event="spawn",
                status="running",
                payload=expected_payload,
            )

            lines = writer.runs_jsonl_file.read_text(encoding="utf-8").strip().splitlines()
            self.assertEqual(len(lines), 1)

            parsed_line = json.loads(lines[0])
            self.assertEqual(parsed_line, entry)
            self.assertEqual(parsed_line["run_name"], "long-run-alpha")
            self.assertEqual(parsed_line["event"], "spawn")
            self.assertEqual(parsed_line["status"], "running")
            self.assertEqual(parsed_line["payload"], expected_payload)
            self.assertTrue(parsed_line["timestamp"].endswith("Z"))

    def test_update_handoff_writes_sections(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            writer = RunStateWriter(tmp_dir)
            writer.update_handoff(
                active_runs=["long-run-alpha (last event: spawn at 2026-02-27T00:00:00Z)"],
                recent_milestones=["long-run-alpha: completion (done) at 2026-02-27T01:00:00Z"],
                notes=["Auto-refreshed by test."],
                updated_at="2026-02-27T02:00:00Z",
            )

            handoff_content = writer.handoff_md_file.read_text(encoding="utf-8")
            self.assertIn("Last updated: 2026-02-27T02:00:00Z", handoff_content)
            self.assertIn("- long-run-alpha (last event: spawn at 2026-02-27T00:00:00Z)", handoff_content)
            self.assertIn("- long-run-alpha: completion (done) at 2026-02-27T01:00:00Z", handoff_content)
            self.assertIn("- Auto-refreshed by test.", handoff_content)

    def test_refresh_handoff_from_conductor_renders_live_workers_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            live_workspace = Path(tmp_dir) / ".subturtles" / "alpha"
            live_workspace.mkdir(parents=True)
            missing_workspace = Path(tmp_dir) / ".subturtles" / "ghost"

            self.assertEqual(
                main(
                    [
                        "--state-dir",
                        tmp_dir,
                        "put-worker",
                        "--worker-name",
                        "alpha",
                        "--lifecycle-state",
                        "running",
                        "--updated-by",
                        "supervisor",
                        "--workspace",
                        str(live_workspace),
                        "--current-task",
                        "Ship conductor-rendered handoff",
                    ]
                ),
                0,
            )
            self.assertEqual(
                main(
                    [
                        "--state-dir",
                        tmp_dir,
                        "enqueue-wakeup",
                        "--worker-name",
                        "alpha",
                        "--category",
                        "critical",
                        "--summary",
                        "Alpha notification was interrupted mid-send",
                        "--delivery-state",
                        "processing",
                    ]
                ),
                0,
            )
            self.assertEqual(
                main(
                    [
                        "--state-dir",
                        tmp_dir,
                        "put-worker",
                        "--worker-name",
                        "ghost",
                        "--lifecycle-state",
                        "running",
                        "--updated-by",
                        "supervisor",
                        "--workspace",
                        str(missing_workspace),
                        "--current-task",
                        "This should stay filtered",
                    ]
                ),
                0,
            )
            self.assertEqual(
                main(
                    [
                        "--state-dir",
                        tmp_dir,
                        "enqueue-wakeup",
                        "--worker-name",
                        "alpha",
                        "--category",
                        "notable",
                        "--summary",
                        "Alpha needs a checkpoint review",
                    ]
                ),
                0,
            )
            self.assertEqual(
                main(
                    [
                        "--state-dir",
                        tmp_dir,
                        "refresh-handoff-from-conductor",
                        "--updated-at",
                        "2026-03-08T09:00:00Z",
                    ]
                ),
                0,
            )

            handoff_content = (Path(tmp_dir) / "handoff.md").read_text(encoding="utf-8")
            self.assertIn("Last updated: 2026-03-08T09:00:00Z", handoff_content)
            self.assertIn("## Active Workers", handoff_content)
            self.assertIn("alpha [running]", handoff_content)
            self.assertIn("Ship conductor-rendered handoff", handoff_content)
            self.assertIn("## Pending Wakeups", handoff_content)
            self.assertIn("Alpha needs a checkpoint review", handoff_content)
            self.assertIn("Alpha notification was interrupted mid-send", handoff_content)
            self.assertIn("alpha [critical/processing]", handoff_content)
            self.assertNotIn("ghost [running]", handoff_content)

    def test_cli_commands_smoke(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            self.assertEqual(
                main(
                    [
                        "--state-dir",
                        tmp_dir,
                        "append",
                        "--run-name",
                        "long-run-beta",
                        "--event",
                        "milestone",
                        "--status",
                        "done",
                        "--payload-json",
                        '{"step":"smoke"}',
                    ]
                ),
                0,
            )
            self.assertEqual(
                main(
                    [
                        "--state-dir",
                        tmp_dir,
                        "update-handoff",
                        "--active-run",
                        "long-run-beta (last event: milestone at 2026-02-27T03:00:00Z)",
                        "--milestone",
                        "long-run-beta: milestone (done) at 2026-02-27T03:00:00Z",
                    ]
                ),
                0,
            )

            runs_jsonl_file = Path(tmp_dir) / "runs.jsonl"
            handoff_md_file = Path(tmp_dir) / "handoff.md"

            self.assertTrue(runs_jsonl_file.exists())
            self.assertTrue(handoff_md_file.exists())
            self.assertIn("long-run-beta", runs_jsonl_file.read_text(encoding="utf-8"))
            self.assertIn("long-run-beta", handoff_md_file.read_text(encoding="utf-8"))

    def test_conductor_cli_commands_smoke(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            self.assertEqual(
                main(
                    [
                        "--state-dir",
                        tmp_dir,
                        "put-worker",
                        "--worker-name",
                        "gamma-run",
                        "--lifecycle-state",
                        "running",
                        "--updated-by",
                        "supervisor",
                        "--run-id",
                        "run-123",
                        "--workspace",
                        ".subturtles/gamma-run",
                        "--checkpoint-json",
                        '{"commit_sha":"abc123"}',
                    ]
                ),
                0,
            )
            self.assertEqual(
                main(
                    [
                        "--state-dir",
                        tmp_dir,
                        "append-conductor-event",
                        "--worker-name",
                        "gamma-run",
                        "--event-type",
                        "worker.started",
                        "--emitted-by",
                        "supervisor",
                        "--lifecycle-state",
                        "running",
                    ]
                ),
                0,
            )
            self.assertEqual(
                main(
                    [
                        "--state-dir",
                        tmp_dir,
                        "enqueue-wakeup",
                        "--worker-name",
                        "gamma-run",
                        "--category",
                        "notable",
                        "--summary",
                        "gamma-run completed",
                        "--payload-json",
                        '{"kind":"completion"}',
                    ]
                ),
                0,
            )

            worker_path = Path(tmp_dir) / "workers" / "gamma-run.json"
            events_path = Path(tmp_dir) / "events.jsonl"
            wakeups_dir = Path(tmp_dir) / "wakeups"

            self.assertTrue(worker_path.exists())
            self.assertTrue(events_path.exists())
            self.assertTrue(wakeups_dir.exists())
            self.assertIn("gamma-run", worker_path.read_text(encoding="utf-8"))
            self.assertIn("worker.started", events_path.read_text(encoding="utf-8"))
            wakeup_files = list(wakeups_dir.glob("*.json"))
            self.assertEqual(len(wakeup_files), 1)
            self.assertIn(
                "gamma-run completed",
                wakeup_files[0].read_text(encoding="utf-8"),
            )

    def test_put_worker_merges_existing_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            self.assertEqual(
                main(
                    [
                        "--state-dir",
                        tmp_dir,
                        "put-worker",
                        "--worker-name",
                        "delta-run",
                        "--lifecycle-state",
                        "running",
                        "--updated-by",
                        "supervisor",
                        "--run-id",
                        "run-999",
                        "--cron-job-id",
                        "cron-1",
                        "--current-task",
                        "Initial task",
                    ]
                ),
                0,
            )
            self.assertEqual(
                main(
                    [
                        "--state-dir",
                        tmp_dir,
                        "put-worker",
                        "--worker-name",
                        "delta-run",
                        "--lifecycle-state",
                        "archived",
                        "--updated-by",
                        "supervisor",
                    ]
                ),
                0,
            )

            worker_path = Path(tmp_dir) / "workers" / "delta-run.json"
            parsed = json.loads(worker_path.read_text(encoding="utf-8"))
            self.assertEqual(parsed["lifecycle_state"], "archived")
            self.assertEqual(parsed["run_id"], "run-999")
            self.assertEqual(parsed["cron_job_id"], "cron-1")
            self.assertEqual(parsed["current_task"], "Initial task")


if __name__ == "__main__":
    unittest.main()
