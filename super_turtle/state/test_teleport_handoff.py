from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from super_turtle.state.teleport_handoff import build_handoff_text, main


class TeleportHandoffTests(unittest.TestCase):
    def test_build_handoff_text_includes_recent_context(self) -> None:
        text = build_handoff_text(
            {
                "source_host": "macbook",
                "destination_transport": "ssh",
                "destination_label": "azure-box",
                "ssh_target": "azure-box",
                "source_project_root": "/Users/richard/project",
                "remote_root": "/home/richard/project",
                "active_driver": "claude",
                "model": "claude-opus-4-6",
                "effort": "high",
                "pending_inbox_count": 2,
                "pending_wakeup_count": 1,
                "workers": ["writer | completed | yolo-codex"],
                "recent_messages": [
                    {"role": "user", "text": "Finish the dashboard.", "timestamp": "2026-03-12T10:00:00Z"},
                    {"role": "assistant", "text": "I updated the layout and conductor panel.", "timestamp": "2026-03-12T10:01:00Z"},
                ],
            }
        )

        self.assertIn("Teleport handoff from macbook", text)
        self.assertIn("Destination transport: ssh", text)
        self.assertIn("Active driver: claude", text)
        self.assertIn("Workers:", text)
        self.assertIn("Finish the dashboard.", text)
        self.assertIn("I updated the layout and conductor panel.", text)

    def test_export_and_import_roundtrip_restores_portable_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            base = Path(tmp_dir)
            project_root = base / "project"
            project_root.mkdir(parents=True)
            (project_root / ".superturtle").mkdir()
            (project_root / ".superturtle" / "state" / "workers").mkdir(parents=True)
            (project_root / ".git").mkdir()
            (project_root / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
            (project_root / ".superturtle" / ".env").write_text(
                "TELEGRAM_BOT_TOKEN=test-token\nTELEGRAM_ALLOWED_USERS=123\nCODEX_ENABLED=true\n",
                encoding="utf-8",
            )

            tmp_state = base / "tmp-runtime"
            tmp_state.mkdir()
            (tmp_state / "claude-telegram-test-token-prefs.json").write_text(
                json.dumps({"model": "claude-opus-4-6", "effort": "high", "activeDriver": "claude"}),
                encoding="utf-8",
            )
            (tmp_state / "claude-telegram-test-token-turns.jsonl").write_text(
                json.dumps(
                    {
                        "driver": "claude",
                        "originalMessage": "Continue the work",
                        "response": "Done. I moved the conductor card.",
                        "startedAt": "2026-03-12T09:00:00Z",
                        "completedAt": "2026-03-12T09:00:02Z",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            (tmp_state / "claude-telegram-test-token-session.json").write_text(
                json.dumps(
                    {
                        "sessions": [
                            {
                                "session_id": "claude-session-1",
                                "working_dir": str(project_root),
                                "title": "Active Claude session",
                                "recentMessages": [
                                    {
                                        "role": "user",
                                        "text": "Ship the teleport script.",
                                        "timestamp": "2026-03-12T09:00:00Z",
                                    },
                                    {
                                        "role": "assistant",
                                        "text": "I am preparing the teleport handoff.",
                                        "timestamp": "2026-03-12T09:00:01Z",
                                    },
                                ],
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            (project_root / ".superturtle" / "state" / "workers" / "writer.json").write_text(
                json.dumps(
                    {
                        "worker_name": "writer",
                        "lifecycle_state": "completed",
                        "loop_type": "yolo-codex",
                        "current_task": "Write the teleport summary",
                        "run_id": "run-1",
                    }
                ),
                encoding="utf-8",
            )

            exit_code = main(
                [
                    "export",
                    "--project-root",
                    str(project_root),
                    "--remote-root",
                    "/home/richard/project",
                    "--ssh-target",
                    "richard@azure",
                    "--tmp-dir",
                    str(tmp_state),
                ]
            )
            self.assertEqual(exit_code, 0)

            teleport_dir = project_root / ".superturtle" / "teleport"
            context = json.loads((teleport_dir / "context.json").read_text(encoding="utf-8"))
            handoff = json.loads((teleport_dir / "handoff.json").read_text(encoding="utf-8"))
            inbox = json.loads((teleport_dir / "teleport-inbox.json").read_text(encoding="utf-8"))

            self.assertEqual(context["active_driver"], "claude")
            self.assertEqual(context["destination_transport"], "ssh")
            self.assertEqual(context["destination_label"], "richard@azure")
            self.assertEqual(handoff["recent_messages"][0]["text"], "Ship the teleport script.")
            self.assertEqual(handoff["workers"][0], "writer | completed | yolo-codex | run-1 | task=Write the teleport summary")
            self.assertEqual(inbox["delivery_state"], "pending")
            self.assertIn("Teleport handoff from", inbox["title"])
            self.assertEqual(inbox["metadata"]["destination_transport"], "ssh")
            self.assertEqual(inbox["metadata"]["destination_label"], "richard@azure")
            self.assertTrue((teleport_dir / "runtime-import" / "claude-prefs.json").exists())
            self.assertTrue((teleport_dir / "runtime-import" / "turn-log.jsonl").exists())

            remote_root = base / "remote-project"
            (remote_root / ".superturtle").mkdir(parents=True)
            (remote_root / ".superturtle" / ".env").write_text(
                "TELEGRAM_BOT_TOKEN=test-token\nTELEGRAM_ALLOWED_USERS=123\n",
                encoding="utf-8",
            )
            shutil_source = teleport_dir
            shutil_target = remote_root / ".superturtle" / "teleport"
            shutil_target.mkdir(parents=True)
            for item in shutil_source.rglob("*"):
                rel = item.relative_to(shutil_source)
                dest = shutil_target / rel
                if item.is_dir():
                    dest.mkdir(parents=True, exist_ok=True)
                else:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(item.read_bytes())

            remote_tmp = base / "remote-tmp"
            remote_tmp.mkdir()
            exit_code = main(
                [
                    "import",
                    "--project-root",
                    str(remote_root),
                    "--tmp-dir",
                    str(remote_tmp),
                ]
            )
            self.assertEqual(exit_code, 0)
            self.assertTrue((remote_tmp / "claude-telegram-test-token-prefs.json").exists())
            self.assertTrue((remote_tmp / "claude-telegram-test-token-turns.jsonl").exists())

            inbox_files = list((remote_root / ".superturtle" / "state" / "inbox").glob("*.json"))
            self.assertEqual(len(inbox_files), 1)
            imported_inbox = json.loads(inbox_files[0].read_text(encoding="utf-8"))
            self.assertEqual(imported_inbox["delivery_state"], "pending")
            self.assertIn("Ship the teleport script.", imported_inbox["text"])

    def test_export_supports_e2b_destinations_without_ssh_target(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            base = Path(tmp_dir)
            project_root = base / "project"
            project_root.mkdir(parents=True)
            (project_root / ".superturtle").mkdir()
            (project_root / ".superturtle" / "state" / "workers").mkdir(parents=True)
            (project_root / ".git").mkdir()
            (project_root / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
            (project_root / ".superturtle" / ".env").write_text(
                "TELEGRAM_BOT_TOKEN=test-token\nTELEGRAM_ALLOWED_USERS=123\n",
                encoding="utf-8",
            )

            tmp_state = base / "tmp-runtime"
            tmp_state.mkdir()
            (tmp_state / "claude-telegram-test-token-prefs.json").write_text(
                json.dumps({"model": "claude-opus-4-6", "effort": "high", "activeDriver": "claude"}),
                encoding="utf-8",
            )

            exit_code = main(
                [
                    "export",
                    "--project-root",
                    str(project_root),
                    "--remote-root",
                    "/home/user/agentic",
                    "--transport",
                    "e2b",
                    "--destination-label",
                    "sandbox_123",
                    "--tmp-dir",
                    str(tmp_state),
                ]
            )
            self.assertEqual(exit_code, 0)

            teleport_dir = project_root / ".superturtle" / "teleport"
            context = json.loads((teleport_dir / "context.json").read_text(encoding="utf-8"))
            inbox = json.loads((teleport_dir / "teleport-inbox.json").read_text(encoding="utf-8"))

            self.assertEqual(context["destination_transport"], "e2b")
            self.assertEqual(context["destination_label"], "sandbox_123")
            self.assertEqual(context["ssh_target"], "")
            self.assertIn("Teleport handoff from", inbox["text"])
            self.assertIn("to sandbox_123.", inbox["text"])
            self.assertIn("Destination transport: e2b", inbox["text"])


if __name__ == "__main__":
    unittest.main()
