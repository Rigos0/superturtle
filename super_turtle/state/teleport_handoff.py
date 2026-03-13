from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def sanitize_token_prefix(token: str) -> str:
    prefix = (token.split(":", 1)[0] if token else "") or "default"
    chars: list[str] = []
    last_dash = False
    for char in prefix.lower():
        if char.isalnum() or char in "_-":
            chars.append(char)
            last_dash = False
            continue
        if not last_dash:
            chars.append("-")
            last_dash = True
    normalized = "".join(chars).strip("-")
    return normalized or "default"


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def copy_if_exists(source: Path, target: Path) -> bool:
    if not source.exists():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    return True


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("\r")
        if (
            len(value) >= 2
            and ((value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")))
        ):
            value = value[1:-1]
        values[key] = value
    return values


def shorten(text: str, limit: int = 220) -> str:
    compact = " ".join((text or "").split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 3].rstrip() + "..."


def parse_turn_log(path: Path, driver: str, limit: int = 6) -> list[dict[str, str]]:
    if not path.exists():
        return []
    entries: list[dict[str, str]] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if parsed.get("driver") != driver:
            continue
        user_text = shorten(str(parsed.get("originalMessage") or ""), 320)
        response_text = shorten(str(parsed.get("response") or ""), 320)
        started_at = str(parsed.get("startedAt") or utc_now_iso())
        completed_at = str(parsed.get("completedAt") or started_at)
        if user_text:
            entries.append({"role": "user", "text": user_text, "timestamp": started_at})
        if response_text:
            entries.append({"role": "assistant", "text": response_text, "timestamp": completed_at})
    return entries[-limit:]


def load_session_recent_messages(path: Path, project_root: Path) -> list[dict[str, str]]:
    loaded = read_json(path)
    if not isinstance(loaded, dict):
        return []
    sessions = loaded.get("sessions")
    if not isinstance(sessions, list):
        return []

    matching: dict[str, Any] | None = None
    for item in sessions:
        if not isinstance(item, dict):
            continue
        if item.get("working_dir") == str(project_root):
            matching = item
            break
        if matching is None:
            matching = item

    if not isinstance(matching, dict):
        return []
    recent_messages = matching.get("recentMessages")
    if not isinstance(recent_messages, list):
        return []

    normalized: list[dict[str, str]] = []
    for item in recent_messages:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip()
        text = shorten(str(item.get("text") or ""), 320)
        timestamp = str(item.get("timestamp") or utc_now_iso())
        if role not in {"user", "assistant"} or not text:
            continue
        normalized.append({"role": role, "text": text, "timestamp": timestamp})
    return normalized


def summarize_worker_states(workers_dir: Path, limit: int = 8) -> list[str]:
    if not workers_dir.exists():
        return []
    summaries: list[str] = []
    for path in sorted(workers_dir.glob("*.json")):
        loaded = read_json(path)
        if not isinstance(loaded, dict):
            continue
        worker_name = str(loaded.get("worker_name") or path.stem)
        lifecycle = str(loaded.get("lifecycle_state") or "unknown")
        current_task = shorten(str(loaded.get("current_task") or ""), 120)
        loop_type = str(loaded.get("loop_type") or "")
        run_id = str(loaded.get("run_id") or "")
        parts = [worker_name, lifecycle]
        if loop_type:
            parts.append(loop_type)
        if run_id:
            parts.append(run_id)
        if current_task:
            parts.append(f"task={current_task}")
        summaries.append(" | ".join(parts))
    return summaries[:limit]


def count_pending_json(path: Path) -> int:
    if not path.exists():
        return 0
    count = 0
    for item_path in path.glob("*.json"):
        loaded = read_json(item_path)
        if not isinstance(loaded, dict):
            continue
        if loaded.get("delivery_state") == "pending":
            count += 1
    return count


@dataclass(frozen=True)
class RuntimePaths:
    project_root: Path
    teleport_dir: Path
    runtime_import_dir: Path
    env_file: Path
    state_dir: Path
    workers_dir: Path
    inbox_dir: Path


def resolve_runtime_paths(project_root: Path, teleport_dir: Path | None = None) -> RuntimePaths:
    base_teleport_dir = teleport_dir or project_root / ".superturtle" / "teleport"
    return RuntimePaths(
        project_root=project_root,
        teleport_dir=base_teleport_dir,
        runtime_import_dir=base_teleport_dir / "runtime-import",
        env_file=project_root / ".superturtle" / ".env",
        state_dir=project_root / ".superturtle" / "state",
        workers_dir=project_root / ".superturtle" / "state" / "workers",
        inbox_dir=project_root / ".superturtle" / "state" / "inbox",
    )


def normalize_destination_transport(value: str | None) -> str:
    transport = str(value or "ssh").strip().lower()
    if transport not in {"ssh", "e2b"}:
        raise SystemExit(f"Unsupported teleport destination transport: {transport}")
    return transport


def resolve_destination_label(
    destination_transport: str, destination_label: str | None, ssh_target: str | None
) -> str:
    explicit_label = str(destination_label or "").strip()
    if explicit_label:
        return explicit_label
    ssh_label = str(ssh_target or "").strip()
    if ssh_label:
        return ssh_label
    if destination_transport == "e2b":
        return "managed-sandbox"
    raise SystemExit("SSH teleport exports require --ssh-target or --destination-label.")


def build_context(
    paths: RuntimePaths,
    tmp_dir: Path,
    remote_root: str | None,
    ssh_target: str | None,
    destination_transport: str | None = None,
    destination_label: str | None = None,
) -> dict[str, Any]:
    env = read_env_file(paths.env_file)
    token = env.get("TELEGRAM_BOT_TOKEN", "")
    allowed_users = env.get("TELEGRAM_ALLOWED_USERS", "")
    chat_id: int | None = None
    if allowed_users:
        for part in allowed_users.split(","):
            part = part.strip()
            if part.isdigit():
                chat_id = int(part)
                break

    token_prefix = sanitize_token_prefix(token)
    claude_prefs = read_json(tmp_dir / f"claude-telegram-{token_prefix}-prefs.json")
    codex_prefs = read_json(tmp_dir / f"codex-telegram-{token_prefix}-prefs.json")
    active_driver = "claude"
    model = ""
    effort = ""

    if isinstance(claude_prefs, dict):
        active_driver = str(claude_prefs.get("activeDriver") or active_driver)
        model = str(claude_prefs.get("model") or model)
        effort = str(claude_prefs.get("effort") or effort)

    if active_driver == "codex" and isinstance(codex_prefs, dict):
        model = str(codex_prefs.get("model") or model)
        effort = str(codex_prefs.get("reasoningEffort") or effort)

    resolved_transport = normalize_destination_transport(destination_transport)
    resolved_label = resolve_destination_label(resolved_transport, destination_label, ssh_target)

    return {
        "created_at": utc_now_iso(),
        "source_host": socket.gethostname(),
        "source_project_root": str(paths.project_root),
        "remote_root": remote_root or "",
        "destination_transport": resolved_transport,
        "destination_label": resolved_label,
        "ssh_target": ssh_target or "",
        "token_prefix": token_prefix,
        "chat_id": chat_id,
        "active_driver": active_driver if active_driver in {"claude", "codex"} else "claude",
        "model": model,
        "effort": effort,
    }


def build_handoff_payload(paths: RuntimePaths, tmp_dir: Path, context: dict[str, Any]) -> dict[str, Any]:
    token_prefix = context["token_prefix"]
    active_driver = context["active_driver"]
    turn_log_path = tmp_dir / f"claude-telegram-{token_prefix}-turns.jsonl"
    claude_session_path = tmp_dir / f"claude-telegram-{token_prefix}-session.json"
    codex_session_path = tmp_dir / f"codex-telegram-{token_prefix}-session.json"
    recent_messages = (
        load_session_recent_messages(
            codex_session_path if active_driver == "codex" else claude_session_path,
            paths.project_root,
        )
        or parse_turn_log(turn_log_path, active_driver)
    )

    workers = summarize_worker_states(paths.workers_dir)
    pending_inbox = count_pending_json(paths.state_dir / "inbox")
    pending_wakeups = count_pending_json(paths.state_dir / "wakeups")

    return {
        **context,
        "workers": workers,
        "pending_inbox_count": pending_inbox,
        "pending_wakeup_count": pending_wakeups,
        "recent_messages": recent_messages,
        "git": {
            "head": read_git_head(paths.project_root),
            "dirty": is_git_dirty(paths.project_root),
        },
    }


def read_git_head(project_root: Path) -> str:
    head_path = project_root / ".git" / "HEAD"
    if not head_path.exists():
        return ""
    return head_path.read_text(encoding="utf-8").strip()


def is_git_dirty(project_root: Path) -> bool:
    git_dir = project_root / ".git"
    if not git_dir.exists():
        return False
    try:
        proc = subprocess.run(
            ["git", "status", "--short"],
            cwd=project_root,
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return False
    return bool(proc.stdout.strip())


def build_handoff_text(payload: dict[str, Any]) -> str:
    destination_transport = normalize_destination_transport(str(payload.get("destination_transport") or "ssh"))
    destination_label = resolve_destination_label(
        destination_transport,
        str(payload.get("destination_label") or ""),
        str(payload.get("ssh_target") or ""),
    )
    lines = [
        f"Teleport handoff from {payload.get('source_host') or 'unknown-host'} to {destination_label}.",
        f"Previous project root: {payload.get('source_project_root') or '(unknown)'}",
        f"Destination project root: {payload.get('remote_root') or '(unknown)'}",
        f"Destination transport: {destination_transport}",
        f"Active driver: {payload.get('active_driver') or 'claude'}",
    ]
    model = str(payload.get("model") or "").strip()
    effort = str(payload.get("effort") or "").strip()
    if model:
        lines.append(f"Model: {model}{f' | effort={effort}' if effort else ''}")

    lines.append(
        f"Pending durable state: inbox={payload.get('pending_inbox_count', 0)} wakeups={payload.get('pending_wakeup_count', 0)}"
    )

    workers = payload.get("workers") or []
    if isinstance(workers, list) and workers:
        lines.append("Workers:")
        for item in workers[:8]:
            lines.append(f"- {item}")

    recent_messages = payload.get("recent_messages") or []
    if isinstance(recent_messages, list) and recent_messages:
        lines.append("Recent conversation:")
        for item in recent_messages[-8:]:
            if not isinstance(item, dict):
                continue
            role = "User" if item.get("role") == "user" else "Assistant"
            lines.append(f"- {role}: {shorten(str(item.get('text') or ''), 260)}")

    lines.append(
        "This is a machine-to-machine teleport handoff. Treat it as current runtime context for the next user turn."
    )
    return "\n".join(lines)


def build_inbox_item(payload: dict[str, Any]) -> dict[str, Any]:
    created_at = utc_now_iso()
    item_id = f"inbox_teleport_{int(time.time())}"
    return {
        "kind": "meta_agent_inbox_item",
        "schema_version": 1,
        "id": item_id,
        "chat_id": payload.get("chat_id"),
        "worker_name": None,
        "run_id": None,
        "priority": "high",
        "category": "teleport_handoff",
        "title": f"Teleport handoff from {payload.get('source_host') or 'unknown-host'}",
        "text": build_handoff_text(payload),
        "delivery_state": "pending",
        "source_event_id": None,
        "source_wakeup_id": None,
        "created_at": created_at,
        "updated_at": created_at,
        "delivery": {
            "acknowledged_at": None,
            "acknowledged_by_driver": None,
            "acknowledged_by_turn_id": None,
            "acknowledged_by_session_id": None,
        },
        "metadata": {
            "kind": "teleport_handoff",
            "source_host": payload.get("source_host"),
            "source_project_root": payload.get("source_project_root"),
            "remote_root": payload.get("remote_root"),
            "destination_transport": payload.get("destination_transport") or "ssh",
            "destination_label": payload.get("destination_label") or payload.get("ssh_target"),
            "ssh_target": payload.get("ssh_target"),
            "active_driver": payload.get("active_driver"),
        },
    }


def export_runtime_imports(paths: RuntimePaths, tmp_dir: Path, token_prefix: str) -> list[str]:
    paths.runtime_import_dir.mkdir(parents=True, exist_ok=True)
    exported: list[str] = []
    mapping = {
        tmp_dir / f"claude-telegram-{token_prefix}-prefs.json": paths.runtime_import_dir / "claude-prefs.json",
        tmp_dir / f"codex-telegram-{token_prefix}-prefs.json": paths.runtime_import_dir / "codex-prefs.json",
        tmp_dir / f"claude-telegram-{token_prefix}-turns.jsonl": paths.runtime_import_dir / "turn-log.jsonl",
    }
    for source, target in mapping.items():
        if copy_if_exists(source, target):
            exported.append(target.name)
    return exported


def cmd_export(args: argparse.Namespace) -> int:
    project_root = Path(args.project_root).resolve()
    tmp_dir = Path(args.tmp_dir).resolve()
    paths = resolve_runtime_paths(project_root, Path(args.teleport_dir).resolve() if args.teleport_dir else None)
    context = build_context(
        paths,
        tmp_dir,
        args.remote_root,
        args.ssh_target,
        args.transport,
        args.destination_label,
    )
    payload = build_handoff_payload(paths, tmp_dir, context)
    inbox_item = build_inbox_item(payload)
    exported_files = export_runtime_imports(paths, tmp_dir, context["token_prefix"])

    write_json(paths.teleport_dir / "context.json", context)
    write_json(paths.teleport_dir / "handoff.json", payload)
    write_json(paths.teleport_dir / "teleport-inbox.json", inbox_item)

    summary = {
        "teleport_dir": str(paths.teleport_dir),
        "active_driver": context["active_driver"],
        "token_prefix": context["token_prefix"],
        "chat_id": context["chat_id"],
        "exported_files": exported_files,
    }
    print(json.dumps(summary))
    return 0


def cmd_import(args: argparse.Namespace) -> int:
    project_root = Path(args.project_root).resolve()
    tmp_dir = Path(args.tmp_dir).resolve()
    paths = resolve_runtime_paths(project_root, Path(args.teleport_dir).resolve() if args.teleport_dir else None)
    context = read_json(paths.teleport_dir / "context.json")
    inbox_item = read_json(paths.teleport_dir / "teleport-inbox.json")
    if not isinstance(context, dict) or not isinstance(inbox_item, dict):
        raise SystemExit("Teleport export artifacts are missing or invalid.")

    runtime_import_dir = paths.runtime_import_dir
    restored: list[str] = []
    mapping = {
        runtime_import_dir / "claude-prefs.json": tmp_dir / f"claude-telegram-{context['token_prefix']}-prefs.json",
        runtime_import_dir / "codex-prefs.json": tmp_dir / f"codex-telegram-{context['token_prefix']}-prefs.json",
        runtime_import_dir / "turn-log.jsonl": tmp_dir / f"claude-telegram-{context['token_prefix']}-turns.jsonl",
    }
    for source, target in mapping.items():
        if copy_if_exists(source, target):
            restored.append(target.name)

    inbox_path = paths.inbox_dir / f"{inbox_item['id']}.json"
    write_json(inbox_path, inbox_item)
    print(json.dumps({"restored_files": restored, "inbox_path": str(inbox_path)}))
    return 0


def cmd_notify(args: argparse.Namespace) -> int:
    project_root = Path(args.project_root).resolve()
    paths = resolve_runtime_paths(project_root, Path(args.teleport_dir).resolve() if args.teleport_dir else None)
    env = read_env_file(paths.env_file)
    token = env.get("TELEGRAM_BOT_TOKEN", "")
    allowed_users = env.get("TELEGRAM_ALLOWED_USERS", "")
    if not token:
        raise SystemExit("TELEGRAM_BOT_TOKEN is missing from .superturtle/.env")

    chat_id = args.chat_id
    if chat_id is None:
        for part in allowed_users.split(","):
            part = part.strip()
            if part.isdigit():
                chat_id = int(part)
                break
    if chat_id is None:
        raise SystemExit("Could not determine Telegram chat id for notification.")

    payload = json.dumps({"chat_id": chat_id, "text": args.text}).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Telegram notification failed: {error.code} {body}") from error
    except urllib.error.URLError as error:
        raise SystemExit(f"Telegram notification failed: {error}") from error
    print(body)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Export and import teleport handoff state.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    export_parser = subparsers.add_parser("export", help="Build the local teleport handoff bundle.")
    export_parser.add_argument("--project-root", required=True)
    export_parser.add_argument("--remote-root", required=True)
    export_parser.add_argument("--ssh-target")
    export_parser.add_argument("--transport", default="ssh")
    export_parser.add_argument("--destination-label")
    export_parser.add_argument("--tmp-dir", default="/tmp")
    export_parser.add_argument("--teleport-dir")
    export_parser.set_defaults(func=cmd_export)

    import_parser = subparsers.add_parser("import", help="Restore portable runtime state on the remote host.")
    import_parser.add_argument("--project-root", required=True)
    import_parser.add_argument("--tmp-dir", default="/tmp")
    import_parser.add_argument("--teleport-dir")
    import_parser.set_defaults(func=cmd_import)

    notify_parser = subparsers.add_parser("notify", help="Send a Telegram notification using the project bot token.")
    notify_parser.add_argument("--project-root", required=True)
    notify_parser.add_argument("--text", required=True)
    notify_parser.add_argument("--chat-id", type=int)
    notify_parser.add_argument("--teleport-dir")
    notify_parser.set_defaults(func=cmd_notify)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
