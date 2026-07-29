#!/usr/bin/env python3
"""Bridge a Codex lifecycle hook to the local mobile notification sender."""

from __future__ import annotations

import json
import os
import runpy
import sys
from pathlib import Path
from typing import Any


def fail_closed(message: str) -> int:
    # Hook delivery is observational and must never block Codex work.
    print(f"notify-mobile hook skipped: {message}", file=sys.stderr)
    return 0


def load_single_paired_device(state_path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None

    devices = value.get("devices") if isinstance(value, dict) else None
    if not isinstance(devices, list):
        return None
    paired = [
        device
        for device in devices
        if isinstance(device, dict)
        and isinstance(device.get("hookToken"), str)
        and device["hookToken"]
    ]
    return paired[0] if len(paired) == 1 else None


def main() -> int:
    script_path = Path(__file__).resolve()
    configured_root = os.environ.get("ATTENTION_COMPANION_ROOT")
    repo_root = (
        Path(configured_root).expanduser().resolve()
        if configured_root
        else script_path.parents[2]
    )
    configured_skills = os.environ.get("ATTENTION_SKILLS_ROOT")
    skills_root = (
        Path(configured_skills).expanduser().resolve()
        if configured_skills
        else repo_root.parent / "skills"
    )
    configured_state = os.environ.get("ATTENTION_RELAY_STATE_FILE")
    state_path = (
        Path(configured_state).expanduser().resolve()
        if configured_state
        else repo_root / "relay" / ".data" / "state.json"
    )
    sender_path = (
        skills_root / "notify-agent-mobile" / "scripts" / "send_event.py"
    )

    device = load_single_paired_device(state_path)
    if device is None:
        return fail_closed("expected exactly one paired local device")
    if not sender_path.is_file():
        return fail_closed("notification sender is unavailable")

    os.environ["ATTENTION_RELAY_URL"] = (
        "http://127.0.0.1:8787/v1/events"
    )
    os.environ["ATTENTION_RELAY_TOKEN"] = device["hookToken"]

    # The sender reads the original hook JSON from stdin. It deliberately
    # ignores prompts, code, paths, tool inputs, outputs, and transcripts.
    sys.argv = [str(sender_path), "--source", "codex", *sys.argv[1:]]
    runpy.run_path(str(sender_path), run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
