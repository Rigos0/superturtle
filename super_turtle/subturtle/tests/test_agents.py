from pathlib import Path

from super_turtle.subturtle.subturtle_loop import agents


class _CompletedProcess:
    def __init__(self, stdout: str) -> None:
        self.stdout = stdout


def test_allowed_tools_arg_merges_discovered_and_fallback(monkeypatch, tmp_path) -> None:
    agents._ALLOWED_TOOLS_CACHE.clear()

    monkeypatch.setattr(
        agents.subprocess,
        "run",
        lambda *args, **kwargs: _CompletedProcess(
            '{"type":"system","subtype":"init","tools":["Bash","KillShell","SlashCommand"]}\n'
        ),
    )

    allowed = agents._allowed_tools_arg(Path(tmp_path))

    assert "Bash" in allowed
    assert "KillShell" in allowed
    assert "SlashCommand" in allowed
    assert "Read" in allowed
    assert "Write" in allowed
