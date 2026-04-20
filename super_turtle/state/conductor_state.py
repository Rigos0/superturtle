from __future__ import annotations

import json
import re
import secrets
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

CONDUCTOR_SCHEMA_VERSION = 1

WORKER_LIFECYCLE_STATES = frozenset(
    {
        "planned",
        "starting",
        "running",
        "completion_pending",
        "failure_pending",
        "stop_pending",
        "completed",
        "failed",
        "timed_out",
        "stopped",
        "archived",
    }
)

WAKEUP_CATEGORIES = frozenset({"critical", "notable", "silent"})
WAKEUP_DELIVERY_STATES = frozenset(
    {"pending", "processing", "sent", "suppressed", "failed"}
)
EVENT_EMITTERS = frozenset(
    {"subturtle", "supervisor", "meta_agent", "cron", "watchdog", "system"}
)

_WORKER_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def _utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", delete=False, dir=path.parent
    ) as tmp_file:
        tmp_file.write(content)
        tmp_path = Path(tmp_file.name)
    tmp_path.replace(path)


def _atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    _atomic_write_text(path, json.dumps(dict(payload), indent=2, sort_keys=True) + "\n")


def _validate_worker_name(worker_name: str) -> str:
    normalized = worker_name.strip()
    if not normalized:
        raise ValueError("worker_name must not be empty")
    if not _WORKER_NAME_RE.fullmatch(normalized):
        raise ValueError(
            "worker_name must match ^[A-Za-z0-9._-]+$"
        )
    return normalized


def _validate_choice(name: str, value: str, allowed: frozenset[str]) -> str:
    normalized = value.strip()
    if normalized not in allowed:
        raise ValueError(
            f"{name} must be one of: {', '.join(sorted(allowed))}"
        )
    return normalized


def _normalize_mapping(value: Mapping[str, Any] | None) -> dict[str, Any]:
    return dict(value) if value else {}


def _new_record_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


@dataclass(frozen=True)
class ConductorPaths:
    base_dir: Path
    events_jsonl_file: Path
    workers_dir: Path
    wakeups_dir: Path
    results_dir: Path
    runs_jsonl_file: Path
    handoff_md_file: Path


def ensure_conductor_state_paths(state_dir: str | Path) -> ConductorPaths:
    base_dir = Path(state_dir)
    workers_dir = base_dir / "workers"
    wakeups_dir = base_dir / "wakeups"
    results_dir = base_dir / "results"
    events_jsonl_file = base_dir / "events.jsonl"
    runs_jsonl_file = base_dir / "runs.jsonl"
    handoff_md_file = base_dir / "handoff.md"

    base_dir.mkdir(parents=True, exist_ok=True)
    workers_dir.mkdir(parents=True, exist_ok=True)
    wakeups_dir.mkdir(parents=True, exist_ok=True)
    results_dir.mkdir(parents=True, exist_ok=True)
    events_jsonl_file.touch(exist_ok=True)
    runs_jsonl_file.touch(exist_ok=True)

    return ConductorPaths(
        base_dir=base_dir,
        events_jsonl_file=events_jsonl_file,
        workers_dir=workers_dir,
        wakeups_dir=wakeups_dir,
        results_dir=results_dir,
        runs_jsonl_file=runs_jsonl_file,
        handoff_md_file=handoff_md_file,
    )


