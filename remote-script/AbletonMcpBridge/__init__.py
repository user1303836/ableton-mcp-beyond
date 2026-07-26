"""Loadable Ableton Control Surface entrypoint for Ableton MCP.

The package keeps configuration outside the Remote Script.  Live invokes
    ``create_instance(c_instance)`` with one argument. Configuration is loaded
    from a fixed adjacent non-secret reference to a separate owner-controlled
    file, so Live does not need command-line or ambient environment secrets.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any

try:  # Live supplies this module; local contract tests deliberately do not.
    from _Framework.ControlSurface import ControlSurface as _ControlSurface
except ImportError:  # pragma: no cover - exercised only outside Live
    class _ControlSurface:
        def __init__(self, c_instance: Any) -> None:
            self._c_instance = c_instance

try:
    from .ableton_mcp_remote_script import AbletonMcpBridge as _Bridge
except ImportError:  # source-tree contract tests import the flat module
    from ableton_mcp_remote_script import AbletonMcpBridge as _Bridge


def _read_config() -> dict[str, Any]:
    reference = Path(__file__).with_name("bridge-reference.json")
    if reference.is_symlink() or not reference.is_file() or not _owner_controlled(reference) or stat.S_IMODE(reference.stat().st_mode) & 0o077:
        raise ValueError("bridge configuration reference is missing or unsafe")
    try:
        reference_value = json.loads(reference.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("bridge configuration reference is unreadable or malformed") from error
    if not isinstance(reference_value, dict) or set(reference_value) != {"config"} or not isinstance(reference_value["config"], str):
        raise ValueError("bridge configuration reference is invalid")
    path = Path(reference_value["config"])
    if not path.is_absolute() or path.is_symlink() or not path.is_file() or not _owner_controlled(path):
        raise ValueError("bridge configuration must be an existing regular file")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise ValueError("bridge configuration must be owner-readable")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("bridge configuration is unreadable or malformed") from error
    if not isinstance(value, dict):
        raise ValueError("unsupported bridge configuration")
    if value.get("version") == 2:
        if set(value) != {"version", "server", "bridge"} or not isinstance(value.get("bridge"), dict) or set(value["bridge"]) != {"host", "port", "secretFile", "timeoutMs"}:
            raise ValueError("unsupported bridge configuration")
        value = {"version": 1, **value["bridge"]}
    if set(value) != {"version", "host", "port", "secretFile"} or value.get("version") != 1:
        raise ValueError("unsupported bridge configuration")
    host, port, secret_file = value.get("host"), value.get("port"), value.get("secretFile")
    if host not in {"127.0.0.1", "::1"} or not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535 or not isinstance(secret_file, str):
        raise ValueError("bridge configuration is invalid")
    secret_path = Path(secret_file)
    if not secret_path.is_absolute() or secret_path.is_symlink() or not secret_path.is_file() or not _owner_controlled(secret_path):
        raise ValueError("bridge secret must be an existing regular file")
    if stat.S_IMODE(secret_path.stat().st_mode) & 0o077:
        raise ValueError("bridge secret must be owner-readable")
    secret = secret_path.read_text(encoding="utf-8")
    if secret.endswith("\n"):
        secret = secret[:-1]
    if not secret or len(secret) < 32 or any(character.isspace() for character in secret):
        raise ValueError("bridge secret is invalid")
    return {"host": host, "port": port, "secret": secret}


def _owner_controlled(path: Path) -> bool:
    """Require the current account to own each security-sensitive file."""
    try:
        return path.stat().st_uid == os.getuid()
    except (AttributeError, OSError):
        return False


class AbletonMcpBridge(_ControlSurface):
    """Control Surface lifecycle wrapper around the dependency-free bridge."""

    def __init__(self, c_instance: Any) -> None:
        super().__init__(c_instance)
        self._bridge = _Bridge(c_instance, _read_config())
        self._disconnected = False
        self._schedule_next()

    def _schedule_next(self) -> None:
        scheduler = getattr(self, "schedule_message", None)
        self._scheduled = scheduler(1, self._drain) if not self._disconnected and callable(scheduler) else None

    def _drain(self) -> None:
        self._bridge.update_display()
        self._schedule_next()

    def update_display(self) -> None:
        self._bridge.update_display()

    def disconnect(self) -> None:
        self._disconnected = True
        if self._scheduled is not None:
            self._scheduled = None
        self._bridge.disconnect()
        parent_disconnect = getattr(super(), "disconnect", None)
        if callable(parent_disconnect):
            parent_disconnect()

    @property
    def address(self) -> Any:
        return self._bridge.address


def create_instance(c_instance: Any) -> AbletonMcpBridge:
    return AbletonMcpBridge(c_instance)


__all__ = ["AbletonMcpBridge", "create_instance"]
