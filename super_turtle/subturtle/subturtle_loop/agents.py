"""Concrete agent classes for SubTurtle loop orchestration."""

import json
import os
import subprocess
import sys
from pathlib import Path


MAX_CAPTURE_CHARS = 500_000
CLAUDE_FALLBACK_ALLOWED_TOOLS = [
    "Agent",
    "Task",
    "TaskOutput",
    "TaskStop",
    "Bash",
    "Glob",
    "Grep",
    "Read",
    "Edit",
    "Write",
    "NotebookEdit",
    "WebFetch",
    "TodoWrite",
    "WebSearch",
    "ToolSearch",
    "KillShell",
    "AskUserQuestion",
    "Skill",
    "SlashCommand",
    "EnterPlanMode",
    "ExitPlanMode",
    "EnterWorktree",
    "CronCreate",
    "CronDelete",
    "CronList",
]
_ALLOWED_TOOLS_CACHE: dict[str, str] = {}


def _fallback_allowed_tools() -> list[str]:
    tools = list(CLAUDE_FALLBACK_ALLOWED_TOOLS)
    extra = os.environ.get("CLAUDE_ALLOWED_TOOLS_EXTRA", "")
    if extra:
        tools.extend(part.strip() for part in extra.replace(",", " ").split() if part.strip())
    return list(dict.fromkeys(tools))


def _parse_init_tools(output: str) -> list[str]:
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except Exception:
            continue
        if payload.get("type") == "system" and payload.get("subtype") == "init":
            tools = payload.get("tools")
            if isinstance(tools, list):
                return [tool for tool in tools if isinstance(tool, str)]
    return []


def _allowed_tools_arg(cwd: Path) -> str:
    cache_key = str(cwd)
    cached = _ALLOWED_TOOLS_CACHE.get(cache_key)
    if cached is not None:
        return cached

    fallback_tools = _fallback_allowed_tools()
    try:
        probe = subprocess.run(
            ["claude", "-p", "ok", "--verbose", "--output-format", "stream-json"],
            cwd=cwd,
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        discovered = _parse_init_tools(probe.stdout)
        tools = list(dict.fromkeys([*discovered, *fallback_tools])) if discovered else fallback_tools
        if not discovered:
            print(
                "[claude] tool discovery returned no init tool list; using fallback allowlist",
                file=sys.stderr,
            )
    except Exception as exc:
        print(
            f"[claude] tool discovery failed; using fallback allowlist ({exc})",
            file=sys.stderr,
        )
        tools = fallback_tools

    resolved = ",".join(tools)
    _ALLOWED_TOOLS_CACHE[cache_key] = resolved
    return resolved


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


class Claude:
    """Claude Code agent -- planning mode."""

    def __init__(self, cwd: str | Path = ".", add_dirs: list[str] | None = None) -> None:
        self.cwd = Path(cwd).resolve()
        self.add_dirs = add_dirs or []

    def plan(self, prompt: str) -> str:
        """Generate an implementation plan from a prompt. Returns the plan text."""
        print(f"[claude] planning in {self.cwd} ...")
        cmd = [
            "claude",
            "--permission-mode",
            "plan",
            "--dangerously-skip-permissions",
            "--allowedTools",
            _allowed_tools_arg(self.cwd),
        ]
        for add_dir in self.add_dirs:
            cmd.extend(["--add-dir", add_dir])
        cmd.extend(["-p", prompt])
        result = _run_streaming(cmd, self.cwd)
        print(f"[claude] plan ready ({len(result)} chars)")
        print(result)
        return result

    def execute(self, prompt: str) -> str:
        """Execute a prompt (run Claude without plan mode). Returns the output text."""
        print(f"[claude] executing in {self.cwd} ...")
        cmd = [
            "claude",
            "--dangerously-skip-permissions",
            "--allowedTools",
            _allowed_tools_arg(self.cwd),
        ]
        for add_dir in self.add_dirs:
            cmd.extend(["--add-dir", add_dir])
        cmd.extend(["-p", prompt])
        result = _run_streaming(cmd, self.cwd)
        print(f"[claude] executed ready ({len(result)} chars)")
        return result


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
