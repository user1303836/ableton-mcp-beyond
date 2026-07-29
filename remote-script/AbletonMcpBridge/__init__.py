"""Loadable Ableton Control Surface entrypoint for Ableton MCP.

The package keeps configuration outside the Remote Script.  Live invokes
    ``create_instance(c_instance)`` with one argument. Configuration is loaded
    from a fixed adjacent non-secret reference to a separate owner-controlled
    file, so Live does not need command-line or ambient environment secrets.
"""

from __future__ import annotations

import base64
import json
import os
import stat
import subprocess
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


def _normalize_bridge_config(value: Any) -> dict[str, Any]:
    """Collapse a supported host or bridge configuration to its version-1 shape."""
    if not isinstance(value, dict):
        raise ValueError("unsupported bridge configuration")
    if value.get("version") == 2:
        server = value.get("server")
        bridge = value.get("bridge")
        if (set(value) != {"version", "server", "bridge"} or not isinstance(server, dict) or set(server) != {"command", "args"}
                or not isinstance(server.get("command"), str) or not server["command"] or not isinstance(server.get("args"), list) or any(not isinstance(item, str) for item in server["args"])
                or not isinstance(bridge, dict) or not {"host", "port", "secretFile", "timeoutMs"} <= set(bridge) or set(bridge) - {"host", "port", "secretFile", "timeoutMs", "realtimePort"}):
            raise ValueError("unsupported bridge configuration")
        timeout_ms = bridge["timeoutMs"]
        if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool) or not 100 <= timeout_ms <= 60000:
            raise ValueError("unsupported bridge configuration")
        realtime_port = bridge.get("realtimePort")
        if realtime_port is not None and (not isinstance(realtime_port, int) or isinstance(realtime_port, bool) or not 1 <= realtime_port <= 65535 or realtime_port == bridge.get("port")):
            raise ValueError("unsupported bridge configuration")
        normalized = {"version": 1, "host": bridge["host"], "port": bridge["port"], "secretFile": bridge["secretFile"]}
        if realtime_port is not None:
            normalized["realtimePort"] = realtime_port
        return normalized
    if set(value) != {"version", "host", "port", "secretFile"} or value.get("version") != 1:
        raise ValueError("unsupported bridge configuration")
    return value


def _mode_owner_only(path: Path) -> bool:
    """Apply POSIX mode-bit checks only where those bits carry POSIX meaning."""
    if os.name == "nt":
        return True
    try:
        return stat.S_IMODE(path.stat().st_mode) & 0o077 == 0
    except OSError:
        return False


def _read_config() -> dict[str, Any]:
    reference = Path(__file__).with_name("bridge-reference.json")
    if reference.is_symlink() or not reference.is_file() or not _owner_controlled(reference) or not _mode_owner_only(reference):
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
    if not _mode_owner_only(path):
        raise ValueError("bridge configuration must be owner-readable")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("bridge configuration is unreadable or malformed") from error
    value = _normalize_bridge_config(value)
    host, port, secret_file = value.get("host"), value.get("port"), value.get("secretFile")
    if host not in {"127.0.0.1", "::1"} or not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535 or not isinstance(secret_file, str):
        raise ValueError("bridge configuration is invalid")
    realtime_port = value.get("realtimePort")
    if realtime_port is not None and (not isinstance(realtime_port, int) or isinstance(realtime_port, bool) or not 1 <= realtime_port <= 65535 or realtime_port == port):
        raise ValueError("realtime port is invalid")
    secret_path = Path(secret_file)
    if not secret_path.is_absolute() or secret_path.is_symlink() or not secret_path.is_file() or not _owner_controlled(secret_path):
        raise ValueError("bridge secret must be an existing regular file")
    if not _mode_owner_only(secret_path):
        raise ValueError("bridge secret must be owner-readable")
    secret = secret_path.read_text(encoding="utf-8")
    if secret.endswith("\n"):
        secret = secret[:-1]
    if not secret or len(secret) < 32 or any(character.isspace() for character in secret):
        raise ValueError("bridge secret is invalid")
    return {"host": host, "port": port, "secret": secret, "realtimePort": realtime_port}


def _owner_controlled(path: Path) -> bool:
    """Require the current account to own each security-sensitive file."""
    if os.name == "nt":
        return _windows_owner_controlled(path) and _windows_acl_owner_only(path)
    try:
        return path.stat().st_uid == os.getuid()
    except (AttributeError, OSError):
        return False


