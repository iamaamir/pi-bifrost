#!/usr/bin/env python3
"""Run explicitly named UI checks in deterministic order."""
from pathlib import Path
import subprocess
import sys


def main(directory):
    tests = sorted(directory.glob("*.test.py"))
    if not tests:
        print(f"No UI tests found in {directory}", file=sys.stderr)
        return 1
    for test in tests:
        print(f"Running {test.name}", flush=True)
        result = subprocess.run([sys.executable, str(test)])
        if result.returncode:
            return result.returncode if result.returncode > 0 else 1
    return 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent / "ui-tests"))
