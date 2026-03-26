"""CLI entrypoint for SubTurtle loop execution."""

import argparse
from pathlib import Path

from .loops import LOOP_TYPES, run_loop


def main() -> None:
    """Parse CLI arguments and dispatch to the selected SubTurtle loop."""
    parser = argparse.ArgumentParser(description="SubTurtle autonomous coding loop")
    parser.add_argument(
        "--state-dir",
        required=True,
        help="Path to this SubTurtle's workspace directory (contains CLAUDE.md)",
    )
    parser.add_argument(
        "--name",
        default="default",
        help="Human-readable name for this SubTurtle (used in log prefixes)",
    )
    parser.add_argument(
        "--type",
        default="yolo-codex",
        choices=list(LOOP_TYPES.keys()),
        help=(
            "Loop type: yolo-codex (single Codex call), "
            "yolo-codex-spark (single Codex Spark call)"
        ),
    )
    parser.add_argument(
        "--skills",
        nargs="*",
        default=[],
        help="List of shared SuperTurtle skills to load (e.g. frontend testing)",
    )
    args = parser.parse_args()

    run_loop(state_dir=Path(args.state_dir).resolve(), name=args.name, loop_type=args.type, skills=args.skills)


if __name__ == "__main__":
    main()
