#!/usr/bin/env python3
"""Send a privacy-minimized Codex lifecycle event to Codexy."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any


MAX_STDIN_BYTES = 1_048_576
REQUEST_TIMEOUT_SECONDS = 2.0
EVENT_STATE_MAP = {
    "agentturncomplete": "turn_finished",
    "permissionrequest": "needs_you",
    "stop": "turn_finished",
    "sessionend": "session_ended",
    "stopfailure": "failed",
}
DEFAULT_SUMMARIES = {
    "needs_you": "Codex needs your confirmation to continue",
    "turn_finished": "Codex finished this response",
    "failed": "Codex stopped because of an error",
    "session_ended": "Codex session ended",
}
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
WHITESPACE_RE = re.compile(r"\s+")


class NotifyError(RuntimeError):
    """Expected hook input, configuration, or transport failure."""


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Keep the Codexy bearer token on its configured origin."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        return None


def configured(primary: str, legacy: str | None = None) -> str | None:
    value = os.environ.get(primary)
    if value:
        return value
    return os.environ.get(legacy) if legacy else None


def non_blocking_failure(message: str) -> int:
    print(f"codexy notify hook skipped: {message}", file=sys.stderr)
    return 0


def relay_state_path() -> Path:
    configured_path = configured(
        "CODEXY_RELAY_STATE_FILE",
        "ATTENTION_RELAY_STATE_FILE",
    )
    if configured_path:
        return Path(configured_path).expanduser().resolve()
    return Path.home() / ".codex" / "codexy" / "relay-state.json"


def load_single_paired_token(state_path: Path) -> str | None:
    try:
        value = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    devices = value.get("devices") if isinstance(value, dict) else None
    if not isinstance(devices, list):
        return None
    tokens = [
        device["hookToken"]
        for device in devices
        if isinstance(device, dict)
        and isinstance(device.get("hookToken"), str)
        and device["hookToken"]
    ]
    return tokens[0] if len(tokens) == 1 else None


def relay_token() -> str | None:
    return configured(
        "CODEXY_RELAY_TOKEN",
        "ATTENTION_RELAY_TOKEN",
    ) or load_single_paired_token(relay_state_path())


def read_hook_input() -> dict[str, Any]:
    if len(sys.argv) > 1 and sys.argv[1].strip().startswith("{"):
        raw = sys.argv[1].encode("utf-8")
    else:
        raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
    if not raw.strip():
        raise NotifyError("hook input is empty")
    if len(raw) > MAX_STDIN_BYTES:
        raise NotifyError("hook input is larger than 1 MiB")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise NotifyError(f"hook input is not valid UTF-8 JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise NotifyError("hook input must be one JSON object")
    return value


def first_string(*values: Any) -> str | None:
    return next(
        (value for value in values if isinstance(value, str) and value),
        None,
    )


def nested(value: dict[str, Any], *keys: str) -> Any:
    current: Any = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def event_name(hook: dict[str, Any]) -> str:
    value = first_string(
        hook.get("hook_event_name"),
        hook.get("event_name"),
        hook.get("type"),
        hook.get("method"),
    ) or "Manual"
    cleaned = "".join(character for character in value if character.isalnum())
    return cleaned or "Manual"


def event_state(name: str, hook: dict[str, Any]) -> str:
    normalized = name.lower()
    if normalized == "turncompleted":
        status = nested(hook, "params", "turn", "status")
        return {
            "failed": "failed",
            "interrupted": "interrupted",
            "completed": "turn_finished",
        }.get(status, "turn_finished")
    state = EVENT_STATE_MAP.get(normalized)
    if not state:
        raise NotifyError(f"unsupported Codex lifecycle event: {name}")
    return state


def raw_session_id(hook: dict[str, Any]) -> str | None:
    return first_string(
        hook.get("session_id"),
        hook.get("thread-id"),
        hook.get("threadId"),
        nested(hook, "params", "threadId"),
        nested(hook, "params", "turn", "threadId"),
    )


def session_reference(hook: dict[str, Any]) -> str | None:
    value = raw_session_id(hook)
    if not value:
        return None
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
    return f"sha256:{digest[:24]}"


def clean_alias(value: str | None) -> str:
    text = unicodedata.normalize("NFKC", value or "Codex project")
    text = CONTROL_RE.sub(" ", text)
    text = WHITESPACE_RE.sub(" ", text).strip()
    return (text or "Codex project")[:64]


def project_alias(hook: dict[str, Any]) -> str:
    configured_alias = configured(
        "CODEXY_PROJECT_ALIAS",
        "ATTENTION_PROJECT_ALIAS",
    )
    if configured_alias:
        return clean_alias(configured_alias)
    cwd = hook.get("cwd")
    if isinstance(cwd, str):
        parts = [part for part in re.split(r"[\\/]+", cwd.strip()) if part]
        return clean_alias(parts[-1] if parts else None)
    return "Codex project"


def build_payload(hook: dict[str, Any]) -> dict[str, Any]:
    name = event_name(hook)
    state = event_state(name, hook)
    event_id = str(uuid.uuid4())
    session_id = raw_session_id(hook)
    turn_id = first_string(
        hook.get("turn_id"),
        hook.get("turn-id"),
        hook.get("turnId"),
        nested(hook, "params", "turnId"),
        nested(hook, "params", "turn", "id"),
    )
    if session_id or turn_id:
        raw_dedupe = "\x1f".join(
            (session_id or "", turn_id or "", state, name)
        )
        dedupe_key = (
            "sha256:"
            + hashlib.sha256(raw_dedupe.encode("utf-8")).hexdigest()[:24]
        )
    else:
        dedupe_key = f"event:{event_id}"
    payload: dict[str, Any] = {
        "schema_version": "1.0",
        "event_id": event_id,
        "dedupe_key": dedupe_key,
        "occurred_at": (
            dt.datetime.now(dt.timezone.utc)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z")
        ),
        "source": "codex",
        "state": state,
        "event": name,
        "project_alias": project_alias(hook),
        "summary": DEFAULT_SUMMARIES.get(state, "Codex status changed"),
    }
    reference = session_reference(hook)
    if reference:
        payload["session_ref"] = reference
    return payload


def validated_endpoint() -> str:
    endpoint = configured(
        "CODEXY_RELAY_URL",
        "ATTENTION_RELAY_URL",
    ) or "http://127.0.0.1:8797/v1/events"
    parsed = urllib.parse.urlparse(endpoint)
    if not parsed.hostname or parsed.username or parsed.password:
        raise NotifyError("Relay URL must have a hostname and no credentials")
    loopback = parsed.hostname.lower() in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
        raise NotifyError("Relay URL must use HTTPS except on loopback")
    return endpoint


def post_payload(token: str, payload: dict[str, Any]) -> None:
    request = urllib.request.Request(
        validated_endpoint(),
        data=json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8"),
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "codexy-notify/1.0",
        },
        method="POST",
    )
    try:
        opener = urllib.request.build_opener(NoRedirectHandler())
        with opener.open(
            request,
            timeout=REQUEST_TIMEOUT_SECONDS,
        ) as response:
            response.read(1_024)
            if not 200 <= int(response.status) < 300:
                raise NotifyError(f"Relay returned HTTP {response.status}")
    except urllib.error.HTTPError as exc:
        raise NotifyError(f"Relay returned HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise NotifyError(f"Relay request failed: {exc}") from exc


def main() -> int:
    try:
        token = relay_token()
        if not token:
            raise NotifyError(
                "expected one paired Codexy device or CODEXY_RELAY_TOKEN"
            )
        post_payload(token, build_payload(read_hook_input()))
    except (NotifyError, KeyError, TypeError) as error:
        return non_blocking_failure(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
