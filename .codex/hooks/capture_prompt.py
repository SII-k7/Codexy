#!/usr/bin/env python3
"""Capture one sanitized Codex prompt and sync it to the private Relay."""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path
from types import ModuleType
from typing import Any


MAX_STDIN_BYTES = 1_048_576
REQUEST_TIMEOUT_SECONDS = 2.0


def non_blocking_failure(message: str) -> int:
    print(f"prompt-capture hook skipped: {message}", file=sys.stderr)
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


def load_intent_buffer(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location("attention_intent_buffer", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("intent buffer module could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def project_alias(cwd: Any) -> str:
    if not isinstance(cwd, str):
        return "Codex project"
    parts = [part for part in re.split(r"[\\/]+", cwd.strip()) if part]
    value = parts[-1] if parts else "Codex project"
    value = unicodedata.normalize("NFKC", value)
    value = re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return (value or "Codex project")[:64]


def post_capture(
    token: str,
    payload: dict[str, Any],
    endpoint: str,
) -> None:
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8"),
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "attention-prompt-capture/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(
        request,
        timeout=REQUEST_TIMEOUT_SECONDS,
    ) as response:
        response.read(1_024)
        if not 200 <= int(response.status) < 300:
            raise RuntimeError(f"Relay returned HTTP {response.status}")


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
    prompt_endpoint = os.environ.get(
        "ATTENTION_PROMPT_RELAY_URL",
        "http://127.0.0.1:8787/v1/prompts",
    )
    device = load_single_paired_device(state_path)
    if device is None:
        return non_blocking_failure("expected exactly one paired local device")

    raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
    if not raw.strip() or len(raw) > MAX_STDIN_BYTES:
        return non_blocking_failure("hook input is empty or too large")

    intent_path = (
        skills_root / "intent-refiner" / "scripts" / "intent_buffer.py"
    )
    if not intent_path.is_file():
        return non_blocking_failure("intent-refiner privacy filter is unavailable")

    try:
        module = load_intent_buffer(intent_path)
        hook = module.read_json_bytes(raw, "hook stdin")
        captured = module.capture_hook(hook, limit=10, ttl_hours=24)
        prompt = captured["prompt"]
        post_capture(
            device["hookToken"],
            {
                "schema_version": "1.0",
                "session_ref": captured["session_ref"],
                "source": "codex",
                "project_alias": project_alias(hook.get("cwd")),
                "prompt_id": prompt["prompt_id"],
                "captured_at": prompt["captured_at"],
                "text": prompt["text"],
            },
            prompt_endpoint,
        )
    except (
        OSError,
        RuntimeError,
        KeyError,
        TypeError,
        urllib.error.URLError,
        urllib.error.HTTPError,
    ) as error:
        return non_blocking_failure(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
