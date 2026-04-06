"""Concrete agent classes for SubTurtle loop orchestration."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


MAX_CAPTURE_CHARS = 500_000


def _run_streaming(cmd: list[str], cwd: Path) -> str:
    """Run a command, stream stdout line-by-line to stderr, return captured stdout.

    Streams to stderr so that the return value (stdout capture) stays clean
    for programmatic use, while the operator still sees progress in the terminal.

    Raises subprocess.CalledProcessError on non-zero exit.
    """
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=False,
    )
    chunks: list[str] = []
    captured_chars = 0
    if proc.stdout is None:
        raise RuntimeError("stdout is None despite PIPE being set")
    for raw_line in proc.stdout:
        # Codex can emit binary/null-filled chunks on reconnect paths.
        # Decode defensively so the SubTurtle loop keeps retrying instead of crashing.
        line = raw_line.decode("utf-8", errors="replace").replace("\x00", "")
        sys.stderr.write(line)
        sys.stderr.flush()
        if captured_chars < MAX_CAPTURE_CHARS:
            remaining = MAX_CAPTURE_CHARS - captured_chars
            if len(line) <= remaining:
                chunks.append(line)
                captured_chars += len(line)
            else:
                chunks.append(line[:remaining])
                captured_chars = MAX_CAPTURE_CHARS
    proc.wait()
    if proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, cmd)
    return "".join(chunks).strip()


class Codex:
    """Codex agent -- execution mode."""

    def __init__(
        self,
        cwd: str | Path = ".",
        add_dirs: list[str] | None = None,
        model: str | None = None,
    ) -> None:
        self.cwd = Path(cwd).resolve()
        self.add_dirs = add_dirs or []
        self.model = model

    def execute(self, prompt: str) -> str:
        """Execute a prompt with full auto-approval. Returns agent output."""
        print(f"[codex] executing in {self.cwd} ...")
        cmd = ["codex", "exec", "--yolo", "--cd", str(self.cwd)]
        if self.model:
            cmd.extend(["--model", self.model])
        for add_dir in self.add_dirs:
            cmd.extend(["--add-dir", add_dir])
        cmd.append(prompt)
        result = _run_streaming(cmd, self.cwd)
        print("[codex] done")
        return result