def _windows_acl_owner_only(path: Path) -> bool:
    """Require a protected DACL containing exactly one owner FullControl ACE.

    Verification uses the Windows security API with explicit exit codes so no
    localized or serialized output is parsed.
    """
    try:
        encoded = base64.b64encode(str(path).encode("utf-8")).decode("ascii")
        script = (
            "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ABLETON_MCP_ACL_PATH));"
            "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;"
            "$c=[System.IO.File]::GetAccessControl($p);"
            "if ($c.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 2 }"
            "if (-not $c.AreAccessRulesProtected) { exit 3 }"
            "$rules=@($c.Access); if ($rules.Count -ne 1) { exit 4 }"
            "$rule=$rules[0];"
            "if ($rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 5 }"
            "if ($rule.IsInherited) { exit 6 }"
            "if ($rule.AccessControlType.ToString() -ne 'Allow') { exit 7 }"
            "if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { exit 8 }"
            "exit 0"
        )
        environment = dict(os.environ)
        environment["ABLETON_MCP_ACL_PATH"] = encoded
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
            capture_output=True, timeout=10, env=environment,
        )
        return result.returncode == 0
    except (AttributeError, OSError, ValueError, TypeError, subprocess.SubprocessError):
        return False


def _windows_owner_controlled(path: Path) -> bool:
    """Compare the file owner SID with the current process token on Windows.

    ``stat().st_uid`` is not a Windows security identity and is commonly zero
    or otherwise synthetic on Windows.  Use the native security descriptor and
    token APIs instead, without adding a platform-specific dependency.
    """
    security_descriptor = None
    try:
        import ctypes
        from ctypes import wintypes

        advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        owner_sid = ctypes.c_void_p()
        security_descriptor = ctypes.c_void_p()
        advapi32.GetNamedSecurityInfoW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
            ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p,
            ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
        ]
        advapi32.GetNamedSecurityInfoW.restype = wintypes.DWORD
        if advapi32.GetNamedSecurityInfoW(
            str(path), 1, 1, ctypes.byref(owner_sid), None, None, None,
            ctypes.byref(security_descriptor),
        ) != 0 or not owner_sid.value:
            return False

        token = wintypes.HANDLE()
        kernel32.GetCurrentProcess.argtypes = []
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        advapi32.OpenProcessToken.argtypes = [
            wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE),
        ]
        advapi32.OpenProcessToken.restype = wintypes.BOOL
        if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
            return False
        try:
            class SidAndAttributes(ctypes.Structure):
                _fields_ = [("sid", ctypes.c_void_p), ("attributes", wintypes.DWORD)]

            class TokenUser(ctypes.Structure):
                _fields_ = [("user", SidAndAttributes)]

            class TokenOwner(ctypes.Structure):
                _fields_ = [("owner", ctypes.c_void_p)]

            advapi32.GetTokenInformation.argtypes = [
                wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p,
                wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
            ]
            advapi32.GetTokenInformation.restype = wintypes.BOOL

            def token_information(info_class: int, structure: Any) -> tuple[Any, Any] | None:
                required = wintypes.DWORD()
                advapi32.GetTokenInformation(token, info_class, None, 0, ctypes.byref(required))
                if not required.value:
                    return None
                buffer = ctypes.create_string_buffer(required.value)
                if not advapi32.GetTokenInformation(
                    token, info_class, buffer, required.value, ctypes.byref(required),
                ):
                    return None
                return buffer, ctypes.cast(buffer, ctypes.POINTER(structure)).contents

            user_info = token_information(1, TokenUser)
            owner_info = token_information(4, TokenOwner)
            if user_info is None or owner_info is None:
                return False
            # Keep both backing buffers alive while comparing their SID pointers.
            user_buffer, token_user = user_info
            owner_buffer, token_owner = owner_info
            current_sid = token_user.user.sid
            default_owner_sid = token_owner.owner
            advapi32.EqualSid.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            advapi32.EqualSid.restype = wintypes.BOOL
            return bool(
                current_sid
                and default_owner_sid
                and (
                    advapi32.EqualSid(owner_sid, current_sid)
                    or advapi32.EqualSid(owner_sid, default_owner_sid)
                )
            )
        finally:
            kernel32.CloseHandle(token)
    except (AttributeError, OSError, TypeError, ValueError):
        return False
    finally:
        try:
            if 'kernel32' in locals() and security_descriptor is not None and security_descriptor.value:
                kernel32.LocalFree(security_descriptor)
        except (AttributeError, OSError):
            pass


class AbletonMcpBridge(_ControlSurface):
    """Control Surface lifecycle wrapper around the dependency-free bridge."""

    def __init__(self, c_instance: Any) -> None:
        super().__init__(c_instance)
        accessor = getattr(self, "song", None)
        self._bridge = _Bridge(c_instance, _read_config(), song=accessor() if callable(accessor) else None, provenance="real-live")
        self._disconnected = False
        self._schedule_next()

    def _schedule_next(self) -> None:
        scheduler = getattr(self, "schedule_message", None)
        self._scheduled = scheduler(1, self._drain) if not self._disconnected and callable(scheduler) else None

    def _drain(self) -> None:
        if self._disconnected:
            return
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
