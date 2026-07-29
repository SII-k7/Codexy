#!/usr/bin/env python3
"""Capture one privacy-filtered Codex prompt and sync it to Codexy."""

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
from pathlib import Path
from typing import Any


MAX_STDIN_BYTES = 1_048_576
MAX_PROMPT_CHARS = 2_000
REQUEST_TIMEOUT_SECONDS = 2.0

CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
WHITESPACE_RE = re.compile(r"\s+")
FENCED_CODE_RE = re.compile(r"```[\s\S]*?```", re.MULTILINE)
URL_RE = re.compile(r"\bhttps?://\S+", re.IGNORECASE)
EMAIL_RE = re.compile(
    r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b",
    re.IGNORECASE,
)
WINDOWS_PATH_RE = re.compile(
    r"(?<!\w)[A-Za-z]:[\\/]"
    r"(?:[^\s<>:\"|?*,，。；;\[\](){}]+[\\/])*"
    r"[^\s<>:\"|?*,，。；;\[\](){}]*"
)
POSIX_PATH_RE = re.compile(
    r"(?<!\w)/(?:[^/\s,，。；;\[\](){}]+/)+[^/\s,，。；;\[\](){}]*"
)
SECRET_RE = re.compile(
    r"(?i)\b(?:bearer\s+)?(?:"
    r"sk-[a-z0-9_-]{12,}|"
    r"(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+|"
    r"eyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{8,}"
    r")"
)


class CaptureError(RuntimeError):
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
    print(f"codexy prompt hook skipped: {message}", file=sys.stderr)
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
    raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
    if not raw.strip():
        raise CaptureError("hook input is empty")
    if len(raw) > MAX_STDIN_BYTES:
        raise CaptureError("hook input is larger than 1 MiB")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CaptureError(f"hook input is not valid UTF-8 JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise CaptureError("hook input must be one JSON object")
    return value


def first_string(*values: Any) -> str | None:
    return next(
        (value for value in values if isinstance(value, str) and value),
        None,
    )


def session_id(hook: dict[str, Any]) -> str:
    params = hook.get("params") if isinstance(hook.get("params"), dict) else {}
    value = first_string(
        hook.get("session_id"),
        hook.get("thread-id"),
        hook.get("threadId"),
        params.get("threadId"),
    )
    if not value:
        raise CaptureError("hook input does not contain a Codex session id")
    return value


def prompt_text(hook: dict[str, Any]) -> str:
    params = hook.get("params") if isinstance(hook.get("params"), dict) else {}
    value = first_string(
        hook.get("prompt"),
        hook.get("user_prompt"),
        params.get("prompt"),
    )
    if not value:
        raise CaptureError("hook input does not contain a string prompt")
    text = unicodedata.normalize("NFKC", value)
    text = FENCED_CODE_RE.sub(" [code omitted] ", text)
    text = SECRET_RE.sub("[redacted]", text)
    text = URL_RE.sub("[link]", text)
    text = EMAIL_RE.sub("[email]", text)
    text = WINDOWS_PATH_RE.sub("[path]", text)
    text = POSIX_PATH_RE.sub("[path]", text)
    text = CONTROL_RE.sub(" ", text)
    text = WHITESPACE_RE.sub(" ", text).strip()
    if not text:
        raise CaptureError("prompt is empty after privacy filtering")
    return text[:MAX_PROMPT_CHARS]


def session_reference(value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
    return f"sha256:{digest[:24]}"


def project_alias(hook: dict[str, Any]) -> str:
    configured_alias = configured(
        "CODEXY_PROJECT_ALIAS",
        "ATTENTION_PROJECT_ALIAS",
    )
    cwd = hook.get("cwd")
    if configured_alias:
        value = configured_alias
    elif isinstance(cwd, str):
        parts = [part for part in re.split(r"[\\/]+", cwd.strip()) if part]
        value = parts[-1] if parts else "Codex project"
    else:
        value = "Codex project"
    value = unicodedata.normalize("NFKC", value)
    value = CONTROL_RE.sub(" ", value)
    value = WHITESPACE_RE.sub(" ", value).strip()
    return (value or "Codex project")[:64]


def validated_endpoint() -> str:
    endpoint = configured(
        "CODEXY_PROMPT_RELAY_URL",
        "ATTENTION_PROMPT_RELAY_URL",
    ) or "http://127.0.0.1:8797/v1/prompts"
    parsed = urllib.parse.urlparse(endpoint)
    if not parsed.hostname or parsed.username or parsed.password:
        raise CaptureError("Relay URL must have a hostname and no credentials")
    loopback = parsed.hostname.lower() in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
        raise CaptureError("Relay URL must use HTTPS except on loopback")
    return endpoint


def post_capture(token: str, payload: dict[str, Any]) -> None:
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
            "User-Agent": "codexy-prompt-capture/1.0",
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
                raise CaptureError(f"Relay returned HTTP {response.status}")
    except urllib.error.HTTPError as exc:
        raise CaptureError(f"Relay returned HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise CaptureError(f"Relay request failed: {exc}") from exc


def main() -> int:
    try:
        token = relay_token()
        if not token:
            raise CaptureError(
                "expected one paired Codexy device or CODEXY_RELAY_TOKEN"
            )
        hook = read_hook_input()
        raw_session_id = session_id(hook)
        sanitized_prompt = prompt_text(hook)
        turn_id = first_string(
            hook.get("turn_id"),
            hook.get("turn-id"),
            hook.get("turnId"),
        ) or ""
        prompt_identity = "\x1f".join(
            (raw_session_id, turn_id, sanitized_prompt)
        )
        post_capture(
            token,
            {
                "schema_version": "1.0",
                "session_ref": session_reference(raw_session_id),
                "source": "codex",
                "project_alias": project_alias(hook),
                "prompt_id": (
                    "sha256:"
                    + hashlib.sha256(
                        prompt_identity.encode("utf-8")
                    ).hexdigest()[:24]
                ),
                "captured_at": (
                    dt.datetime.now(dt.timezone.utc)
                    .isoformat(timespec="seconds")
                    .replace("+00:00", "Z")
                ),
                "text": sanitized_prompt,
            },
        )
    except (CaptureError, KeyError, TypeError) as error:
        return non_blocking_failure(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