class ConductorStateStore:
    def __init__(self, state_dir: str | Path):
        self.paths = ensure_conductor_state_paths(state_dir)

    def worker_state_path(self, worker_name: str) -> Path:
        return self.paths.workers_dir / f"{_validate_worker_name(worker_name)}.json"

    def wakeup_path(self, wakeup_id: str) -> Path:
        wakeup_id = wakeup_id.strip()
        if not wakeup_id:
            raise ValueError("wakeup_id must not be empty")
        return self.paths.wakeups_dir / f"{wakeup_id}.json"

    def load_worker_state(self, worker_name: str) -> dict[str, Any] | None:
        path = self.worker_state_path(worker_name)
        if not path.exists():
            return None
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise ValueError(f"worker state at {path} must be a JSON object")
        return loaded

    def result_path(self, worker_name: str) -> Path:
        """Return the canonical result file path for a worker."""
        return self.paths.results_dir / f"{_validate_worker_name(worker_name)}.json"

    def load_worker_result(self, worker_name: str) -> dict[str, Any] | None:
        """Load a worker's structured result file if it exists."""
        path = self.result_path(worker_name)
        if not path.exists():
            return None
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            return loaded if isinstance(loaded, dict) else None
        except (OSError, json.JSONDecodeError):
            return None

    def delete_worker_state(self, worker_name: str) -> bool:
        path = self.worker_state_path(worker_name)
        if not path.exists():
            return False
        path.unlink()
        return True

    def list_worker_states(self) -> list[dict[str, Any]]:
        states: list[dict[str, Any]] = []
        for path in sorted(self.paths.workers_dir.glob("*.json")):
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                states.append(loaded)
        return states

    def write_worker_state(self, state: Mapping[str, Any]) -> dict[str, Any]:
        worker_name = _validate_worker_name(str(state.get("worker_name", "")))
        lifecycle_state = _validate_choice(
            "lifecycle_state",
            str(state.get("lifecycle_state", "")),
            WORKER_LIFECYCLE_STATES,
        )
        created_at = str(state.get("created_at") or _utc_now_iso())
        updated_at = str(state.get("updated_at") or _utc_now_iso())

        normalized: dict[str, Any] = {
            "kind": "worker_state",
            "schema_version": CONDUCTOR_SCHEMA_VERSION,
            "worker_name": worker_name,
            "run_id": state.get("run_id"),
            "lifecycle_state": lifecycle_state,
            "workspace": state.get("workspace"),
            "loop_type": state.get("loop_type"),
            "pid": state.get("pid"),
            "timeout_seconds": state.get("timeout_seconds"),
            "cron_job_id": state.get("cron_job_id"),
            "current_task": state.get("current_task"),
            "stop_reason": state.get("stop_reason"),
            "completion_requested_at": state.get("completion_requested_at"),
            "terminal_at": state.get("terminal_at"),
            "created_at": created_at,
            "updated_at": updated_at,
            "updated_by": state.get("updated_by"),
            "last_event_id": state.get("last_event_id"),
            "last_event_at": state.get("last_event_at"),
            "checkpoint": state.get("checkpoint"),
            "metadata": _normalize_mapping(
                state.get("metadata")
                if isinstance(state.get("metadata"), Mapping)
                else None
            ),
        }
        _atomic_write_json(self.worker_state_path(worker_name), normalized)
        return normalized

    def make_worker_state(
        self,
        *,
        worker_name: str,
        lifecycle_state: str,
        updated_by: str,
        run_id: str | None = None,
        workspace: str | None = None,
        loop_type: str | None = None,
        pid: int | None = None,
        timeout_seconds: int | None = None,
        cron_job_id: str | None = None,
        current_task: str | None = None,
        stop_reason: str | None = None,
        completion_requested_at: str | None = None,
        terminal_at: str | None = None,
        last_event_id: str | None = None,
        last_event_at: str | None = None,
        checkpoint: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
        created_at: str | None = None,
        updated_at: str | None = None,
    ) -> dict[str, Any]:
        worker_name = _validate_worker_name(worker_name)
        lifecycle_state = _validate_choice(
            "lifecycle_state", lifecycle_state, WORKER_LIFECYCLE_STATES
        )
        now = _utc_now_iso()
        return {
            "kind": "worker_state",
            "schema_version": CONDUCTOR_SCHEMA_VERSION,
            "worker_name": worker_name,
            "run_id": run_id,
            "lifecycle_state": lifecycle_state,
            "workspace": workspace,
            "loop_type": loop_type,
            "pid": pid,
            "timeout_seconds": timeout_seconds,
            "cron_job_id": cron_job_id,
            "current_task": current_task,
            "stop_reason": stop_reason,
            "completion_requested_at": completion_requested_at,
            "terminal_at": terminal_at,
            "created_at": created_at or now,
            "updated_at": updated_at or now,
            "updated_by": updated_by,
            "last_event_id": last_event_id,
            "last_event_at": last_event_at,
            "checkpoint": _normalize_mapping(checkpoint),
            "metadata": _normalize_mapping(metadata),
        }

    def append_event(
        self,
        *,
        worker_name: str,
        event_type: str,
        emitted_by: str,
        run_id: str | None = None,
        lifecycle_state: str | None = None,
        payload: Mapping[str, Any] | None = None,
        event_id: str | None = None,
        timestamp: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        worker_name = _validate_worker_name(worker_name)
        emitted_by = _validate_choice("emitted_by", emitted_by, EVENT_EMITTERS)
        event_type = event_type.strip()
        if not event_type:
            raise ValueError("event_type must not be empty")
        if lifecycle_state is not None:
            lifecycle_state = _validate_choice(
                "lifecycle_state", lifecycle_state, WORKER_LIFECYCLE_STATES
            )

        entry: dict[str, Any] = {
            "kind": "worker_event",
            "schema_version": CONDUCTOR_SCHEMA_VERSION,
            "id": event_id or _new_record_id("evt"),
            "timestamp": timestamp or _utc_now_iso(),
            "worker_name": worker_name,
            "run_id": run_id,
            "event_type": event_type,
            "emitted_by": emitted_by,
            "lifecycle_state": lifecycle_state,
            "idempotency_key": idempotency_key,
            "payload": _normalize_mapping(payload),
        }

        with self.paths.events_jsonl_file.open("a", encoding="utf-8") as jsonl_file:
            jsonl_file.write(json.dumps(entry, sort_keys=True) + "\n")
        return entry

    def make_wakeup(
        self,
        *,
        worker_name: str,
        category: str,
        summary: str,
        reason_event_id: str | None = None,
        run_id: str | None = None,
        wakeup_id: str | None = None,
        delivery_state: str = "pending",
        payload: Mapping[str, Any] | None = None,
        created_at: str | None = None,
        updated_at: str | None = None,
        attempts: int = 0,
        last_attempt_at: str | None = None,
        sent_at: str | None = None,
        failed_at: str | None = None,
        suppressed_at: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        worker_name = _validate_worker_name(worker_name)
        category = _validate_choice("category", category, WAKEUP_CATEGORIES)
        delivery_state = _validate_choice(
            "delivery_state", delivery_state, WAKEUP_DELIVERY_STATES
        )
        summary = summary.strip()
        if not summary:
            raise ValueError("summary must not be empty")
        now = _utc_now_iso()
        return {
            "kind": "wakeup",
            "schema_version": CONDUCTOR_SCHEMA_VERSION,
            "id": wakeup_id or _new_record_id("wake"),
            "worker_name": worker_name,
            "run_id": run_id,
            "reason_event_id": reason_event_id,
            "category": category,
            "delivery_state": delivery_state,
            "summary": summary,
            "created_at": created_at or now,
            "updated_at": updated_at or now,
            "delivery": {
                "attempts": attempts,
                "last_attempt_at": last_attempt_at,
                "sent_at": sent_at,
                "failed_at": failed_at,
                "suppressed_at": suppressed_at,
            },
            "payload": _normalize_mapping(payload),
            "metadata": _normalize_mapping(metadata),
        }

    def write_wakeup(self, wakeup: Mapping[str, Any]) -> dict[str, Any]:
        worker_name = _validate_worker_name(str(wakeup.get("worker_name", "")))
        category = _validate_choice(
            "category",
            str(wakeup.get("category", "")),
            WAKEUP_CATEGORIES,
        )
        delivery_state = _validate_choice(
            "delivery_state",
            str(wakeup.get("delivery_state", "")),
            WAKEUP_DELIVERY_STATES,
        )
        wakeup_id = str(wakeup.get("id", "")).strip()
        if not wakeup_id:
            raise ValueError("wakeup.id must not be empty")
        summary = str(wakeup.get("summary", "")).strip()
        if not summary:
            raise ValueError("wakeup.summary must not be empty")

        delivery_raw = wakeup.get("delivery")
        delivery = dict(delivery_raw) if isinstance(delivery_raw, Mapping) else {}
        normalized: dict[str, Any] = {
            "kind": "wakeup",
            "schema_version": CONDUCTOR_SCHEMA_VERSION,
            "id": wakeup_id,
            "worker_name": worker_name,
            "run_id": wakeup.get("run_id"),
            "reason_event_id": wakeup.get("reason_event_id"),
            "category": category,
            "delivery_state": delivery_state,
            "summary": summary,
            "created_at": wakeup.get("created_at") or _utc_now_iso(),
            "updated_at": wakeup.get("updated_at") or _utc_now_iso(),
            "delivery": {
                "attempts": delivery.get("attempts", 0),
                "last_attempt_at": delivery.get("last_attempt_at"),
                "sent_at": delivery.get("sent_at"),
                "failed_at": delivery.get("failed_at"),
                "suppressed_at": delivery.get("suppressed_at"),
            },
            "payload": _normalize_mapping(
                wakeup.get("payload")
                if isinstance(wakeup.get("payload"), Mapping)
                else None
            ),
            "metadata": _normalize_mapping(
                wakeup.get("metadata")
                if isinstance(wakeup.get("metadata"), Mapping)
                else None
            ),
        }
        _atomic_write_json(self.wakeup_path(wakeup_id), normalized)
        return normalized

    def load_wakeup(self, wakeup_id: str) -> dict[str, Any] | None:
        path = self.wakeup_path(wakeup_id)
        if not path.exists():
            return None
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise ValueError(f"wakeup record at {path} must be a JSON object")
        return loaded

    def list_wakeups(self, delivery_state: str | None = None) -> list[dict[str, Any]]:
        if delivery_state is not None:
            delivery_state = _validate_choice(
                "delivery_state", delivery_state, WAKEUP_DELIVERY_STATES
            )

        wakeups: list[dict[str, Any]] = []
        for path in sorted(self.paths.wakeups_dir.glob("*.json")):
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(loaded, dict):
                continue
            if delivery_state and loaded.get("delivery_state") != delivery_state:
                continue
            wakeups.append(loaded)
        return wakeups

    def update_wakeup_delivery(
        self,
        *,
        wakeup_id: str,
        delivery_state: str,
        increment_attempts: bool = False,
        last_attempt_at: str | None = None,
        sent_at: str | None = None,
        failed_at: str | None = None,
        suppressed_at: str | None = None,
    ) -> dict[str, Any]:
        wakeup = self.load_wakeup(wakeup_id)
        if wakeup is None:
            raise FileNotFoundError(f"wakeup not found: {wakeup_id}")

        delivery_state = _validate_choice(
            "delivery_state", delivery_state, WAKEUP_DELIVERY_STATES
        )
        delivery = dict(wakeup.get("delivery") or {})
        if increment_attempts:
            delivery["attempts"] = int(delivery.get("attempts", 0)) + 1
        if last_attempt_at is not None:
            delivery["last_attempt_at"] = last_attempt_at
        if sent_at is not None:
            delivery["sent_at"] = sent_at
        if failed_at is not None:
            delivery["failed_at"] = failed_at
        if suppressed_at is not None:
            delivery["suppressed_at"] = suppressed_at

        updated = dict(wakeup)
        updated["delivery_state"] = delivery_state
        updated["updated_at"] = _utc_now_iso()
        updated["delivery"] = delivery
        return self.write_wakeup(updated)
