"""Minimal Ableton Remote Script transport boundary.

This module intentionally has no import-time dependency on Ableton Live, so it
can be syntax-tested and installed before Live is available. Live's Control
Surface can call ``dispatch`` with a JSON-compatible object and forward the
returned JSON line over its localhost socket implementation.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import base64
import re
import math
import os
import queue
import socket
import stat
import struct
import sys
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Callable

PROTOCOL = "ableton-loopback/v1"
_DIAGNOSTICS_MAX_BYTES = 256 * 1024
_DIAGNOSTICS_QUEUE_LIMIT = 64
_DIAGNOSTICS_RECORD_LIMIT = 512
_DIAGNOSTIC_EVENTS = {"dispatch-failure", "result-contract-failure", "capture-tick-failure", "realtime-packet-failure"}


class _DiagnosticsSink:
    """Bounded owner-file diagnostics writer; callers only enqueue constants."""

    def __init__(self, path: str, max_bytes: int = _DIAGNOSTICS_MAX_BYTES, *, start_writer: bool = True, security_validator: Callable[[Path], bool] | None = None) -> None:
        self._path = Path(path)
        self._max_bytes = max_bytes
        self._security_validator = security_validator
        self._parent_identity: os.stat_result | None = None
        self._queue: queue.Queue[Any] = queue.Queue(maxsize=_DIAGNOSTICS_QUEUE_LIMIT)
        self._stop = threading.Event()
        self._dropped = 0
        self._fd: int | None = None
        self._thread: threading.Thread | None = None
        self.enabled = False
        if not self._path.is_absolute() or max_bytes != _DIAGNOSTICS_MAX_BYTES or (os.name == "nt" and security_validator is None):
            return
        try:
            self._fd = self._secure_open()
        except (OSError, ValueError):
            return
        self.enabled = True
        if start_writer:
            self._thread = threading.Thread(target=self._write_loop, name="AbletonMcpDiagnostics", daemon=True)
            try:
                self._thread.start()
            except BaseException:
                self._thread = None
                self._disable()

    @staticmethod
    def _reparse_point(entry: os.stat_result) -> bool:
        return bool(getattr(entry, "st_file_attributes", 0) & 0x400)

    @classmethod
    def _safe_descriptor(cls, entry: os.stat_result) -> bool:
        if not stat.S_ISREG(entry.st_mode) or entry.st_nlink != 1 or cls._reparse_point(entry):
            return False
        if os.name != "nt":
            if stat.S_IMODE(entry.st_mode) & 0o077:
                return False
            if hasattr(os, "getuid") and entry.st_uid != os.getuid():
                return False
        return True

    def _secure_open(self) -> int:
        parent = self._path.parent
        parent_entry = os.lstat(parent)
        if stat.S_ISLNK(parent_entry.st_mode) or self._reparse_point(parent_entry) or not stat.S_ISDIR(parent_entry.st_mode):
            raise ValueError("unsafe diagnostics directory")
        if os.name != "nt" and ((stat.S_IMODE(parent_entry.st_mode) & 0o077) or (hasattr(os, "getuid") and parent_entry.st_uid != os.getuid())):
            raise ValueError("diagnostics directory is not owner-only")
        for ancestor in (parent, *parent.parents):
            entry = os.lstat(ancestor)
            if (stat.S_ISLNK(entry.st_mode) or self._reparse_point(entry)) and str(ancestor) not in {"/var", "/tmp"}:
                raise ValueError("diagnostics path contains a linked ancestor")
        if self._security_validator is not None and not self._security_validator(self._path):
            raise ValueError("diagnostics security validation failed")
        before = os.lstat(self._path)
        if stat.S_ISLNK(before.st_mode) or not self._safe_descriptor(before):
            raise ValueError("unsafe diagnostics destination")
        flags = os.O_WRONLY | os.O_APPEND
        flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
        descriptor = os.open(self._path, flags)
        try:
            opened = os.fstat(descriptor)
            current = os.lstat(self._path)
            if not self._safe_descriptor(opened) or not self._safe_descriptor(current) or not os.path.samestat(before, opened) or not os.path.samestat(opened, current):
                raise ValueError("diagnostics destination changed during open")
            if opened.st_size > self._max_bytes:
                os.ftruncate(descriptor, 0)
                opened = os.fstat(descriptor)
            self._parent_identity = parent_entry
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    @staticmethod
    def _error_category() -> str:
        kind = sys.exc_info()[0]
        if kind is None:
            return "unknown-error"
        try:
            if issubclass(kind, TimeoutError): return "timeout-error"
            if issubclass(kind, OSError): return "io-error"
            if issubclass(kind, (ValueError, TypeError, KeyError)): return "validation-error"
        except TypeError:
            pass
        return "internal-error"

    def record(self, event: str) -> None:
        if not self.enabled or event not in _DIAGNOSTIC_EVENTS:
            return
        item = (int(time.time() * 1000), event, self._error_category())
        try:
            self._queue.put_nowait(item)
        except queue.Full:
            self._dropped = min(self._dropped + 1, 2**31 - 1)

    def _descriptor_current(self) -> bool:
        if self._fd is None or self._parent_identity is None:
            return False
        try:
            opened = os.fstat(self._fd)
            current = os.lstat(self._path)
            parent = os.lstat(self._path.parent)
            parent_safe = stat.S_ISDIR(parent.st_mode) and not stat.S_ISLNK(parent.st_mode) and not self._reparse_point(parent)
            if os.name != "nt":
                parent_safe = parent_safe and not (stat.S_IMODE(parent.st_mode) & 0o077) and (not hasattr(os, "getuid") or parent.st_uid == os.getuid())
            if self._security_validator is not None:
                parent_safe = parent_safe and self._security_validator(self._path)
            return parent_safe and os.path.samestat(self._parent_identity, parent) and self._safe_descriptor(opened) and self._safe_descriptor(current) and os.path.samestat(opened, current)
        except (OSError, ValueError):
            return False

    def _disable(self) -> None:
        self.enabled = False
        descriptor, self._fd = self._fd, None
        if descriptor is not None:
            try: os.close(descriptor)
            except OSError: pass

    def _write(self, item: tuple[int, str, str]) -> None:
        if self._fd is None or not self._descriptor_current():
            raise OSError("diagnostics descriptor is no longer authoritative")
        record = json.dumps({"version": 1, "timeMs": item[0], "event": item[1], "category": item[2], "dropped": self._dropped}, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("ascii") + b"\n"
        if len(record) > _DIAGNOSTICS_RECORD_LIMIT:
            raise OSError("diagnostics record exceeds bound")
        if os.fstat(self._fd).st_size + len(record) > self._max_bytes:
            os.ftruncate(self._fd, 0)
        offset = 0
        while offset < len(record):
            written = os.write(self._fd, record[offset:])
            if written <= 0:
                raise OSError("diagnostics write made no progress")
            offset += written

    def _write_loop(self) -> None:
        try:
            while not self._stop.is_set():
                try: item = self._queue.get(timeout=0.2)
                except queue.Empty: continue
                try:
                    if item is None: return
                    self._write(item)
                except OSError:
                    self._disable()
                    return
                finally:
                    self._queue.task_done()
        finally:
            self._disable()

    def flush_for_test(self, timeout: float = 2.0) -> bool:
        deadline = time.monotonic() + timeout
        while self._queue.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.005)
        return self._queue.unfinished_tasks == 0

    def close(self) -> None:
        self._stop.set()
        if self._thread is None:
            self._disable()
            return
        try: self._queue.put_nowait(None)
        except queue.Full: pass

    def wait_closed_for_test(self, timeout: float = 2.0) -> bool:
        thread = self._thread
        if thread is not None:
            thread.join(timeout)
        return (thread is None or not thread.is_alive()) and self._fd is None


_ACTIVE_DIAGNOSTICS: _DiagnosticsSink | None = None


def _set_diagnostics_sink(sink: _DiagnosticsSink | None) -> None:
    global _ACTIVE_DIAGNOSTICS
    prior, _ACTIVE_DIAGNOSTICS = _ACTIVE_DIAGNOSTICS, sink
    if prior is not None and prior is not sink:
        prior.close()


def _clear_diagnostics_sink(sink: _DiagnosticsSink) -> None:
    global _ACTIVE_DIAGNOSTICS
    if _ACTIVE_DIAGNOSTICS is sink:
        _ACTIVE_DIAGNOSTICS = None
    sink.close()


def _debug_trace(context: str) -> None:
    sink = _ACTIVE_DIAGNOSTICS
    if sink is not None:
        sink.record(context)

METHODS = {"status", "snapshot", "discover", "get", "preflight", "prepare", "invoke", "subscribe", "reconnect", "retire"}
_READ_ONLY_INVOKES = {"session.playback", "automation.envelope.read", "browser.search", "browser.inspect", "audio.capture.inspect", "audio.capture.status", "realtime.stats", "session.reconnect"}
_TRANSACTION_CREATIONS = {"track.create", "scene.create", "clip.create", "clip.duplicate", "arrangement.clip.create", "arrangement.audio-clip.create", "session.audio-clip.create", "browser.load", "device.insert", "session.capture-midi", "scene.capture", "locator.add"}
_TRANSACTION_DELETIONS = {"track.delete", "scene.delete", "clip.delete", "arrangement.clip.delete", "device.delete", "locator.delete"}
_OWNED_CONTENT_MUTATIONS = {"note.add", "note.add-batch", "note.update", "note.delete"}
def _mutation_authority_required(operation: str) -> bool: return operation not in _READ_ONLY_INVOKES

def _require_output_safety(args: dict[str, Any]) -> None:
    evidence = args.get("outputSafety")
    if not isinstance(evidence, dict) or set(evidence) - {"safe", "provenance", "observedAt", "scope"} or evidence.get("safe") is not True or not isinstance(evidence.get("provenance"), str) or evidence.get("provenance") in {"", "unknown", "simulator"}:
        raise ValueError("explicit authoritative output-safety evidence is required")
REQUIRED_REGISTRY_OPERATIONS = {"status", "snapshot", "discover", "get", "reconnect", "session.playback"}
_MODULE_PATH = Path(__file__).resolve()
_REGISTRY_CANDIDATES = (
    _MODULE_PATH.with_name("ableton-live-v1.operations.json"),
    _MODULE_PATH.parents[1] / "protocol" / "ableton-live-v1.operations.json",
    _MODULE_PATH.parents[2] / "protocol" / "ableton-live-v1.operations.json",
)


def operation_registry() -> tuple[dict[str, Any], str]:
    """Load the registry and hash canonical JSON, independent of line endings."""
    try:
        registry_path = next(path for path in _REGISTRY_CANDIDATES if path.is_file())
        raw = registry_path.read_bytes()
        registry = json.loads(raw.decode("utf-8"))
    except (OSError, StopIteration, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("operation registry is unavailable or malformed") from error
    operations = registry.get("operations") if isinstance(registry, dict) else None
    if not isinstance(registry, dict) or set(registry) != {"version", "protocol", "operations"} or registry.get("version") != 1 or registry.get("protocol") != "ableton-live/v1" or not isinstance(operations, list):
        raise ValueError("unsupported operation registry")
    identifiers = [item.get("id") for item in operations if isinstance(item, dict)]
    if len(identifiers) != len(operations) or identifiers != sorted(identifiers) or len(set(identifiers)) != len(identifiers):
        raise ValueError("operation registry identifiers are not canonical")
    allowed_schema = {"type", "properties", "required", "additionalProperties", "items", "enum", "const", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "uniqueItems", "maxProperties", "pattern"}
    types = {"object", "array", "string", "number", "integer", "boolean", "null"}
    def validate_schema(schema: Any, depth: int = 0) -> None:
        if not isinstance(schema, dict) or depth > 8 or set(schema) - allowed_schema:
            raise ValueError("invalid operation schema")
        declared = schema.get("type")
        declared_types = declared if isinstance(declared, list) else [declared]
        if not declared_types or len(declared_types) > 4 or any(item not in types for item in declared_types):
            raise ValueError("invalid operation schema type")
        for key in ("minLength", "maxLength", "minItems", "maxItems", "maxProperties"):
            value = schema.get(key)
            if value is not None and (not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > 2**53 - 1):
                raise ValueError("invalid operation schema bound")
        for key in ("minimum", "maximum"):
            value = schema.get(key)
            if value is not None and (not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or not -2**53 < float(value) < 2**53):
                raise ValueError("invalid operation schema bound")
        if "object" in declared_types:
            additional = schema.get("additionalProperties")
            if not isinstance(additional, (bool, dict)) or additional is not False and "maxProperties" not in schema:
                raise ValueError("object schema must be bounded")
            if isinstance(additional, dict): validate_schema(additional, depth + 1)
            properties = schema.get("properties", {})
            if not isinstance(properties, dict) or len(properties) > 64:
                raise ValueError("invalid operation schema properties")
            required = schema.get("required", [])
            if not isinstance(required, list) or len(required) > 64 or any(not isinstance(item, str) for item in required):
                raise ValueError("invalid operation schema required fields")
            for child in properties.values(): validate_schema(child, depth + 1)
        if "array" in declared_types:
            if not isinstance(schema.get("items"), dict): raise ValueError("array schema items are required")
            if "uniqueItems" in schema and not isinstance(schema["uniqueItems"], bool): raise ValueError("invalid uniqueItems")
            if schema.get("minItems", 0) > schema.get("maxItems", 2**53 - 1): raise ValueError("invalid array bounds")
            validate_schema(schema["items"], depth + 1)
        if "enum" in schema and (not isinstance(schema["enum"], list) or not 0 < len(schema["enum"]) <= 32):
            raise ValueError("invalid operation schema enum")
    for item in operations:
        if set(item) != {"id", "method", "request", "result"} or not isinstance(item["id"], str) or item["method"] not in METHODS or not isinstance(item["request"], dict) or not isinstance(item["result"], dict):
            raise ValueError("operation registry entry is malformed")
        validate_schema(item["request"])
        validate_schema(item["result"])
    if not REQUIRED_REGISTRY_OPERATIONS.issubset(identifiers):
        raise ValueError("operation registry is missing required operations")
    canonical_registry = json.dumps(registry, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return registry, hashlib.sha256(canonical_registry).hexdigest()


def _matches_schema_type(value: Any, declared: str) -> bool:
    if declared == "null": return value is None
    if declared == "object": return isinstance(value, dict)
    if declared == "array": return isinstance(value, list)
    if declared == "boolean": return isinstance(value, bool)
    if declared == "integer": return isinstance(value, int) and not isinstance(value, bool) and -(2**53 - 1) <= value <= 2**53 - 1
    if declared == "number": return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))
    if declared == "string": return isinstance(value, str)
    return False


def validate_registry_value(schema: dict[str, Any], value: Any, path: str = "$") -> None:
    declared = schema.get("type")
    declared_types = declared if isinstance(declared, list) else [declared]
    if not any(_matches_schema_type(value, item) for item in declared_types): raise ValueError(f"{path} does not match registry type")
    if "const" in schema and value != schema["const"]: raise ValueError(f"{path} does not match registry constant")
    if "enum" in schema and value not in schema["enum"]: raise ValueError(f"{path} is outside registry enum")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]: raise ValueError(f"{path} is too short")
        if "maxLength" in schema and len(value) > schema["maxLength"]: raise ValueError(f"{path} is too long")
        if "pattern" in schema and re.fullmatch(schema["pattern"], value) is None: raise ValueError(f"{path} does not match pattern")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if not math.isfinite(float(value)) or ("minimum" in schema and value < schema["minimum"]) or ("maximum" in schema and value > schema["maximum"]): raise ValueError(f"{path} is outside numeric bounds")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]: raise ValueError(f"{path} is below item bound")
        if "maxItems" in schema and len(value) > schema["maxItems"]: raise ValueError(f"{path} exceeds item bound")
        if schema.get("uniqueItems") is True:
            encoded = [json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":")) for item in value]
            if len(set(encoded)) != len(encoded): raise ValueError(f"{path} contains duplicate items")
        for index, item in enumerate(value): validate_registry_value(schema["items"], item, f"{path}[{index}]")
    if isinstance(value, dict):
        if "maxProperties" in schema and len(value) > schema["maxProperties"]: raise ValueError(f"{path} exceeds property bound")
        properties = schema.get("properties", {})
        for required in schema.get("required", []):
            if required not in value: raise ValueError(f"{path}.{required} is required")
        additional = schema.get("additionalProperties")
        unknown = set(value) - set(properties)
        if additional is False and unknown: raise ValueError(f"{path} contains unknown properties")
        if isinstance(additional, dict):
            for key in unknown: validate_registry_value(additional, value[key], f"{path}.{key}")
        for key, child in properties.items():
            if key in value: validate_registry_value(child, value[key], f"{path}.{key}")


def validate_operation_payload(operation_id: str, side: str, value: Any) -> None:
    registry, _ = operation_registry()
    operation = next((item for item in registry["operations"] if item["id"] == operation_id), None)
    if operation is None: raise ValueError("operation is not in canonical registry")
    validate_registry_value(operation[side], value, f"{operation_id}.{side}")

MAX_NONCE_LENGTH = 256
MAX_WIRE_BYTES = 1_048_576
MAX_WIRE_DEPTH = 16
MAX_WIRE_STRING_LENGTH = 16_384
MAX_WIRE_ARRAY_LENGTH = 512
MAX_WIRE_OBJECT_PROPERTIES = 256
MAX_DISCOVERY_COLLECTION_LENGTH = 256
MAX_QUEUE_ITEMS = 128
DEFAULT_TIMEOUT_SECONDS = 5.0


class AuthenticatedRemoteScript:
    def __init__(self, secret: str, operation: Callable[[str, dict[str, Any]], Any], bridge_epoch: str | None = None, connection_challenge: str | None = None):
        if len(secret) < 32:
            raise ValueError("loopback secret must contain at least 32 characters")
        self._secret = secret.encode("utf-8")
        self._operation = operation
        self._last_sequence = 0
        self.invalid = False
        self.bridge_epoch = bridge_epoch or secrets.token_urlsafe(24)
        self.connection_challenge = connection_challenge or secrets.token_urlsafe(24)
        if len(self.bridge_epoch) < 16 or len(self.connection_challenge) < 16:
            raise ValueError("authenticated channel binding is too short")

    def sign(self, payload: dict[str, Any]) -> str:
        encoded = self._bounded_canonical(payload).encode("utf-8")
        return base64.urlsafe_b64encode(hmac.new(self._secret, encoded, hashlib.sha256).digest()).decode("ascii").rstrip("=")

    @classmethod
    def _canonical(cls, value: Any, depth: int = 0) -> str:
        if depth > MAX_WIRE_DEPTH:
            raise ValueError("wire payload is too deeply nested")
        if value is None or isinstance(value, (str, bool)):
            if isinstance(value, str) and len(value) > MAX_WIRE_STRING_LENGTH:
                raise ValueError("wire string is too large")
            return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        if isinstance(value, int):
            # Live exposes Boost enum values as int subclasses whose str() is a
            # symbolic name; canonical wire numbers must be plain integers.
            return str(value) if type(value) is int else str(int(value))
        if isinstance(value, float):
            if not math.isfinite(value):
                raise ValueError("non-finite wire number")
            if value == 0 or (value.is_integer() and abs(value) < 1e21):
                return str(int(value))
            encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            return re.sub(r"e([+-])0+(\d+)", r"e\1\2", encoded)
        if isinstance(value, list):
            if len(value) > MAX_WIRE_ARRAY_LENGTH:
                raise ValueError("wire array is too large")
            return "[" + ",".join(cls._canonical(item, depth + 1) for item in value) + "]"
        if isinstance(value, dict):
            if len(value) > MAX_WIRE_OBJECT_PROPERTIES:
                raise ValueError("wire object is too large")
            return "{" + ",".join(json.dumps(key, ensure_ascii=False) + ":" + cls._canonical(value[key], depth + 1) for key in sorted(value)) + "}"
        raise TypeError("unsupported wire value")

    @classmethod
    def _bounded_canonical(cls, value: Any) -> str:
        encoded = cls._canonical(value)
        if len(encoded.encode("utf-8")) > MAX_WIRE_BYTES:
            raise ValueError("wire payload is too large")
        return encoded

    def bound(self, payload: dict[str, Any], deadline_ms: int | None = None) -> dict[str, Any]:
        return {**payload, "bridgeEpoch": self.bridge_epoch, "connectionChallenge": self.connection_challenge, "deadlineMs": deadline_ms or int(time.time() * 1000) + 5000}

    def hello_response(self) -> dict[str, Any]:
        _, registry_hash = operation_registry()
        return self._response("hello", True, {"protocol": "ableton-live/v1", "registryHash": registry_hash, "maxDeadlineMs": 60000})

    def _operation_contract(self, request: dict[str, Any]) -> tuple[str, Any]:
        method = request["method"]
        if method in {"status", "snapshot", "reconnect"}: return method, {}
        if method == "retire": return "authority.retire", {"transactionId": request.get("transactionId"), **({"terminal": request["terminal"]} if "terminal" in request else {})}
        if method == "discover":
            args = dict(request.get("args", {}))
            return ("session.playback", {}) if args.get("kind") == "session_playback" else ("discover", args)
        if method == "get": return "get", {"ref": request.get("ref")}
        if method in {"preflight", "prepare"}:
            args = dict(request.get("args", {})); operation = str(request.get("operation")); digest = hashlib.sha256(self._bounded_canonical(args).encode("utf-8")).hexdigest()
            if method == "preflight": return "authority.preflight", {"operation": operation, "argsDigest": digest, "transactionId": request.get("transactionId")}
            return "authority.prepare", {"operation": operation, "argsDigest": digest, "transactionId": request.get("transactionId"), "preflightToken": request.get("preflightToken"), "confirmation": request.get("confirmation"), "idempotencyKey": request.get("idempotencyKey")}
        if method == "invoke": return str(request.get("operation")), dict(request.get("args", {}))
        return method, dict(request.get("args", {}))

    def dispatch(self, request: dict[str, Any]) -> dict[str, Any]:
        required = {"version", "id", "method", "nonce", "sequence", "bridgeEpoch", "connectionChallenge", "deadlineMs", "mac"}
        optional = {"ref", "property", "value", "operation", "args", "preflightToken", "confirmation", "idempotencyKey", "authorityToken", "transactionId", "ownershipToken", "terminal"}
        if not isinstance(request, dict) or set(request) - required - optional or not required <= set(request):
            return self._error("invalid", "invalid request")
        unsigned = {key: value for key, value in request.items() if key != "mac"}
        now_ms = int(time.time() * 1000)
        if (
            request["version"] != PROTOCOL
            or request["bridgeEpoch"] != self.bridge_epoch
            or request["connectionChallenge"] != self.connection_challenge
            or not isinstance(request["deadlineMs"], int) or isinstance(request["deadlineMs"], bool)
            or not now_ms <= request["deadlineMs"] <= now_ms + 60000
            or not isinstance(request["id"], str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request["id"])
            or request["method"] not in METHODS
            or (request["method"] == "prepare" and (not isinstance(request.get("preflightToken"), str) or not 24 <= len(request["preflightToken"]) <= 128 or not isinstance(request.get("confirmation"), str) or not 24 <= len(request["confirmation"]) <= 128 or not isinstance(request.get("idempotencyKey"), str) or not 8 <= len(request["idempotencyKey"]) <= 128))
            or (request["method"] in {"preflight", "prepare"} and (not isinstance(request.get("transactionId"), str) or not 8 <= len(request["transactionId"]) <= 128))
            or (request["method"] == "invoke" and _mutation_authority_required(str(request.get("operation"))) and (not isinstance(request.get("authorityToken"), str) or not 24 <= len(request["authorityToken"]) <= 128 or not isinstance(request.get("transactionId"), str) or not 8 <= len(request["transactionId"]) <= 128))
            or ("ownershipToken" in request and (not isinstance(request["ownershipToken"], str) or not 32 <= len(request["ownershipToken"]) <= 128))
            or (request["method"] == "retire" and (not isinstance(request.get("transactionId"), str) or not 8 <= len(request["transactionId"]) <= 128 or ("terminal" in request and not isinstance(request["terminal"], bool))))
            or not isinstance(request["nonce"], str)
            or not isinstance(request["sequence"], int) or isinstance(request["sequence"], bool)
            or not 1 <= request["sequence"] <= (2**53 - 1)
            or not isinstance(request["mac"], str)
        ):
            return self._error(request.get("id", "invalid"), "invalid request")
        if request["method"] in {"invoke", "preflight", "prepare", "discover"}:
            if request["method"] in {"invoke", "preflight", "prepare"} and (not isinstance(request.get("operation"), str) or not re.fullmatch(r"[a-z]+(?:[.-][a-z]+)+", request["operation"])):
                return self._error(request["id"], "operation is required")
            if not isinstance(request.get("args", {}), dict) or len(request.get("args", {})) > 32:
                return self._error(request["id"], "args must be a bounded object")
        try:
            authenticated = len(request["nonce"]) >= 16 and len(request["nonce"]) <= MAX_NONCE_LENGTH and request["sequence"] > self._last_sequence and hmac.compare_digest(self.sign(unsigned), request["mac"])
        except (TypeError, ValueError):
            authenticated = False
        if not authenticated:
            return self._error(request["id"], "authentication or replay check failed")
        self._last_sequence = request["sequence"]
        try:
            operation_id, operation_request = self._operation_contract(request)
            validate_operation_payload(operation_id, "request", operation_request)
            result = self._operation(request["method"], unsigned)
        except Exception:
            _debug_trace("dispatch-failure")
            return self._error(request["id"], "request failed")
        try:
            validate_operation_payload(operation_id, "result", result)
        except Exception:
            _debug_trace("result-contract-failure")
            self.invalid = True
            return self._error(request["id"], "response contract failed")
        return self._response(request["id"], True, result=result)

    def new_nonce(self) -> str:
        return secrets.token_urlsafe(18)

    def _response(self, request_id: str, ok: bool, result: Any = None, error: str | None = None) -> dict[str, Any]:
        response: dict[str, Any] = {"version": PROTOCOL, "id": request_id, "ok": ok, "bridgeEpoch": self.bridge_epoch, "connectionChallenge": self.connection_challenge}
        if result is not None: response["result"] = result
        if error is not None: response["error"] = error
        response["mac"] = self.sign(response)
        return response

    def _error(self, request_id: str, message: str) -> dict[str, Any]:
        return self._response(request_id if isinstance(request_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request_id) else "invalid", False, error=message)

    def error_response(self, message: str = "malformed request") -> dict[str, Any]:
        return self._error("invalid", message)


class ReferenceRegistry:
    """Epoch-scoped opaque references; references never expose Live objects."""

    def __init__(self) -> None:
        self.epoch = secrets.randbelow(2**53 - 1) + 1
        self._cursor_key = secrets.token_bytes(32)
        self._objects: dict[str, Any] = {}
        self._revisions: dict[str, int] = {}

    def reset(self) -> None:
        self.epoch = secrets.randbelow(2**53 - 1) + 1
        self._cursor_key = secrets.token_bytes(32)
        self._objects.clear()
        self._revisions.clear()

    def put(self, kind: str, obj: Any, key: str) -> str:
        # Live hands out fresh proxy objects per read, so always re-assert the
        # traversal-derived key rather than memoizing by Python proxy identity.
        reference = f"{self.epoch}:{kind}:{key}"
        self._objects[reference] = obj
        self._revisions.setdefault(reference, 1)
        return reference

    def get(self, reference: str) -> Any:
        if not isinstance(reference, str) or not reference.startswith(str(self.epoch) + ":"):
            raise KeyError("stale or invalid reference")
        return self._objects[reference]

    def revision(self, reference: str) -> int:
        self.get(reference)
        return self._revisions[reference]

    def touch(self, reference: str) -> int:
        self.get(reference)
        self._revisions[reference] += 1
        return self._revisions[reference]

    def delete(self, reference: str) -> None:
        self.get(reference)
        self._objects.pop(reference, None)
        self._revisions.pop(reference, None)

    def checkpoint(self) -> tuple[dict[str, Any], dict[str, int]]:
        return dict(self._objects), dict(self._revisions)

    def restore(self, checkpoint: tuple[dict[str, Any], dict[str, int]]) -> None:
        self._objects, self._revisions = dict(checkpoint[0]), dict(checkpoint[1])


class LiveObjectMapper:
    """Small, version-tolerant Live object mapper used only on Live's main thread."""

    _bounded_canonical = staticmethod(AuthenticatedRemoteScript._bounded_canonical)

    def __init__(self, song: Any, registry: ReferenceRegistry | None = None, provenance: str = "fake-live"):
        if provenance not in {"fake-live", "real-live"}:
            raise ValueError("invalid Live provenance")
        self.song = song
        self.refs = registry or ReferenceRegistry()
        self.provenance = provenance
        self._capture_state: dict[str, Any] | None = None
        self._owned_cleanup_tokens: dict[str, dict[str, Any]] = {}
        self._playback_state_digest: str | None = None
        self._playback_revision_counter = 0

    def status(self) -> dict[str, Any]:
        registry, registry_hash = operation_registry()
        operations = [item["id"] for item in registry["operations"] if self._operation_supported(item["id"])]
        return {
            "connected": self.song is not None,
            "adapter": "remote-script" if self.song is not None else "unavailable",
            "epoch": self.refs.epoch if self.song is not None else None,
            "protocol": "ableton-live/v1",
            "capabilities": self.capabilities(set(operations)),
            "registryHash": registry_hash,
            "operations": operations,
            "provenance": self.provenance,
        }

    def _operation_supported(self, operation: str) -> bool:
        """Advertise only operations executable against this observed Live shape."""
        if self.song is None:
            return operation in {"status", "reconnect"}
        if operation in {"status", "snapshot", "discover", "get", "reconnect"}:
            return True
        if operation == "session.playback":
            return True
        if operation == "subscribe":
            return bool(_supported_event_types(self.song) - {"reset"})
        if operation == "transport.set":
            return callable(getattr(self.song, "stop_playing", None)) or hasattr(self.song, "current_song_time")
        if operation == "session.clip-launch":
            return any(getattr(slot, "clip", None) is not None and callable(getattr(slot, "fire", None)) for track in self._items(getattr(self.song, "tracks", [])) for slot in self._items(getattr(track, "clip_slots", [])))
        if operation == "session.clip-stop":
            return any(callable(getattr(track, "stop_all_clips", None)) for track in self._items(getattr(self.song, "tracks", [])))
        if operation == "tempo.set":
            return isinstance(self._read_attr(self.song, "tempo"), (int, float))
        if operation == "session.capture-midi":
            return callable(getattr(self.song, "capture_midi", None)) and not any(getattr(slot, "clip", None) is not None for track in self._items(getattr(self.song, "tracks", [])) for slot in self._items(getattr(track, "clip_slots", [])))
        if operation == "scene.capture":
            return callable(getattr(self.song, "capture_and_insert_scene", None))
        if operation in {"clip.duplicate", "clip.move"}:
            session = any(getattr(slot, "clip", None) is not None and callable(getattr(slot, "duplicate_clip_to", None)) and (operation != "clip.move" or callable(getattr(slot, "delete_clip", None))) for track in self._items(getattr(self.song, "tracks", [])) for slot in self._items(getattr(track, "clip_slots", [])))
            arrangement = operation == "clip.duplicate" and any(getattr(slot, "clip", None) is not None and callable(getattr(track, "duplicate_clip_to_arrangement", None)) for track in self._items(getattr(self.song, "tracks", [])) for slot in self._items(getattr(track, "clip_slots", [])))
            return session or arrangement
        if operation == "arrangement.clip.create":
            return any(callable(getattr(track, "create_midi_clip", None)) for track in self._items(getattr(self.song, "tracks", [])))
        if operation == "arrangement.clip.delete":
            return any(callable(getattr(track, "delete_clip", None)) for track in self._items(getattr(self.song, "tracks", []))) or bool(self._items(getattr(self.song, "arrangement_clips", [])))
        if operation == "arrangement.clip.move":
            return bool(self._arrangement_clip_items())
        if operation == "audio.clip.set":
            return any(self._read_attr(getattr(slot, "clip", None), "is_audio_clip") is True and bool(self._audio_fields(getattr(slot, "clip"))["availableAudioFields"]) for track in self._items(getattr(self.song, "tracks", [])) for slot in self._items(getattr(track, "clip_slots", [])))
        if operation in {"audio.capture.inspect", "audio.capture.start", "audio.capture.stop", "audio.capture.status", "audio.capture.emergency-stop", "audio.capture.cleanup"} and self._capture_state is not None and self._capture_state.get("state") != "cleaned":
            # Recovery authority and the negotiated provider identity must
            # remain advertised while the one destination is occupied or a
            # stop/cleanup is unresolved. Target checks still refuse new work.
            return True
        if operation in {"audio.capture.inspect", "audio.capture.start", "audio.capture.stop", "audio.capture.status", "audio.capture.emergency-stop", "audio.capture.cleanup"}:
            return self._capture_shape_supported()
        if operation == "mixer.set":
            return any(self._read_attr(track, "mixer_device") is not None for track in self._items(getattr(self.song, "tracks", [])))
        if operation in {"automation.envelope.read", "automation.envelope.create", "automation.point.insert", "automation.point.delete"}:
            return any(getattr(slot, "clip", None) is not None and callable(getattr(getattr(slot, "clip", None), "create_automation_envelope", None)) for track in self._items(getattr(self.song, "tracks", [])) for slot in self._items(getattr(track, "clip_slots", [])))
        if operation == "automation.envelope.delete":
            return any(getattr(slot, "clip", None) is not None and callable(getattr(getattr(slot, "clip", None), "clear_envelope", None)) for track in self._items(getattr(self.song, "tracks", [])) for slot in self._items(getattr(track, "clip_slots", [])))
        if operation == "device.insert":
            return any(callable(getattr(track, "insert_device", None)) for track in self._items(getattr(self.song, "tracks", [])))
        if operation == "device.delete":
            return any(callable(getattr(track, "delete_device", None)) for track in self._items(getattr(self.song, "tracks", [])))
        if operation == "device.enable":
            return any(self._device_on_parameter(device) is not None for track in self._items(getattr(self.song, "tracks", [])) for device in self._items(getattr(track, "devices", [])))
        if operation == "device.move":
            return callable(getattr(self.song, "move_device", None))
        if operation in {"browser.search", "browser.inspect", "browser.load"}:
            try:
                browser = self._browser()
                return operation != "browser.load" or callable(getattr(browser, "load_item", None))
            except ValueError:
                return False
        if operation == "track.rename": return any(hasattr(track, "name") for track in self._items(getattr(self.song, "tracks", [])))
        if operation == "scene.rename": return any(hasattr(scene, "name") for scene in self._items(getattr(self.song, "scenes", [])))
        if operation == "clip.rename": return any(hasattr(getattr(slot, "clip", None), "name") for track in self._items(getattr(self.song, "tracks", [])) for slot in self._items(getattr(track, "clip_slots", [])) if getattr(slot, "clip", None) is not None)
        if operation == "device.rename": return any(hasattr(device, "name") for track in self._items(getattr(self.song, "tracks", [])) for device in self._items(getattr(track, "devices", [])))
        if operation == "locator.rename": return any(hasattr(locator, "name") for locator in self._items(getattr(self.song, "cue_points", [])))
        if operation == "routing.set":
            return any(self._read_attr(track, "available_output_routing_types") is not None or self._read_attr(track, "can_be_armed") is True or isinstance(self._read_attr(track, "current_monitoring_state"), int) for track in self._items(getattr(self.song, "tracks", [])))
        if operation in {"recording.session", "recording.arrangement"}:
            tracks = self._items(getattr(self.song, "tracks", []))
            return isinstance(self._read_attr(self.song, "session_record"), bool) and isinstance(self._read_attr(self.song, "record_mode"), bool) and any(isinstance(self._read_attr(track, "arm"), bool) for track in tracks)
        if operation in {"realtime.arm", "realtime.disarm", "realtime.stats"}:
            return getattr(self, "realtime_available", False)
        if operation == "session.audition-launch":
            return any(callable(getattr(scene, "fire", None)) or callable(getattr(scene, "launch", None)) for scene in self._items(getattr(self.song, "scenes", [])))
        if operation in {"session.audition-stop", "session.emergency-stop"}:
            return callable(getattr(self.song, "stop_all_clips", None)) and callable(getattr(self.song, "stop_playing", None))
        if operation == "locator.add" or operation == "locator.delete":
            return self._locator_supported()
        tracks = self._items(getattr(self.song, "tracks", []))
        if operation == "track.create":
            return callable(getattr(self.song, "create_midi_track", None)) and callable(getattr(self.song, "create_audio_track", None))
        if operation == "track.delete":
            return callable(getattr(self.song, "delete_track", None)) and bool(tracks)
        if operation == "scene.create":
            return callable(getattr(self.song, "create_scene", None))
        if operation == "scene.delete":
            return callable(getattr(self.song, "delete_scene", None)) and bool(self._items(getattr(self.song, "scenes", [])))
        if operation == "clip.create":
            return any(bool(getattr(track, "has_midi_input", False)) and any(callable(getattr(slot, "create_clip", None)) for slot in self._items(getattr(track, "clip_slots", []))) for track in tracks)
        if operation == "clip.delete":
            return any(callable(getattr(slot, "delete_clip", None)) and (getattr(slot, "clip", None) is not None or (bool(getattr(track, "has_midi_input", False)) and callable(getattr(slot, "create_clip", None)))) for track in tracks for slot in self._items(getattr(track, "clip_slots", [])))
        if operation in {"note.add", "note.add-batch"}:
            existing_clip_support = any(callable(getattr(getattr(slot, "clip", None), "add_new_notes", None)) for track in tracks for slot in self._items(getattr(track, "clip_slots", [])))
            creatable_midi_slot = any(bool(getattr(track, "has_midi_input", False)) and any(callable(getattr(slot, "create_clip", None)) for slot in self._items(getattr(track, "clip_slots", []))) for track in tracks)
            return existing_clip_support or creatable_midi_slot
        if operation == "note.update":
            return any(callable(getattr(getattr(slot, "clip", None), "apply_note_modifications", None)) and callable(getattr(getattr(slot, "clip", None), "get_notes_extended", None)) for track in tracks for slot in self._items(getattr(track, "clip_slots", [])))
        if operation == "note.delete":
            return any(callable(getattr(getattr(slot, "clip", None), "remove_notes_by_id", None)) for track in tracks for slot in self._items(getattr(track, "clip_slots", [])))
        if operation == "device.parameter.set":
            return any(
                any(device.get("parameters") for device in self._device_items(track, track_index))
                for track_index, track in enumerate(tracks)
            )
        if operation == "arrangement.audio-clip.create":
            return any(callable(getattr(track, "create_audio_clip", None)) for track in tracks)
        if operation == "clip.set":
            clips = [getattr(slot, "clip", None) for track in tracks for slot in self._items(getattr(track, "clip_slots", []))]
            clips += [clip for track in tracks for clip in self._items(self._read_attr(track, "arrangement_clips") or [])]
            return any(clip is not None and (self._read_attr(clip, "muted") is not None or isinstance(self._read_attr(clip, "color_index"), int) or self._read_attr(clip, "looping") is not None) for clip in clips)
        if operation == "locator.jump":
            return callable(getattr(self.song, "jump_to_next_cue", None)) and callable(getattr(self.song, "jump_to_prev_cue", None))
        if operation in {"view.set", "view.control"}:
            try:
                view = getattr(self._application(), "view", None)
            except ValueError:
                return False
            if view is None: return False
            if operation == "view.set": return callable(getattr(view, "show_view", None)) and callable(getattr(view, "is_view_visible", None))
            song_view = getattr(self.song, "view", None)
            return callable(getattr(view, "zoom_view", None)) and callable(getattr(view, "scroll_view", None)) and song_view is not None and self._read_attr(song_view, "follow_song") is not None
        if operation == "session.audio-clip.create":
            return any(not bool(getattr(track, "has_midi_input", False)) and any(callable(getattr(slot, "create_audio_clip", None)) for slot in self._items(getattr(track, "clip_slots", []))) for track in tracks)
        if operation == "clip.action":
            return any(clip is not None and (callable(getattr(clip, "crop", None)) or callable(getattr(clip, "duplicate_loop", None)) or callable(getattr(clip, "start_scrub", None))) for track in tracks for slot in self._items(getattr(track, "clip_slots", [])) for clip in [getattr(slot, "clip", None)])
        if operation == "automation.envelope.clear":
            return any(callable(getattr(getattr(slot, "clip", None), "clear_all_envelopes", None)) for track in tracks for slot in self._items(getattr(track, "clip_slots", [])))
        if operation == "note.read-by-id":
            return any(callable(getattr(getattr(slot, "clip", None), "get_notes_by_id", None)) for track in tracks for slot in self._items(getattr(track, "clip_slots", [])))
        if operation == "note.read-selected":
            return any(callable(getattr(getattr(slot, "clip", None), "get_selected_notes", None)) for track in tracks for slot in self._items(getattr(track, "clip_slots", [])))
        if operation == "note.duplicate":
            return any(callable(getattr(getattr(slot, "clip", None), "duplicate_notes_by_id", None)) for track in tracks for slot in self._items(getattr(track, "clip_slots", [])))
        if operation == "note.quantize":
            return any(callable(getattr(getattr(slot, "clip", None), "quantize", None)) for track in tracks for slot in self._items(getattr(track, "clip_slots", [])))
        if operation in {"audio.warp-marker.read", "audio.warp-marker.add", "audio.warp-marker.move", "audio.warp-marker.delete"}:
            clips = [getattr(slot, "clip", None) for track in tracks for slot in self._items(getattr(track, "clip_slots", []))]
            clips += [clip for track in tracks for clip in self._items(self._read_attr(track, "arrangement_clips") or [])]
            audio_clips = [clip for clip in clips if clip is not None and self._read_attr(clip, "is_audio_clip") is True]
            if operation == "audio.warp-marker.read": return any(self._read_attr(clip, "warp_markers") is not None for clip in audio_clips)
            method = {"audio.warp-marker.add": "add_warp_marker", "audio.warp-marker.move": "move_warp_marker", "audio.warp-marker.delete": "remove_warp_marker"}[operation]
            return any(callable(getattr(clip, method, None)) for clip in audio_clips)
        if operation == "audio.take-lane.read":
            return any(self._read_attr(track, "take_lanes") is not None for track in tracks)
        if operation == "take-lane.create":
            return any(callable(getattr(track, "create_take_lane", None)) for track in tracks)
        if operation == "take-lane.rename":
            return any(hasattr(lane, "name") for track in tracks for lane in self._items(self._read_attr(track, "take_lanes") or []))
        if operation == "take-lane.clip.create":
            return any(callable(getattr(lane, "create_midi_clip", None)) for track in tracks for lane in self._items(self._read_attr(track, "take_lanes") or []))
        if operation == "take-lane.audio-clip.create":
            return any(callable(getattr(lane, "create_audio_clip", None)) for track in tracks for lane in self._items(self._read_attr(track, "take_lanes") or []))
        if operation == "tuning.read":
            return getattr(self.song, "tuning_system", None) is not None or self._read_attr(self.song, "root_note") is not None or self._read_attr(self.song, "scale_name") is not None
        if operation == "tuning.set":
            tuning = getattr(self.song, "tuning_system", None)
            return tuning is not None and (self._read_attr(tuning, "reference_pitch") is not None or self._read_attr(self.song, "root_note") is not None)
        if operation == "groove.read":
            return getattr(self.song, "groove_pool", None) is not None or self._read_attr(self.song, "groove_amount") is not None
        if operation == "groove.set":
            return isinstance(self._read_attr(self.song, "groove_amount"), (int, float)) and not isinstance(self._read_attr(self.song, "groove_amount"), bool)
        if operation == "groove.edit":
            pool = getattr(self.song, "groove_pool", None)
            return any(self._read_attr(groove, "name") is not None for groove in self._items(self._read_attr(pool, "grooves") or [])) if pool is not None else False
        if operation == "scene.set":
            return any(self._read_attr(scene, "color_index") is not None or self._read_attr(scene, "tempo") is not None for scene in self._items(getattr(self.song, "scenes", [])))
        if operation == "scene.fire-selected":
            return any(callable(getattr(scene, "fire_as_selected", None)) for scene in self._items(getattr(self.song, "scenes", [])))
        if operation == "song.read":
            return True
        if operation == "transport.action":
            song = self.song
            return any(callable(getattr(song, name, None)) for name in ("start_playing", "continue_playing", "stop_playing", "play_selection", "tap_tempo", "nudge_up", "nudge_down", "re_enable_automation", "force_link_beat_time"))
        if operation == "locator.jump-to":
            return self._locator_supported() and any(callable(getattr(locator, "jump", None)) for locator in self._items(getattr(self.song, "cue_points", [])))
        if operation == "song.time-convert":
            song = self.song
            return callable(getattr(song, "get_beats_loop_time", None)) or callable(getattr(song, "get_smpte_loop_time", None))
        if operation == "track.create-return":
            return callable(getattr(self.song, "create_return_track", None))
        if operation == "track.delete-return":
            return callable(getattr(self.song, "delete_return_track", None)) and bool(self._items(getattr(self.song, "return_tracks", [])))
        if operation == "track.duplicate":
            return callable(getattr(self.song, "duplicate_track", None)) and bool(self._items(getattr(self.song, "tracks", [])))
        if operation == "scene.duplicate":
            return callable(getattr(self.song, "duplicate_scene", None)) and bool(self._items(getattr(self.song, "scenes", [])))
        if operation == "track.view.set":
            return any(getattr(track, "view", None) is not None and (self._read_attr(getattr(track, "view", None), "is_collapsed") is not None or self._read_attr(getattr(track, "view", None), "device_insert_mode") is not None) for track in tracks)
        if operation == "track.select-instrument":
            return any(callable(getattr(getattr(track, "view", None), "select_instrument", None)) for track in tracks)
        if operation == "selection.set":
            return getattr(self.song, "view", None) is not None
        if operation == "song.view.set":
            return self._read_attr(getattr(self.song, "view", None), "draw_mode") is not None
        if operation == "clip.view.set":
            return any(getattr(getattr(slot, "clip", None), "view", None) is not None for track in tracks for slot in self._items(getattr(track, "clip_slots", [])))
        if operation == "device.view.set":
            return any(getattr(device, "view", None) is not None for track in tracks for device in self._items(getattr(track, "devices", [])))
        if operation == "application.dialog":
            try:
                application = self._application()
            except ValueError:
                return False
            return callable(getattr(application, "get_dialog_state", None)) or callable(getattr(application, "press_dialog_button", None))
        if operation == "performance.read":
            return True
        return False

    def capabilities(self, operations: set[str] | None = None) -> list[str]:
        if self.song is None:
            return []
        supports = (lambda operation: operation in operations) if operations is not None else self._operation_supported
        capabilities = ["reconnect"]
        if supports("snapshot") and supports("discover") and supports("get"):
            capabilities.extend(("session.read", "tracks", "scenes", "clips", "session.discovery"))
        structure_operations = {"track.create", "track.delete", "scene.create", "scene.delete"}
        if any(supports(item) for item in structure_operations): capabilities.append("session.structure")
        if supports("clip.create"): capabilities.append("session.midi_clip.create")
        if supports("clip.delete"): capabilities.append("session.midi_clip.delete")
        if any(supports(item) for item in {"note.add", "note.add-batch", "note.update", "note.delete"}): capabilities.extend(("notes", "session.midi_note.read"))
        if supports("note.add") and supports("note.add-batch"): capabilities.append("session.midi_note.write")
        if supports("transport.set") and supports("tempo.set"): capabilities.append("transport")
        if supports("subscribe"): capabilities.append("subscriptions")
        if self._locator_supported() or supports("arrangement.clip.delete"): capabilities.append("arrangement.read")
        if self._locator_supported() or supports("arrangement.clip.create") or supports("arrangement.clip.delete"): capabilities.append("arrangement.write")
        tracks = self._items(getattr(self.song, "tracks", []))
        device_objects = [device for track in tracks for device in self._items(getattr(track, "devices", []))]
        # Shallow attribute traversal is enough for status and avoids building
        # the full recursive device graph on every capability refresh.
        cursor = 0
        while cursor < len(device_objects) and len(device_objects) < 512:
            device = device_objects[cursor]; cursor += 1
            for chain in self._items(self._read_attr(device, "chains") or []):
                for nested in self._items(self._read_attr(chain, "devices") or []):
                    if len(device_objects) >= 512: break
                    device_objects.append(nested)
                if len(device_objects) >= 512: break
        if device_objects:
            capabilities.append("devices")
            if any(self._items(getattr(device, "parameters", [])) for device in device_objects): capabilities.append("parameters")
            if supports("device.parameter.set"): capabilities.append("device.parameter.write")
            if any(self._read_attr(item, "can_have_chains") is True for item in device_objects): capabilities.extend(("racks", "chains"))
            class_names = [str(self._read_attr(item, "class_name") or item.__class__.__name__).lower() for item in device_objects]
            if any(any(marker in name for marker in ("plugin", "vst", "audio_unit")) for name in class_names): capabilities.append("plugins")
        if supports("audio.clip.set"): capabilities.append("audio")
        if supports("audio.warp-marker.read"): capabilities.append("warp")
        if supports("audio.take-lane.read"): capabilities.append("takes")
        if supports("tuning.read"): capabilities.append("tuning")
        if supports("groove.read"): capabilities.append("groove")
        if supports("audio.capture.inspect") and supports("audio.capture.start") and supports("audio.capture.stop") and supports("audio.capture.cleanup"): capabilities.append("audio.capture.resampling")
        if supports("automation.envelope.read"): capabilities.append("automation")
        if supports("view.set") or supports("view.control"): capabilities.append("view")
        if supports("browser.search"): capabilities.append("browser")
        if supports("routing.set"): capabilities.append("routing")
        if supports("recording.session") or supports("recording.arrangement"): capabilities.append("recording")
        if supports("mixer.set"): capabilities.append("mixing")
        if isinstance(self._read_attr(self.song, "file_path"), str): capabilities.append("projects")
        if getattr(self, "realtime_available", False): capabilities.extend(("osc", "realtime.events"))
        return list(dict.fromkeys(capabilities))

    def _locator_supported(self) -> bool:
        return hasattr(self.song, "cue_points") and callable(getattr(self.song, "set_or_delete_cue", None))

    def _locator_items(self) -> list[dict[str, Any]]:
        if not self._locator_supported():
            return []
        result = []; native_locators = self._items(getattr(self.song, "cue_points", []))
        if len(native_locators) > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("locator collection exceeds its complete-state bound")
        for index, locator in enumerate(native_locators):
            position = getattr(locator, "time", getattr(locator, "position", None))
            if not isinstance(position, (int, float)) or isinstance(position, bool) or not math.isfinite(float(position)): raise ValueError("locator collection contains an unreadable item")
            name = getattr(locator, "name", "")
            reference = self.refs.put("locator", locator, str(index))
            result.append({"ref": reference, "objectIdentity": self._capture_object_identity(locator), "name": str(name), "position": float(position)})
        return result

    def _track_kind(self, track: Any) -> str:
        """Read Live's track class without treating a missing property as truth."""
        value = getattr(track, "kind", getattr(track, "track_kind", None))
        if isinstance(value, str) and value.lower() in {"regular", "midi", "audio"}:
            return "regular"
        if bool(getattr(track, "is_foldable", False)) or "group" in track.__class__.__name__.lower():
            return "group"
        if bool(getattr(track, "is_return", False)) or "return" in track.__class__.__name__.lower():
            return "return"
        if bool(getattr(track, "is_master", False)) or "master" in track.__class__.__name__.lower():
            return "main"
        return "regular"

    @staticmethod
    def _authoritative(value: Any, predicate: Callable[[Any], bool]) -> Any:
        return value if predicate(value) else None

    @staticmethod
    def _monitoring_state(value: Any) -> str | None:
        if isinstance(value, bool) or value is None: return None
        if isinstance(value, int): return {0: "in", 1: "auto", 2: "off"}.get(value)
        if isinstance(value, str):
            normalized = value.strip().lower().replace("_", "-")
            return normalized if normalized in {"in", "auto", "off"} else None
        return None

    @staticmethod
    def _slot_index(value: Any) -> int | None:
        return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None

    _QUANTIZATION_NAMES = {0: "none", 1: "8-bars", 2: "4-bars", 3: "2-bars", 4: "1-bar", 5: "1/2", 6: "1/2T", 7: "1/4", 8: "1/4T", 9: "1/8", 10: "1/8T", 11: "1/16", 12: "1/16T", 13: "1/32"}
    _QUANTIZATION_ALIASES = {"q-bar": "1-bar", "q-2-bars": "2-bars", "q-4-bars": "4-bars", "q-8-bars": "8-bars", "q-no-q": "none", "q-half": "1/2", "q-half-t": "1/2T", "q-quarter": "1/4", "q-quarter-t": "1/4T", "q-8": "1/8", "q-8-t": "1/8T", "q-16": "1/16", "q-16-t": "1/16T", "q-32": "1/32"}

    @staticmethod
    def _quantization(value: Any) -> dict[str, Any]:
        if isinstance(value, bool) or value is None:
            raw = None
        elif isinstance(value, int):
            raw = int(value)
        elif isinstance(value, float):
            raw = value if math.isfinite(value) else None
        elif isinstance(value, str):
            raw = value
        else:
            raw = None
        if isinstance(raw, str):
            normalized = raw.strip().lower().replace("_", "-").replace(" ", "-") or None
            if normalized is not None:
                normalized = LiveObjectMapper._QUANTIZATION_ALIASES.get(normalized, normalized)
        elif isinstance(raw, int):
            normalized = LiveObjectMapper._QUANTIZATION_NAMES.get(raw, str(raw))
        elif isinstance(raw, float):
            normalized = str(raw)
        else:
            normalized = None
        return {"raw": raw, "normalized": normalized}

    def _transport_dict(self) -> dict[str, Any]:
        return {
            "playing": getattr(self.song, "is_playing", None) if isinstance(getattr(self.song, "is_playing", None), bool) else None,
            "arrangementRecord": getattr(self.song, "record_mode", None) if isinstance(getattr(self.song, "record_mode", None), bool) else None,
            "sessionRecord": getattr(self.song, "session_record", None) if isinstance(getattr(self.song, "session_record", None), bool) else None,
            "position": float(getattr(self.song, "current_song_time", getattr(self.song, "song_time", 0))) if isinstance(getattr(self.song, "current_song_time", getattr(self.song, "song_time", None)), (int, float)) and not isinstance(getattr(self.song, "current_song_time", getattr(self.song, "song_time", None)), bool) and math.isfinite(float(getattr(self.song, "current_song_time", getattr(self.song, "song_time", 0)))) and float(getattr(self.song, "current_song_time", getattr(self.song, "song_time", 0))) >= 0 else None,
            "launchQuantization": self._quantization(getattr(self.song, "clip_trigger_quantization", getattr(self.song, "launch_quantization", None))),
            "loop": {
                "enabled": self._read_attr(self.song, "loop") if isinstance(self._read_attr(self.song, "loop"), bool) else None,
                "start": float(self._read_attr(self.song, "loop_start")) if isinstance(self._read_attr(self.song, "loop_start"), (int, float)) and not isinstance(self._read_attr(self.song, "loop_start"), bool) and math.isfinite(float(self._read_attr(self.song, "loop_start"))) else None,
                "length": float(self._read_attr(self.song, "loop_length")) if isinstance(self._read_attr(self.song, "loop_length"), (int, float)) and not isinstance(self._read_attr(self.song, "loop_length"), bool) and math.isfinite(float(self._read_attr(self.song, "loop_length"))) else None,
            },
            "punchIn": self._read_attr(self.song, "punch_in") if isinstance(self._read_attr(self.song, "punch_in"), bool) else None,
            "punchOut": self._read_attr(self.song, "punch_out") if isinstance(self._read_attr(self.song, "punch_out"), bool) else None,
            "metronome": self._read_attr(self.song, "metronome") if isinstance(self._read_attr(self.song, "metronome"), bool) else None,
            "countIn": float(self._read_attr(self.song, "count_in_duration")) if isinstance(self._read_attr(self.song, "count_in_duration"), (int, float)) and not isinstance(self._read_attr(self.song, "count_in_duration"), bool) and math.isfinite(float(self._read_attr(self.song, "count_in_duration"))) else None,
        }

    def _playback(self, track_rows: list[dict[str, Any]] | None = None, scene_rows: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        if track_rows is None or scene_rows is None:
            snapshot = self.snapshot()
            return snapshot["playback"]
        transport = self._transport_dict()
        fired: list[dict[str, Any]] = []
        playing: list[dict[str, Any]] = []
        for track in track_rows:
            for field, destination in (("firedSlotIndex", fired), ("playingSlotIndex", playing)):
                index = track.get(field)
                if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(scene_rows): continue
                slot = next((item for item in track.get("clipSlots", []) if item.get("sceneIndex") == index), None)
                if slot is None: continue
                destination.append({"trackRef": track["ref"], "clipSlotRef": slot["ref"], "sceneRef": scene_rows[index]["ref"], "sceneIndex": index, "clipRef": slot.get("clipRef")})
        fired.sort(key=lambda item: (item["sceneIndex"], item["trackRef"], item["clipSlotRef"]))
        playing.sort(key=lambda item: (item["sceneIndex"], item["trackRef"], item["clipSlotRef"]))
        # Position drifts continuously while playing and is verified by
        # postcondition instead of revision; it is not a fencing input.
        revision_transport = {key: value for key, value in transport.items() if key != "position"}
        revision_payload = {"transport": revision_transport, "firedTargets": fired, "playingTargets": playing}
        state_digest = hashlib.sha256(json.dumps(revision_payload, sort_keys=True, separators=(',', ':')).encode("utf-8")).hexdigest()
        # Include an observed-state generation so A -> B -> A cannot reuse the
        # first A revision. Repeated reads of an unchanged state remain stable.
        if state_digest != self._playback_state_digest:
            self._playback_revision_counter += 1
            self._playback_state_digest = state_digest
        revision = f"{self.refs.epoch}:playback:{self._playback_revision_counter}:{state_digest[:16]}"
        return {"ref": self.refs.put("session_playback", self.song, "playback"), "epoch": self.refs.epoch, "revision": revision, "transport": transport, "firedTargets": fired, "playingTargets": playing}

    def _cursor(self, offset: int, revision: str) -> str:
        payload = f"{self.refs.epoch}|{revision}|{offset}".encode("ascii")
        tag = hmac.new(self.refs._cursor_key, payload, hashlib.sha256).hexdigest()[:24]
        return base64.urlsafe_b64encode(payload + b":" + tag.encode("ascii")).decode("ascii").rstrip("=")

    def _cursor_offset(self, cursor: str, revision: str) -> int:
        try:
            raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
            encoded = raw.decode("ascii")
            payload_text, tag = encoded.rsplit(":", 1)
            epoch, actual_revision, offset_text = payload_text.split("|", 2)
            payload = payload_text.encode("ascii")
            expected = hmac.new(self.refs._cursor_key, payload, hashlib.sha256).hexdigest()[:24]
            if not hmac.compare_digest(tag, expected) or int(epoch) != self.refs.epoch or actual_revision != revision:
                raise ValueError("stale discovery cursor")
            offset = int(offset_text)
        except (ValueError, TypeError, UnicodeError, OSError) as error:
            raise ValueError("invalid discovery cursor") from error
        if not 0 <= offset <= MAX_DISCOVERY_COLLECTION_LENGTH * MAX_DISCOVERY_COLLECTION_LENGTH:
            raise ValueError("invalid discovery cursor")
        return offset

    def _audio_fields(self, clip: Any) -> dict[str, Any]:
        """Audio-specific clip properties, honestly null when unavailable."""
        def finite(name: str) -> float | None:
            value = self._read_attr(clip, name)
            return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) else None
        is_audio = self._read_attr(clip, "is_audio_clip")
        if is_audio is False:
            return {
                "isAudio": False,
                "gain": None, "pitchCoarse": None, "pitchFine": None,
                "warpMode": None, "warping": None,
                "fadeInLength": None, "fadeOutLength": None,
                "loopStart": None, "loopEnd": None, "startMarker": None, "endMarker": None,
                "filePath": None, "availableAudioFields": [], "warpMarkers": [],
                "warpMarkerEditingAvailable": False,
            }
        warp_mode = self._read_attr(clip, "warp_mode")
        if isinstance(warp_mode, int) and not isinstance(warp_mode, bool):
            warp = int(warp_mode)
        elif isinstance(warp_mode, str):
            warp = warp_mode
        else:
            warp = None
        file_path = self._read_attr(clip, "file_path")
        values = {
            "isAudio": bool(is_audio) if isinstance(is_audio, bool) else None,
            "gain": finite("gain"), "pitchCoarse": finite("pitch_coarse"), "pitchFine": finite("pitch_fine"),
            "warpMode": warp, "warping": self._read_attr(clip, "warping") if isinstance(self._read_attr(clip, "warping"), bool) else None,
            "fadeInLength": finite("fade_in_length"), "fadeOutLength": finite("fade_out_length"),
            "loopStart": finite("loop_start"), "loopEnd": finite("loop_end"), "startMarker": finite("start_marker"), "endMarker": finite("end_marker"),
            "filePath": str(file_path) if isinstance(file_path, str) and file_path else None,
        }
        values["availableAudioFields"] = [field for field in ("gain", "pitchCoarse", "pitchFine", "warpMode", "warping", "fadeInLength", "fadeOutLength", "loopStart", "loopEnd") if values.get(field) is not None]
        available_warp_modes = self._read_attr(clip, "available_warp_modes")
        values["availableWarpModes"] = [int(mode) for mode in self._items(available_warp_modes) if isinstance(mode, int) and not isinstance(mode, bool)][:32] if available_warp_modes is not None else None
        sample_length = self._read_attr(clip, "sample_length")
        values["sampleLength"] = float(sample_length) if isinstance(sample_length, (int, float)) and not isinstance(sample_length, bool) and math.isfinite(float(sample_length)) else None
        try:
            markers = list(getattr(clip, "warp_markers", None) or [])
        except Exception as error:
            raise ValueError("complete warp-marker collection is unreadable") from error
        if len(markers) > 256:
            raise ValueError("complete warp-marker content exceeds its authoritative bound")
        marker_rows = []
        for marker in markers:
            beat_time = self._read_attr(marker, "beat_time"); sample_time = self._read_attr(marker, "sample_time")
            if not all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) for value in (beat_time, sample_time)):
                raise ValueError("complete warp-marker content is unreadable")
            marker_rows.append({"beatTime": float(beat_time), "sampleTime": float(sample_time)})
        values["warpMarkers"] = marker_rows
        values["warpMarkerEditingAvailable"] = False
        return values

    def _clip_content_fingerprint(self, clip: Any) -> str:
        length = self._read_attr(clip, "length")
        if not isinstance(length, (int, float)) or isinstance(length, bool) or not math.isfinite(float(length)) or float(length) < 0: raise ValueError("clip content length is unavailable")
        notes = [{key: value for key, value in note.items() if key != "id"} for note in self._read_notes(clip)]; notes.sort(key=self._bounded_canonical)
        if len(self._items(self._read_attr(clip, "warp_markers") or [])) > 256: raise ValueError("complete warp-marker content exceeds its authoritative move bound")
        row = {"name": str(self._read_attr(clip, "name") or ""), "length": float(length), "kind": "midi" if callable(getattr(clip, "add_new_notes", None)) else "audio", "notes": notes, "audio": self._audio_fields(clip)}
        return hashlib.sha256(self._bounded_canonical(row).encode("utf-8")).hexdigest()

    def _arrangement_clip_row(self, track: Any, clip: Any, track_index: int, clip_index: int) -> dict[str, Any]:
        track_ref = self.refs.put("track", track, str(track_index)); reference = self.refs.put("arrangement_clip", clip, f"{track_index}:{clip_index}"); notes = self._read_notes(clip)
        row = {"ref": reference, "objectIdentity": self._capture_object_identity(clip), "parentRef": track_ref, "trackRef": track_ref, "name": str(getattr(clip, "name", "")), "kind": "midi" if hasattr(clip, "add_new_notes") else "audio", "start": float(getattr(clip, "start_time", getattr(clip, "start", 0.0)) or 0.0), "length": float(getattr(clip, "length", 0.0) or 0.0), "notes": notes, "notesRevision": hashlib.sha256(self._bounded_canonical(notes).encode("utf-8")).hexdigest(), **self._audio_fields(clip)}
        for key, value in self._clip_state_fields(clip).items():
            if value is not None or key not in row: row[key] = value
        return row

    def _arrangement_clip_items(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        song_level = self._items(getattr(self.song, "arrangement_clips", []))
        if song_level:
            for index, clip in enumerate(song_level):
                reference = self.refs.put("arrangement_clip", clip, str(index)); notes = self._read_notes(clip)
                rows.append({
                    "ref": reference,
                    "objectIdentity": self._capture_object_identity(clip),
                    "parentRef": self.refs.put("set", self.song, "song"),
                    "trackRef": None,
                    "name": str(getattr(clip, "name", "")),
                    "kind": "midi" if hasattr(clip, "add_new_notes") else "audio",
                    "start": float(getattr(clip, "start_time", getattr(clip, "start", 0.0)) or 0.0),
                    "length": float(getattr(clip, "length", 0.0) or 0.0),
                    "notes": notes,
                    "notesRevision": hashlib.sha256(self._bounded_canonical(notes).encode("utf-8")).hexdigest(),
                    **self._audio_fields(clip),
                })
            return rows
        for track_index, track in enumerate(self._items(getattr(self.song, "tracks", [])) + self._items(getattr(self.song, "return_tracks", []))):
            track_ref = self.refs.put("track", track, str(track_index))
            for clip_index, clip in enumerate(self._items(self._read_attr(track, "arrangement_clips") or [])):
                rows.append(self._arrangement_clip_row(track, clip, track_index, clip_index))
        return rows

    def _device_items(self, track: Any, track_index: int) -> list[dict[str, Any]]:
        devices = self._items(getattr(track, "devices", getattr(track, "device_chain", [])))
        if len(devices) > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("device collection exceeds its bound")
        rows: list[dict[str, Any]] = []; track_ref = self.refs.put("track", track, str(track_index)); traversal: dict[str, Any] = {"count": 0, "seen": set()}
        for index, device in enumerate(devices):
            device_ref = self.refs.put("device", device, f"{track_index}:{index}")
            rows.append(self._device_row(device, device_ref, track_ref, track_index, f"{track_index}:{index}", index, traversal, 0))
        return rows

    def _flatten_device_rows(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        flattened: list[dict[str, Any]] = []; seen: set[str] = set()
        def visit(device: dict[str, Any], depth: int = 0) -> None:
            reference = str(device.get("ref", ""))
            if depth > 32 or not reference or reference in seen or len(flattened) >= MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("device row hierarchy is cyclic, ambiguous, or exceeds its bound")
            seen.add(reference); flattened.append(device)
            for chain in device.get("chains", []):
                for nested in chain.get("devices", []): visit(nested, depth + 1)
            for pad in device.get("drumPads", []):
                for chain in pad.get("chains", []):
                    for nested in chain.get("devices", []): visit(nested, depth + 1)
        for row in rows: visit(row)
        return flattened

    def _device_row(self, device: Any, device_ref: str, track_ref: str, track_index: int, path: str, index: int, traversal: dict[str, Any], depth: int) -> dict[str, Any]:
        identity = self._capture_object_identity(device); seen = traversal["seen"]
        if depth > 32 or identity in seen: raise ValueError("device hierarchy is cyclic or identity-ambiguous")
        seen.add(identity); traversal["count"] += 1
        if traversal["count"] > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("device hierarchy exceeds its traversal bound")
        parameters: list[dict[str, Any]] = []; native_parameters = self._items(getattr(device, "parameters", []))
        if len(native_parameters) > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("device parameter collection exceeds its complete-state bound")
        for parameter_index, parameter in enumerate(native_parameters):
            minimum = self._read_attr(parameter, "min", "min_value")
            maximum = self._read_attr(parameter, "max", "max_value")
            value = self._read_attr(parameter, "value")
            numeric = (minimum, maximum, value)
            if any(not isinstance(item, (int, float)) or isinstance(item, bool) or not math.isfinite(float(item)) for item in numeric):
                continue
            parameter_ref = self.refs.put("parameter", parameter, f"{device_ref}:{parameter_index}")
            display = self._read_attr(parameter, "display_value")
            if display is None:
                display = self._read_attr(parameter, "str_for_value")
                if callable(display):
                    try:
                        display = display(value)
                    except Exception:
                        display = value
                if display is None:
                    display = value
            parameters.append({
                "ref": parameter_ref, "parentRef": device_ref, "objectIdentity": self._capture_object_identity(parameter),
                "name": str(self._read_attr(parameter, "name") or f"Parameter {parameter_index + 1}"),
                "value": float(value), "min": float(minimum), "max": float(maximum),
                "quantization": float(self._read_attr(parameter, "quantization") or 0),
                "enabled": bool(self._read_attr(parameter, "is_enabled", "enabled") if self._read_attr(parameter, "is_enabled", "enabled") is not None else True),
                "automatable": bool(self._read_attr(parameter, "is_automatable", "automatable") if self._read_attr(parameter, "is_automatable", "automatable") is not None else True),
                "automationState": str(self._read_attr(parameter, "automation_state") or "none"),
                "displayValue": str(display), "revision": self.refs.revision(parameter_ref),
            })
        enabled = self._read_attr(device, "is_active", "is_enabled", "enabled")
        row: dict[str, Any] = {
            "ref": device_ref, "parentRef": track_ref, "chainPosition": index,
            "objectIdentity": self._capture_object_identity(device),
            "className": str(self._read_attr(device, "class_name") or device.__class__.__name__),
            "name": str(self._read_attr(device, "name") or "Device"),
            "kind": "rack" if self._read_attr(device, "can_have_chains") is True else "device",
            "enabled": bool(enabled) if isinstance(enabled, bool) else None,
            "canHaveChains": self._read_attr(device, "can_have_chains") if isinstance(self._read_attr(device, "can_have_chains"), bool) else None,
            "canHaveDrumPads": self._read_attr(device, "can_have_drum_pads") if isinstance(self._read_attr(device, "can_have_drum_pads"), bool) else None,
            "latencySamples": int(self._read_attr(device, "latency_in_samples")) if isinstance(self._read_attr(device, "latency_in_samples"), int) and not isinstance(self._read_attr(device, "latency_in_samples"), bool) else None,
            "latencyMs": float(self._read_attr(device, "latency_in_ms")) if isinstance(self._read_attr(device, "latency_in_ms"), (int, float)) and not isinstance(self._read_attr(device, "latency_in_ms"), bool) and math.isfinite(float(self._read_attr(device, "latency_in_ms"))) else None,
            "parameters": parameters,
        }
        if row["canHaveChains"] is True:
            row["chains"] = self._chain_rows(device, device_ref, track_index, path, traversal, depth)
            row["chainSelector"] = self._read_attr(device, "chain_selector")
            macros = self._items(self._read_attr(device, "macros") or [])
            if len(macros) > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("device macro collection exceeds its bound")
            row["macros"] = [{"ref": self.refs.put("parameter", macro, f"{device_ref}:macro:{macro_index}"), "objectIdentity": self._capture_object_identity(macro), "name": str(self._read_attr(macro, "name") or f"Macro {macro_index + 1}"), "value": self._read_attr(macro, "value")} for macro_index, macro in enumerate(macros)]
            row["variationCount"] = len(self._items(self._read_attr(device, "variations") or []))
        if row["canHaveDrumPads"] is True:
            row["drumPads"] = self._drum_pad_rows(device, device_ref, track_index, path, traversal, depth)
        return row

    def _chain_rows(self, parent: Any, parent_ref: str, track_index: int, path: str, traversal: dict[str, Any], depth: int) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []; chains = self._items(self._read_attr(parent, "chains") or [])
        if len(chains) > MAX_WIRE_ARRAY_LENGTH: raise ValueError("device chain collection exceeds its wire bound")
        for chain_index, chain in enumerate(chains):
            chain_ref = self.refs.put("chain", chain, f"{path}:{chain_index}")
            chain_devices: list[dict[str, Any]] = []; devices = self._items(self._read_attr(chain, "devices") or [])
            if len(devices) > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("chain device collection exceeds its bound")
            for device_index, device in enumerate(devices):
                nested_ref = self.refs.put("device", device, f"{path}:{chain_index}:{device_index}")
                chain_devices.append(self._device_row(device, nested_ref, chain_ref, track_index, f"{path}:{chain_index}:{device_index}", device_index, traversal, depth + 1))
            mute = self._read_attr(chain, "mute")
            solo = self._read_attr(chain, "solo")
            rows.append({
                "ref": chain_ref, "parentRef": parent_ref, "index": chain_index, "objectIdentity": self._capture_object_identity(chain),
                "name": str(self._read_attr(chain, "name") or f"Chain {chain_index + 1}"),
                "mute": bool(mute) if isinstance(mute, bool) else None,
                "solo": bool(solo) if isinstance(solo, bool) else None,
                "devices": chain_devices,
            })
        return rows

    def _drum_pad_rows(self, device: Any, device_ref: str, track_index: int, path: str, traversal: dict[str, Any], depth: int) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        pads = self._items(self._read_attr(device, "visible_drum_pads") or self._read_attr(device, "drum_pads") or [])
        if len(pads) > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("drum-pad collection exceeds its bound")
        for pad_index, pad in enumerate(pads):
            pad_ref = self.refs.put("drum_pad", pad, f"{path}:{pad_index}")
            mute = self._read_attr(pad, "mute")
            rows.append({
                "ref": pad_ref, "parentRef": device_ref, "index": pad_index,
                "name": str(self._read_attr(pad, "name") or f"Pad {pad_index + 1}"),
                "mute": bool(mute) if isinstance(mute, bool) else None,
                "chains": self._chain_rows(pad, pad_ref, track_index, f"{path}:{pad_index}", traversal, depth),
            })
        return rows

    @staticmethod
    def _items(value: Any) -> list[Any]:
        try:
            return list(value or [])
        except (TypeError, AttributeError):
            return []

    def _all_track_objects(self) -> list[Any]:
        tracks = self._items(getattr(self.song, "tracks", [])) + self._items(getattr(self.song, "return_tracks", [])); main = getattr(self.song, "master_track", getattr(self.song, "main_track", None))
        return tracks + ([main] if main is not None else [])

    @staticmethod
    def _read_attr(obj: Any, *names: str) -> Any:
        """Read the first available non-None attribute, treating Live's
        per-shape RuntimeError on unsupported properties as unavailable."""
        for name in names:
            try:
                value = getattr(obj, name, None)
            except Exception:
                continue
            if value is not None:
                return value
        return None

    def snapshot(self) -> dict[str, Any]:
        set_ref = self.refs.put("set", self.song, "song")
        set_row: dict[str, Any] = {"ref": set_ref, "objectIdentity": self._capture_object_identity(self.song), "name": str(getattr(self.song, "name", "Live Set"))}
        file_path = getattr(self.song, "file_path", None)
        if isinstance(file_path, str) and file_path:
            set_row["filePath"] = file_path
        tempo = getattr(self.song, "tempo", None)
        if isinstance(tempo, (int, float)) and not isinstance(tempo, bool) and math.isfinite(float(tempo)):
            set_row["tempo"] = float(tempo)
        position = getattr(self.song, "current_song_time", getattr(self.song, "song_time", None))
        if isinstance(position, (int, float)) and not isinstance(position, bool) and math.isfinite(float(position)) and float(position) >= 0:
            set_row["position"] = float(position)
        playing = getattr(self.song, "is_playing", None)
        if isinstance(playing, bool):
            set_row["playing"] = playing
        loop_row: dict[str, Any] = {}
        loop_enabled = getattr(self.song, "loop", None)
        loop_length = getattr(self.song, "loop_length", None)
        if isinstance(loop_enabled, bool):
            loop_row["enabled"] = loop_enabled
        if isinstance(loop_length, (int, float)) and not isinstance(loop_length, bool) and math.isfinite(float(loop_length)) and float(loop_length) > 0:
            loop_row["length"] = float(loop_length)
        if loop_row:
            set_row["loop"] = loop_row
        # Song exposes regular/group, return, and main tracks separately; the
        # authoritative collection determines kind rather than shape heuristics.
        track_entries: list[tuple[Any, str]] = []
        for track in self._items(getattr(self.song, "tracks", [])):
            track_entries.append((track, self._track_kind(track) if self._track_kind(track) == "group" else "regular"))
        for track in self._items(getattr(self.song, "return_tracks", [])):
            track_entries.append((track, "return"))
        main_track = getattr(self.song, "master_track", getattr(self.song, "main_track", None))
        if main_track is not None:
            track_entries.append((main_track, "main"))
        scenes = self._items(getattr(self.song, "scenes", []))
        track_rows = []
        for index, (track, track_kind) in enumerate(track_entries):
            track_ref = self.refs.put("track", track, str(index))
            slots = self._items(getattr(track, "clip_slots", []))
            clips = []
            slot_rows = []
            for slot_index, slot in enumerate(slots):
                clip = getattr(slot, "clip", None)
                slot_ref = self.refs.put("clip_slot", slot, f"{index}:{slot_index}")
                if clip is None:
                    slot_rows.append({"ref": slot_ref, "parentRef": track_ref, "trackRef": track_ref, "objectIdentity": self._capture_object_identity(slot), "sceneIndex": slot_index, "empty": True, **self._slot_state_fields(slot)})
                    continue
                clip_ref = self.refs.put("clip", clip, f"{index}:{slot_index}")
                notes = self._read_notes(clip)
                clip_row = {"ref": clip_ref, "parentRef": slot_ref, "objectIdentity": self._capture_object_identity(clip), "name": str(getattr(clip, "name", "")), "kind": "midi" if hasattr(clip, "add_new_notes") else "audio", "start": slot_index * 4, "length": float(getattr(clip, "length", 0.0)), "notes": notes, "notesRevision": hashlib.sha256(self._bounded_canonical(notes).encode("utf-8")).hexdigest(), **self._audio_fields(clip)}
                for key, value in self._clip_state_fields(clip).items():
                    if value is not None or key not in clip_row: clip_row[key] = value
                clips.append(clip_row)
                slot_rows.append({"ref": slot_ref, "parentRef": track_ref, "trackRef": track_ref, "objectIdentity": self._capture_object_identity(slot), "sceneIndex": slot_index, "clipRef": clip_ref, "empty": False, **self._slot_state_fields(slot)})
            armed_value = self._read_attr(track, "arm", "armed")
            track_rows.append({
                "ref": track_ref, "parentRef": self.refs.put("set", self.song, "song"), "objectIdentity": self._capture_object_identity(track),
                "name": str(getattr(track, "name", f"Track {index + 1}")), "kind": track_kind,
                "mediaKind": "midi" if bool(self._read_attr(track, "has_midi_input")) else "audio",
                "armed": armed_value if isinstance(armed_value, bool) else None,
                "monitoringState": self._monitoring_state(self._read_attr(track, "current_monitoring_state", "monitoring")),
                "playingSlotIndex": self._slot_index(self._read_attr(track, "playing_slot_index")),
                "firedSlotIndex": self._slot_index(self._read_attr(track, "fired_slot_index")),
                "mixer": self._mixer_row(track, index),
                "routing": self._routing_row(track),
                "clips": clips, "clipSlots": slot_rows, "devices": self._device_items(track, index), "takeLanes": self._take_lane_rows(track, index), **self._track_state_fields(track, index),
            })
        scene_rows = [self._scene_row(scene, i) for i, scene in enumerate(scenes)]
        locators = self._locator_items()
        return {"set": set_row, "tracks": track_rows, "scenes": scene_rows, "arrangement": {"locators": locators, "locatorRevision": hashlib.sha256(self._bounded_canonical(locators).encode("utf-8")).hexdigest(), "clips": self._arrangement_clip_items()}, "playback": self._playback(track_rows, scene_rows), "epoch": self.refs.epoch}

    def _read_notes(self, clip: Any) -> list[dict[str, Any]]:
        if self._read_attr(clip, "is_audio_clip") is True:
            return []
        try:
            if hasattr(clip, "get_all_notes_extended"):
                raw = list(clip.get_all_notes_extended())
            elif hasattr(clip, "get_notes"):
                length = self._read_attr(clip, "length")
                if not isinstance(length, (int, float)) or isinstance(length, bool) or not math.isfinite(float(length)) or not 0 <= float(length) <= 1_000_000_000: raise ValueError("complete MIDI note range is unavailable")
                raw = list(clip.get_notes(0, 0.0, float(length), 128))
            else:
                raise ValueError("complete MIDI note enumeration is unavailable")
        except (AttributeError, RuntimeError, TypeError) as error:
            raise ValueError("complete MIDI note enumeration failed") from error
        if len(raw) > MAX_WIRE_ARRAY_LENGTH: raise ValueError("MIDI note collection exceeds its authoritative bound")
        return self._note_rows_from(raw)

    def _note_rows_from(self, raw: Any) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for item in self._items(raw):
            if isinstance(item, dict):
                row = {"pitch": int(item.get("pitch", 0)), "start": float(item.get("start_time", item.get("start", 0))), "duration": float(item.get("duration", 0)), "velocity": item.get("velocity", 0), "channel": int(item.get("channel", 1))}
                note_id = item.get("note_id", item.get("id"))
            elif isinstance(item, (list, tuple)):
                values = list(item)
                row = {"pitch": int(values[0]) if len(values) > 0 else 0, "start": float(values[1]) if len(values) > 1 else 0.0, "duration": float(values[2]) if len(values) > 2 else 0.0, "velocity": values[3] if len(values) > 3 else 0, "channel": 1}
                note_id = None
            else:
                row = {"pitch": int(getattr(item, "pitch", 0)), "start": float(getattr(item, "start_time", getattr(item, "start", 0))), "duration": float(getattr(item, "duration", 0)), "velocity": getattr(item, "velocity", 0), "channel": int(getattr(item, "channel", 1) or 1)}
                note_id = getattr(item, "note_id", None)
            row["velocity"] = int(row["velocity"]) if isinstance(row["velocity"], (int, float)) and float(row["velocity"]).is_integer() else row["velocity"]
            row["id"] = int(note_id) if isinstance(note_id, int) and not isinstance(note_id, bool) else None
            for field, attr, convert in (("mute", "mute", bool), ("probability", "probability", float), ("velocityDeviation", "velocity_deviation", float), ("releaseVelocity", "release_velocity", float)):
                value = item.get(field) if isinstance(item, dict) else getattr(item, attr, None)
                row[field] = convert(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) else (bool(value) if field == "mute" and isinstance(value, bool) else None)
            rows.append(row)
        return rows

    def get(self, reference: str) -> Any:
        if not isinstance(reference, str):
            raise ValueError("object reference is required")
        obj = self.refs.get(reference)
        if obj is None:
            raise ValueError("unknown live ref")
        kind = reference.split(":", 2)[1] if reference.count(":") >= 2 else ""
        result = None
        if kind == "set":
            result = self.snapshot()["set"]
        elif kind == "clip":
            result = next((clip for track in self.snapshot()["tracks"] for clip in track["clips"] if clip["ref"] == reference), None)
        elif kind == "arrangement_clip":
            result = next((clip for clip in self._arrangement_clip_items() if clip["ref"] == reference), None)
        elif kind == "take_lane":
            result = next((lane for track in self.snapshot()["tracks"] for lane in (track.get("takeLanes") or []) if lane["ref"] == reference), None)
        elif kind == "take_lane_clip":
            result = next((clip for track in self.snapshot()["tracks"] for lane in (track.get("takeLanes") or []) for clip in (lane.get("clips") or []) if clip["ref"] == reference), None)
        elif kind in {"device", "parameter"}:
            for track in self.snapshot()["tracks"]:
                for device in self._flatten_device_rows(track.get("devices", [])):
                    if device["ref"] == reference:
                        result = device; break
                    result = next((parameter for parameter in device["parameters"] if parameter["ref"] == reference), None)
                    if result is not None: break
                if result is not None: break
        elif kind == "locator":
            result = next((item for item in self._locator_items() if item["ref"] == reference), None)
        elif kind == "scene":
            result = next((row for row in self.snapshot()["scenes"] if row["ref"] == reference), None)
        elif kind == "track":
            identity = self._capture_object_identity(obj); tracks = self._all_track_objects(); matches = [candidate for candidate in tracks if self._capture_same_object(candidate, obj, identity)]
            if len(matches) == 1: result = next((row for row in self.snapshot()["tracks"] if row["ref"] == reference and row.get("objectIdentity") == identity), None)
        if result is None:
            raise ValueError("unknown live ref")
        return result

    def _set_parameter_value(self, reference: str, value: Any) -> dict[str, Any]:
        parameter = self.refs.get(reference)
        if not hasattr(parameter, "value"):
            raise ValueError("parameter value is unavailable")
        minimum = getattr(parameter, "min", getattr(parameter, "min_value", None))
        maximum = getattr(parameter, "max", getattr(parameter, "max_value", None))
        quantization = float(getattr(parameter, "quantization", 0) or 0)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
            raise ValueError("parameter value is invalid")
        if not bool(getattr(parameter, "is_enabled", getattr(parameter, "enabled", True))) or not bool(getattr(parameter, "is_automatable", getattr(parameter, "automatable", True))):
            raise ValueError("parameter is disabled or not automatable")
        if not isinstance(minimum, (int, float)) or not isinstance(maximum, (int, float)) or not float(minimum) <= float(value) <= float(maximum):
            raise ValueError("parameter value is outside authoritative bounds")
        if quantization > 0 and abs((float(value) - float(minimum)) / quantization - round((float(value) - float(minimum)) / quantization)) > 1e-9:
            raise ValueError("parameter value does not match authoritative quantization")
        prior_value = self._read_attr(parameter, "value")
        if not isinstance(prior_value, (int, float)) or isinstance(prior_value, bool) or not math.isfinite(float(prior_value)): raise ValueError("parameter prior value is unavailable")
        target_value = float(value); setter_error: BaseException | None = None
        try: parameter.value = target_value
        except BaseException as error: setter_error = error
        observed = self._read_attr(parameter, "value")
        if setter_error is not None or not isinstance(observed, (int, float)) or isinstance(observed, bool) or float(observed) != target_value:
            try: parameter.value = float(prior_value)
            except BaseException: pass
            restored = self._read_attr(parameter, "value")
            if not isinstance(restored, (int, float)) or float(restored) != float(prior_value): raise ValueError("parameter mutation failed and exact rollback failed") from setter_error
            raise ValueError("parameter mutation was not confirmed") from setter_error
        revision = self.refs.touch(reference)
        return {"changed": True, "ref": reference, "property": "value", "value": float(observed), "revision": revision}

    def discover(self, kind: str, limit: int = 100, cursor: str | None = None, parent: str | None = None, filters: dict[str, Any] | None = None, requested_fields: list[str] | None = None, traversal_budget: int = 1000) -> dict[str, Any]:
        supported = {"set", "song", "track", "group_track", "return_track", "main_track", "scene", "clip_slot", "clip", "session_clip", "arrangement_clip", "note", "locator", "device", "parameter", "selection", "routing_choice", "session_playback"}
        if kind not in supported:
            raise ValueError("unsupported discovery kind")
        parent_required = {"clip_slot", "clip", "session_clip", "arrangement_clip", "note", "device", "parameter", "routing_choice"}
        if kind in parent_required and parent is None:
            raise ValueError("a kind-specific parent reference is required")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
            raise ValueError("discovery limit is invalid")
        if not isinstance(traversal_budget, int) or isinstance(traversal_budget, bool) or not 1 <= traversal_budget <= 10_000:
            raise ValueError("traversal budget is invalid")
        if parent is not None and not isinstance(parent, str):
            raise ValueError("parent reference is invalid")
        def valid_filter_value(value: Any) -> bool:
            return value is None or isinstance(value, bool) or isinstance(value, str) and len(value) <= 256 or isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) and abs(float(value)) <= 2**53 - 1
        if filters is not None and (not isinstance(filters, dict) or len(filters) > 16 or any(not isinstance(key, str) or not key or len(key) > 64 or not valid_filter_value(value) for key, value in filters.items())):
            raise ValueError("discovery filters are invalid")
        if requested_fields is not None and (not isinstance(requested_fields, list) or len(requested_fields) > 32 or any(not isinstance(field, str) or not field for field in requested_fields)):
            raise ValueError("requested fields are invalid")
        snapshot = self.snapshot()
        set_row = snapshot["set"]
        if kind in {"set", "song"}: items = [set_row]
        elif kind == "track": items = [item for item in snapshot["tracks"] if item["kind"] in {"regular", "group"}]
        elif kind == "group_track": items = [item for item in snapshot["tracks"] if item["kind"] == "group"]
        elif kind == "return_track": items = [item for item in snapshot["tracks"] if item["kind"] == "return"]
        elif kind == "main_track": items = [item for item in snapshot["tracks"] if item["kind"] == "main"]
        elif kind == "scene": items = snapshot["scenes"]
        elif kind == "clip_slot": items = [slot for track in snapshot["tracks"] for slot in track["clipSlots"]]
        elif kind in {"clip", "session_clip"}: items = [clip for track in snapshot["tracks"] for clip in track["clips"]]
        elif kind == "arrangement_clip": items = self._arrangement_clip_items()
        elif kind == "note": items = [note | {"ref": f"{clip['ref']}:note:{index}", "parentRef": clip["ref"]} for track in snapshot["tracks"] for clip in track["clips"] for index, note in enumerate(clip["notes"])]
        elif kind == "locator": items = snapshot["arrangement"]["locators"]
        elif kind == "device": items = [device for track in snapshot["tracks"] for device in self._flatten_device_rows(track["devices"])]
        elif kind == "parameter": items = [parameter for track in snapshot["tracks"] for device in self._flatten_device_rows(track["devices"]) for parameter in device["parameters"]]
        elif kind == "session_playback": items = [snapshot["playback"]]
        elif kind == "selection":
            view = getattr(self.song, "view", None); selected_track = getattr(view, "selected_track", None); selected_scene = getattr(view, "selected_scene", None); highlighted_slot = getattr(view, "highlighted_clip_slot", None)
            track_objects = self._all_track_objects()
            track_index = self._capture_index(track_objects, selected_track); track_ref = snapshot["tracks"][track_index]["ref"] if track_index is not None and track_index < len(snapshot["tracks"]) else None
            scene_objects = self._items(getattr(self.song, "scenes", [])); scene_index = self._capture_index(scene_objects, selected_scene); scene_ref = snapshot["scenes"][scene_index]["ref"] if scene_index is not None and scene_index < len(snapshot["scenes"]) else None
            highlighted_identity = self._capture_object_identity(highlighted_slot) if highlighted_slot is not None else None; slot_matches = [slot["ref"] for track in snapshot["tracks"] for slot in track.get("clipSlots", []) if highlighted_identity is not None and self._capture_same_object(self.refs.get(slot["ref"]), highlighted_slot, highlighted_identity)]; slot_ref = slot_matches[0] if len(slot_matches) == 1 else None
            items = [{"ref": f"{self.refs.epoch}:selection:current", "parentRef": set_row["ref"], "selectedRef": track_ref or scene_ref or slot_ref, "selectedTrackRef": track_ref, "selectedSceneRef": scene_ref, "highlightedClipSlotRef": slot_ref}]
        else:
            # Routing choices are track-scoped Live objects. Enumerating a
            # non-existent Song.routing_choices collection made parent-scoped
            # discovery silently return no rows even when routing was usable.
            if parent is None or not parent.startswith(f"{self.refs.epoch}:track:"):
                raise ValueError("routing-choice parent must be an authoritative track")
            try:
                track = self.refs.get(parent)
            except KeyError as error:
                raise ValueError("routing-choice parent is stale") from error
            tracks = self._items(getattr(self.song, "tracks", [])) + self._items(getattr(self.song, "return_tracks", []))
            main_track = getattr(self.song, "master_track", getattr(self.song, "main_track", None))
            if main_track is not None: tracks.append(main_track)
            track_index = self._capture_index(tracks, track)
            if track_index is None: raise ValueError("routing-choice parent is stale")
            items = []
            groups = (
                ("input-type", "available_input_routing_types"),
                ("input-channel", "available_input_routing_channels"),
                ("output-type", "available_output_routing_types"),
                ("output-channel", "available_output_routing_channels"),
            )
            for direction, attribute in groups:
                for index, choice in enumerate(self._items(self._read_attr(track, attribute) or [])):
                    row = dict(choice) if isinstance(choice, dict) else {"name": str(getattr(choice, "name", getattr(choice, "display_name", ""))), "type": str(getattr(choice, "type", ""))}
                    row["direction"] = direction
                    row["ref"] = self.refs.put("routing_choice", choice, f"{track_index}:{direction}:{index}")
                    row["parentRef"] = parent
                    items.append(row)
        if parent is not None:
            if not parent.startswith(f"{self.refs.epoch}:"):
                raise ValueError("stale parent reference")
            items = [item for item in items if item.get("parentRef") == parent]
        if filters:
            items = [item for item in items if all(item.get(key) == value for key, value in filters.items())]
        items = items[:traversal_budget]
        fingerprint = hashlib.sha256(json.dumps(items, sort_keys=True, default=str, separators=(",", ":")).encode("utf-8")).hexdigest()[:16]
        revision = f"{self.refs.epoch}:{kind}:{len(items)}:{fingerprint}"
        offset = 0
        if cursor is not None:
            offset = self._cursor_offset(cursor, revision)
        if not 0 <= offset <= len(items):
            raise ValueError("invalid discovery cursor")
        page = items[offset:offset + limit]
        next_offset = offset + len(page)
        next_cursor = self._cursor(next_offset, revision) if next_offset < len(items) else None
        if requested_fields is not None:
            allowed = set(requested_fields) | {"ref", "parentRef"}
            page = [{key: value for key, value in item.items() if key in allowed} for item in page]
        return {"epoch": self.refs.epoch, "items": page, "truncated": next_cursor is not None, "revision": revision, "kind": kind, **({"nextCursor": next_cursor} if next_cursor else {})}

    _MONITORABLE_KINDS = {"regular", "audio", "midi"}

    @staticmethod
    def _target_key(target: dict[str, Any]) -> str:
        return f"{target['trackRef']}|{target['clipSlotRef']}|{target['sceneRef']}"

    def _active_targets(self, playback: dict[str, Any]) -> list[dict[str, Any]]:
        seen: dict[str, dict[str, Any]] = {}
        for target in list(playback.get("firedTargets", [])) + list(playback.get("playingTargets", [])):
            seen[self._target_key(target)] = target
        return [seen[key] for key in sorted(seen)]

    def _check_audition_safety(self, snapshot: dict[str, Any]) -> None:
        playback = snapshot["playback"]
        transport = playback["transport"]
        if transport.get("playing") is not False or transport.get("arrangementRecord") is not False or transport.get("sessionRecord") is not False:
            raise ValueError("audition requires a stopped, non-recording authoritative state")
        quantization = (transport.get("launchQuantization") or {}).get("normalized")
        if not isinstance(quantization, str) or quantization in {"none", "unknown", "free"}:
            raise ValueError("launch quantization is unsafe or unknown")
        if playback["firedTargets"] or playback["playingTargets"]:
            raise ValueError("existing Session playback prevents audition")
        for track in snapshot["tracks"]:
            armed = track.get("armed")
            monitoring = track.get("monitoringState")
            if track.get("kind") in self._MONITORABLE_KINDS:
                # Auto monitoring with a verified-unarmed track passes no input;
                # In monitoring or an unknown state refuses unconditionally.
                if armed is not False or monitoring not in {"off", "auto"}:
                    raise ValueError("armed, input-monitored, or unknown-state track prevents audition")
            elif armed is True or monitoring == "in":
                raise ValueError("armed or input-monitored track prevents audition")

    def _check_eligible_targets(self, snapshot: dict[str, Any], reference: str, scene_index: int, eligible: set[str]) -> None:
        tracks = {track["ref"]: track for track in snapshot["tracks"]}
        for key in eligible:
            parts = key.split("|")
            if len(parts) != 3:
                raise ValueError("eligible target key is malformed")
            track_ref, slot_ref, scene_ref = parts
            if scene_ref != reference:
                raise ValueError("eligible target references a different scene")
            track = tracks.get(track_ref)
            slot = next((item for item in (track or {}).get("clipSlots", []) if item.get("ref") == slot_ref), None)
            if slot is None or slot.get("sceneIndex") != scene_index or not slot.get("clipRef"):
                raise ValueError("eligible target is not an authoritative clip slot with a clip")

    def _audition_authority_revision(self, snapshot: dict[str, Any], reference: str, scene_index: int, eligible: set[str]) -> str:
        scenes = snapshot.get("scenes", [])
        if not 0 <= scene_index < len(scenes): raise ValueError("audition scene is not authoritative")
        scene = scenes[scene_index]; tracks = {track.get("ref"): track for track in snapshot.get("tracks", [])}; targets = []
        for key in sorted(eligible):
            track_ref, slot_ref, scene_ref = key.split("|"); track = tracks.get(track_ref); slot = next((item for item in (track or {}).get("clipSlots", []) if item.get("ref") == slot_ref), None); clip = next((item for item in (track or {}).get("clips", []) if slot and item.get("ref") == slot.get("clipRef")), None)
            if track is None or slot is None or clip is None or scene_ref != reference: raise ValueError("audition target hierarchy is incomplete")
            targets.append({"trackRef": track_ref, "trackIdentity": track.get("objectIdentity"), "slotRef": slot_ref, "slotIdentity": slot.get("objectIdentity"), "sceneRef": scene.get("ref"), "sceneIdentity": scene.get("objectIdentity"), "clipRef": clip.get("ref"), "clipIdentity": clip.get("objectIdentity")})
        authority = {"set": {"ref": snapshot.get("set", {}).get("ref"), "objectIdentity": snapshot.get("set", {}).get("objectIdentity")}, "scene": {"ref": scene.get("ref"), "objectIdentity": scene.get("objectIdentity"), "index": scene.get("index")}, "targets": targets}
        return hashlib.sha256(self._bounded_canonical(authority).encode("utf-8")).hexdigest()

    def _stop_playback(self) -> None:
        stop_all = getattr(self.song, "stop_all_clips", None)
        stop_transport = getattr(self.song, "stop_playing", None)
        if not callable(stop_all) or not callable(stop_transport):
            raise ValueError("guarded stop is unavailable")
        try:
            # stop_all_clips is quantized by default; an owned or emergency
            # stop must land immediately, not at the next quantization boundary.
            stop_all(False)
        except TypeError:
            stop_all()
        stop_transport()

    def _guarded_audition_launch(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        set_name = args.get("setName")
        scene_name = args.get("sceneName")
        scene_index = args.get("sceneIndex")
        playback_revision = args.get("playbackRevision")
        eligible = args.get("eligibleTargets")
        expected_set_identity = args.get("expectedSetIdentity"); expected_authority = args.get("expectedAuthorityRevision")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:scene:"):
            raise ValueError("scene reference is stale or invalid")
        if not isinstance(set_name, str) or not 1 <= len(set_name) <= 256:
            raise ValueError("set identity is invalid")
        if not isinstance(scene_name, str) or len(scene_name) > 256:
            raise ValueError("scene identity is invalid")
        if not isinstance(scene_index, int) or isinstance(scene_index, bool) or not 0 <= scene_index <= 10000:
            raise ValueError("scene index is invalid")
        if not isinstance(playback_revision, str) or not 1 <= len(playback_revision) <= 256:
            raise ValueError("playback revision is invalid")
        if not isinstance(eligible, list) or not 1 <= len(eligible) <= 256 or len(set(eligible)) != len(eligible) or not all(isinstance(item, str) and 1 <= len(item) <= 1024 for item in eligible):
            raise ValueError("eligible targets are invalid")
        eligible_keys = set(eligible)
        snapshot = self.snapshot()
        if snapshot["set"].get("name") != set_name or not isinstance(expected_set_identity, str) or not hmac.compare_digest(str(snapshot["set"].get("objectIdentity", "")), expected_set_identity):
            raise ValueError("disposable Set identity does not match")
        scenes = snapshot["scenes"]
        if not 0 <= scene_index < len(scenes):
            raise ValueError("scene is not authoritative")
        scene_row = scenes[scene_index]
        if scene_row.get("ref") != reference or scene_row.get("name") != scene_name or scene_row.get("index") != scene_index:
            raise ValueError("scene identity changed since preview")
        self._check_audition_safety(snapshot)
        if snapshot["playback"].get("revision") != playback_revision:
            raise ValueError("playback state changed since preview")
        self._check_eligible_targets(snapshot, reference, scene_index, eligible_keys)
        if not isinstance(expected_authority, str) or not hmac.compare_digest(self._audition_authority_revision(snapshot, reference, scene_index, eligible_keys), expected_authority): raise ValueError("audition identity hierarchy changed since preview")
        scene = self.refs.get(reference)
        fire = getattr(scene, "fire", getattr(scene, "launch", None))
        if not callable(fire):
            raise ValueError("scene launch is unavailable")
        fire()
        # Live applies the fire asynchronously at the launch quantization
        # boundary, so no synchronous post-fire verification is possible here;
        # the host verifies through fresh authoritative playback reads.
        return {"launched": reference, "targets": self._active_targets(self._playback())}

    def _guarded_audition_stop(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        set_name = args.get("setName")
        eligible = args.get("eligibleTargets")
        expected_set_identity = args.get("expectedSetIdentity"); expected_authority = args.get("expectedAuthorityRevision")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:scene:"):
            raise ValueError("scene reference is stale or invalid")
        if not isinstance(set_name, str) or not 1 <= len(set_name) <= 256:
            raise ValueError("set identity is invalid")
        if not isinstance(eligible, list) or len(eligible) > 256 or len(set(eligible)) != len(eligible) or not all(isinstance(item, str) and 1 <= len(item) <= 1024 for item in eligible):
            raise ValueError("eligible targets are invalid")
        eligible_keys = set(eligible)
        snapshot = self.snapshot()
        if snapshot["set"].get("name") != set_name or not isinstance(expected_set_identity, str) or not hmac.compare_digest(str(snapshot["set"].get("objectIdentity", "")), expected_set_identity):
            raise ValueError("disposable Set identity does not match")
        scene_row = next((item for item in snapshot.get("scenes", []) if item.get("ref") == reference), None)
        if scene_row is None or not isinstance(expected_authority, str) or not hmac.compare_digest(self._audition_authority_revision(snapshot, reference, int(scene_row.get("index", -1)), eligible_keys), expected_authority): raise ValueError("audition identity hierarchy changed; owned stop refused")
        active = self._active_targets(snapshot["playback"])
        if any(self._target_key(target) not in eligible_keys or target.get("sceneRef") != reference for target in active): raise ValueError("external or unknown playback is active; owned stop refused")
        if not active:
            transport = snapshot["playback"].get("transport", {})
            if transport.get("playing") is True or transport.get("arrangementRecord") is True or transport.get("sessionRecord") is True: raise ValueError("unrelated transport or recording is active; owned stop refused")
            return {"stopped": True}
        self._stop_playback(); return {"stopped": True}

    def _guarded_emergency_stop(self, args: dict[str, Any]) -> dict[str, Any]:
        expected, expected_recording = args.get("expectedTargets"), args.get("expectedRecording")
        if not isinstance(expected, list) or len(expected) > 256 or len(set(expected)) != len(expected) or not all(isinstance(item, str) and 1 <= len(item) <= 1024 for item in expected):
            raise ValueError("expected targets are invalid")
        playback = self._playback()
        session_record, arrangement_record = playback["transport"].get("sessionRecord") is True, playback["transport"].get("arrangementRecord") is True
        recording = "both" if session_record and arrangement_record else "session" if session_record else "arrangement" if arrangement_record else "stopped"
        if expected_recording != recording:
            raise ValueError("recording state exceeds the separately authorized observation; perform fresh discovery")
        active = self._active_targets(playback)
        active_keys = {self._target_key(target) for target in active}
        if active_keys != set(expected):
            raise ValueError("active playback does not exactly match the separately authorized observation; perform fresh discovery")
        self._stop_playback()
        if isinstance(self._read_attr(self.song, "session_record"), bool): self.song.session_record = False
        if isinstance(self._read_attr(self.song, "record_mode"), bool): self.song.record_mode = False
        return {"stopped": True, "stoppedTargets": sorted(active_keys), "recordingStopped": True}

    def _guard_note_clip(self, args: dict[str, Any]) -> Any:
        reference = str(args.get("ref")); self.snapshot(); authority = self._session_clip_authority(reference)
        expected_authority = args.get("expectedClipAuthority"); expected_revision = args.get("expectedNotesRevision")
        if not isinstance(expected_authority, dict) or not hmac.compare_digest(self._bounded_canonical(authority), self._bounded_canonical(expected_authority)):
            raise ValueError("note clip hierarchy identity changed since preview")
        clip = self.refs.get(reference); current_revision = hashlib.sha256(self._bounded_canonical(self._read_notes(clip)).encode("utf-8")).hexdigest()
        if not isinstance(expected_revision, str) or not hmac.compare_digest(current_revision, expected_revision):
            raise ValueError("clip notes changed since preview")
        return clip

    def _note_update(self, args: dict[str, Any]) -> dict[str, Any]:
        clip = self._guard_note_clip(args)
        patches = args.get("notes")
        if not isinstance(patches, list) or not 1 <= len(patches) <= 512:
            raise ValueError("note patches are invalid")
        if not callable(getattr(clip, "get_notes_extended", None)) or not callable(getattr(clip, "apply_note_modifications", None)) or not callable(getattr(clip, "get_all_notes_extended", None)):
            raise ValueError("note modification is unavailable on this Live shape")
        extended = list(clip.get_all_notes_extended())
        if len(extended) > MAX_WIRE_ARRAY_LENGTH: raise ValueError("MIDI note collection exceeds its authoritative bound")
        by_id = {}
        for candidate in extended:
            note_id = getattr(candidate, "note_id", None)
            if not isinstance(note_id, int) or isinstance(note_id, bool) or int(note_id) in by_id: raise ValueError("stable unique note ids are required for exact update")
            by_id[int(note_id)] = candidate
        before_rows = self._read_notes(clip); before_by_id = {row["id"]: dict(row) for row in before_rows}
        if len(before_by_id) != len(before_rows) or any(note_id is None for note_id in before_by_id): raise ValueError("complete stable note identity is unavailable")
        targets: list[tuple[Any, dict[str, Any]]] = []
        seen: set[int] = set()
        for patch in patches:
            if not isinstance(patch, dict) or not isinstance(patch.get("id"), int) or isinstance(patch["id"], bool) or patch["id"] < 0:
                raise ValueError("note patch id is invalid")
            if set(patch) - {"id", "pitch", "start", "duration", "velocity", "mute", "probability", "velocityDeviation", "releaseVelocity"}:
                raise ValueError("note patch contains unknown fields")
            if "pitch" in patch and (not isinstance(patch["pitch"], int) or isinstance(patch["pitch"], bool) or not 0 <= patch["pitch"] <= 127):
                raise ValueError("note patch pitch is invalid")
            if "start" in patch and (not isinstance(patch["start"], (int, float)) or isinstance(patch["start"], bool) or not math.isfinite(float(patch["start"])) or float(patch["start"]) < 0):
                raise ValueError("note patch start is invalid")
            if "duration" in patch and (not isinstance(patch["duration"], (int, float)) or isinstance(patch["duration"], bool) or not math.isfinite(float(patch["duration"])) or float(patch["duration"]) <= 0):
                raise ValueError("note patch duration is invalid")
            if "velocity" in patch and (not isinstance(patch["velocity"], (int, float)) or isinstance(patch["velocity"], bool) or not 0 <= float(patch["velocity"]) <= 127):
                raise ValueError("note patch velocity is invalid")
            if "mute" in patch and not isinstance(patch["mute"], bool):
                raise ValueError("note patch mute is invalid")
            if "probability" in patch and (not isinstance(patch["probability"], (int, float)) or isinstance(patch["probability"], bool) or not 0 <= float(patch["probability"]) <= 1):
                raise ValueError("note patch probability is invalid")
            if "velocityDeviation" in patch and (not isinstance(patch["velocityDeviation"], (int, float)) or isinstance(patch["velocityDeviation"], bool) or not -127 <= float(patch["velocityDeviation"]) <= 127):
                raise ValueError("note patch velocity deviation is invalid")
            if "releaseVelocity" in patch and (not isinstance(patch["releaseVelocity"], (int, float)) or isinstance(patch["releaseVelocity"], bool) or not 0 <= float(patch["releaseVelocity"]) <= 127):
                raise ValueError("note patch release velocity is invalid")
            if patch["id"] in seen:
                raise ValueError("duplicate note patch id")
            target = by_id.get(patch["id"])
            if target is None:
                raise ValueError("note id is not present in the clip")
            prior = before_by_id.get(patch["id"]); final_start = float(patch.get("start", prior["start"] if prior else -1)); final_duration = float(patch.get("duration", prior["duration"] if prior else -1)); clip_length = self._read_attr(clip, "length")
            if prior is None or not isinstance(clip_length, (int, float)) or final_start + final_duration > float(clip_length): raise ValueError("note patch exceeds the exact clip length")
            seen.add(patch["id"])
            targets.append((target, patch))
        expected_by_id = {note_id: dict(row) for note_id, row in before_by_id.items()}; field_attributes = {"pitch": "pitch", "start": "start_time", "duration": "duration", "velocity": "velocity", "mute": "mute", "probability": "probability", "velocityDeviation": "velocity_deviation", "releaseVelocity": "release_velocity"}
        for target, patch in targets:
            expected = expected_by_id[patch["id"]]
            for field, attribute in field_attributes.items():
                if field not in patch: continue
                value = bool(patch[field]) if field == "mute" else int(patch[field]) if field == "pitch" else float(patch[field]); setattr(target, attribute, value)
                expected[field] = int(value) if field == "velocity" and float(value).is_integer() else value
        canonical_rows = lambda rows: self._bounded_canonical(sorted(rows, key=lambda row: int(row["id"])))
        try:
            clip.apply_note_modifications(extended); after_rows = self._read_notes(clip)
            if canonical_rows(after_rows) != canonical_rows(list(expected_by_id.values())): raise ValueError("note update did not produce the exact complete expected state")
        except BaseException as error:
            rollback_failed = False
            try:
                current = list(clip.get_all_notes_extended()); current_by_id = {int(candidate.note_id): candidate for candidate in current}
                if len(current_by_id) != len(before_by_id) or set(current_by_id) != set(before_by_id): raise ValueError("note identity set changed")
                for note_id, prior in before_by_id.items():
                    candidate = current_by_id[int(note_id)]
                    for field, attribute in field_attributes.items():
                        value = prior.get(field)
                        if value is not None: setattr(candidate, attribute, value)
                clip.apply_note_modifications(current)
                if canonical_rows(self._read_notes(clip)) != canonical_rows(before_rows): rollback_failed = True
            except BaseException: rollback_failed = True
            if rollback_failed: raise ValueError("note update failed and exact rollback failed") from error
            raise
        return {"updated": len(targets)}

    def _note_delete(self, args: dict[str, Any]) -> dict[str, Any]:
        clip = self._guard_note_clip(args)
        note_ids = args.get("noteIds")
        if not isinstance(note_ids, list) or not 1 <= len(note_ids) <= 512 or len(set(note_ids)) != len(note_ids) or not all(isinstance(item, int) and not isinstance(item, bool) and item >= 0 for item in note_ids):
            raise ValueError("note ids are invalid")
        if not callable(getattr(clip, "remove_notes_by_id", None)):
            raise ValueError("note deletion is unavailable on this Live shape")
        before_rows = self._read_notes(clip); existing = {int(row["id"]) for row in before_rows if isinstance(row.get("id"), int)}
        if len(existing) != len(before_rows) or any(note_id not in existing for note_id in note_ids): raise ValueError("complete stable note identity is required for deletion")
        expected_rows = [row for row in before_rows if row["id"] not in set(note_ids)]; canonical_rows = lambda rows: self._bounded_canonical(sorted(rows, key=lambda row: int(row["id"]))); operation_error: BaseException | None = None
        try: clip.remove_notes_by_id(note_ids)
        except BaseException as error: operation_error = error
        try: after_rows = self._read_notes(clip)
        except BaseException as error:
            if operation_error is None: operation_error = error
            after_rows = []
        if canonical_rows(after_rows) == canonical_rows(expected_rows): return {"deleted": len(note_ids)}
        rollback_failed = False
        try:
            content = lambda row: {key: row.get(key) for key in ("pitch", "start", "duration", "velocity", "channel", "mute", "probability", "velocityDeviation", "releaseVelocity")}; remaining = [content(row) for row in after_rows]; missing: list[dict[str, Any]] = []
            for prior in before_rows:
                prior_content = content(prior); match = next((index for index, candidate in enumerate(remaining) if self._bounded_canonical(candidate) == self._bounded_canonical(prior_content)), None)
                if match is None: missing.append(prior)
                else: remaining.pop(match)
            if remaining: raise ValueError("native deletion changed content outside its exact targets")
            if missing:
                try: spec_class = getattr(__import__("Live.Clip", fromlist=["MidiNoteSpecification"]), "MidiNoteSpecification", None)
                except Exception: spec_class = None
                if spec_class is not None:
                    additions = [spec_class(row["pitch"], float(row["start"]), float(row["duration"]), float(row["velocity"]), bool(row.get("mute", False)), float(row.get("probability") if row.get("probability") is not None else 1.0), float(row.get("velocityDeviation") if row.get("velocityDeviation") is not None else 0.0), float(row.get("releaseVelocity") if row.get("releaseVelocity") is not None else 64.0)) for row in missing]
                else:
                    additions = [{"pitch": row["pitch"], "start_time": float(row["start"]), "duration": float(row["duration"]), "velocity": row["velocity"], "channel": row.get("channel", 1), "mute": bool(row.get("mute", False)), "probability": float(row.get("probability") if row.get("probability") is not None else 1.0), "velocity_deviation": float(row.get("velocityDeviation") if row.get("velocityDeviation") is not None else 0.0), "release_velocity": float(row.get("releaseVelocity") if row.get("releaseVelocity") is not None else 64.0)} for row in missing]
                clip.add_new_notes(additions)
            restored = self._read_notes(clip); restored_ids = [row.get("id") for row in restored]
            if len(restored_ids) != len(set(restored_ids)) or any(not isinstance(note_id, int) for note_id in restored_ids) or self._bounded_canonical(sorted([content(row) for row in restored], key=self._bounded_canonical)) != self._bounded_canonical(sorted([content(row) for row in before_rows], key=self._bounded_canonical)): rollback_failed = True
        except BaseException: rollback_failed = True
        failure = operation_error or ValueError("note deletion did not produce the exact complete expected state")
        if rollback_failed: raise ValueError("note deletion failed and exact content rollback failed") from failure
        raise failure

    def _transport_set(self, args: dict[str, Any]) -> dict[str, Any]:
        expected = args.get("expectedRevision"); set_ref = args.get("setRef"); expected_identity = args.get("expectedObjectIdentity"); set_target = self.refs.get(set_ref) if isinstance(set_ref, str) else None
        if not isinstance(expected, str) or not 1 <= len(expected) <= 256 or not isinstance(set_ref, str) or not isinstance(expected_identity, str) or not self._capture_same_object(set_target, self.song, expected_identity) or not hmac.compare_digest(self._capture_object_identity(self.song), expected_identity):
            raise ValueError("transport Set identity or revision authority is invalid")
        allowed = {"position", "loopEnabled", "loopStart", "loopLength", "metronome", "punchIn", "punchOut", "expectedRevision", "setRef", "expectedObjectIdentity"}
        if set(args) - allowed:
            raise ValueError("transport fields are invalid")
        playback = self._playback()
        if playback["revision"] != expected:
            raise ValueError("transport state changed since preview")

        def number(name: str, upper: float) -> float | None:
            value = args.get(name)
            if value is None:
                return None
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or not 0 <= float(value) <= upper:
                raise ValueError(f"{name} is invalid")
            return float(value)

        def flag(name: str) -> bool | None:
            value = args.get(name)
            if value is None:
                return None
            if not isinstance(value, bool):
                raise ValueError(f"{name} is invalid")
            return value

        position = number("position", 1_000_000_000)
        loop_enabled = flag("loopEnabled")
        loop_start = number("loopStart", 1_000_000_000)
        loop_length = number("loopLength", 1_000_000_000)
        metronome = flag("metronome")
        punch_in = flag("punchIn")
        punch_out = flag("punchOut")
        # count_in_duration is get/observe in the public LOM; it is read in the
        # transport row but never written here.
        if loop_length is not None and loop_length <= 0:
            raise ValueError("loopLength is invalid")
        proposed = [("current_song_time", position), ("loop", loop_enabled), ("loop_start", loop_start), ("loop_length", loop_length), ("metronome", metronome), ("punch_in", punch_in), ("punch_out", punch_out)]; assignments = []
        for attribute, value in proposed:
            if value is None: continue
            prior = self._read_attr(self.song, attribute)
            if not isinstance(prior, (int, float, bool)) or isinstance(prior, bool) != isinstance(value, bool): raise ValueError(f"transport {attribute} prior state is unavailable")
            assignments.append((attribute, value, prior))
        try:
            applied = []
            for attribute, value, prior in assignments:
                applied.append((attribute, prior)); setattr(self.song, attribute, value)
            transport = self._transport_dict(); loop = transport["loop"]; checks = []
            # Every requested field is synchronously exact here; Host also
            # performs fresh position readback to account for later playhead motion.
            if position is not None: checks.append(isinstance(transport["position"], (int, float)) and float(transport["position"]) == position)
            if loop_enabled is not None: checks.append(loop["enabled"] is loop_enabled)
            if loop_start is not None: checks.append(isinstance(loop["start"], (int, float)) and float(loop["start"]) == loop_start)
            if loop_length is not None: checks.append(isinstance(loop["length"], (int, float)) and float(loop["length"]) == loop_length)
            if metronome is not None: checks.append(transport["metronome"] is metronome)
            if punch_in is not None: checks.append(transport["punchIn"] is punch_in)
            if punch_out is not None: checks.append(transport["punchOut"] is punch_out)
            if not all(checks): raise ValueError("transport change was not confirmed by fresh state")
            after_revision = self._playback()["revision"]
        except BaseException as error:
            rollback_failed = False
            for attribute, prior in reversed(locals().get("applied", [])):
                try: setattr(self.song, attribute, prior)
                except BaseException: pass
                restored = self._read_attr(self.song, attribute)
                if isinstance(prior, bool): rollback_failed = rollback_failed or restored is not prior
                elif not isinstance(restored, (int, float)) or float(restored) != float(prior): rollback_failed = True
            if rollback_failed: raise ValueError("transport mutation failed and exact rollback failed") from error
            raise
        return {"changed": True, "revision": after_revision}

    def _guarded_session_target(self, args: dict[str, Any], operation: str) -> tuple[str, str, str, str, int]:
        slot_ref, track_ref, scene_ref, clip_ref = (args.get(name) for name in ("slotRef", "trackRef", "sceneRef", "clipRef"))
        scene_index = args.get("sceneIndex")
        identities = {name: args.get(name) for name in ("trackIdentity", "sceneIdentity", "slotIdentity", "clipIdentity")}
        if not all(isinstance(item, str) and item.startswith(f"{self.refs.epoch}:") for item in (slot_ref, track_ref, scene_ref, clip_ref)) or not isinstance(scene_index, int) or isinstance(scene_index, bool) or scene_index < 0 or not all(isinstance(item, str) and item for item in identities.values()):
            raise ValueError(f"guarded {operation} identity is invalid")
        tracks, scenes = self._items(getattr(self.song, "tracks", [])), self._items(getattr(self.song, "scenes", []))
        current_track_row = next(((index, item) for index, item in enumerate(tracks) if self.refs.put("track", item, str(index)) == track_ref), None)
        if current_track_row is None or scene_index >= len(scenes):
            raise ValueError(f"{operation} hierarchy changed since preview")
        track_index, current_track = current_track_row
        current_scene = scenes[scene_index]; slots = self._items(getattr(current_track, "clip_slots", [])); current_slot = slots[scene_index] if scene_index < len(slots) else None; current_clip = getattr(current_slot, "clip", None)
        if current_slot is None or current_clip is None or self.refs.put("scene", current_scene, str(scene_index)) != scene_ref or self.refs.put("clip_slot", current_slot, f"{track_index}:{scene_index}") != slot_ref or self.refs.put("clip", current_clip, f"{track_index}:{scene_index}") != clip_ref:
            raise ValueError(f"{operation} hierarchy changed since preview")
        current_identities = {"trackIdentity": self._capture_object_identity(current_track), "sceneIdentity": self._capture_object_identity(current_scene), "slotIdentity": self._capture_object_identity(current_slot), "clipIdentity": self._capture_object_identity(current_clip)}
        if any(not hmac.compare_digest(current_identities[name], identities[name]) for name in identities):
            raise ValueError(f"{operation} object identity changed since preview")
        return slot_ref, track_ref, scene_ref, clip_ref, scene_index

    def _guarded_clip_launch(self, args: dict[str, Any]) -> dict[str, Any]:
        playback_revision = args.get("playbackRevision")
        if not isinstance(playback_revision, str):
            raise ValueError("guarded clip-launch identity is invalid")
        playback = self._playback()
        if playback.get("revision") != playback_revision or playback["transport"].get("playing") is not False or playback["transport"].get("arrangementRecord") is not False or playback["transport"].get("sessionRecord") is not False or playback["firedTargets"] or playback["playingTargets"]:
            raise ValueError("stopped playback or recording baseline changed since clip-launch preview")
        slot_ref, _, _, _, _ = self._guarded_session_target(args, "clip-launch")
        return self._clip_launch({"ref": slot_ref})

    def _guarded_clip_stop(self, args: dict[str, Any]) -> dict[str, Any]:
        active = self._active_targets(self._playback())
        slot_ref, track_ref, scene_ref, clip_ref, scene_index = self._guarded_session_target(args, "clip-stop")
        expected = (track_ref, slot_ref, scene_ref, scene_index, clip_ref)
        on_track = [(item.get("trackRef"), item.get("clipSlotRef"), item.get("sceneRef"), item.get("sceneIndex"), item.get("clipRef")) for item in active if item.get("trackRef") == track_ref]
        if any(item != expected for item in on_track):
            raise ValueError("track has foreign playback targets; guarded stop refused")
        if on_track:
            self._track_stop({"ref": track_ref})
        return {"stopped": True}

    def _tempo_set(self, args: dict[str, Any]) -> dict[str, Any]:
        reference, value, expected, expected_identity = args.get("ref"), args.get("value"), args.get("expectedTempo"), args.get("expectedObjectIdentity")
        if not isinstance(reference, str) or not isinstance(value, (int, float)) or isinstance(value, bool) or not isinstance(expected, (int, float)) or isinstance(expected, bool) or not isinstance(expected_identity, str):
            raise ValueError("tempo authority is invalid")
        if not self._capture_same_object(self.refs.get(reference), self.song, expected_identity) or not hmac.compare_digest(self._capture_object_identity(self.song), expected_identity) or float(self._read_attr(self.song, "tempo")) != float(expected):
            raise ValueError("Set identity or tempo changed since preview")
        if not math.isfinite(float(value)) or not 20 <= float(value) <= 999: raise ValueError("tempo value is outside authoritative bounds")
        setter_error: BaseException | None = None
        try: self.song.tempo = float(value)
        except BaseException as error: setter_error = error
        observed = self._read_attr(self.song, "tempo")
        if setter_error is not None or not isinstance(observed, (int, float)) or float(observed) != float(value):
            try: self.song.tempo = float(expected)
            except BaseException: pass
            restored = self._read_attr(self.song, "tempo")
            if not isinstance(restored, (int, float)) or float(restored) != float(expected): raise ValueError("tempo mutation failed and exact rollback failed") from setter_error
            raise ValueError("tempo mutation was not confirmed") from setter_error
        return {"changed": True, "tempo": float(observed), "revision": self.refs.touch(reference)}

    def _clip_launch(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:"):
            raise ValueError("clip reference is stale or invalid")
        target = self.refs.get(reference)
        if hasattr(target, "fire"):
            slot = target
        else:
            _, slot, _, _ = self._clip_location(reference)
        if getattr(slot, "clip", None) is None:
            raise ValueError("clip slot with a clip is required")
        fire = getattr(slot, "fire", None)
        if not callable(fire):
            raise ValueError("clip launch is unavailable")
        fire()
        return {"launched": reference, "targets": self._active_targets(self._playback())}

    def _track_stop(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:track:"):
            raise ValueError("track reference is stale or invalid")
        track = self.refs.get(reference)
        stop = getattr(track, "stop_all_clips", None)
        if not callable(stop):
            raise ValueError("track stop is unavailable")
        try:
            stop(False)
        except TypeError:
            stop()
        return {"stopped": True}

    def _capture_authority_revision(self) -> str:
        snapshot = self.snapshot(); tracks = []
        for track in snapshot.get("tracks", []):
            slots = [{key: slot.get(key) for key in ("ref", "objectIdentity", "sceneIndex", "clipRef", "empty")} for slot in track.get("clipSlots", [])]
            tracks.append({"ref": track.get("ref"), "objectIdentity": track.get("objectIdentity"), "slots": slots, "clips": track.get("clips", [])})
        authority = {"tracks": tracks, "scenes": [{"ref": scene.get("ref"), "objectIdentity": scene.get("objectIdentity"), "name": scene.get("name"), "index": scene.get("index")} for scene in snapshot.get("scenes", [])], "playbackRevision": snapshot.get("playback", {}).get("revision")}
        return hashlib.sha256(self._bounded_canonical(authority).encode("utf-8")).hexdigest()

    def _capture_midi(self, args: dict[str, Any]) -> dict[str, Any]:
        expected = args.get("expectedStateRevision")
        if not isinstance(expected, str) or not hmac.compare_digest(self._capture_authority_revision(), expected): raise ValueError("Session state changed since capture preview")
        capture = getattr(self.song, "capture_midi", None)
        if not callable(capture):
            raise ValueError("MIDI capture is unavailable")
        def occupied() -> set[tuple[int, int]]:
            filled: set[tuple[int, int]] = set()
            for track_index, track in enumerate(self._items(getattr(self.song, "tracks", []))):
                for slot_index, slot in enumerate(self._items(getattr(track, "clip_slots", []))):
                    if getattr(slot, "clip", None) is not None:
                        filled.add((track_index, slot_index))
            return filled
        before = occupied()
        if before: raise ValueError("MIDI capture requires globally empty Session slots for exact cleanup isolation")
        before_objects: dict[tuple[int, int], str] = {}; checkpoint = self.refs.checkpoint(); capture_error: BaseException | None = None
        try: capture()
        except BaseException as error: capture_error = error
        created_slots = [(track_index, slot_index, slot, getattr(slot, "clip", None)) for track_index, track in enumerate(self._items(getattr(self.song, "tracks", []))) for slot_index, slot in enumerate(self._items(getattr(track, "clip_slots", []))) if getattr(slot, "clip", None) is not None and (track_index, slot_index) not in before]
        try:
            if capture_error is not None: raise capture_error
            if len(created_slots) > 256: raise ValueError("MIDI capture created too many clips")
            captured: list[str] = []; identities: list[dict[str, str]] = []
            for track_index, slot_index, _, clip in created_slots:
                reference = self.refs.put("clip", clip, f"{track_index}:{slot_index}"); captured.append(reference); identities.append({"ref": reference, "objectIdentity": self._capture_object_identity(clip), "createdFingerprint": self._mapped_fingerprint(reference)})
            current_existing = {(track_index, slot_index): self._capture_object_identity(getattr(slot, "clip")) for track_index, track in enumerate(self._items(getattr(self.song, "tracks", []))) for slot_index, slot in enumerate(self._items(getattr(track, "clip_slots", []))) if (track_index, slot_index) in before and getattr(slot, "clip", None) is not None}
            if current_existing != before_objects: raise ValueError("MIDI capture changed pre-existing clips")
            return {"captured": bool(captured), "clips": captured, "clipIdentities": identities}
        except BaseException as error:
            rollback_failed = False
            for _, _, slot, clip in created_slots:
                current = getattr(slot, "clip", None); identity = self._capture_object_identity(clip)
                if current is not None and self._capture_same_object(current, clip, identity):
                    deleter = getattr(slot, "delete_clip", None)
                    if not callable(deleter): rollback_failed = True
                    else:
                        try: deleter()
                        except BaseException: pass
            if occupied() != before: rollback_failed = True
            if rollback_failed: raise ValueError("MIDI capture failed and exact transaction-owned cleanup failed") from error
            self.refs.restore(checkpoint); raise

    def _scene_capture(self, args: dict[str, Any]) -> dict[str, Any]:
        expected = args.get("expectedStateRevision")
        if not isinstance(expected, str) or not hmac.compare_digest(self._capture_authority_revision(), expected): raise ValueError("Session state changed since capture preview")
        capture = getattr(self.song, "capture_and_insert_scene", None)
        if not callable(capture):
            raise ValueError("scene capture is unavailable")
        before_scenes = self._items(getattr(self.song, "scenes", [])); before_identity_order = [self._capture_object_identity(scene) for scene in before_scenes]; before_identities = set(before_identity_order); baseline_topology = self._creation_topology(); checkpoint = self.refs.checkpoint(); capture_error: BaseException | None = None
        try: capture()
        except BaseException as error: capture_error = error
        try:
            after_scenes = self._items(getattr(self.song, "scenes", [])); created = [(index, scene, self._capture_object_identity(scene)) for index, scene in enumerate(after_scenes) if self._capture_object_identity(scene) not in before_identities]
            if capture_error is not None: raise capture_error
            if len(after_scenes) != len(before_scenes) + 1 or len(created) != 1: raise ValueError("scene capture did not produce one identity-distinct scene")
            inserted, scene, identity = created[0]
            if self._owned_positional_conflict("scene", inserted): raise ValueError("scene capture would shift active transaction-owned reference authority")
            expected_identity_order = list(before_identity_order); expected_identity_order.insert(inserted, identity)
            if [self._capture_object_identity(candidate) for candidate in after_scenes] != expected_identity_order: raise ValueError("scene capture reordered pre-existing scenes")
            created_ref = self.refs.put("scene", scene, str(inserted)); fingerprint = self._ownership_fingerprint(created_ref)
            return {"captured": True, "ref": created_ref, "objectIdentity": identity, "createdFingerprint": fingerprint}
        except BaseException as error:
            rollback_failed = False; deleter = getattr(self.song, "delete_scene", None); current = self._items(getattr(self.song, "scenes", [])); owned = [(index, scene) for index, scene in enumerate(current) if self._capture_object_identity(scene) not in before_identities]
            if owned and not callable(deleter): rollback_failed = True
            if callable(deleter):
                for index, _ in reversed(owned):
                    try: deleter(index)
                    except BaseException: pass
            if [self._capture_object_identity(scene) for scene in self._items(getattr(self.song, "scenes", []))] != before_identity_order or self._creation_topology() != baseline_topology: rollback_failed = True
            if rollback_failed: raise ValueError("scene capture failed and exact transaction-owned cleanup failed") from error
            self.refs.restore(checkpoint); raise

    def invoke(self, operation: str, args: dict[str, Any], transaction_id: str | None = None, ownership_token: str | None = None) -> Any:
        enforce_ownership = transaction_id is not None or self.provenance == "real-live"
        if enforce_ownership and operation in _TRANSACTION_CREATIONS.union(_TRANSACTION_DELETIONS) and (not isinstance(transaction_id, str) or not 8 <= len(transaction_id) <= 128): raise ValueError("mutation transaction identity is required")
        if enforce_ownership and operation in _TRANSACTION_CREATIONS:
            reserve = 256 if operation == "session.capture-midi" else 1
            if len(self._owned_cleanup_tokens) + reserve > 4096: raise ValueError("transaction-owned cleanup ledger is full")
        if enforce_ownership and operation in _TRANSACTION_DELETIONS: self._require_cleanup_ownership(operation, args, str(transaction_id), ownership_token)
        consumed_move_ownership: str | None = None
        if enforce_ownership and operation in {"clip.move", "arrangement.clip.move"} and isinstance(args.get("ref"), str):
            active = [(token, row) for token, row in self._owned_cleanup_tokens.items() if row.get("ref") == args["ref"] and row.get("deleted") is not True]
            if len(active) > 1: raise ValueError("transaction-owned move authority is ambiguous")
            if active:
                token, row = active[0]
                if (ownership_token is not None and ownership_token != token) or not hmac.compare_digest(self._ownership_fingerprint(args["ref"]), row["fingerprint"]): raise ValueError("transaction-owned move lacks exact cleanup-authority consumption")
                consumed_move_ownership = token
        creation_rollback: tuple[str, tuple[dict[str, Any], dict[str, int]], dict[str, dict[str, Any]]] | None = None
        if enforce_ownership and operation in _TRANSACTION_CREATIONS: creation_rollback = (self._creation_topology(), self.refs.checkpoint(), {token: dict(row) for token, row in self._owned_cleanup_tokens.items()})
        owned_content = None
        if enforce_ownership and operation in _OWNED_CONTENT_MUTATIONS and isinstance(args.get("ref"), str):
            matches = [row for row in self._owned_cleanup_tokens.values() if row.get("transactionId") == transaction_id and row.get("ref") == args["ref"] and row.get("deleted") is not True]
            if len(matches) > 1: raise ValueError("transaction-owned content authority is ambiguous")
            if matches:
                owned_content = matches[0]
                if not hmac.compare_digest(self._ownership_fingerprint(args["ref"]), owned_content["fingerprint"]): raise ValueError("transaction-owned content changed before mutation")
        try:
            result = self._invoke_operation(operation, args)
            if owned_content is not None: owned_content["fingerprint"] = self._ownership_fingerprint(str(args["ref"]))
        except BaseException:
            if owned_content is not None:
                try: owned_content["fingerprint"] = self._ownership_fingerprint(str(args["ref"]))
                except BaseException: pass
            if consumed_move_ownership is not None:
                row = self._owned_cleanup_tokens.get(consumed_move_ownership)
                try:
                    if row is None or not hmac.compare_digest(self._ownership_fingerprint(str(args["ref"])), row["fingerprint"]): self._owned_cleanup_tokens.pop(consumed_move_ownership, None)
                except BaseException: self._owned_cleanup_tokens.pop(consumed_move_ownership, None)
            raise
        if enforce_ownership and operation in _TRANSACTION_CREATIONS:
            try: result = self._attach_cleanup_ownership(operation, result, str(transaction_id))
            except BaseException as error:
                if creation_rollback is None: raise
                baseline, checkpoint, ownership_checkpoint = creation_rollback
                try: self._rollback_unattached_creation(operation, result, args, baseline, checkpoint)
                except BaseException as cleanup_error: raise ValueError("creation ownership attachment failed and exact physical cleanup failed") from cleanup_error
                self._owned_cleanup_tokens = ownership_checkpoint
                raise error
        if consumed_move_ownership is not None: self._owned_cleanup_tokens.pop(consumed_move_ownership, None)
        if enforce_ownership and operation in _TRANSACTION_DELETIONS and isinstance(ownership_token, str): self._owned_cleanup_tokens[ownership_token]["deleted"] = True
        if operation == "session.reconnect": self._owned_cleanup_tokens.clear()
        return result

    def _invoke_operation(self, operation: str, args: dict[str, Any]) -> Any:
        if operation in {"session.audition-launch", "session.clip-launch", "audio.capture.start"}: _require_output_safety(args)
        if operation == "session.audition-launch":
            return self._guarded_audition_launch(args)
        if operation == "session.audition-stop":
            return self._guarded_audition_stop(args)
        if operation == "session.emergency-stop":
            return self._guarded_emergency_stop(args)
        if operation == "transport.set":
            return self._transport_set(args)
        if operation == "session.clip-launch":
            return self._guarded_clip_launch(args)
        if operation == "session.clip-stop":
            return self._guarded_clip_stop(args)
        if operation == "tempo.set":
            return self._tempo_set(args)
        if operation == "session.capture-midi":
            return self._capture_midi(args)
        if operation == "note.update":
            return self._note_update(args)
        if operation == "note.delete":
            return self._note_delete(args)
        if operation == "clip.duplicate":
            return self._clip_duplicate(args)
        if operation == "clip.move":
            return self._clip_duplicate(args, True)
        if operation == "arrangement.clip.create":
            return self._arrangement_clip_create(args)
        if operation == "arrangement.clip.delete":
            return self._arrangement_clip_delete(args)
        if operation == "arrangement.clip.move":
            return self._arrangement_clip_move(args)
        if operation == "audio.clip.set":
            return self._audio_clip_set(args)
        if operation == "clip.set":
            return self._clip_set(args)
        if operation == "clip.action":
            return self._clip_action(args)
        if operation == "session.audio-clip.create":
            return self._session_audio_clip_create(args)
        if operation == "automation.envelope.clear":
            return self._automation_envelope_clear(args)
        if operation == "note.read-by-id":
            return self._note_read_by_id(args)
        if operation == "note.read-selected":
            return self._note_read_selected(args)
        if operation == "note.duplicate":
            return self._note_duplicate(args)
        if operation == "note.quantize":
            return self._note_quantize(args)
        if operation == "audio.warp-marker.read":
            return self._warp_marker_read(args)
        if operation in {"audio.warp-marker.add", "audio.warp-marker.move", "audio.warp-marker.delete"}:
            return self._warp_marker_mutate(operation, args)
        if operation == "audio.take-lane.read":
            return self._take_lane_read(args)
        if operation == "tuning.read":
            return self._tuning_read(args)
        if operation == "tuning.set":
            return self._tuning_set(args)
        if operation == "groove.read":
            return self._groove_read(args)
        if operation == "groove.set":
            return self._groove_set(args)
        if operation == "groove.edit":
            return self._groove_edit(args)
        if operation == "scene.set":
            return self._scene_set(args)
        if operation == "scene.fire-selected":
            return self._scene_fire_selected(args)
        if operation == "song.read":
            return self._song_read(args)
        if operation == "transport.action":
            return self._transport_action(args)
        if operation == "locator.jump-to":
            return self._locator_jump_to(args)
        if operation == "song.time-convert":
            return self._song_time_convert(args)
        if operation == "track.create-return":
            return self._track_create_return(args)
        if operation == "track.delete-return":
            return self._track_delete_return(args)
        if operation == "track.duplicate":
            return self._track_duplicate(args)
        if operation == "scene.duplicate":
            return self._scene_duplicate(args)
        if operation == "track.view.set":
            return self._track_view_set(args)
        if operation == "track.select-instrument":
            return self._track_select_instrument(args)
        if operation == "selection.set":
            return self._selection_set(args)
        if operation == "song.view.set":
            return self._song_view_set(args)
        if operation == "clip.view.set":
            return self._clip_view_set(args)
        if operation == "device.view.set":
            return self._device_view_set(args)
        if operation == "application.dialog":
            return self._application_dialog(args)
        if operation == "performance.read":
            return self._performance_read(args)
        if operation == "take-lane.create":
            return self._take_lane_create(args)
        if operation == "take-lane.rename":
            return self._take_lane_rename(args)
        if operation in {"take-lane.clip.create", "take-lane.audio-clip.create"}:
            return self._take_lane_clip_create(args, audio=operation == "take-lane.audio-clip.create")
        if operation == "arrangement.audio-clip.create":
            return self._arrangement_audio_clip_create(args)
        if operation == "locator.jump":
            return self._locator_jump(args)
        if operation == "view.set":
            return self._view_set(args)
        if operation == "view.control":
            return self._view_control(args)
        if operation == "audio.capture.inspect":
            return self._capture_inspect(args)
        if operation == "audio.capture.start":
            return self._capture_start(args)
        if operation == "audio.capture.stop":
            return self._capture_stop(args)
        if operation == "audio.capture.status":
            return self._capture_status()
        if operation == "audio.capture.emergency-stop":
            return self._capture_emergency_stop(args)
        if operation == "audio.capture.cleanup":
            return self._capture_cleanup(args)
        if operation == "mixer.set":
            return self._mixer_set(args)
        if operation == "automation.envelope.read":
            return self._envelope_read(args)
        if operation == "automation.envelope.create":
            return self._envelope_create(args)
        if operation == "automation.envelope.delete":
            return self._envelope_delete(args)
        if operation == "automation.point.insert":
            return self._envelope_point_insert(args)
        if operation == "automation.point.delete":
            return self._envelope_point_delete(args)
        if operation == "device.insert":
            return self._device_insert(args)
        if operation == "device.delete":
            return self._device_delete(args)
        if operation == "device.enable":
            return self._device_enable(args)
        if operation == "device.move":
            return self._device_move(args)
        if operation == "browser.search":
            return self._browser_search(args)
        if operation == "browser.inspect":
            return self._browser_inspect(args)
        if operation == "browser.load":
            return self._browser_load(args)
        if operation == "routing.set":
            return self._routing_set(args)
        if operation == "recording.session":
            return self._recording_session(args)
        if operation == "recording.arrangement":
            return self._recording_arrangement(args)
        if operation == "scene.capture":
            return self._scene_capture(args)
        if operation == "session.playback":
            return self._playback()
        if operation == "session.discover":
            if not isinstance(args, dict) or set(args) - {"kind", "limit", "cursor", "parent", "filters", "requestedFields", "traversalBudget"}:
                raise ValueError("discovery arguments are invalid")
            if any(key in args and args[key] is not None and not isinstance(args[key], expected) for key, expected in (("kind", str), ("limit", int), ("cursor", str), ("parent", str), ("filters", dict), ("requestedFields", list), ("traversalBudget", int))):
                raise ValueError("discovery arguments are invalid")
            return self.discover(args.get("kind", "track"), args.get("limit", 100), args.get("cursor"), args.get("parent"), args.get("filters"), args.get("requestedFields"), args.get("traversalBudget", 1000))
        if operation == "session.status":
            return self.status()
        if operation == "session.reconnect":
            self.refs.reset()
            self._playback_state_digest = None
            self._playback_revision_counter = 0
            return self.status()
        if operation in {"locator.add", "arrangement.locator.create"}:
            return self._locator_mutate(args, delete=False)
        if operation in {"locator.delete", "arrangement.locator.delete"}:
            return self._locator_mutate(args, delete=True)
        if operation in {"clip.create", "clip.delete", "note.add", "note.add-batch"}:
            return self._mutate(operation, args)
        if operation in {"track.create", "track.delete", "scene.create", "scene.delete"}:
            return self._structure_mutate(operation, args)
        if operation in {"track.rename", "scene.rename", "clip.rename", "device.rename", "locator.rename"}:
            return self._rename(operation, args)
        if operation == "device.parameter.set":
            reference, expected = str(args.get("ref")), args.get("expectedRevision")
            authority = self._realtime_parameter_authority(reference)
            expected_authority = {
                "ref": reference,
                "parameterIdentity": args.get("expectedObjectIdentity"),
                "ownerRef": args.get("expectedOwnerRef"),
                "ownerIdentity": args.get("expectedOwnerIdentity"),
                "trackRef": args.get("expectedTrackRef"),
                "trackIdentity": args.get("expectedTrackIdentity"),
                "siblings": args.get("expectedSiblings"),
            }
            if any(not isinstance(expected_authority[key], str) for key in ("parameterIdentity", "ownerRef", "ownerIdentity", "trackRef", "trackIdentity")) or not isinstance(expected_authority["siblings"], list) or not hmac.compare_digest(self._bounded_canonical(authority), self._bounded_canonical(expected_authority)):
                raise ValueError("parameter identity or hierarchy changed since preview")
            if not isinstance(expected, int) or isinstance(expected, bool) or self.refs.revision(reference) != expected:
                raise ValueError("parameter revision changed since preview")
            return self._set_parameter_value(reference, args.get("value"))
        raise ValueError("live operation unavailable")

    def _rename_authority_revision(self, kind: str, reference: str) -> str:
        if kind in {"track", "scene"}: return self._structure_revision()
        if kind == "locator": return hashlib.sha256(self._bounded_canonical(self._locator_items()).encode("utf-8")).hexdigest()
        if kind == "clip":
            authority = self._session_clip_authority(reference) if reference.startswith(f"{self.refs.epoch}:clip:") else {"expectedObjectIdentity": self.get(reference).get("objectIdentity"), "expectedAuthorityRevision": self._arrangement_clip_authority_revision(reference)}
            return hashlib.sha256(self._bounded_canonical(authority).encode("utf-8")).hexdigest()
        if kind == "device":
            snapshot = self.snapshot()
            def visit(values: Any, owner_ref: str, owner_identity: str, track: dict[str, Any]) -> dict[str, Any] | None:
                if not isinstance(values, list): return None
                siblings = [{"ref": item.get("ref"), "objectIdentity": item.get("objectIdentity")} for item in values if isinstance(item, dict)]
                for item in values:
                    if not isinstance(item, dict): continue
                    if item.get("ref") == reference: return {"ref": item.get("ref"), "objectIdentity": item.get("objectIdentity"), "trackRef": track.get("ref"), "trackIdentity": track.get("objectIdentity"), "ownerRef": owner_ref, "ownerIdentity": owner_identity, "siblings": siblings}
                    for chain in item.get("chains", []):
                        found = visit(chain.get("devices", []), chain.get("ref"), chain.get("objectIdentity"), track)
                        if found is not None: return found
                    for pad in item.get("drumPads", []):
                        for chain in pad.get("chains", []):
                            found = visit(chain.get("devices", []), chain.get("ref"), chain.get("objectIdentity"), track)
                            if found is not None: return found
                return None
            for track in snapshot.get("tracks", []):
                found = visit(track.get("devices", []), track.get("ref"), track.get("objectIdentity"), track)
                if found is not None: return hashlib.sha256(self._bounded_canonical(found).encode("utf-8")).hexdigest()
            raise ValueError("device rename hierarchy is unavailable")
        raise ValueError("rename authority kind is unsupported")

    def _rename(self, operation: str, args: dict[str, Any]) -> dict[str, Any]:
        reference, name, expected_name, expected_identity = args.get("ref"), args.get("name"), args.get("expectedName"), args.get("expectedObjectIdentity")
        kind = operation.split(".", 1)[0]
        if not isinstance(reference, str) or f":{kind}:" not in reference or not isinstance(name, str) or not 1 <= len(name) <= 256 or not isinstance(expected_name, str) or not isinstance(expected_identity, str):
            raise ValueError("rename authority is invalid")
        authoritative = self.get(reference)
        if not isinstance(authoritative, dict) or authoritative.get("ref") != reference or not hmac.compare_digest(str(authoritative.get("objectIdentity", "")), expected_identity):
            raise ValueError("rename target identity changed since preview")
        expected_authority = args.get("expectedAuthorityRevision")
        if not isinstance(expected_authority, str) or not hmac.compare_digest(self._rename_authority_revision(kind, reference), expected_authority): raise ValueError("rename hierarchy changed since preview")
        target = self.refs.get(reference)
        if not hasattr(target, "name") or str(getattr(target, "name", "")) != expected_name:
            raise ValueError("rename target changed since preview")
        if kind == "track":
            tracks = self._all_track_objects()
            if sum(1 for candidate in tracks if self._capture_same_object(candidate, target, expected_identity)) != 1: raise ValueError("rename track is stale or ambiguous")
        if kind == "scene" and sum(1 for candidate in self._items(getattr(self.song, "scenes", [])) if self._capture_same_object(candidate, target, expected_identity)) != 1: raise ValueError("rename scene is stale or ambiguous")
        if kind == "locator" and sum(1 for candidate in self._items(getattr(self.song, "cue_points", [])) if self._capture_same_object(candidate, target, expected_identity)) != 1: raise ValueError("rename locator is stale or ambiguous")
        if kind == "clip":
            arrangement_rows = self._arrangement_clip_items(); current_clips = [getattr(slot, "clip", None) for track in self._items(getattr(self.song, "tracks", [])) for slot in self._items(getattr(track, "clip_slots", []))] + [self.refs.get(row["ref"]) for row in arrangement_rows]
            if sum(1 for candidate in current_clips if self._capture_same_object(candidate, target, expected_identity)) != 1: raise ValueError("rename clip is stale or ambiguous")
        if kind == "device":
            matching_rows = [device for track in self.snapshot()["tracks"] for device in self._flatten_device_rows(track.get("devices", [])) if device.get("objectIdentity") == expected_identity]
            if len(matching_rows) != 1 or matching_rows[0].get("ref") != reference: raise ValueError("rename device is stale or ambiguous")
        rename_error: BaseException | None = None
        try: target.name = name
        except BaseException as error: rename_error = error
        if rename_error is not None or str(getattr(target, "name", "")) != name:
            try: target.name = expected_name
            except BaseException: pass
            if str(getattr(target, "name", "")) != expected_name: raise ValueError("rename failed and exact rollback failed") from rename_error
            raise ValueError("rename postcondition was not confirmed") from rename_error
        return {"renamed": reference, "name": name}

    def _structure_revision(self) -> str:
        snapshot = self.snapshot()
        identity = {"tracks": [[item["ref"], item.get("objectIdentity"), item["name"], item["kind"], index] for index, item in enumerate(snapshot["tracks"])], "scenes": [[item["ref"], item.get("objectIdentity"), item["name"], index] for index, item in enumerate(snapshot["scenes"])]}
        return hashlib.sha256(json.dumps(identity, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()

    def _owned_positional_conflict(self, axis: str, index: int, strict: bool = False, exclude_token: str | None = None) -> bool:
        for token, row in self._owned_cleanup_tokens.items():
            if token == exclude_token or row.get("deleted") is True: continue
            reference = str(row.get("ref", "")); parts = reference.split(":")
            if len(parts) < 3 or parts[0] != str(self.refs.epoch): continue
            kind, path = parts[1], parts[2:]; position: int | None = None
            if axis == "track" and kind in {"track", "clip", "arrangement_clip", "device"} and path and path[0].isdigit(): position = int(path[0])
            if axis == "scene" and kind == "scene" and path and path[0].isdigit(): position = int(path[0])
            if axis == "scene" and kind == "clip" and len(path) >= 2 and path[1].isdigit(): position = int(path[1])
            if position is not None and (position > index if strict else position >= index): return True
        return False

    def _structure_create_atomic(self, kind: str, index: int, name: str, creator: Callable[[int], Any]) -> dict[str, Any]:
        attribute = "tracks" if kind == "track" else "scenes"; before = self._items(getattr(self.song, attribute, [])); before_identities = [self._capture_object_identity(item) for item in before]; baseline_topology = self._creation_topology()
        if len(set(before_identities)) != len(before_identities): raise ValueError(f"{kind} collection identity is ambiguous")
        checkpoint = self.refs.checkpoint(); creation_error: BaseException | None = None
        try: creator(index)
        except BaseException as error: creation_error = error
        after = self._items(getattr(self.song, attribute, [])); created = [(position, item, self._capture_object_identity(item)) for position, item in enumerate(after) if self._capture_object_identity(item) not in set(before_identities)]
        try:
            if creation_error is not None: raise creation_error
            if len(after) != len(before) + 1 or len(created) != 1 or created[0][0] != index: raise ValueError(f"{kind} creation did not produce one exact identity-distinct object")
            position, item, identity = created[0]; expected_identity_order = list(before_identities); expected_identity_order.insert(position, identity)
            if [self._capture_object_identity(candidate) for candidate in after] != expected_identity_order: raise ValueError(f"{kind} creation reordered pre-existing objects")
            if hasattr(item, "name"): item.name = name
            if str(getattr(item, "name", name)) != name: raise ValueError(f"{kind} creation name was not confirmed")
            reference = self.refs.put(kind, item, str(position)); fingerprint = self._ownership_fingerprint(reference)
            return {"ref": reference, "objectIdentity": identity, "name": str(getattr(item, "name", name)), "index": position, "createdFingerprint": fingerprint}
        except BaseException as error:
            rollback_failed = False; deleter = getattr(self.song, "delete_track" if kind == "track" else "delete_scene", None)
            current = self._items(getattr(self.song, attribute, [])); new_rows = [(position, item) for position, item in enumerate(current) if self._capture_object_identity(item) not in set(before_identities)]
            if new_rows and not callable(deleter): rollback_failed = True
            if callable(deleter):
                for position, _ in reversed(new_rows):
                    try: deleter(position)
                    except BaseException: pass
            if [self._capture_object_identity(item) for item in self._items(getattr(self.song, attribute, []))] != before_identities or self._creation_topology() != baseline_topology: rollback_failed = True
            if rollback_failed:
                try: self.snapshot()
                except BaseException: pass
                raise ValueError(f"{kind} creation failed and exact rollback failed") from error
            self.refs.restore(checkpoint); raise

    def _structure_mutate(self, operation: str, args: dict[str, Any]) -> dict[str, Any]:
        expected_revision = args.get("expectedStructureRevision")
        if not isinstance(expected_revision, str) or expected_revision != self._structure_revision():
            raise ValueError("Session structure changed since preview")
        if operation == "track.create":
            name, kind, index = args.get("name"), args.get("kind"), args.get("index")
            if not isinstance(name, str) or not 1 <= len(name) <= 128 or kind not in {"audio", "midi"}:
                raise ValueError("track name or kind is invalid")
            tracks = self._items(getattr(self.song, "tracks", []))
            if any(str(getattr(track, "name", "")) == name for track in tracks): raise ValueError("track name already exists")
            if index is None: index = len(tracks)
            if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index <= len(tracks): raise ValueError("track index is invalid")
            if self._owned_positional_conflict("track", index): raise ValueError("track insertion would shift active transaction-owned reference authority")
            creator = getattr(self.song, "create_midi_track" if kind == "midi" else "create_audio_track", None)
            if not callable(creator): raise ValueError("track creation is unavailable")
            return {**self._structure_create_atomic("track", index, name, creator), "kind": kind}
        if operation == "scene.create":
            name, index = args.get("name"), args.get("index")
            scenes = self._items(getattr(self.song, "scenes", []))
            if not isinstance(name, str) or not 1 <= len(name) <= 128 or any(str(getattr(scene, "name", "")) == name for scene in scenes): raise ValueError("scene name is invalid or already exists")
            if index is None: index = len(scenes)
            if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index <= len(scenes): raise ValueError("scene index is invalid")
            if self._owned_positional_conflict("scene", index): raise ValueError("scene insertion would shift active transaction-owned reference authority")
            creator = getattr(self.song, "create_scene", None)
            if not callable(creator): raise ValueError("scene creation is unavailable")
            return self._structure_create_atomic("scene", index, name, creator)
        reference = args.get("ref")
        if not isinstance(reference, str): raise ValueError("object reference is required")
        kind = "track" if operation == "track.delete" else "scene"
        collection = self._items(getattr(self.song, "tracks" if kind == "track" else "scenes", []))
        current_row = next(((index, item) for index, item in enumerate(collection) if self.refs.put(kind, item, str(index)) == reference), None)
        expected_identity = args.get("expectedObjectIdentity")
        if current_row is None or not isinstance(expected_identity, str) or not expected_identity: raise ValueError("object is not a current identity-bound Session object")
        index, obj = current_row
        if not hmac.compare_digest(expected_identity, self._capture_object_identity(obj)): raise ValueError("Session object identity changed; deletion refused")
        deleter = getattr(self.song, "delete_track" if operation == "track.delete" else "delete_scene", None)
        if not callable(deleter): raise ValueError("object deletion is unavailable")
        before_identity_order = [self._capture_object_identity(item) for item in collection]; expected_identity_order = list(before_identity_order); expected_identity_order.pop(index); deletion_error: BaseException | None = None
        try: deleter(index)
        except BaseException as error: deletion_error = error
        after = self._items(getattr(self.song, "tracks" if kind == "track" else "scenes", [])); after_identity_order = [self._capture_object_identity(item) for item in after]
        if after_identity_order != expected_identity_order: raise ValueError("Session object deletion did not preserve exact remaining sibling order") from deletion_error
        self.refs.delete(reference)
        return {"deleted": reference}

    def _locator_mutate(self, args: dict[str, Any], delete: bool) -> dict[str, Any]:
        if not self._locator_supported():
            raise ValueError("Arrangement locators are unavailable")
        current_items = self._locator_items(); current_revision = hashlib.sha256(self._bounded_canonical(current_items).encode("utf-8")).hexdigest()
        if not isinstance(args.get("expectedCollectionRevision"), str) or not hmac.compare_digest(current_revision, args["expectedCollectionRevision"]):
            raise ValueError("locator collection changed since preview")
        if delete:
            reference = args.get("ref")
            if not isinstance(reference, str):
                raise ValueError("locator reference is required")
            locator = self.refs.get(reference)
            expected_identity = args.get("expectedObjectIdentity")
            if not isinstance(expected_identity, str) or not hmac.compare_digest(self._capture_object_identity(locator), expected_identity):
                raise ValueError("locator identity changed; deletion refused")
            position = getattr(locator, "time", getattr(locator, "position", None))
            if not isinstance(position, (int, float)) or not math.isfinite(float(position)):
                raise ValueError("locator position is invalid")
            native_before = self._items(getattr(self.song, "cue_points", [])); native_matches = [index for index, candidate in enumerate(native_before) if self._capture_same_object(candidate, locator, expected_identity)]
            if len(native_matches) != 1: raise ValueError("locator native hierarchy is ambiguous")
            expected_native_order = [self._capture_object_identity(candidate) for candidate in native_before]; expected_native_order.pop(native_matches[0]); expected_rows = [{key: row.get(key) for key in ("objectIdentity", "name", "position")} for row in current_items if row.get("ref") != reference]; deletion_error: BaseException | None = None
            try: self.song.set_or_delete_cue(float(position))
            except BaseException as error: deletion_error = error
            native_after_order = [self._capture_object_identity(candidate) for candidate in self._items(getattr(self.song, "cue_points", []))]; after_items = self._locator_items(); after_rows = [{key: row.get(key) for key in ("objectIdentity", "name", "position")} for row in after_items]
            if native_after_order != expected_native_order or self._bounded_canonical(after_rows) != self._bounded_canonical(expected_rows): raise ValueError("locator deletion was not confirmed exactly") from deletion_error
            self.refs.delete(reference)
            return {"deleted": reference}
        name = args.get("name")
        position = args.get("position")
        if not isinstance(name, str) or not 1 <= len(name) <= 128 or not isinstance(position, (int, float)) or isinstance(position, bool) or not math.isfinite(float(position)) or not 0 <= float(position) <= 100000:
            raise ValueError("locator name or position is invalid")
        if any(item["name"] == name or item["position"] == float(position) for item in self._locator_items()):
            raise ValueError("locator target collides with existing state")
        before = self._locator_items(); before_identities = [row["objectIdentity"] for row in before]; checkpoint = self.refs.checkpoint(); mutation_error: BaseException | None = None
        try: self.song.set_or_delete_cue(float(position))
        except BaseException as error: mutation_error = error
        try:
            after = self._locator_items(); created = [item for item in after if item.get("objectIdentity") not in set(before_identities)]
            if mutation_error is not None: raise mutation_error
            if len(after) != len(before) + 1 or len(created) != 1 or created[0]["position"] != float(position): raise RuntimeError("Live did not confirm one identity-distinct locator creation")
            locator = self.refs.get(created[0]["ref"])
            if hasattr(locator, "name"): locator.name = name
            if str(getattr(locator, "name", "")) != name: raise ValueError("locator name was not confirmed")
            return {"ref": created[0]["ref"], "objectIdentity": self._capture_object_identity(locator), "name": name, "position": float(position), "createdFingerprint": self._ownership_fingerprint(created[0]["ref"])}
        except BaseException as error:
            rollback_failed = False; current = self._locator_items(); owned = [row for row in current if row.get("objectIdentity") not in set(before_identities)]
            for row in owned:
                try: self.song.set_or_delete_cue(float(row["position"]))
                except BaseException: pass
            restored = self._locator_items()
            if self._bounded_canonical([{key: row.get(key) for key in ("objectIdentity", "name", "position")} for row in restored]) != self._bounded_canonical([{key: row.get(key) for key in ("objectIdentity", "name", "position")} for row in before]): rollback_failed = True
            if rollback_failed: raise ValueError("locator creation failed and exact rollback failed") from error
            self.refs.restore(checkpoint); raise

    def _mutate(self, operation: str, args: dict[str, Any]) -> Any:
        if operation == "clip.create":
            track_ref = str(args["trackRef"]); self.snapshot(); track = self.refs.get(track_ref)
            if not bool(getattr(track, "has_midi_input", False)):
                raise ValueError("target track is not MIDI-capable")
            slots = self._items(getattr(track, "clip_slots", [])); scenes = self._items(getattr(self.song, "scenes", []))
            if not isinstance(args.get("sceneIndex"), int) or isinstance(args["sceneIndex"], bool):
                raise ValueError("scene index is invalid")
            index = args["sceneIndex"]
            if not 0 <= index < len(slots) or index >= len(scenes):
                raise ValueError("scene index is invalid")
            slot = slots[index]; scene = scenes[index]; track_index = self._capture_index(self._items(getattr(self.song, "tracks", [])), track)
            if track_index is None or track_ref != f"{self.refs.epoch}:track:{track_index}": raise ValueError("clip creation track hierarchy is stale")
            current_authority = {"trackIdentity": self._capture_object_identity(track), "slotRef": self.refs.put("clip_slot", slot, f"{track_index}:{index}"), "slotIdentity": self._capture_object_identity(slot), "sceneRef": self.refs.put("scene", scene, str(index)), "sceneIdentity": self._capture_object_identity(scene)}
            expected_authority = {"trackIdentity": args.get("expectedTrackIdentity"), "slotRef": args.get("expectedSlotRef"), "slotIdentity": args.get("expectedSlotIdentity"), "sceneRef": args.get("expectedSceneRef"), "sceneIdentity": args.get("expectedSceneIdentity")}
            if not all(isinstance(value, str) for value in expected_authority.values()) or not hmac.compare_digest(self._bounded_canonical(current_authority), self._bounded_canonical(expected_authority)):
                raise ValueError("clip creation target identity changed since preview")
            if getattr(slot, "clip", None) is not None:
                raise ValueError("session slot is occupied")
            length = args.get("length")
            if not isinstance(length, (int, float)) or isinstance(length, bool) or not math.isfinite(float(length)) or not 0 < float(length) <= 1024:
                raise ValueError("clip length is invalid")
            name = args.get("name")
            if not isinstance(name, str) or not 1 <= len(name) <= 256:
                raise ValueError("clip name is invalid")
            checkpoint = self.refs.checkpoint()
            try:
                clip = slot.create_clip(float(length)); clip = clip if clip is not None else getattr(slot, "clip", None)
                if clip is None: raise ValueError("clip creation was not confirmed")
                if hasattr(clip, "name"): clip.name = name
                if str(getattr(clip, "name", "")) != name or not isinstance(self._read_attr(clip, "length"), (int, float)) or float(self._read_attr(clip, "length")) != float(length): raise ValueError("clip creation name or length was not confirmed")
                created_ref = self.refs.put("clip", clip, f"{track_index}:{index}"); created_identity = self._capture_object_identity(clip); fingerprint = self._mapped_fingerprint(created_ref)
                return {"ref": created_ref, "objectIdentity": created_identity, "name": getattr(clip, "name", ""), "length": float(getattr(clip, "length", length)), "createdFingerprint": fingerprint}
            except BaseException as error:
                rollback_failed = False; current = getattr(slot, "clip", None); deleter = getattr(slot, "delete_clip", None)
                if current is not None:
                    if not callable(deleter): rollback_failed = True
                    else:
                        try: deleter()
                        except BaseException: pass
                if getattr(slot, "clip", None) is not None: rollback_failed = True
                if rollback_failed: raise ValueError("clip creation failed and exact transaction-owned cleanup failed") from error
                self.refs.restore(checkpoint); raise
        if operation == "clip.delete":
            authority = self._session_clip_authority(str(args["ref"])); _, slot, _, _ = self._clip_location(str(args["ref"])); clip = getattr(slot, "clip", None)
            if clip is None or not callable(getattr(slot, "delete_clip", None)):
                raise ValueError("clip reference is not deletable")
            expected = {key: args.get(key) for key in authority}
            if not all(isinstance(value, str) for value in expected.values()) or not hmac.compare_digest(self._bounded_canonical(authority), self._bounded_canonical(expected)):
                raise ValueError("clip hierarchy identity changed; deletion refused")
            deletion_error: BaseException | None = None
            try: slot.delete_clip()
            except BaseException as error: deletion_error = error
            current = getattr(slot, "clip", None); clip_identity = self._capture_object_identity(clip)
            if current is not None and self._capture_same_object(current, clip, clip_identity): raise ValueError("clip deletion was not confirmed") from deletion_error
            if current is not None: raise ValueError("clip slot changed unexpectedly during deletion") from deletion_error
            self.refs.delete(str(args["ref"])); return {"deleted": args["ref"]}
        clip = self.refs.get(str(args["ref"]))
        if operation == "note.add-batch":
            if not isinstance(args.get("notes"), list) or not 1 <= len(args["notes"]) <= 512:
                raise ValueError("note batch is invalid")
            return self._note_add_batch(args)
        if not isinstance(args.get("note"), dict):
            raise ValueError("note is invalid")
        return self._note_add(args)

    def _clip_location(self, reference: str) -> tuple[Any, Any, int, int]:
        """Resolve a clip or clip-slot reference to (track, slot, track_index,
        slot_index) through its traversal key, independent of proxy identity."""
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:"):
            raise ValueError("clip reference is stale or invalid")
        segments = reference.split(":")
        kind = segments[1] if len(segments) >= 3 else ""
        key = ":".join(segments[2:]) if len(segments) >= 3 else ""
        parts = key.split(":")
        if kind not in {"clip", "clip_slot"} or len(parts) != 2 or not all(part.isdigit() for part in parts):
            raise ValueError("clip reference is not a Session clip slot")
        track_index, slot_index = int(parts[0]), int(parts[1])
        tracks = self._items(getattr(self.song, "tracks", []))
        if not 0 <= track_index < len(tracks):
            raise ValueError("clip reference track is stale")
        slots = self._items(getattr(tracks[track_index], "clip_slots", []))
        if not 0 <= slot_index < len(slots):
            raise ValueError("clip reference slot is stale")
        return tracks[track_index], slots[slot_index], track_index, slot_index

    def _session_clip_authority(self, reference: str) -> dict[str, str]:
        track, slot, track_index, slot_index = self._clip_location(reference)
        clip = getattr(slot, "clip", None); scenes = self._items(getattr(self.song, "scenes", []))
        if clip is None or slot_index >= len(scenes): raise ValueError("clip hierarchy is stale")
        scene = scenes[slot_index]
        return {
            "expectedObjectIdentity": self._capture_object_identity(clip),
            "expectedTrackRef": self.refs.put("track", track, str(track_index)),
            "expectedTrackIdentity": self._capture_object_identity(track),
            "expectedSlotRef": self.refs.put("clip_slot", slot, f"{track_index}:{slot_index}"),
            "expectedSlotIdentity": self._capture_object_identity(slot),
            "expectedSceneRef": self.refs.put("scene", scene, str(slot_index)),
            "expectedSceneIdentity": self._capture_object_identity(scene),
        }

    def _arrangement_location(self, reference: str) -> tuple[Any, Any, int, int]:
        """Resolve an arrangement-clip reference to (track, clip, track_index,
        clip_index) through its traversal key."""
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:arrangement_clip:"):
            raise ValueError("arrangement clip reference is stale or invalid")
        segments = reference.split(":")
        key = ":".join(segments[2:]) if len(segments) >= 3 else ""
        parts = key.split(":")
        if len(parts) != 2 or not all(part.isdigit() for part in parts):
            raise ValueError("arrangement clip reference is malformed")
        track_index, clip_index = int(parts[0]), int(parts[1])
        tracks = self._items(getattr(self.song, "tracks", [])) + self._items(getattr(self.song, "return_tracks", []))
        if not 0 <= track_index < len(tracks):
            raise ValueError("arrangement clip track is stale")
        clips = self._items(self._read_attr(tracks[track_index], "arrangement_clips") or [])
        if not 0 <= clip_index < len(clips):
            raise ValueError("arrangement clip is stale")
        return tracks[track_index], clips[clip_index], track_index, clip_index

    def _take_lane_rows(self, track: Any, track_index: int) -> list[dict[str, Any]]:
        lanes = self._items(self._read_attr(track, "take_lanes") or [])
        if len(lanes) > 64: raise ValueError("take-lane collection exceeds its bound")
        rows = []
        for lane_index, lane in enumerate(lanes):
            clips = self._items(self._read_attr(lane, "arrangement_clips") or [])
            if len(clips) > 256: raise ValueError("take-lane clip collection exceeds its bound")
            clip_rows = []
            for clip_index, clip in enumerate(clips):
                reference = self.refs.put("take_lane_clip", clip, f"{track_index}:{lane_index}:{clip_index}")
                notes = self._read_notes(clip)
                row = {"ref": reference, "objectIdentity": self._capture_object_identity(clip), "parentRef": self.refs.put("take_lane", lane, f"{track_index}:{lane_index}"), "takeLaneRef": self.refs.put("take_lane", lane, f"{track_index}:{lane_index}"), "name": str(getattr(clip, "name", "")), "kind": "midi" if hasattr(clip, "add_new_notes") else "audio", "start": float(getattr(clip, "start_time", getattr(clip, "start", 0.0)) or 0.0), "length": float(getattr(clip, "length", 0.0) or 0.0), "notes": notes, "notesRevision": hashlib.sha256(self._bounded_canonical(notes).encode("utf-8")).hexdigest(), **self._audio_fields(clip)}
                for key, value in self._clip_state_fields(clip).items():
                    if value is not None or key not in row: row[key] = value
                if row.get("isTakeLaneClip") is None: row["isTakeLaneClip"] = True
                clip_rows.append(row)
            lane_ref = self.refs.put("take_lane", lane, f"{track_index}:{lane_index}")
            rows.append({"ref": lane_ref, "objectIdentity": self._capture_object_identity(lane), "parentRef": self.refs.put("track", track, str(track_index)), "trackRef": self.refs.put("track", track, str(track_index)), "name": str(getattr(lane, "name", "")), "index": lane_index, "clips": clip_rows})
        return rows

    def _take_lane_collection_revision(self, track: Any, track_index: int) -> str:
        lanes = self._items(self._read_attr(track, "take_lanes") or []); siblings = [{"ref": self.refs.put("take_lane", lane, f"{track_index}:{index}"), "objectIdentity": self._capture_object_identity(lane), "name": str(getattr(lane, "name", ""))} for index, lane in enumerate(lanes)]
        if len(siblings) > 64: raise ValueError("take-lane collection exceeds authority bound")
        return hashlib.sha256(self._bounded_canonical(siblings).encode("utf-8")).hexdigest()

    def _take_lane_clip_collection_revision(self, lane: Any, lane_ref: str) -> str:
        path = ":".join(lane_ref.split(":")[2:]); clips = self._items(self._read_attr(lane, "arrangement_clips") or []); siblings = [{"ref": self.refs.put("take_lane_clip", clip, f"{path}:{index}"), "objectIdentity": self._capture_object_identity(clip)} for index, clip in enumerate(clips)]
        if len(siblings) > 256: raise ValueError("take-lane clip collection exceeds authority bound")
        return hashlib.sha256(self._bounded_canonical(siblings).encode("utf-8")).hexdigest()

    def _take_lane_location(self, reference: str) -> tuple[Any, Any, int, int]:
        parts = reference.split(":"); key = parts[2:] if len(parts) > 2 else []
        if len(key) < 2 or not all(part.isdigit() for part in key[:2]): raise ValueError("take-lane reference is stale or invalid")
        track_index, lane_index = int(key[0]), int(key[1]); tracks = self._items(getattr(self.song, "tracks", []))
        if track_index >= len(tracks): raise ValueError("take-lane track hierarchy changed")
        track = tracks[track_index]; lanes = self._items(self._read_attr(track, "take_lanes") or [])
        if lane_index >= len(lanes): raise ValueError("take-lane hierarchy changed")
        return track, lanes[lane_index], track_index, lane_index

    def _arrangement_collection_revision(self, track: Any, track_index: int) -> str:
        clips = self._items(self._read_attr(track, "arrangement_clips") or []); siblings = [{"ref": self.refs.put("arrangement_clip", clip, f"{track_index}:{index}"), "objectIdentity": self._capture_object_identity(clip)} for index, clip in enumerate(clips)]
        if len(siblings) > 256: raise ValueError("Arrangement clip collection exceeds authority bound")
        return hashlib.sha256(self._bounded_canonical(siblings).encode("utf-8")).hexdigest()

    def _arrangement_clip_authority_revision(self, reference: str) -> str:
        owner, clip, track_index, _ = self._arrangement_location(reference); owner_ref = self.refs.put("track", owner, str(track_index)); clips = self._items(self._read_attr(owner, "arrangement_clips") or [])
        siblings = [{"ref": self.refs.put("arrangement_clip", item, f"{track_index}:{index}"), "objectIdentity": self._capture_object_identity(item)} for index, item in enumerate(clips)]
        if len(siblings) > 256: raise ValueError("Arrangement clip collection exceeds authority bound")
        authority = {"clip": {"ref": reference, "objectIdentity": self._capture_object_identity(clip)}, "owner": {"ref": owner_ref, "objectIdentity": self._capture_object_identity(owner)}, "siblings": siblings}
        return hashlib.sha256(self._bounded_canonical(authority).encode("utf-8")).hexdigest()

    def _mapped_fingerprint(self, reference: str) -> str:
        row = self.get(reference)
        if not isinstance(row, dict): raise ValueError("created object fingerprint is unavailable")
        return hashlib.sha256(self._bounded_canonical(row).encode("utf-8")).hexdigest()

    def _ownership_fingerprint(self, reference: str) -> str:
        if not reference.startswith(f"{self.refs.epoch}:"): raise ValueError("created object reference is malformed")
        snapshot = self.snapshot()
        if f":track:" in reference:
            track = next((row for row in snapshot["tracks"] if row["ref"] == reference), None)
            if track is None: raise ValueError("created track fingerprint is unavailable")
            owned_track = {**track, "clipSlots": [slot for slot in track.get("clipSlots", []) if slot.get("empty") is not True or slot.get("clipRef") is not None]}; arrangement_clips = [clip for clip in snapshot.get("arrangement", {}).get("clips", []) if clip.get("trackRef") == reference or clip.get("parentRef") == reference]
            return hashlib.sha256(self._bounded_canonical({"track": owned_track, "arrangementClips": arrangement_clips}).encode("utf-8")).hexdigest()
        if f":scene:" not in reference: return self._mapped_fingerprint(reference)
        scene = next((row for row in snapshot["scenes"] if row["ref"] == reference), None)
        if scene is None: raise ValueError("created scene fingerprint is unavailable")
        scene_identity = {key: scene.get(key) for key in ("ref", "parentRef", "objectIdentity", "name", "triggerable")}; contents = []
        for track in snapshot["tracks"]:
            slot = next((row for row in track.get("clipSlots", []) if row.get("sceneIndex") == scene["index"]), None); clip = next((row for row in track.get("clips", []) if slot is not None and row.get("ref") == slot.get("clipRef")), None); owned_slot = {key: slot.get(key) for key in ("ref", "parentRef", "trackRef", "objectIdentity", "clipRef", "empty")} if slot is not None else None
            contents.append({"trackRef": track.get("ref"), "trackIdentity": track.get("objectIdentity"), "slot": owned_slot, "clip": clip})
        return hashlib.sha256(self._bounded_canonical({"scene": scene_identity, "contents": contents}).encode("utf-8")).hexdigest()

    def _creation_topology(self) -> str:
        tracks = self._items(getattr(self.song, "tracks", [])) + self._items(getattr(self.song, "return_tracks", [])); main_track = getattr(self.song, "master_track", getattr(self.song, "main_track", None)); tracks += [main_track] if main_track is not None else []; scenes = self._items(getattr(self.song, "scenes", [])); rows = []
        for track in tracks:
            slots = self._items(getattr(track, "clip_slots", [])); rows.append({"identity": self._capture_object_identity(track), "slots": [{"identity": self._capture_object_identity(slot), "clip": self._capture_object_identity(getattr(slot, "clip")) if getattr(slot, "clip", None) is not None else None} for slot in slots], "arrangement": [self._capture_object_identity(clip) for clip in self._items(self._read_attr(track, "arrangement_clips") or [])], "devices": [self._capture_object_identity(device) for device in self._items(getattr(track, "devices", []))]})
        topology = {"tracks": rows, "scenes": [self._capture_object_identity(scene) for scene in scenes], "locators": [self._capture_object_identity(locator) for locator in self._items(getattr(self.song, "cue_points", []))]}
        return self._bounded_canonical(topology)

    def _rollback_unattached_creation(self, operation: str, result: Any, args: dict[str, Any], baseline: str, checkpoint: tuple[dict[str, Any], dict[str, int]]) -> None:
        rows = result.get("clipIdentities") if operation == "session.capture-midi" and isinstance(result, dict) else [result]
        if not isinstance(rows, list): raise ValueError("unattached creation rows are unavailable")
        normalized: list[tuple[str, str, str]] = []
        for row in rows:
            if not isinstance(row, dict): raise ValueError("unattached creation row is unavailable")
            reference = row.get("deviceRef") if operation == "browser.load" else row.get("ref"); identity = row.get("deviceObjectIdentity") if operation == "browser.load" else row.get("objectIdentity"); fingerprint = row.get("createdFingerprint")
            if not isinstance(reference, str) or not isinstance(identity, str) or not isinstance(fingerprint, str) or not hmac.compare_digest(self._ownership_fingerprint(reference), fingerprint): raise ValueError("unattached creation identity or fingerprint changed")
            normalized.append((reference, identity, fingerprint))
        for reference, identity, _ in reversed(normalized):
            kind = reference.split(":", 2)[1] if reference.count(":") >= 2 else ""; deletion_error: BaseException | None = None
            try:
                if kind == "track":
                    collection = self._items(getattr(self.song, "tracks", [])); matches = [index for index, item in enumerate(collection) if self._capture_object_identity(item) == identity]
                    if len(matches) != 1 or not callable(getattr(self.song, "delete_track", None)): raise ValueError("unattached track is not exactly deletable")
                    self.song.delete_track(matches[0])
                elif kind == "scene":
                    collection = self._items(getattr(self.song, "scenes", [])); matches = [index for index, item in enumerate(collection) if self._capture_object_identity(item) == identity]
                    if len(matches) != 1 or not callable(getattr(self.song, "delete_scene", None)): raise ValueError("unattached scene is not exactly deletable")
                    self.song.delete_scene(matches[0])
                elif kind == "clip":
                    _, slot, _, _ = self._clip_location(reference); current = getattr(slot, "clip", None)
                    if current is None or not self._capture_same_object(current, self.refs.get(reference), identity) or not callable(getattr(slot, "delete_clip", None)): raise ValueError("unattached Session clip is not exactly deletable")
                    slot.delete_clip()
                elif kind == "arrangement_clip":
                    owner, clip, _, _ = self._arrangement_location(reference)
                    if self._capture_object_identity(clip) != identity or not callable(getattr(owner, "delete_clip", None)): raise ValueError("unattached Arrangement clip is not exactly deletable")
                    owner.delete_clip(clip)
                elif kind == "device":
                    track_ref = (result.get("parentTrackRef") or args.get("trackRef")) if operation == "browser.load" and isinstance(result, dict) else args.get("trackRef"); track = self.refs.get(str(track_ref)); devices = self._items(getattr(track, "devices", [])); matches = [index for index, device in enumerate(devices) if self._capture_object_identity(device) == identity]
                    if len(matches) != 1 or not callable(getattr(track, "delete_device", None)): raise ValueError("unattached device is not exactly deletable")
                    track.delete_device(matches[0])
                elif kind == "locator":
                    locator = self.refs.get(reference); position = self._read_attr(locator, "time", "position")
                    if self._capture_object_identity(locator) != identity or not isinstance(position, (int, float)) or not callable(getattr(self.song, "set_or_delete_cue", None)): raise ValueError("unattached locator is not exactly deletable")
                    self.song.set_or_delete_cue(float(position))
                else: raise ValueError("unattached creation kind is unsupported")
            except BaseException as error: deletion_error = error
            if deletion_error is not None:
                # A Live deleter may apply and then raise; the exact global
                # topology check below is the acknowledgement-loss authority.
                pass
        if self._creation_topology() != baseline: raise ValueError("unattached creation cleanup did not restore exact topology")
        self.refs.restore(checkpoint)

    def _attach_cleanup_ownership(self, operation: str, result: Any, transaction_id: str) -> Any:
        rows = result.get("clipIdentities") if operation == "session.capture-midi" and isinstance(result, dict) else [result]
        if not isinstance(rows, list): raise ValueError("created-object ownership result is malformed")
        normalized = []
        for row in rows:
            if not isinstance(row, dict): raise ValueError("created-object ownership evidence is incomplete")
            reference = row.get("deviceRef") if operation == "browser.load" else row.get("ref"); identity = row.get("deviceObjectIdentity") if operation == "browser.load" else row.get("objectIdentity"); fingerprint = row.get("createdFingerprint")
            if not isinstance(reference, str) or not isinstance(identity, str) or not isinstance(fingerprint, str) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint): raise ValueError("created-object ownership evidence is incomplete")
            normalized.append((row, reference, identity, fingerprint))
        if len(self._owned_cleanup_tokens) + len(normalized) > 4096: raise ValueError("transaction-owned cleanup ledger is full")
        for row, reference, identity, fingerprint in normalized:
            token = secrets.token_urlsafe(32); self._owned_cleanup_tokens[token] = {"transactionId": transaction_id, "ref": reference, "objectIdentity": identity, "fingerprint": fingerprint}; row["ownershipToken"] = token
        return result

    def _require_cleanup_ownership(self, operation: str, args: dict[str, Any], transaction_id: str, ownership_token: str | None) -> None:
        reference, expected_identity = args.get("ref"), args.get("expectedObjectIdentity")
        record = self._owned_cleanup_tokens.get(str(ownership_token)) if isinstance(ownership_token, str) else None
        if record is None or record.get("transactionId") != transaction_id or record.get("ref") != reference or record.get("objectIdentity") != expected_identity: raise ValueError("destructive cleanup lacks exact transaction-owned authority")
        if record.get("deleted") is True: return
        if not hmac.compare_digest(self._ownership_fingerprint(str(reference)), record["fingerprint"]): raise ValueError("transaction-owned object changed after creation; cleanup refused")
        if operation in {"track.delete", "scene.delete"}:
            target_text = str(reference).rsplit(":", 1)[-1]
            if not target_text.isdigit(): raise ValueError("transaction-owned structure reference is malformed")
            axis = "track" if operation == "track.delete" else "scene"
            if self._owned_positional_conflict(axis, int(target_text), strict=True, exclude_token=ownership_token): raise ValueError("transaction-owned structure cleanup must proceed from the highest positional authority")

    def retire_transaction_ownership(self, transaction_id: str, terminal: bool = False) -> None:
        for token, row in list(self._owned_cleanup_tokens.items()):
            if row.get("transactionId") == transaction_id and (terminal or row.get("deleted") is True): self._owned_cleanup_tokens.pop(token, None)

    def _clip_duplicate(self, args: dict[str, Any], delete_source: bool = False) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:clip:"):
            raise ValueError("clip reference is stale or invalid")
        self.snapshot(); authority = self._session_clip_authority(reference)
        expected_source = {key: args.get(key) for key in authority}
        if not all(isinstance(value, str) for value in expected_source.values()) or not hmac.compare_digest(self._bounded_canonical(authority), self._bounded_canonical(expected_source)):
            raise ValueError("clip duplication source identity changed since preview")
        expected_content = args.get("expectedContentFingerprint")
        if not isinstance(expected_content, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_content) or not hmac.compare_digest(self._mapped_fingerprint(reference), expected_content):
            raise ValueError("clip content changed since preview")
        owner, source_slot, track_index, _ = self._clip_location(reference); clip = getattr(source_slot, "clip", None)
        if clip is None: raise ValueError("clip duplication source is stale")
        source_content_fingerprint = self._clip_content_fingerprint(clip)
        arrangement_position = args.get("arrangementPosition")
        if delete_source and arrangement_position is not None: raise ValueError("Session clip move cannot target the Arrangement")
        if arrangement_position is not None:
            if not isinstance(arrangement_position, (int, float)) or isinstance(arrangement_position, bool) or not math.isfinite(float(arrangement_position)) or float(arrangement_position) < 0:
                raise ValueError("arrangement position is invalid")
            duplicate = getattr(owner, "duplicate_clip_to_arrangement", None)
            if not callable(duplicate): raise ValueError("arrangement duplication is unavailable")
            expected_collection = args.get("expectedTargetCollectionRevision"); current_collection = self._arrangement_collection_revision(owner, track_index)
            if not isinstance(expected_collection, str) or not hmac.compare_digest(current_collection, expected_collection): raise ValueError("Arrangement target collection changed since preview")
            clips_before = self._items(self._read_attr(owner, "arrangement_clips") or []); before_identity_order = [self._capture_object_identity(item) for item in clips_before]; before_identities = set(before_identity_order); checkpoint = self.refs.checkpoint()
            try:
                duplicate(clip, float(arrangement_position)); clips_after = self._items(self._read_attr(owner, "arrangement_clips") or []); created_rows = [(index, candidate) for index, candidate in enumerate(clips_after) if self._capture_object_identity(candidate) not in before_identities]
                if len(clips_after) != len(clips_before) + 1 or len(created_rows) != 1: raise ValueError("arrangement duplication did not produce one identity-distinct clip")
                clip_index, created = created_rows[0]; created_identity = self._capture_object_identity(created); expected_identity_order = list(before_identity_order); expected_identity_order.insert(clip_index, created_identity)
                if [self._capture_object_identity(candidate) for candidate in clips_after] != expected_identity_order: raise ValueError("Arrangement duplication reordered pre-existing clips")
                actual_start = self._read_attr(created, "start_time", "start")
                if self._clip_content_fingerprint(created) != source_content_fingerprint or not isinstance(actual_start, (int, float)) or float(actual_start) != float(arrangement_position): raise ValueError("Arrangement duplication did not preserve exact clip content and position")
                created_ref = self.refs.put("arrangement_clip", created, f"{track_index}:{clip_index}"); fingerprint = self._mapped_fingerprint(created_ref)
                return {"ref": created_ref, "objectIdentity": created_identity, "name": str(getattr(created, "name", "")), "createdFingerprint": fingerprint}
            except BaseException as error:
                rollback_failed = False; deleter = getattr(owner, "delete_clip", None); current = self._items(self._read_attr(owner, "arrangement_clips") or []); owned = [candidate for candidate in current if self._capture_object_identity(candidate) not in before_identities]
                if owned and not callable(deleter): rollback_failed = True
                if callable(deleter):
                    for candidate in owned:
                        try: deleter(candidate)
                        except BaseException: pass
                if [self._capture_object_identity(item) for item in self._items(self._read_attr(owner, "arrangement_clips") or [])] != before_identity_order: rollback_failed = True
                if rollback_failed: raise ValueError("arrangement duplication failed and exact cleanup failed") from error
                self.refs.restore(checkpoint); raise
        if args.get("expectedTargetCollectionRevision") is not None: raise ValueError("Session duplication cannot carry Arrangement collection authority")
        target_track_ref = args.get("targetTrackRef"); target_scene_index = args.get("targetSceneIndex")
        if not isinstance(target_track_ref, str) or not target_track_ref.startswith(f"{self.refs.epoch}:track:"):
            raise ValueError("target track reference is required for Session duplication")
        if not isinstance(target_scene_index, int) or isinstance(target_scene_index, bool) or not 0 <= target_scene_index <= 10000:
            raise ValueError("target scene index is invalid")
        target_track = self.refs.get(target_track_ref); slots = self._items(getattr(target_track, "clip_slots", [])); scenes = self._items(getattr(self.song, "scenes", []))
        if target_scene_index >= len(slots) or target_scene_index >= len(scenes): raise ValueError("target scene index is invalid")
        target_slot = slots[target_scene_index]; target_scene = scenes[target_scene_index]; target_track_index = self._capture_index(self._items(getattr(self.song, "tracks", [])), target_track)
        if target_track_index is None: raise ValueError("target Session track hierarchy is stale")
        current_target = {"expectedTargetTrackIdentity": self._capture_object_identity(target_track), "expectedTargetSlotRef": self.refs.put("clip_slot", target_slot, f"{target_track_index}:{target_scene_index}"), "expectedTargetSlotIdentity": self._capture_object_identity(target_slot), "expectedTargetSceneRef": self.refs.put("scene", target_scene, str(target_scene_index)), "expectedTargetSceneIdentity": self._capture_object_identity(target_scene)}
        expected_target = {key: args.get(key) for key in current_target}
        if not all(isinstance(value, str) for value in expected_target.values()) or not hmac.compare_digest(self._bounded_canonical(current_target), self._bounded_canonical(expected_target)):
            raise ValueError("clip duplication target identity changed since preview")
        if getattr(target_slot, "clip", None) is not None: raise ValueError("target Session slot is occupied")
        duplicate = getattr(source_slot, "duplicate_clip_to", None)
        if not callable(duplicate): raise ValueError("Session duplication is unavailable")
        checkpoint = self.refs.checkpoint()
        try:
            duplicate(target_slot); created = getattr(target_slot, "clip", None)
            if created is None: raise ValueError("Session duplication was not confirmed")
            if self._clip_content_fingerprint(created) != source_content_fingerprint: raise ValueError("Session duplication did not preserve exact clip content")
            created_identity = self._capture_object_identity(created); created_ref = self.refs.put("clip", created, f"{target_track_index}:{target_scene_index}"); fingerprint = self._mapped_fingerprint(created_ref)
        except BaseException as error:
            rollback_failed = False; cleanup = getattr(target_slot, "delete_clip", None)
            if getattr(target_slot, "clip", None) is not None:
                if not callable(cleanup): rollback_failed = True
                else:
                    try: cleanup()
                    except BaseException: pass
            if getattr(target_slot, "clip", None) is not None: rollback_failed = True
            if rollback_failed: raise ValueError("Session duplication failed and exact cleanup failed") from error
            self.refs.restore(checkpoint); raise
        if delete_source:
            deleter = getattr(source_slot, "delete_clip", None)
            if not callable(deleter):
                cleanup = getattr(target_slot, "delete_clip", None); rollback_failed = False
                if not callable(cleanup): rollback_failed = True
                else:
                    try: cleanup()
                    except BaseException: pass
                if getattr(target_slot, "clip", None) is not None: rollback_failed = True
                if rollback_failed: raise ValueError("Session move source deletion is unavailable and destination cleanup failed")
                self.refs.restore(checkpoint); raise ValueError("Session move source deletion is unavailable")
            deletion_error: BaseException | None = None
            try: deleter()
            except BaseException as error: deletion_error = error
            source_after = getattr(source_slot, "clip", None); source_identity = str(args.get("expectedObjectIdentity"))
            if source_after is not None and self._capture_same_object(source_after, clip, source_identity):
                cleanup = getattr(target_slot, "delete_clip", None); target_after = getattr(target_slot, "clip", None)
                if callable(cleanup) and target_after is not None and self._capture_same_object(target_after, created, created_identity):
                    try: cleanup()
                    except BaseException: pass
                residual = getattr(target_slot, "clip", None)
                if residual is not None or not self._capture_same_object(getattr(source_slot, "clip", None), clip, source_identity): raise ValueError("Session move source deletion failed and exact destination cleanup failed") from deletion_error
                self.refs.restore(checkpoint); raise ValueError("Session move source deletion failed") from deletion_error
            if source_after is not None or not self._capture_same_object(getattr(target_slot, "clip", None), created, created_identity): raise ValueError("Session move produced an invalid final hierarchy") from deletion_error
        return {"ref": created_ref, "objectIdentity": created_identity, "name": str(getattr(created, "name", "")), "createdFingerprint": fingerprint}

    def _arrangement_clip_create(self, args: dict[str, Any]) -> dict[str, Any]:
        track_ref = args.get("trackRef")
        if not isinstance(track_ref, str) or not track_ref.startswith(f"{self.refs.epoch}:track:"):
            raise ValueError("track reference is stale or invalid")
        self.snapshot(); track = self.refs.get(track_ref)
        expected_track_identity = args.get("expectedTrackIdentity"); track_index = self._capture_index(self._items(getattr(self.song, "tracks", [])), track, expected_track_identity if isinstance(expected_track_identity, str) else None)
        if track_index is None or track_ref != f"{self.refs.epoch}:track:{track_index}": raise ValueError("arrangement clip target track hierarchy is stale")
        if not isinstance(expected_track_identity, str) or not hmac.compare_digest(self._capture_object_identity(track), expected_track_identity):
            raise ValueError("arrangement clip target track identity changed since preview")
        expected_collection = args.get("expectedCollectionRevision")
        if not isinstance(expected_collection, str) or not hmac.compare_digest(self._arrangement_collection_revision(track, track_index), expected_collection): raise ValueError("Arrangement clip collection changed since preview")
        position = args.get("position")
        length = args.get("length")
        name = args.get("name")
        if not isinstance(position, (int, float)) or isinstance(position, bool) or not math.isfinite(float(position)) or float(position) < 0:
            raise ValueError("position is invalid")
        if not isinstance(length, (int, float)) or isinstance(length, bool) or not math.isfinite(float(length)) or not 0 < float(length) <= 100000:
            raise ValueError("length is invalid")
        if not isinstance(name, str) or not 1 <= len(name) <= 256:
            raise ValueError("name is invalid")
        creator = getattr(track, "create_midi_clip", None)
        if not callable(creator):
            raise ValueError("arrangement clip creation is unavailable")
        before_clips = self._items(self._read_attr(track, "arrangement_clips") or []); before_identity_order = [self._capture_object_identity(item) for item in before_clips]; before_identities = set(before_identity_order); checkpoint = self.refs.checkpoint()
        try:
            clip = creator(float(position), float(length)); clips = self._items(self._read_attr(track, "arrangement_clips") or []); created_rows = [(index, candidate) for index, candidate in enumerate(clips) if self._capture_object_identity(candidate) not in before_identities]
            if clip is None or len(clips) != len(before_clips) + 1 or len(created_rows) != 1: raise ValueError("arrangement clip creation did not produce one identity-distinct clip")
            clip_index, created = created_rows[0]; created_identity = self._capture_object_identity(created); expected_identity_order = list(before_identity_order); expected_identity_order.insert(clip_index, created_identity)
            if [self._capture_object_identity(candidate) for candidate in clips] != expected_identity_order: raise ValueError("arrangement clip creation reordered pre-existing clips")
            if not self._capture_same_object(created, clip, self._capture_object_identity(clip)): raise ValueError("arrangement clip creator returned a different object")
            if hasattr(created, "name"): created.name = name
            actual_start = self._read_attr(created, "start_time"); actual_length = self._read_attr(created, "length")
            if str(getattr(created, "name", "")) != name or not isinstance(actual_start, (int, float)) or not isinstance(actual_length, (int, float)) or float(actual_start) != float(position) or float(actual_length) != float(length): raise ValueError("arrangement clip requested name, position, or length was not confirmed")
            created_ref = self.refs.put("arrangement_clip", created, f"{track_index}:{clip_index}"); created_identity = self._capture_object_identity(created); fingerprint = self._mapped_fingerprint(created_ref)
            return {"ref": created_ref, "objectIdentity": created_identity, "name": str(getattr(created, "name", "")), "start": float(getattr(created, "start_time", position)), "length": float(getattr(created, "length", length)), "createdFingerprint": fingerprint}
        except BaseException as error:
            rollback_failed = False; deleter = getattr(track, "delete_clip", None); current = self._items(self._read_attr(track, "arrangement_clips") or []); owned = [candidate for candidate in current if self._capture_object_identity(candidate) not in before_identities]
            if owned and not callable(deleter): rollback_failed = True
            if callable(deleter):
                for candidate in owned:
                    try: deleter(candidate)
                    except BaseException: pass
            if [self._capture_object_identity(item) for item in self._items(self._read_attr(track, "arrangement_clips") or [])] != before_identity_order: rollback_failed = True
            if rollback_failed: raise ValueError("arrangement clip creation failed and exact cleanup failed") from error
            self.refs.restore(checkpoint); raise

    def _arrangement_clip_delete(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:arrangement_clip:"):
            raise ValueError("arrangement clip reference is stale or invalid")
        current = self.get(reference); expected_identity = args.get("expectedObjectIdentity"); expected_authority = args.get("expectedAuthorityRevision")
        if not isinstance(current, dict) or not isinstance(expected_identity, str) or not hmac.compare_digest(str(current.get("objectIdentity", "")), expected_identity):
            raise ValueError("arrangement clip identity changed; deletion refused")
        key = ":".join(reference.split(":")[2:])
        if ":" not in key: raise ValueError("song-level Arrangement clip mutation is unavailable without track hierarchy authority")
        if not isinstance(expected_authority, str) or not hmac.compare_digest(self._arrangement_clip_authority_revision(reference), expected_authority): raise ValueError("Arrangement clip hierarchy changed; deletion refused")
        owner, clip, _, clip_index = self._arrangement_location(reference)
        deleter = getattr(owner, "delete_clip", None)
        if not callable(deleter):
            raise ValueError("arrangement clip deletion is unavailable")
        before_identity_order = [self._capture_object_identity(candidate) for candidate in self._items(self._read_attr(owner, "arrangement_clips") or [])]; expected_order = list(before_identity_order); expected_order.pop(clip_index); deletion_error: BaseException | None = None
        try: deleter(clip)
        except BaseException as error: deletion_error = error
        if [self._capture_object_identity(candidate) for candidate in self._items(self._read_attr(owner, "arrangement_clips") or [])] != expected_order: raise ValueError("arrangement clip deletion did not preserve exact remaining sibling order") from deletion_error
        self.refs.delete(reference); return {"deleted": reference}

    def _arrangement_clip_move(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:arrangement_clip:"):
            raise ValueError("arrangement clip reference is stale or invalid")
        current = self.get(reference); expected_identity = args.get("expectedObjectIdentity"); expected_authority = args.get("expectedAuthorityRevision")
        if not isinstance(current, dict) or not isinstance(expected_identity, str) or not hmac.compare_digest(str(current.get("objectIdentity", "")), expected_identity):
            raise ValueError("arrangement clip identity changed; move refused")
        if not isinstance(expected_authority, str) or not hmac.compare_digest(self._arrangement_clip_authority_revision(reference), expected_authority): raise ValueError("Arrangement clip hierarchy changed; move refused")
        expected_content = args.get("expectedContentFingerprint")
        if not isinstance(expected_content, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_content) or not hmac.compare_digest(self._mapped_fingerprint(reference), expected_content): raise ValueError("Arrangement clip content changed; move refused")
        clip = self.refs.get(reference)
        position = args.get("position")
        if not isinstance(position, (int, float)) or isinstance(position, bool) or not math.isfinite(float(position)) or float(position) < 0:
            raise ValueError("position is invalid")
        # start_time is read-only in Live; a move composes duplicate+delete
        # atomically on the main thread and reports the new clip identity.
        owner, clip, track_index, source_index = self._arrangement_location(reference); source_content_fingerprint = self._clip_content_fingerprint(clip)
        duplicate = getattr(owner, "duplicate_clip_to_arrangement", None)
        deleter = getattr(owner, "delete_clip", None)
        if not callable(duplicate) or not callable(deleter):
            raise ValueError("arrangement clip move is unavailable")
        before_clips = self._items(self._read_attr(owner, "arrangement_clips") or []); before_identity_order = [self._capture_object_identity(item) for item in before_clips]; before_identities = set(before_identity_order); checkpoint = self.refs.checkpoint()
        try:
            duplicate(clip, float(position)); clips_after = self._items(self._read_attr(owner, "arrangement_clips") or []); created_rows = [(index, candidate) for index, candidate in enumerate(clips_after) if self._capture_object_identity(candidate) not in before_identities]
            if len(clips_after) != len(before_clips) + 1 or len(created_rows) != 1: raise ValueError("arrangement clip move did not produce one identity-distinct duplicate")
            created_pre_index, created = created_rows[0]; actual_start = self._read_attr(created, "start_time", "start")
            if self._clip_content_fingerprint(created) != source_content_fingerprint or not isinstance(actual_start, (int, float)) or float(actual_start) != float(position): raise ValueError("Arrangement move did not preserve exact clip content and requested position")
            created_identity = self._capture_object_identity(created); final_index = created_pre_index - 1 if source_index < created_pre_index else created_pre_index; projected_row = self._arrangement_clip_row(owner, created, track_index, final_index); created_ref = projected_row["ref"]; fingerprint = hashlib.sha256(self._bounded_canonical(projected_row).encode("utf-8")).hexdigest()
        except BaseException as error:
            rollback_failed = False; current = self._items(self._read_attr(owner, "arrangement_clips") or []); owned = [candidate for candidate in current if self._capture_object_identity(candidate) not in before_identities]
            for candidate in owned:
                try: deleter(candidate)
                except BaseException: pass
            if [self._capture_object_identity(item) for item in self._items(self._read_attr(owner, "arrangement_clips") or [])] != before_identity_order: rollback_failed = True
            if rollback_failed: raise ValueError("Arrangement move preparation failed and exact cleanup failed") from error
            self.refs.restore(checkpoint); raise
        deletion_error: BaseException | None = None
        try: deleter(clip)
        except BaseException as error: deletion_error = error
        remaining = self._items(self._read_attr(owner, "arrangement_clips") or []); source_matches = [candidate for candidate in remaining if self._capture_same_object(candidate, clip, expected_identity)]; created_matches = [candidate for candidate in remaining if self._capture_same_object(candidate, created, created_identity)]
        if source_matches:
            rollback_failed = len(source_matches) != 1 or len(created_matches) != 1
            if len(created_matches) == 1:
                try: deleter(created_matches[0])
                except BaseException: pass
            if [self._capture_object_identity(item) for item in self._items(self._read_attr(owner, "arrangement_clips") or [])] != before_identity_order: rollback_failed = True
            if rollback_failed: raise ValueError("Arrangement clip move source deletion failed and exact destination cleanup failed") from deletion_error
            self.refs.restore(checkpoint); raise ValueError("Arrangement clip move source deletion failed") from deletion_error
        if len(created_matches) != 1 or len(remaining) != len(before_clips): raise ValueError("Arrangement clip move produced an invalid final hierarchy") from deletion_error
        created_current = created_matches[0]
        if created_current is None: raise ValueError("Arrangement clip move destination disappeared")
        created_index = self._capture_index(remaining, created_current, created_identity)
        if created_index is None or created_index != final_index: raise ValueError("Arrangement clip move destination identity is ambiguous")
        return {"ref": created_ref, "objectIdentity": created_identity, "start": float(getattr(created_current, "start_time", position)), "createdFingerprint": fingerprint}

    def _audio_clip_set(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:"):
            raise ValueError("clip reference is stale or invalid")
        current = self.get(reference); expected_identity = args.get("expectedObjectIdentity"); expected_authority = args.get("expectedAuthorityRevision"); expected_state = args.get("expectedStateRevision")
        if not isinstance(current, dict) or not isinstance(expected_identity, str) or not hmac.compare_digest(str(current.get("objectIdentity", "")), expected_identity):
            raise ValueError("audio clip identity changed since preview")
        if reference.startswith(f"{self.refs.epoch}:clip:"): authority_revision = hashlib.sha256(self._bounded_canonical(self._session_clip_authority(reference)).encode("utf-8")).hexdigest()
        elif reference.startswith(f"{self.refs.epoch}:arrangement_clip:"): authority_revision = self._arrangement_clip_authority_revision(reference)
        else: raise ValueError("audio clip hierarchy is unavailable")
        fields = ("gain", "pitchCoarse", "pitchFine", "loopStart", "loopEnd", "warpMode", "warping", "fadeInLength", "fadeOutLength"); state_revision = hashlib.sha256(self._bounded_canonical({field: current.get(field) for field in fields}).encode("utf-8")).hexdigest()
        if not isinstance(expected_authority, str) or not hmac.compare_digest(authority_revision, expected_authority) or not isinstance(expected_state, str) or not hmac.compare_digest(state_revision, expected_state): raise ValueError("audio clip hierarchy or state changed since preview")
        clip = self.refs.get(reference)
        if self._read_attr(clip, "is_audio_clip") is not True:
            raise ValueError("audio properties require an audio clip")
        allowed = {"ref", "gain", "pitchCoarse", "pitchFine", "loopStart", "loopEnd", "warpMode", "warping", "fadeInLength", "fadeOutLength", "expectedObjectIdentity", "expectedAuthorityRevision", "expectedStateRevision"}
        if set(args) - allowed:
            raise ValueError("audio clip fields are invalid")
        proposals: list[tuple[str, str, Any]] = []
        numeric = (("gain", "gain", 0, 1000000), ("pitchCoarse", "pitch_coarse", -48, 48), ("pitchFine", "pitch_fine", -50, 50), ("loopStart", "loop_start", 0, float("inf")), ("loopEnd", "loop_end", 0, float("inf")), ("fadeInLength", "fade_in_length", 0, float("inf")), ("fadeOutLength", "fade_out_length", 0, float("inf")))
        for field, attribute, minimum, maximum in numeric:
            if field in args:
                value = args[field]
                if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or not minimum <= float(value) <= maximum: raise ValueError(f"{field} is invalid")
                proposals.append((field, attribute, float(value)))
        if "warpMode" in args:
            value = args["warpMode"]
            if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 16: raise ValueError("warpMode is invalid")
            proposals.append(("warpMode", "warp_mode", value))
        if "warping" in args:
            value = args["warping"]
            if not isinstance(value, bool): raise ValueError("warping is invalid")
            proposals.append(("warping", "warping", value))
        if not proposals: raise ValueError("audio clip mutation has no fields")
        final_loop_start = args.get("loopStart", current.get("loopStart")); final_loop_end = args.get("loopEnd", current.get("loopEnd"))
        if isinstance(final_loop_start, (int, float)) and isinstance(final_loop_end, (int, float)) and float(final_loop_start) > float(final_loop_end): raise ValueError("audio clip loopStart must not exceed loopEnd")
        for _, attribute, _ in proposals:
            if self._read_attr(clip, attribute) is None: raise ValueError(f"{attribute} is unavailable on this audio clip")
        if "loopStart" in args and "loopEnd" in args:
            current_end = self._read_attr(clip, "loop_end"); new_start = float(args["loopStart"])
            if isinstance(current_end, (int, float)) and new_start > float(current_end): proposals.sort(key=lambda item: 0 if item[0] == "loopEnd" else 1)
        assignments = [(field, attribute, value, self._read_attr(clip, attribute)) for field, attribute, value in proposals]
        applied = {field: value for field, _, value, _ in assignments}
        try:
            for _, attribute, value, _ in assignments: setattr(clip, attribute, value)
            observed = self._audio_fields(clip); checks = []
            for key, value in applied.items():
                if key == "warpMode" or isinstance(value, bool): checks.append(observed.get(key) == value)
                else:
                    observed_value = observed.get(key); checks.append(isinstance(observed_value, (int, float)) and float(observed_value) == float(value))
            if not all(checks): raise ValueError("audio clip change was not confirmed")
        except BaseException as error:
            rollback_failed = False
            for _, attribute, _, prior in reversed(assignments):
                try: setattr(clip, attribute, prior)
                except BaseException: rollback_failed = True
            restored = self._audio_fields(clip)
            if any(self._bounded_canonical(restored.get(field)) != self._bounded_canonical(current.get(field)) for field, _, _, _ in assignments): rollback_failed = True
            if rollback_failed: raise ValueError("audio clip change failed and exact rollback failed") from error
            raise
        revision = self.refs.touch(reference)
        return {"changed": True, "revision": revision}

    _CLIP_SET_FIELDS = ("muted", "colorIndex", "looping", "loopStart", "loopEnd", "groove")

    def _clip_state_fields(self, clip: Any) -> dict[str, Any]:
        """Muted/color/loop clip state, honestly null when unavailable."""
        muted = self._read_attr(clip, "muted"); color = self._read_attr(clip, "color_index"); looping = self._read_attr(clip, "looping")
        fields: dict[str, Any] = {
            "muted": muted if isinstance(muted, bool) else None,
            "colorIndex": int(color) if isinstance(color, int) and not isinstance(color, bool) and 0 <= color <= 69 else None,
            "looping": looping if isinstance(looping, bool) else None,
        }
        if self._read_attr(clip, "is_audio_clip") is not True:
            for name, key in (("loop_start", "loopStart"), ("loop_end", "loopEnd")):
                value = self._read_attr(clip, name)
                fields[key] = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) else None
        def optional_bool(name: str) -> bool | None:
            value = self._read_attr(clip, name)
            return value if isinstance(value, bool) else None
        def optional_float(name: str) -> float | None:
            value = self._read_attr(clip, name)
            return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) else None
        def optional_int(name: str) -> int | None:
            value = self._read_attr(clip, name)
            return int(value) if isinstance(value, int) and not isinstance(value, bool) else None
        fields["launchMode"] = optional_int("launch_mode")
        fields["legato"] = optional_bool("legato")
        fields["playingPosition"] = optional_float("playing_position")
        fields["isPlaying"] = optional_bool("is_playing")
        fields["isTriggered"] = optional_bool("is_triggered")
        fields["isRecording"] = optional_bool("is_recording")
        fields["ramMode"] = optional_bool("ram_mode")
        fields["signatureNumerator"] = optional_int("signature_numerator")
        fields["signatureDenominator"] = optional_int("signature_denominator")
        fields["velocityAmount"] = optional_float("velocity_amount")
        fields["willRecordOnStart"] = optional_bool("will_record_on_start")
        fields["fireButtonState"] = optional_bool("fire_button_state")
        is_take_lane = self._read_attr(clip, "is_take_lane_clip")
        fields["isTakeLaneClip"] = is_take_lane if isinstance(is_take_lane, bool) else None
        groove = self._read_attr(clip, "groove")
        if groove is not None:
            groove_ref = self.refs.put("groove", groove, str(id(groove)))
            fields["groove"] = {"ref": groove_ref, "name": str(self._read_attr(groove, "name") or "")}
        else:
            fields["groove"] = None
        has_groove = self._read_attr(clip, "has_groove")
        fields["hasGroove"] = has_groove if isinstance(has_groove, bool) else (groove is not None)
        end_time = self._read_attr(clip, "end_time")
        fields["endTime"] = float(end_time) if isinstance(end_time, (int, float)) and not isinstance(end_time, bool) and math.isfinite(float(end_time)) else None
        return fields

    def _clip_set(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:"):
            raise ValueError("clip reference is stale or invalid")
        current = self.get(reference); expected_identity = args.get("expectedObjectIdentity"); expected_authority = args.get("expectedAuthorityRevision"); expected_state = args.get("expectedStateRevision")
        if not isinstance(current, dict) or not isinstance(expected_identity, str) or not hmac.compare_digest(str(current.get("objectIdentity", "")), expected_identity):
            raise ValueError("clip identity changed since preview")
        authority_revision = self._clip_authority_digest(reference)
        state_revision = hashlib.sha256(self._bounded_canonical({field: current.get(field) for field in self._CLIP_SET_FIELDS}).encode("utf-8")).hexdigest()
        if not isinstance(expected_authority, str) or not hmac.compare_digest(authority_revision, expected_authority) or not isinstance(expected_state, str) or not hmac.compare_digest(state_revision, expected_state): raise ValueError("clip hierarchy or state changed since preview")
        clip = self.refs.get(reference)
        is_audio = self._read_attr(clip, "is_audio_clip") is True
        allowed = {"ref", "muted", "colorIndex", "looping", "loopStart", "loopEnd", "grooveRef", "expectedObjectIdentity", "expectedAuthorityRevision", "expectedStateRevision"}
        if set(args) - allowed:
            raise ValueError("clip fields are invalid")
        proposals: list[tuple[str, str, Any]] = []
        if "grooveRef" in args:
            groove_ref = args["grooveRef"]
            if not hasattr(clip, "groove"): raise ValueError("groove assignment is unavailable on this clip")
            if groove_ref is None:
                proposals.append(("groove", "groove", None))
            elif isinstance(groove_ref, str) and groove_ref.startswith(f"{self.refs.epoch}:groove:"):
                proposals.append(("groove", "groove", self.refs.get(groove_ref)))
            else: raise ValueError("grooveRef is invalid")
        if "muted" in args:
            value = args["muted"]
            if not isinstance(value, bool): raise ValueError("muted is invalid")
            proposals.append(("muted", "muted", value))
        if "colorIndex" in args:
            value = args["colorIndex"]
            if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 69: raise ValueError("colorIndex is invalid")
            proposals.append(("colorIndex", "color_index", value))
        if "looping" in args:
            value = args["looping"]
            if not isinstance(value, bool): raise ValueError("looping is invalid")
            if is_audio: raise ValueError("audio clip loop editing uses audio.clip.set")
            proposals.append(("looping", "looping", value))
        for field, attribute in (("loopStart", "loop_start"), ("loopEnd", "loop_end")):
            if field in args:
                value = args[field]
                if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or float(value) < 0: raise ValueError(f"{field} is invalid")
                if is_audio: raise ValueError("audio clip loop editing uses audio.clip.set")
                proposals.append((field, attribute, float(value)))
        if not proposals: raise ValueError("clip mutation has no fields")
        final_loop_start = args.get("loopStart", current.get("loopStart")); final_loop_end = args.get("loopEnd", current.get("loopEnd"))
        if isinstance(final_loop_start, (int, float)) and isinstance(final_loop_end, (int, float)) and float(final_loop_start) > float(final_loop_end): raise ValueError("clip loopStart must not exceed loopEnd")
        for _, attribute, _ in proposals:
            if attribute != "groove" and self._read_attr(clip, attribute) is None: raise ValueError(f"{attribute} is unavailable on this clip")
        if "loopStart" in args and "loopEnd" in args:
            current_end = self._read_attr(clip, "loop_end"); new_start = float(args["loopStart"])
            if isinstance(current_end, (int, float)) and new_start > float(current_end): proposals.sort(key=lambda item: 0 if item[0] == "loopEnd" else 1)
        assignments = [(field, attribute, value, self._read_attr(clip, attribute)) for field, attribute, value in proposals]
        applied = {field: value for field, _, value, _ in assignments}
        try:
            for _, attribute, value, _ in assignments: setattr(clip, attribute, value)
            observed = self.get(reference); checks = []
            for key, value in applied.items():
                observed_value = observed.get(key)
                if key == "groove":
                    if value is None: checks.append(observed_value is None)
                    else: checks.append(isinstance(observed_value, dict) and observed_value.get("name") == str(self._read_attr(value, "name") or ""))
                elif isinstance(value, bool): checks.append(observed_value is value)
                else: checks.append(isinstance(observed_value, (int, float)) and not isinstance(observed_value, bool) and float(observed_value) == float(value))
            if not all(checks): raise ValueError("clip change was not confirmed")
        except BaseException as error:
            rollback_failed = False
            for _, attribute, _, prior in reversed(assignments):
                try: setattr(clip, attribute, prior)
                except BaseException: rollback_failed = True
            restored = self.get(reference)
            if any(self._bounded_canonical(restored.get(field)) != self._bounded_canonical(current.get(field)) for field, _, _, _ in assignments): rollback_failed = True
            if rollback_failed: raise ValueError("clip change failed and exact rollback failed") from error
            raise
        revision = self.refs.touch(reference)
        return {"changed": True, "revision": revision}

    def _locator_jump(self, args: dict[str, Any]) -> dict[str, Any]:
        direction = args.get("direction")
        if direction not in {"next", "previous"} or set(args) - {"direction"}:
            raise ValueError("locator jump direction is invalid")
        method = getattr(self.song, "jump_to_next_cue" if direction == "next" else "jump_to_prev_cue", None)
        if not callable(method):
            raise ValueError("locator jump is unavailable")
        before = self._read_attr(self.song, "current_song_time")
        if not isinstance(before, (int, float)) or isinstance(before, bool) or not math.isfinite(float(before)) or float(before) < 0:
            raise ValueError("current song time is unreadable")
        method()
        after = self._read_attr(self.song, "current_song_time")
        if not isinstance(after, (int, float)) or isinstance(after, bool) or not math.isfinite(float(after)) or float(after) < 0:
            raise ValueError("locator jump did not report a readable song position")
        return {"direction": direction, "before": float(before), "position": float(after)}

    _VIEW_CONTROL_ACTIONS = {"zoom-in", "zoom-out", "scroll-left", "scroll-right", "follow-on", "follow-off", "collapse-track", "expand-track", "hide-view", "focus-view", "browser-toggle"}

    def _view_set(self, args: dict[str, Any]) -> dict[str, Any]:
        view_name = args.get("view")
        if not isinstance(view_name, str) or not 1 <= len(view_name) <= 64 or set(args) - {"view"}:
            raise ValueError("view name is invalid")
        view = getattr(self._application(), "view", None)
        if view is None or not callable(getattr(view, "show_view", None)):
            raise ValueError("view control is unavailable")
        try:
            view.show_view(view_name)
        except BaseException as error:
            raise ValueError("view change was rejected") from error
        visible = view.is_view_visible(view_name) if callable(getattr(view, "is_view_visible", None)) else None
        if visible is not True:
            raise ValueError("view change was not confirmed")
        return {"view": view_name, "visible": True}

    def _view_control(self, args: dict[str, Any]) -> dict[str, Any]:
        action = args.get("action")
        if action not in self._VIEW_CONTROL_ACTIONS or set(args) - {"action", "trackRef", "view"}:
            raise ValueError("view control action is invalid")
        view = getattr(self._application(), "view", None)
        if view is None:
            raise ValueError("view control is unavailable")
        if action in {"zoom-in", "zoom-out"}:
            zoom = getattr(view, "zoom_view", None)
            if not callable(zoom): raise ValueError("arrangement zoom is unavailable")
            zoom(1 if action == "zoom-in" else 0, "Arranger", False)
            return {"action": action, "done": True}
        if action in {"scroll-left", "scroll-right"}:
            scroll = getattr(view, "scroll_view", None)
            if not callable(scroll): raise ValueError("arrangement scroll is unavailable")
            scroll(1 if action == "scroll-right" else 0, "Arranger", False)
            return {"action": action, "done": True}
        if action in {"follow-on", "follow-off"}:
            song_view = getattr(self.song, "view", None)
            if song_view is None or self._read_attr(song_view, "follow_song") is None: raise ValueError("arrangement follow is unavailable")
            song_view.follow_song = action == "follow-on"
            if self._read_attr(song_view, "follow_song") is not (action == "follow-on"): raise ValueError("arrangement follow change was not confirmed")
            return {"action": action, "done": True}
        if action == "browser-toggle":
            toggler = getattr(view, "toggle_browse", None)
            if not callable(toggler): raise ValueError("browser mode toggle is unavailable on this Live shape")
            toggler()
            return {"action": action, "done": True}
        if action in {"hide-view", "focus-view"}:
            view_name = args.get("view")
            if not isinstance(view_name, str) or not 1 <= len(view_name) <= 64: raise ValueError("view name is required")
            method = getattr(view, "hide_view" if action == "hide-view" else "focus_view", None)
            if not callable(method): raise ValueError(f"{action} is unavailable on this Live shape")
            method(view_name)
            return {"action": action, "done": True}
        track_ref = args.get("trackRef")
        if not isinstance(track_ref, str) or not track_ref.startswith(f"{self.refs.epoch}:track:"):
            raise ValueError("track reference is stale or invalid")
        self.snapshot(); track = self.refs.get(track_ref)
        track_view = getattr(track, "view", None)
        if track_view is None or self._read_attr(track_view, "is_collapsed") is None: raise ValueError("track collapse is unavailable")
        track_view.is_collapsed = action == "collapse-track"
        if self._read_attr(track_view, "is_collapsed") is not (action == "collapse-track"): raise ValueError("track collapse change was not confirmed")
        return {"action": action, "done": True}

    def _arrangement_audio_clip_create(self, args: dict[str, Any]) -> dict[str, Any]:
        track_ref = args.get("trackRef")
        if not isinstance(track_ref, str) or not track_ref.startswith(f"{self.refs.epoch}:track:"):
            raise ValueError("track reference is stale or invalid")
        self.snapshot(); track = self.refs.get(track_ref)
        expected_track_identity = args.get("expectedTrackIdentity"); track_index = self._capture_index(self._items(getattr(self.song, "tracks", [])), track, expected_track_identity if isinstance(expected_track_identity, str) else None)
        if track_index is None or track_ref != f"{self.refs.epoch}:track:{track_index}": raise ValueError("arrangement audio clip target track hierarchy is stale")
        if not isinstance(expected_track_identity, str) or not hmac.compare_digest(self._capture_object_identity(track), expected_track_identity):
            raise ValueError("arrangement audio clip target track identity changed since preview")
        expected_collection = args.get("expectedCollectionRevision")
        if not isinstance(expected_collection, str) or not hmac.compare_digest(self._arrangement_collection_revision(track, track_index), expected_collection): raise ValueError("Arrangement clip collection changed since preview")
        position = args.get("position"); file_path = args.get("filePath"); name = args.get("name")
        if not isinstance(position, (int, float)) or isinstance(position, bool) or not math.isfinite(float(position)) or float(position) < 0:
            raise ValueError("position is invalid")
        if not isinstance(file_path, str) or not 1 <= len(file_path) <= 1024:
            raise ValueError("filePath is invalid")
        if name is not None and (not isinstance(name, str) or not 1 <= len(name) <= 256):
            raise ValueError("name is invalid")
        creator = getattr(track, "create_audio_clip", None)
        if not callable(creator):
            raise ValueError("arrangement audio clip creation is unavailable")
        before_clips = self._items(self._read_attr(track, "arrangement_clips") or []); before_identity_order = [self._capture_object_identity(item) for item in before_clips]; before_identities = set(before_identity_order); checkpoint = self.refs.checkpoint()
        try:
            clip = creator(file_path, float(position)); clips = self._items(self._read_attr(track, "arrangement_clips") or []); created_rows = [(index, candidate) for index, candidate in enumerate(clips) if self._capture_object_identity(candidate) not in before_identities]
            if clip is None or len(clips) != len(before_clips) + 1 or len(created_rows) != 1: raise ValueError("arrangement audio clip creation did not produce one identity-distinct clip")
            clip_index, created = created_rows[0]; created_identity = self._capture_object_identity(created); expected_identity_order = list(before_identity_order); expected_identity_order.insert(clip_index, created_identity)
            if [self._capture_object_identity(candidate) for candidate in clips] != expected_identity_order: raise ValueError("arrangement audio clip creation reordered pre-existing clips")
            if not self._capture_same_object(created, clip, self._capture_object_identity(clip)): raise ValueError("arrangement audio clip creator returned a different object")
            if name is not None and hasattr(created, "name"): created.name = name
            actual_start = self._read_attr(created, "start_time"); actual_length = self._read_attr(created, "length"); actual_path = self._read_attr(created, "file_path")
            if name is not None and str(getattr(created, "name", "")) != name: raise ValueError("arrangement audio clip requested name was not confirmed")
            if not isinstance(actual_start, (int, float)) or isinstance(actual_start, bool) or float(actual_start) != float(position): raise ValueError("arrangement audio clip position was not confirmed")
            if not isinstance(actual_length, (int, float)) or isinstance(actual_length, bool) or not math.isfinite(float(actual_length)) or float(actual_length) <= 0: raise ValueError("arrangement audio clip length was not confirmed")
            if not isinstance(actual_path, str) or not actual_path: raise ValueError("arrangement audio clip file path was not confirmed")
            created_ref = self.refs.put("arrangement_clip", created, f"{track_index}:{clip_index}"); created_identity = self._capture_object_identity(created); fingerprint = self._mapped_fingerprint(created_ref)
            return {"ref": created_ref, "objectIdentity": created_identity, "name": str(getattr(created, "name", "")), "start": float(actual_start), "length": float(actual_length), "filePath": actual_path, "createdFingerprint": fingerprint}
        except BaseException as error:
            rollback_failed = False; deleter = getattr(track, "delete_clip", None); current = self._items(self._read_attr(track, "arrangement_clips") or []); owned = [candidate for candidate in current if self._capture_object_identity(candidate) not in before_identities]
            if owned and not callable(deleter): rollback_failed = True
            if callable(deleter):
                for candidate in owned:
                    try: deleter(candidate)
                    except BaseException: pass
            if [self._capture_object_identity(item) for item in self._items(self._read_attr(track, "arrangement_clips") or [])] != before_identity_order: rollback_failed = True
            if rollback_failed: raise ValueError("arrangement audio clip creation failed and exact cleanup failed") from error
            self.refs.restore(checkpoint); raise

    def _clip_authority_digest(self, reference: str) -> str:
        if reference.startswith(f"{self.refs.epoch}:clip:"): return hashlib.sha256(self._bounded_canonical(self._session_clip_authority(reference)).encode("utf-8")).hexdigest()
        if reference.startswith(f"{self.refs.epoch}:arrangement_clip:"): return self._arrangement_clip_authority_revision(reference)
        if reference.startswith(f"{self.refs.epoch}:take_lane_clip:"):
            parts = reference.split(":"); track, lane, track_index, lane_index = self._take_lane_location(":".join(parts[:4]))
            return hashlib.sha256(self._bounded_canonical({"takeLaneRevision": self._take_lane_clip_collection_revision(lane, ":".join(parts[:4])), "laneIdentity": self._capture_object_identity(lane)}).encode("utf-8")).hexdigest()
        raise ValueError("clip hierarchy is unavailable")

    def _warp_marker_rows(self, clip: Any) -> list[dict[str, Any]]:
        markers = list(getattr(clip, "warp_markers", None) or [])
        if len(markers) > 256: raise ValueError("complete warp-marker collection exceeds its authoritative bound")
        rows = []
        for marker in markers:
            beat_time = self._read_attr(marker, "beat_time"); sample_time = self._read_attr(marker, "sample_time")
            if not all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) for value in (beat_time, sample_time)):
                raise ValueError("complete warp-marker content is unreadable")
            rows.append({"beatTime": float(beat_time), "sampleTime": float(sample_time)})
        rows.sort(key=lambda row: row["beatTime"])
        return rows

    def _warp_marker_collection_revision(self, clip: Any) -> str:
        return hashlib.sha256(self._bounded_canonical(self._warp_marker_rows(clip)).encode("utf-8")).hexdigest()

    def _warp_marker_read(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or set(args) - {"ref"}:
            raise ValueError("warp-marker read arguments are invalid")
        clip = self.refs.get(reference)
        if self._read_attr(clip, "is_audio_clip") is not True:
            raise ValueError("warp markers require an audio clip")
        return {"revision": self._warp_marker_collection_revision(clip), "markers": self._warp_marker_rows(clip)}

    def _warp_marker_mutate(self, operation: str, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:"):
            raise ValueError("clip reference is stale or invalid")
        if set(args) - {"ref", "beatTime", "distance", "expectedClipAuthorityDigest", "expectedMarkerCollectionRevision"}:
            raise ValueError("warp-marker arguments are invalid")
        clip = self.refs.get(reference)
        if self._read_attr(clip, "is_audio_clip") is not True:
            raise ValueError("warp markers require an audio clip")
        expected_authority = args.get("expectedClipAuthorityDigest")
        if not isinstance(expected_authority, str) or not hmac.compare_digest(self._clip_authority_digest(reference), expected_authority):
            raise ValueError("clip hierarchy changed since preview")
        before_rows = self._warp_marker_rows(clip)
        expected_collection = args.get("expectedMarkerCollectionRevision")
        if not isinstance(expected_collection, str) or not hmac.compare_digest(hashlib.sha256(self._bounded_canonical(before_rows).encode("utf-8")).hexdigest(), expected_collection):
            raise ValueError("warp-marker collection changed since preview")
        beat_time = args.get("beatTime")
        if not isinstance(beat_time, (int, float)) or isinstance(beat_time, bool) or not math.isfinite(float(beat_time)):
            raise ValueError("beatTime is invalid")
        beat_time = float(beat_time)
        before_beats = {row["beatTime"] for row in before_rows}
        distance = 0.0
        if operation == "audio.warp-marker.add":
            method = getattr(clip, "add_warp_marker", None)
            if not callable(method): raise ValueError("warp-marker creation is unavailable")
            if beat_time < 0 or beat_time in before_beats: raise ValueError("a warp marker already exists at that beat time")
            call = lambda: method(beat_time)
            expected_beats = before_beats | {beat_time}
        elif operation == "audio.warp-marker.move":
            method = getattr(clip, "move_warp_marker", None)
            raw_distance = args.get("distance")
            if not callable(method): raise ValueError("warp-marker move is unavailable")
            if not isinstance(raw_distance, (int, float)) or isinstance(raw_distance, bool) or not math.isfinite(float(raw_distance)): raise ValueError("distance is invalid")
            if beat_time not in before_beats: raise ValueError("no warp marker exists at that beat time")
            distance = float(raw_distance); target = beat_time + distance
            if target < 0 or (target in before_beats and target != beat_time): raise ValueError("warp-marker move target collides with an existing marker")
            call = lambda: method(beat_time, distance)
            expected_beats = (before_beats - {beat_time}) | {target}
        else:
            method = getattr(clip, "remove_warp_marker", None)
            if not callable(method): raise ValueError("warp-marker deletion is unavailable")
            if beat_time not in before_beats: raise ValueError("no warp marker exists at that beat time")
            native_markers = list(getattr(clip, "warp_markers", None) or [])
            target_marker = next((marker for marker in native_markers if self._read_attr(marker, "beat_time") == beat_time), None)
            if target_marker is None: raise ValueError("warp marker identity is unavailable")
            call = lambda: method(target_marker)
            expected_beats = before_beats - {beat_time}
        try:
            call()
            after_rows = self._warp_marker_rows(clip)
            if len(after_rows) != len(expected_beats) or {row["beatTime"] for row in after_rows} != expected_beats: raise ValueError("warp-marker change was not confirmed")
        except BaseException as error:
            rollback_failed = False
            try:
                if operation == "audio.warp-marker.add":
                    native_markers = list(getattr(clip, "warp_markers", None) or [])
                    created = next((marker for marker in native_markers if self._read_attr(marker, "beat_time") == beat_time), None)
                    remover = getattr(clip, "remove_warp_marker", None)
                    if created is not None and callable(remover): remover(created)
                elif operation == "audio.warp-marker.move":
                    mover = getattr(clip, "move_warp_marker", None)
                    if callable(mover): mover(beat_time + distance, -distance)
                else:
                    adder = getattr(clip, "add_warp_marker", None)
                    if callable(adder): adder(beat_time)
            except BaseException: rollback_failed = True
            try:
                restored_beats = {row["beatTime"] for row in self._warp_marker_rows(clip)}
            except BaseException:
                rollback_failed = True; restored_beats = set()
            if rollback_failed or restored_beats != before_beats: raise ValueError("warp-marker change failed and exact rollback failed") from error
            raise
        revision = self.refs.touch(reference)
        return {"changed": True, "revision": revision}

    def _session_audio_clip_create(self, args: dict[str, Any]) -> dict[str, Any]:
        file_path = args.get("filePath")
        if not isinstance(file_path, str) or not 1 <= len(file_path) <= 1024 or not (file_path.startswith("/") or (len(file_path) > 2 and file_path[1] == ":" and file_path[0].isalpha())): raise ValueError("filePath must be an absolute path")
        name = args.get("name")
        if name is not None and (not isinstance(name, str) or not 1 <= len(name) <= 256): raise ValueError("name is invalid")
        track_ref = args.get("trackRef")
        if not isinstance(track_ref, str): raise ValueError("track reference is invalid")
        self.snapshot(); track = self.refs.get(track_ref)
        if bool(getattr(track, "has_midi_input", False)):
            raise ValueError("target track is not an audio track")
        slots = self._items(getattr(track, "clip_slots", [])); scenes = self._items(getattr(self.song, "scenes", []))
        if not isinstance(args.get("sceneIndex"), int) or isinstance(args["sceneIndex"], bool): raise ValueError("scene index is invalid")
        index = args["sceneIndex"]
        if not 0 <= index < len(slots) or index >= len(scenes): raise ValueError("scene index is invalid")
        slot = slots[index]; scene = scenes[index]; track_index = self._capture_index(self._items(getattr(self.song, "tracks", [])), track)
        if track_index is None or track_ref != f"{self.refs.epoch}:track:{track_index}": raise ValueError("audio import track hierarchy is stale")
        current_authority = {"trackIdentity": self._capture_object_identity(track), "slotRef": self.refs.put("clip_slot", slot, f"{track_index}:{index}"), "slotIdentity": self._capture_object_identity(slot), "sceneRef": self.refs.put("scene", scene, str(index)), "sceneIdentity": self._capture_object_identity(scene)}
        expected_authority = {"trackIdentity": args.get("expectedTrackIdentity"), "slotRef": args.get("expectedSlotRef"), "slotIdentity": args.get("expectedSlotIdentity"), "sceneRef": args.get("expectedSceneRef"), "sceneIdentity": args.get("expectedSceneIdentity")}
        if not all(isinstance(value, str) for value in expected_authority.values()) or not hmac.compare_digest(self._bounded_canonical(current_authority), self._bounded_canonical(expected_authority)):
            raise ValueError("audio import target identity changed since preview")
        if getattr(slot, "clip", None) is not None: raise ValueError("session slot is occupied")
        creator = getattr(slot, "create_audio_clip", None)
        if not callable(creator): raise ValueError("session audio import is unavailable")
        checkpoint = self.refs.checkpoint()
        try:
            clip = creator(file_path); clip = clip if clip is not None else getattr(slot, "clip", None)
            if clip is None: raise ValueError("audio import was not confirmed")
            if name is not None and hasattr(clip, "name"): clip.name = name
            actual_path = self._read_attr(clip, "file_path"); actual_length = self._read_attr(clip, "length")
            if name is not None and str(getattr(clip, "name", "")) != name: raise ValueError("audio import name was not confirmed")
            if not isinstance(actual_path, str) or not actual_path: raise ValueError("audio import file path was not confirmed")
            if not isinstance(actual_length, (int, float)) or isinstance(actual_length, bool) or not math.isfinite(float(actual_length)) or float(actual_length) <= 0: raise ValueError("audio import length was not confirmed")
            created_ref = self.refs.put("clip", clip, f"{track_index}:{index}"); created_identity = self._capture_object_identity(clip); fingerprint = self._mapped_fingerprint(created_ref)
            return {"ref": created_ref, "objectIdentity": created_identity, "name": str(getattr(clip, "name", "")), "length": float(actual_length), "filePath": actual_path, "createdFingerprint": fingerprint}
        except BaseException as error:
            rollback_failed = False; current = getattr(slot, "clip", None); deleter = getattr(slot, "delete_clip", None)
            if current is not None:
                if not callable(deleter): rollback_failed = True
                else:
                    try: deleter()
                    except BaseException: pass
            if getattr(slot, "clip", None) is not None: rollback_failed = True
            if rollback_failed: raise ValueError("audio import failed and exact transaction-owned cleanup failed") from error
            self.refs.restore(checkpoint); raise

    _CLIP_ACTIONS = {"crop", "duplicate-loop", "duplicate-region", "scrub-start", "scrub-stop", "move-playing-position"}

    def _clip_action(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref"); action = args.get("action")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:") or action not in self._CLIP_ACTIONS:
            raise ValueError("clip action is invalid")
        allowed = {"ref", "action", "regionStart", "regionEnd", "destination", "offset", "expectedObjectIdentity", "expectedAuthorityRevision", "expectedStateRevision", "expectedContentFingerprint"}
        if set(args) - allowed: raise ValueError("clip action arguments are invalid")
        current = self.get(reference); clip = self.refs.get(reference)
        expected_identity = args.get("expectedObjectIdentity")
        if not isinstance(expected_identity, str) or not hmac.compare_digest(str(current.get("objectIdentity", "")), expected_identity):
            raise ValueError("clip identity changed since preview")
        if not isinstance(args.get("expectedAuthorityRevision"), str) or not hmac.compare_digest(self._clip_authority_digest(reference), args["expectedAuthorityRevision"]):
            raise ValueError("clip hierarchy changed since preview")
        content_actions = {"crop", "duplicate-loop", "duplicate-region"}
        if action in content_actions:
            fingerprint = self._mapped_fingerprint(reference)
            if not isinstance(args.get("expectedContentFingerprint"), str) or not hmac.compare_digest(fingerprint, args["expectedContentFingerprint"]):
                raise ValueError("clip content changed since preview")
        state_revision = hashlib.sha256(self._bounded_canonical({"isPlaying": current.get("isPlaying"), "playingPosition": current.get("playingPosition"), "length": current.get("length"), "loopStart": current.get("loopStart"), "loopEnd": current.get("loopEnd")}).encode("utf-8")).hexdigest()
        if not isinstance(args.get("expectedStateRevision"), str) or not hmac.compare_digest(state_revision, args["expectedStateRevision"]):
            raise ValueError("clip state changed since preview")
        before_length = self._read_attr(clip, "length"); loop_start = self._read_attr(clip, "loop_start"); loop_end = self._read_attr(clip, "loop_end")
        if action == "crop":
            method = getattr(clip, "crop", None)
            if not callable(method): raise ValueError("clip crop is unavailable")
            call = lambda: method()
        elif action == "duplicate-loop":
            method = getattr(clip, "duplicate_loop", None)
            if not callable(method): raise ValueError("clip loop duplication is unavailable")
            call = lambda: method()
        elif action == "duplicate-region":
            method = getattr(clip, "duplicate_region", None)
            if not callable(method): raise ValueError("clip region duplication is unavailable")
            region_start, region_end, destination = args.get("regionStart"), args.get("regionEnd"), args.get("destination")
            for value in (region_start, region_end, destination):
                if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or float(value) < 0: raise ValueError("duplicate-region bounds are invalid")
            if float(region_end) <= float(region_start): raise ValueError("duplicate-region end must exceed start")
            call = lambda: method(float(region_start), float(region_end), float(destination))
        elif action == "scrub-start":
            method = getattr(clip, "start_scrub", None)
            if not callable(method): raise ValueError("clip scrub is unavailable")
            position = args.get("offset")
            if not isinstance(position, (int, float)) or isinstance(position, bool) or not math.isfinite(float(position)): raise ValueError("scrub position is invalid")
            call = lambda: method(float(position))
        elif action == "scrub-stop":
            method = getattr(clip, "stop_scrub", None)
            if not callable(method): raise ValueError("clip scrub stop is unavailable")
            call = lambda: method()
        else:
            method = getattr(clip, "move_playing_pos", None)
            if not callable(method): raise ValueError("playing-position move is unavailable")
            offset = args.get("offset")
            if not isinstance(offset, (int, float)) or isinstance(offset, bool) or not math.isfinite(float(offset)): raise ValueError("playing-position offset is invalid")
            call = lambda: method(float(offset))
        call()
        if action == "crop":
            new_length = self._read_attr(clip, "length")
            expected_length = None
            if isinstance(loop_start, (int, float)) and isinstance(loop_end, (int, float)): expected_length = float(loop_end) - float(loop_start)
            if expected_length is not None and (not isinstance(new_length, (int, float)) or abs(float(new_length) - expected_length) > 1e-6): raise ValueError("clip crop was not confirmed")
        if action == "duplicate-loop":
            new_length = self._read_attr(clip, "length")
            if isinstance(before_length, (int, float)) and (not isinstance(new_length, (int, float)) or float(new_length) < float(before_length)): raise ValueError("clip loop duplication was not confirmed")
        if action == "duplicate-region":
            new_length = self._read_attr(clip, "length")
            if isinstance(before_length, (int, float)) and isinstance(new_length, (int, float)) and float(new_length) < float(before_length) + (float(args["regionEnd"]) - float(args["regionStart"])) - 1e-6: raise ValueError("clip region duplication was not confirmed")
        revision = self.refs.touch(reference)
        return {"changed": True, "revision": revision}

    def _automation_envelope_clear(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("clipRef")
        if not isinstance(reference, str) or set(args) - {"clipRef", "expectedAuthorityDigest", "expectedEnvelopesRevision"}:
            raise ValueError("envelope clear arguments are invalid")
        if not hmac.compare_digest(self._clip_authority_digest(reference), str(args.get("expectedAuthorityDigest"))):
            raise ValueError("clip hierarchy changed since preview")
        _, slot, track_index, _ = self._clip_location(reference)
        clip = getattr(slot, "clip", None)
        if clip is None: raise ValueError("envelope clear requires a Session clip")
        clearer = getattr(clip, "clear_all_envelopes", None)
        reader = getattr(clip, "automation_envelope", None)
        if not callable(clearer) or not callable(reader): raise ValueError("envelope clear is unavailable")
        track = self._items(getattr(self.song, "tracks", []))[track_index]
        def walk(device: Any) -> list[Any]:
            collected = list(self._items(getattr(device, "parameters", [])))
            for chain in self._items(self._read_attr(device, "chains") or []):
                for nested in self._items(self._read_attr(chain, "devices") or []): collected.extend(walk(nested))
            for pad in self._items(self._read_attr(device, "drum_pads") or []):
                for chain in self._items(self._read_attr(pad, "chains") or []):
                    for nested in self._items(self._read_attr(chain, "devices") or []): collected.extend(walk(nested))
            return collected
        parameters = [parameter for device in self._items(getattr(track, "devices", [])) for parameter in walk(device)]
        mixer = self._read_attr(track, "mixer_device")
        if mixer is not None:
            parameters.extend(param for param in (self._read_attr(mixer, "volume"), self._read_attr(mixer, "panning"), self._read_attr(mixer, "cue_volume")) if param is not None)
            parameters.extend(self._items(self._read_attr(mixer, "sends") or []))
        if len(parameters) > 512: raise ValueError("parameter collection exceeds its envelope bound")
        def presence() -> list[bool]:
            rows = []
            for parameter in parameters:
                try: rows.append(reader(parameter) is not None)
                except BaseException: rows.append(False)
            return rows
        before = presence()
        if not hmac.compare_digest(hashlib.sha256(self._bounded_canonical(before).encode("utf-8")).hexdigest(), str(args.get("expectedEnvelopesRevision"))):
            raise ValueError("clip envelope collection changed since preview")
        clear_error: BaseException | None = None
        try: clearer()
        except BaseException as error: clear_error = error
        after = presence()
        if clear_error is not None or any(after): raise ValueError("envelope clear was not confirmed") from clear_error
        return {"cleared": sum(1 for present in before if present), "envelopesRevision": hashlib.sha256(self._bounded_canonical(after).encode("utf-8")).hexdigest()}

    def _note_read_by_id(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref"); note_ids = args.get("noteIds")
        if not isinstance(reference, str) or set(args) - {"ref", "noteIds"}: raise ValueError("note read arguments are invalid")
        if not isinstance(note_ids, list) or not 1 <= len(note_ids) <= 1024 or not all(isinstance(item, int) and not isinstance(item, bool) and item >= 0 for item in note_ids): raise ValueError("note ids are invalid")
        clip = self.refs.get(reference)
        if not callable(getattr(clip, "get_notes_by_id", None)): raise ValueError("targeted note reads are unavailable on this Live shape")
        try: raw = list(clip.get_notes_by_id(note_ids))
        except BaseException as error: raise ValueError("targeted note read failed") from error
        if len(raw) > 1024: raise ValueError("note read exceeds its bound")
        rows = self._note_rows_from(raw)
        return {"notes": rows, "notesRevision": hashlib.sha256(self._bounded_canonical(self._read_notes(clip)).encode("utf-8")).hexdigest()}

    def _note_read_selected(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or set(args) - {"ref"}: raise ValueError("note read arguments are invalid")
        clip = self.refs.get(reference)
        reader = getattr(clip, "get_selected_notes", None)
        if not callable(reader): return {"available": False, "notes": [], "notesRevision": hashlib.sha256(self._bounded_canonical(self._read_notes(clip)).encode("utf-8")).hexdigest()}
        try: raw = list(reader())
        except BaseException as error: raise ValueError("selected note read failed") from error
        if len(raw) > 1024: raise ValueError("selected note read exceeds its bound")
        return {"available": True, "notes": self._note_rows_from(raw), "notesRevision": hashlib.sha256(self._bounded_canonical(self._read_notes(clip)).encode("utf-8")).hexdigest()}

    def _note_duplicate(self, args: dict[str, Any]) -> dict[str, Any]:
        clip = self._guard_note_clip(args)
        note_ids = args.get("noteIds")
        if not isinstance(note_ids, list) or not 1 <= len(note_ids) <= 512 or len(set(note_ids)) != len(note_ids) or not all(isinstance(item, int) and not isinstance(item, bool) and item >= 0 for item in note_ids):
            raise ValueError("note ids are invalid")
        if not callable(getattr(clip, "duplicate_notes_by_id", None)): raise ValueError("note duplication is unavailable on this Live shape")
        before_rows = self._read_notes(clip); existing = {int(row["id"]) for row in before_rows if isinstance(row.get("id"), int)}
        if len(existing) != len(before_rows) or any(note_id not in existing for note_id in note_ids): raise ValueError("complete stable note identity is required for duplication")
        duplicate_error: BaseException | None = None
        try: clip.duplicate_notes_by_id(note_ids)
        except BaseException as error: duplicate_error = error
        try: after_rows = self._read_notes(clip)
        except BaseException as error:
            if duplicate_error is None: duplicate_error = error
            after_rows = []
        if duplicate_error is None and len(after_rows) == len(before_rows) + len(note_ids):
            return {"duplicated": len(note_ids), "notesRevision": hashlib.sha256(self._bounded_canonical(after_rows).encode("utf-8")).hexdigest()}
        raise ValueError("note duplication was not confirmed") from duplicate_error

    def _note_quantize(self, args: dict[str, Any]) -> dict[str, Any]:
        clip = self._guard_note_clip(args)
        grid = args.get("grid"); amount = args.get("amount"); pitch = args.get("pitch")
        if not isinstance(grid, (int, float)) or isinstance(grid, bool) or not math.isfinite(float(grid)) or not 0 < float(grid) <= 1000000: raise ValueError("grid is invalid")
        if not isinstance(amount, (int, float)) or isinstance(amount, bool) or not math.isfinite(float(amount)) or not 0 <= float(amount) <= 1: raise ValueError("amount is invalid")
        if pitch is not None and (not isinstance(pitch, int) or isinstance(pitch, bool) or not 0 <= pitch <= 127): raise ValueError("pitch is invalid")
        before_rows = self._read_notes(clip)
        if pitch is not None:
            method = getattr(clip, "quantize_to_pitch", None)
            if not callable(method): raise ValueError("pitch quantization is unavailable on this Live shape")
            call = lambda: method(pitch, float(grid), float(amount))
        else:
            method = getattr(clip, "quantize", None)
            if not callable(method): raise ValueError("quantization is unavailable on this Live shape")
            call = lambda: method(float(grid), float(amount))
        quantize_error: BaseException | None = None
        try: call()
        except BaseException as error: quantize_error = error
        try: after_rows = self._read_notes(clip)
        except BaseException as error:
            if quantize_error is None: quantize_error = error
            after_rows = []
        if quantize_error is None and len(after_rows) == len(before_rows):
            return {"changed": True, "notesRevision": hashlib.sha256(self._bounded_canonical(after_rows).encode("utf-8")).hexdigest()}
        raise ValueError("quantization was not confirmed") from quantize_error

    def _take_lane_read(self, args: dict[str, Any]) -> dict[str, Any]:
        track_ref = args.get("trackRef")
        if not isinstance(track_ref, str) or set(args) - {"trackRef"}:
            raise ValueError("take-lane read arguments are invalid")
        self.snapshot(); track = self.refs.get(track_ref); track_index = self._capture_index(self._items(getattr(self.song, "tracks", [])), track)
        if track_index is None or track_ref != f"{self.refs.epoch}:track:{track_index}": raise ValueError("take-lane track hierarchy is stale")
        lanes = [{"ref": row["ref"], "name": row["name"]} for row in self._take_lane_rows(track, track_index)]
        return {"lanes": lanes}

    def _take_lane_create(self, args: dict[str, Any]) -> dict[str, Any]:
        track_ref = args.get("trackRef")
        if not isinstance(track_ref, str): raise ValueError("track reference is invalid")
        self.snapshot(); track = self.refs.get(track_ref); track_index = self._capture_index(self._items(getattr(self.song, "tracks", [])), track, args.get("expectedTrackIdentity") if isinstance(args.get("expectedTrackIdentity"), str) else None)
        if track_index is None or track_ref != f"{self.refs.epoch}:track:{track_index}": raise ValueError("take-lane track hierarchy is stale")
        if not isinstance(args.get("expectedTrackIdentity"), str) or not hmac.compare_digest(self._capture_object_identity(track), args["expectedTrackIdentity"]):
            raise ValueError("take-lane target track identity changed since preview")
        if not isinstance(args.get("expectedTakeLaneCollectionRevision"), str) or not hmac.compare_digest(self._take_lane_collection_revision(track, track_index), args["expectedTakeLaneCollectionRevision"]):
            raise ValueError("take-lane collection changed since preview")
        name = args.get("name")
        if name is not None and (not isinstance(name, str) or not 1 <= len(name) <= 256): raise ValueError("name is invalid")
        creator = getattr(track, "create_take_lane", None)
        if not callable(creator): raise ValueError("take-lane creation is unavailable")
        before_lanes = self._items(self._read_attr(track, "take_lanes") or []); before_identities = [self._capture_object_identity(lane) for lane in before_lanes]
        lane = creator()
        lanes = self._items(self._read_attr(track, "take_lanes") or []); created_rows = [(index, candidate) for index, candidate in enumerate(lanes) if self._capture_object_identity(candidate) not in set(before_identities)]
        if lane is None or len(lanes) != len(before_lanes) + 1 or len(created_rows) != 1: raise ValueError("take-lane creation was not confirmed (note: the public LOM exposes no take-lane deletion, so creation cannot be compensated)")
        lane_index, created = created_rows[0]
        if name is not None and hasattr(created, "name"): created.name = name
        if name is not None and str(getattr(created, "name", "")) != name: raise ValueError("take-lane name was not confirmed (no public deletion exists for compensation)")
        lane_ref = self.refs.put("take_lane", created, f"{track_index}:{lane_index}"); created_identity = self._capture_object_identity(created); fingerprint = hashlib.sha256(self._bounded_canonical({"ref": lane_ref, "objectIdentity": created_identity, "name": str(getattr(created, "name", "")), "index": lane_index}).encode("utf-8")).hexdigest()
        return {"ref": lane_ref, "objectIdentity": created_identity, "name": str(getattr(created, "name", "")), "index": lane_index, "createdFingerprint": fingerprint}

    def _take_lane_rename(self, args: dict[str, Any]) -> dict[str, Any]:
        reference, name, expected_name, expected_identity = args.get("ref"), args.get("name"), args.get("expectedName"), args.get("expectedObjectIdentity")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:take_lane:") or not isinstance(name, str) or not 1 <= len(name) <= 256 or not isinstance(expected_name, str) or not isinstance(expected_identity, str):
            raise ValueError("take-lane rename authority is invalid")
        track, lane, track_index, lane_index = self._take_lane_location(reference)
        if not hmac.compare_digest(self._capture_object_identity(lane), expected_identity) or str(getattr(lane, "name", "")) != expected_name:
            raise ValueError("take-lane rename target changed since preview")
        expected_authority = args.get("expectedAuthorityRevision")
        if not isinstance(expected_authority, str) or not hmac.compare_digest(self._take_lane_collection_revision(track, track_index), expected_authority): raise ValueError("take-lane hierarchy changed since preview")
        rename_error: BaseException | None = None
        try: lane.name = name
        except BaseException as error: rename_error = error
        if rename_error is not None or str(getattr(lane, "name", "")) != name:
            try: lane.name = expected_name
            except BaseException: pass
            if str(getattr(lane, "name", "")) != expected_name: raise ValueError("take-lane rename failed and exact rollback failed") from rename_error
            raise ValueError("take-lane rename postcondition was not confirmed") from rename_error
        return {"renamed": reference, "name": name}

    def _take_lane_clip_create(self, args: dict[str, Any], audio: bool) -> dict[str, Any]:
        position = args.get("position")
        if not isinstance(position, (int, float)) or isinstance(position, bool) or not math.isfinite(float(position)) or float(position) < 0: raise ValueError("position is invalid")
        name = args.get("name")
        file_path = None; length = None
        if audio:
            file_path = args.get("filePath")
            if not isinstance(file_path, str) or not 1 <= len(file_path) <= 1024 or not (file_path.startswith("/") or (len(file_path) > 2 and file_path[1] == ":" and file_path[0].isalpha())): raise ValueError("filePath must be an absolute path")
            if name is not None and (not isinstance(name, str) or not 1 <= len(name) <= 256): raise ValueError("name is invalid")
        else:
            length = args.get("length")
            if not isinstance(length, (int, float)) or isinstance(length, bool) or not math.isfinite(float(length)) or not 0 < float(length) <= 100000: raise ValueError("length is invalid")
            if not isinstance(name, str) or not 1 <= len(name) <= 256: raise ValueError("name is invalid")
        lane_ref = args.get("takeLaneRef")
        if not isinstance(lane_ref, str): raise ValueError("take-lane reference is invalid")
        track, lane, track_index, lane_index = self._take_lane_location(lane_ref)
        expected_identity = args.get("expectedTakeLaneIdentity")
        if not isinstance(expected_identity, str) or not hmac.compare_digest(self._capture_object_identity(lane), expected_identity):
            raise ValueError("take-lane identity changed since preview")
        lane_path = f"{track_index}:{lane_index}"
        if not isinstance(args.get("expectedCollectionRevision"), str) or not hmac.compare_digest(self._take_lane_clip_collection_revision(lane, lane_ref), args["expectedCollectionRevision"]):
            raise ValueError("take-lane clip collection changed since preview")
        method = getattr(lane, "create_audio_clip" if audio else "create_midi_clip", None)
        if not callable(method): raise ValueError("take-lane clip creation is unavailable")
        before_clips = self._items(self._read_attr(lane, "arrangement_clips") or []); before_identity_order = [self._capture_object_identity(item) for item in before_clips]; before_identities = set(before_identity_order)
        clip = method(file_path, float(position)) if audio else method(float(position), float(length))
        clips = self._items(self._read_attr(lane, "arrangement_clips") or []); created_rows = [(index, candidate) for index, candidate in enumerate(clips) if self._capture_object_identity(candidate) not in before_identities]
        if clip is None or len(clips) != len(before_clips) + 1 or len(created_rows) != 1: raise ValueError("take-lane clip creation was not confirmed (the public LOM exposes no take-lane clip deletion, so creation cannot be compensated)")
        clip_index, created = created_rows[0]
        if name is not None and hasattr(created, "name"): created.name = name
        actual_start = self._read_attr(created, "start_time"); actual_length = self._read_attr(created, "length")
        if name is not None and str(getattr(created, "name", "")) != name: raise ValueError("take-lane clip name was not confirmed")
        if not isinstance(actual_start, (int, float)) or float(actual_start) != float(position): raise ValueError("take-lane clip position was not confirmed")
        if not audio and (not isinstance(actual_length, (int, float)) or float(actual_length) != float(length)): raise ValueError("take-lane clip length was not confirmed")
        if audio:
            if not isinstance(actual_length, (int, float)) or not math.isfinite(float(actual_length)) or float(actual_length) <= 0: raise ValueError("take-lane audio clip length was not confirmed")
            actual_path = self._read_attr(created, "file_path")
            if not isinstance(actual_path, str) or not actual_path: raise ValueError("take-lane audio clip file path was not confirmed")
        created_ref = self.refs.put("take_lane_clip", created, f"{lane_path}:{clip_index}"); created_identity = self._capture_object_identity(created); fingerprint = self._mapped_fingerprint(created_ref)
        result = {"ref": created_ref, "objectIdentity": created_identity, "name": str(getattr(created, "name", "")), "start": float(actual_start), "length": float(actual_length), "createdFingerprint": fingerprint}
        if audio: result["filePath"] = str(self._read_attr(created, "file_path"))
        return result

    def _tuning_state(self) -> dict[str, Any]:
        tuning = getattr(self.song, "tuning_system", None)
        def float_or_none(value: Any) -> float | None:
            return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) else None
        def int_or_none(value: Any) -> int | None:
            return int(value) if isinstance(value, int) and not isinstance(value, bool) else None
        note_tunings = []
        if tuning is not None:
            raw_tunings = self._items(self._read_attr(tuning, "note_tunings") or [])
            if len(raw_tunings) > 128: raise ValueError("note tunings exceed their bound")
            for index, entry in enumerate(raw_tunings):
                if isinstance(entry, dict):
                    note = entry.get("note", index); deviation = entry.get("deviation", entry.get("tuning", entry.get("cents")))
                elif isinstance(entry, (int, float)) and not isinstance(entry, bool):
                    note, deviation = index, entry
                else:
                    note = self._read_attr(entry, "note"); deviation = self._read_attr(entry, "deviation", "tuning", "cents")
                    note = note if isinstance(note, int) else index
                deviation_value = float_or_none(deviation)
                if not isinstance(note, int) or isinstance(note, bool) or not 0 <= note <= 127 or deviation_value is None: raise ValueError("note tunings contain an unreadable entry")
                note_tunings.append({"note": int(note), "deviation": deviation_value})
        system = {"name": str(self._read_attr(tuning, "name") or "") if tuning is not None else "",
                  "lowestNote": int_or_none(self._read_attr(tuning, "lowest_note")) if tuning is not None else None,
                  "highestNote": int_or_none(self._read_attr(tuning, "highest_note")) if tuning is not None else None,
                  "referencePitch": float_or_none(self._read_attr(tuning, "reference_pitch")) if tuning is not None else None,
                  "pseudoOctaveInCents": float_or_none(self._read_attr(tuning, "pseudo_octave_in_cents")) if tuning is not None else None,
                  "noteTunings": note_tunings}
        intervals = []
        for value in self._items(self._read_attr(self.song, "scale_intervals") or []):
            if not isinstance(value, int) or isinstance(value, bool): raise ValueError("scale intervals contain an unreadable entry")
            intervals.append(int(value))
        if len(intervals) > 32: raise ValueError("scale intervals exceed their bound")
        scale_name = self._read_attr(self.song, "scale_name"); scale_mode = self._read_attr(self.song, "scale_mode")
        scale = {"rootNote": int_or_none(self._read_attr(self.song, "root_note")),
                 "scaleName": scale_name if isinstance(scale_name, str) else None,
                 "scaleMode": scale_mode if isinstance(scale_mode, str) else None,
                 "scaleIntervals": intervals}
        return {"tuningSystem": system, "scale": scale}

    def _tuning_revision(self) -> str:
        return hashlib.sha256(self._bounded_canonical(self._tuning_state()).encode("utf-8")).hexdigest()

    def _tuning_read(self, args: dict[str, Any]) -> dict[str, Any]:
        set_ref = args.get("setRef")
        if not isinstance(set_ref, str) or set_ref != self.refs.put("set", self.song, "song") or set(args) - {"setRef"}:
            raise ValueError("tuning read arguments are invalid")
        state = self._tuning_state()
        return {**state, "revision": hashlib.sha256(self._bounded_canonical(state).encode("utf-8")).hexdigest()}

    def _tuning_set(self, args: dict[str, Any]) -> dict[str, Any]:
        set_ref = args.get("setRef")
        if not isinstance(set_ref, str) or set_ref != self.refs.put("set", self.song, "song"): raise ValueError("set reference is stale or invalid")
        allowed = {"setRef", "name", "lowestNote", "highestNote", "referencePitch", "noteTunings", "rootNote", "scaleName", "scaleMode", "scaleIntervals", "expectedObjectIdentity", "expectedRevision"}
        if set(args) - allowed: raise ValueError("tuning fields are invalid")
        if not isinstance(args.get("expectedObjectIdentity"), str) or not hmac.compare_digest(self._capture_object_identity(self.song), args["expectedObjectIdentity"]): raise ValueError("Set identity changed since preview")
        if not isinstance(args.get("expectedRevision"), str) or not hmac.compare_digest(self._tuning_revision(), args["expectedRevision"]): raise ValueError("tuning or scale state changed since preview")
        tuning = getattr(self.song, "tuning_system", None)
        proposals: list[tuple[Any, str, Any]] = []
        if "name" in args:
            if tuning is None or not isinstance(args["name"], str) or not 1 <= len(args["name"]) <= 256: raise ValueError("name is invalid")
            proposals.append((tuning, "name", args["name"]))
        if "lowestNote" in args or "highestNote" in args:
            if tuning is None: raise ValueError("tuning system is unavailable")
            low = args.get("lowestNote"); high = args.get("highestNote")
            for key, value in (("lowestNote", low), ("highestNote", high)):
                if value is not None and (not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 127): raise ValueError(f"{key} is invalid")
            current_low = self._read_attr(tuning, "lowest_note"); current_high = self._read_attr(tuning, "highest_note")
            final_low = low if low is not None else current_low; final_high = high if high is not None else current_high
            if not all(isinstance(value, int) and not isinstance(value, bool) for value in (final_low, final_high)) or final_low > final_high: raise ValueError("tuning note range is invalid")
            if low is not None: proposals.append((tuning, "lowest_note", low))
            if high is not None: proposals.append((tuning, "highest_note", high))
        if "referencePitch" in args:
            value = args["referencePitch"]
            if tuning is None or not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or not 20 <= float(value) <= 20000: raise ValueError("referencePitch is invalid")
            proposals.append((tuning, "reference_pitch", float(value)))
        if "noteTunings" in args:
            rows = args["noteTunings"]
            if tuning is None or not isinstance(rows, list) or len(rows) != 128: raise ValueError("noteTunings must contain exactly 128 entries")
            seen: set[int] = set()
            for row in rows:
                if not isinstance(row, dict) or set(row) - {"note", "deviation"}: raise ValueError("noteTunings entries are invalid")
                note, deviation = row.get("note"), row.get("deviation")
                if not isinstance(note, int) or isinstance(note, bool) or not 0 <= note <= 127 or note in seen: raise ValueError("noteTunings notes are invalid")
                if not isinstance(deviation, (int, float)) or isinstance(deviation, bool) or not math.isfinite(float(deviation)) or not -1200 <= float(deviation) <= 1200: raise ValueError("noteTunings deviations are invalid")
                seen.add(note)
            if self._read_attr(tuning, "note_tunings") is None: raise ValueError("note tunings are unavailable")
            proposals.append((tuning, "note_tunings", rows))
        if "rootNote" in args:
            value = args["rootNote"]
            if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 11: raise ValueError("rootNote is invalid")
            if self._read_attr(self.song, "root_note") is None: raise ValueError("root_note is unavailable")
            proposals.append((self.song, "root_note", value))
        for key, attr in (("scaleName", "scale_name"), ("scaleMode", "scale_mode")):
            if key in args:
                value = args[key]
                if not isinstance(value, str) or not 1 <= len(value) <= 256: raise ValueError(f"{key} is invalid")
                if not isinstance(self._read_attr(self.song, attr), str): raise ValueError(f"{attr} is unavailable")
                proposals.append((self.song, attr, value))
        if "scaleIntervals" in args:
            rows = args["scaleIntervals"]
            if not isinstance(rows, list) or not 1 <= len(rows) <= 32 or not all(isinstance(value, int) and not isinstance(value, bool) and -24 <= value <= 24 for value in rows): raise ValueError("scaleIntervals are invalid")
            if self._read_attr(self.song, "scale_intervals") is None: raise ValueError("scale_intervals is unavailable")
            proposals.append((self.song, "scale_intervals", list(rows)))
        if not proposals: raise ValueError("tuning mutation has no fields")
        assignments = [(target, attr, value, self._read_attr(target, attr)) for target, attr, value in proposals]
        before_state = self._tuning_state()
        try:
            for target, attr, value, _ in assignments: setattr(target, attr, value)
            after = self._tuning_state()
            for target, attr, value, _ in assignments:
                if attr == "note_tunings":
                    normalized = sorted(([row["note"], row["deviation"]] for row in value), key=lambda item: item[0])
                    observed = sorted(([row["note"], row["deviation"]] for row in after["tuningSystem"]["noteTunings"]), key=lambda item: item[0])
                    if self._bounded_canonical(observed) != self._bounded_canonical(normalized): raise ValueError("note tunings were not confirmed")
                else:
                    observed = self._read_attr(target, attr)
                    if self._bounded_canonical(observed) != self._bounded_canonical(value): raise ValueError(f"tuning field {attr} was not confirmed")
        except BaseException as error:
            rollback_failed = False
            for target, attr, _, prior in reversed(assignments):
                try: setattr(target, attr, prior)
                except BaseException: rollback_failed = True
            if rollback_failed or self._bounded_canonical(self._tuning_state()) != self._bounded_canonical(before_state): raise ValueError("tuning change failed and exact rollback failed") from error
            raise
        return {"changed": True, "revision": self._tuning_revision()}

    def _groove_state(self) -> dict[str, Any]:
        pool = getattr(self.song, "groove_pool", None)
        grooves = []
        for index, groove in enumerate(self._items(self._read_attr(pool, "grooves") or [])):
            def float_or_none(value: Any) -> float | None:
                return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) else None
            base = self._read_attr(groove, "base")
            grooves.append({"ref": self.refs.put("groove", groove, str(index)), "objectIdentity": self._capture_object_identity(groove),
                            "name": str(self._read_attr(groove, "name") or ""),
                            "base": int(base) if isinstance(base, int) and not isinstance(base, bool) else None,
                            "quantizationAmount": float_or_none(self._read_attr(groove, "quantization_amount")),
                            "randomAmount": float_or_none(self._read_attr(groove, "random_amount")),
                            "timingAmount": float_or_none(self._read_attr(groove, "timing_amount")),
                            "velocityAmount": float_or_none(self._read_attr(groove, "velocity_amount"))})
        if len(grooves) > 256: raise ValueError("groove collection exceeds its bound")
        amount = self._read_attr(self.song, "groove_amount")
        return {"grooveAmount": float(amount) if isinstance(amount, (int, float)) and not isinstance(amount, bool) and math.isfinite(float(amount)) else None, "grooves": grooves}

    def _groove_revision(self) -> str:
        return hashlib.sha256(self._bounded_canonical(self._groove_state()).encode("utf-8")).hexdigest()

    def _groove_read(self, args: dict[str, Any]) -> dict[str, Any]:
        set_ref = args.get("setRef")
        if not isinstance(set_ref, str) or set_ref != self.refs.put("set", self.song, "song") or set(args) - {"setRef"}:
            raise ValueError("groove read arguments are invalid")
        state = self._groove_state()
        return {**state, "revision": hashlib.sha256(self._bounded_canonical(state).encode("utf-8")).hexdigest()}

    def _groove_set(self, args: dict[str, Any]) -> dict[str, Any]:
        set_ref = args.get("setRef")
        if not isinstance(set_ref, str) or set_ref != self.refs.put("set", self.song, "song"): raise ValueError("set reference is stale or invalid")
        if set(args) - {"setRef", "grooveAmount", "expectedObjectIdentity", "expectedRevision"}: raise ValueError("groove fields are invalid")
        if not isinstance(args.get("expectedObjectIdentity"), str) or not hmac.compare_digest(self._capture_object_identity(self.song), args["expectedObjectIdentity"]): raise ValueError("Set identity changed since preview")
        if not isinstance(args.get("expectedRevision"), str) or not hmac.compare_digest(self._groove_revision(), args["expectedRevision"]): raise ValueError("groove state changed since preview")
        value = args.get("grooveAmount")
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or not 0 <= float(value) <= 1.3: raise ValueError("grooveAmount is invalid")
        prior = self._read_attr(self.song, "groove_amount")
        if not isinstance(prior, (int, float)) or isinstance(prior, bool): raise ValueError("groove amount is unavailable")
        try:
            self.song.groove_amount = float(value)
            observed = self._read_attr(self.song, "groove_amount")
            if not isinstance(observed, (int, float)) or float(observed) != float(value): raise ValueError("groove amount was not confirmed")
        except BaseException as error:
            try: self.song.groove_amount = prior
            except BaseException: raise ValueError("groove amount change failed and exact rollback failed") from error
            if self._read_attr(self.song, "groove_amount") != prior: raise ValueError("groove amount change failed and exact rollback failed") from error
            raise
        return {"changed": True, "revision": self._groove_revision()}

    def _groove_edit(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:groove:"): raise ValueError("groove reference is stale or invalid")
        allowed = {"ref", "name", "base", "quantizationAmount", "randomAmount", "timingAmount", "velocityAmount", "expectedObjectIdentity", "expectedRevision"}
        if set(args) - allowed: raise ValueError("groove fields are invalid")
        if not isinstance(args.get("expectedObjectIdentity"), str) or not hmac.compare_digest(self._capture_object_identity(self.refs.get(reference)), args["expectedObjectIdentity"]): raise ValueError("groove identity changed since preview")
        if not isinstance(args.get("expectedRevision"), str) or not hmac.compare_digest(self._groove_revision(), args["expectedRevision"]): raise ValueError("groove state changed since preview")
        groove = self.refs.get(reference)
        proposals: list[tuple[str, Any]] = []
        if "name" in args:
            if not isinstance(args["name"], str) or not 1 <= len(args["name"]) <= 256: raise ValueError("name is invalid")
            proposals.append(("name", args["name"]))
        if "base" in args:
            value = args["base"]
            if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 16: raise ValueError("base is invalid")
            proposals.append(("base", value))
        for field, attr in (("quantizationAmount", "quantization_amount"), ("randomAmount", "random_amount"), ("timingAmount", "timing_amount"), ("velocityAmount", "velocity_amount")):
            if field in args:
                value = args[field]
                if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or not 0 <= float(value) <= 1: raise ValueError(f"{field} is invalid")
                proposals.append((attr, float(value)))
        if not proposals: raise ValueError("groove mutation has no fields")
        for attr, _ in proposals:
            if self._read_attr(groove, attr) is None: raise ValueError(f"{attr} is unavailable on this groove")
        assignments = [(attr, value, self._read_attr(groove, attr)) for attr, value in proposals]
        before = self._groove_state()
        try:
            for attr, value, _ in assignments: setattr(groove, attr, value)
            for attr, value, _ in assignments:
                observed = self._read_attr(groove, attr)
                if self._bounded_canonical(observed) != self._bounded_canonical(value): raise ValueError(f"groove field {attr} was not confirmed")
        except BaseException as error:
            rollback_failed = False
            for attr, _, prior in reversed(assignments):
                try: setattr(groove, attr, prior)
                except BaseException: rollback_failed = True
            if rollback_failed or self._bounded_canonical(self._groove_state()) != self._bounded_canonical(before): raise ValueError("groove change failed and exact rollback failed") from error
            raise
        return {"changed": True, "revision": self._groove_revision()}

    def _scene_set(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:scene:"): raise ValueError("scene reference is stale or invalid")
        allowed = {"ref", "colorIndex", "tempo", "tempoEnabled", "signatureNumerator", "signatureDenominator", "timeSignatureEnabled", "expectedObjectIdentity", "expectedAuthorityRevision", "expectedStateRevision"}
        if set(args) - allowed: raise ValueError("scene fields are invalid")
        scenes = self._items(getattr(self.song, "scenes", [])); parts = reference.split(":"); index = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else -1
        if not 0 <= index < len(scenes): raise ValueError("scene hierarchy changed")
        scene = scenes[index]
        if not isinstance(args.get("expectedObjectIdentity"), str) or not hmac.compare_digest(self._capture_object_identity(scene), args["expectedObjectIdentity"]): raise ValueError("scene identity changed since preview")
        if not isinstance(args.get("expectedAuthorityRevision"), str) or not hmac.compare_digest(self._scene_collection_revision(), args["expectedAuthorityRevision"]): raise ValueError("scene collection changed since preview")
        state_revision = hashlib.sha256(self._bounded_canonical(self._scene_state_fields(scene)).encode("utf-8")).hexdigest()
        if not isinstance(args.get("expectedStateRevision"), str) or not hmac.compare_digest(state_revision, args["expectedStateRevision"]): raise ValueError("scene state changed since preview")
        proposals: list[tuple[str, str, Any]] = []
        if "colorIndex" in args:
            value = args["colorIndex"]
            if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 69: raise ValueError("colorIndex is invalid")
            proposals.append(("colorIndex", "color_index", value))
        if "tempo" in args:
            value = args["tempo"]
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or not 20 <= float(value) <= 999: raise ValueError("tempo is invalid")
            proposals.append(("tempo", "tempo", float(value)))
        if "tempoEnabled" in args:
            value = args["tempoEnabled"]
            if not isinstance(value, bool): raise ValueError("tempoEnabled is invalid")
            proposals.append(("tempoEnabled", "tempo_enabled", value))
        for field, attr in (("signatureNumerator", "time_signature_numerator"), ("signatureDenominator", "time_signature_denominator")):
            if field in args:
                value = args[field]
                if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 99: raise ValueError(f"{field} is invalid")
                proposals.append((field, attr, value))
        if "timeSignatureEnabled" in args:
            value = args["timeSignatureEnabled"]
            if not isinstance(value, bool): raise ValueError("timeSignatureEnabled is invalid")
            proposals.append(("timeSignatureEnabled", "time_signature_enabled", value))
        if not proposals: raise ValueError("scene mutation has no fields")
        for _, attribute, _ in proposals:
            if self._read_attr(scene, attribute) is None: raise ValueError(f"{attribute} is unavailable on this scene")
        assignments = [(field, attribute, value, self._read_attr(scene, attribute)) for field, attribute, value in proposals]
        before = self._scene_state_fields(scene)
        try:
            for _, attribute, value, _ in assignments: setattr(scene, attribute, value)
            observed = self._scene_state_fields(scene)
            for field, _, value, _ in assignments:
                observed_value = observed.get(field)
                if isinstance(value, bool):
                    if observed_value is not value: raise ValueError("scene change was not confirmed")
                elif not isinstance(observed_value, (int, float)) or isinstance(observed_value, bool) or float(observed_value) != float(value): raise ValueError("scene change was not confirmed")
        except BaseException as error:
            rollback_failed = False
            for _, attribute, _, prior in reversed(assignments):
                try: setattr(scene, attribute, prior)
                except BaseException: rollback_failed = True
            if rollback_failed or self._bounded_canonical(self._scene_state_fields(scene)) != self._bounded_canonical(before): raise ValueError("scene change failed and exact rollback failed") from error
            raise
        revision = self.refs.touch(reference)
        return {"changed": True, "revision": revision}

    def _scene_fire_selected(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:scene:") or set(args) - {"ref", "expectedObjectIdentity", "expectedAuthorityRevision", "expectedStateRevision"}: raise ValueError("scene fire authority is invalid")
        scenes = self._items(getattr(self.song, "scenes", [])); parts = reference.split(":"); index = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else -1
        if not 0 <= index < len(scenes): raise ValueError("scene hierarchy changed")
        scene = scenes[index]
        if not isinstance(args.get("expectedObjectIdentity"), str) or not hmac.compare_digest(self._capture_object_identity(scene), args["expectedObjectIdentity"]): raise ValueError("scene identity changed since preview")
        if not isinstance(args.get("expectedAuthorityRevision"), str) or not hmac.compare_digest(self._scene_collection_revision(), args["expectedAuthorityRevision"]): raise ValueError("scene collection changed since preview")
        playback = self._playback()
        state_revision = hashlib.sha256(self._bounded_canonical({"isTriggered": self._read_attr(scene, "is_triggered"), "playing": playback["transport"]["playing"]}).encode("utf-8")).hexdigest()
        if not isinstance(args.get("expectedStateRevision"), str) or not hmac.compare_digest(state_revision, args["expectedStateRevision"]): raise ValueError("scene fire state changed since preview")
        fire = getattr(scene, "fire_as_selected", None)
        if not callable(fire): raise ValueError("scene fire-as-selected is unavailable")
        fire()
        observed = self._read_attr(scene, "is_triggered")
        if observed is not True: raise ValueError("scene fire was not confirmed")
        return {"fired": True}

    def _song_state(self) -> dict[str, Any]:
        song = self.song
        def optional_bool(name: str) -> bool | None:
            value = self._read_attr(song, name)
            return value if isinstance(value, bool) else None
        def optional_float(name: str) -> float | None:
            value = self._read_attr(song, name)
            return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) else None
        def optional_int(name: str) -> int | None:
            value = self._read_attr(song, name)
            return int(value) if isinstance(value, int) and not isinstance(value, bool) else None
        visible = []
        for index, track in enumerate(self._items(getattr(song, "visible_tracks", []))):
            if len(visible) >= 256: raise ValueError("visible track collection exceeds its bound")
            visible.append(self.refs.put("track", track, str(index)))
        appointed = self._read_attr(song, "appointed_device")
        appointed_ref = self.refs.put("device", appointed, "appointed") if appointed is not None else None
        quantization = self._read_attr(song, "clip_trigger_quantization")
        return {
            "visibleTracks": visible,
            "appointedDevice": appointed_ref,
            "songLength": optional_float("length"),
            "startTime": optional_float("start_time"),
            "signatureNumerator": optional_int("signature_numerator"),
            "signatureDenominator": optional_int("signature_denominator"),
            "swingAmount": optional_float("swing_amount"),
            "overdub": optional_bool("overdub"),
            "arrangementOverdub": optional_bool("arrangement_overdub"),
            "backToArranger": optional_bool("back_to_arranger"),
            "canCaptureMidi": optional_bool("can_capture_midi"),
            "canUndo": optional_bool("can_undo"),
            "canRedo": optional_bool("can_redo"),
            "exclusiveArm": optional_bool("exclusive_arm"),
            "exclusiveSolo": optional_bool("exclusive_solo"),
            "isCountingIn": optional_bool("is_counting_in"),
            "tempoFollowerEnabled": optional_bool("tempo_follower_enabled"),
            "reEnableAutomationEnabled": optional_bool("re_enable_automation_enabled"),
            "sessionRecord": optional_bool("session_record"),
            "sessionAutomationRecord": optional_bool("session_automation_record"),
            "clipTriggerQuantization": str(quantization) if isinstance(quantization, str) else None,
            "isAbletonLinkEnabled": optional_bool("is_ableton_link_enabled"),
            "isAbletonLinkStartStopSyncEnabled": optional_bool("is_ableton_link_start_stop_sync_enabled"),
            "tempoFollower": optional_bool("tempo_follower"),
        }

    def _song_read(self, args: dict[str, Any]) -> dict[str, Any]:
        set_ref = args.get("setRef")
        if not isinstance(set_ref, str) or set_ref != self.refs.put("set", self.song, "song") or set(args) - {"setRef"}:
            raise ValueError("song read arguments are invalid")
        state = self._song_state()
        return {**state, "revision": hashlib.sha256(self._bounded_canonical(state).encode("utf-8")).hexdigest()}

    _TRANSPORT_ACTIONS = {"start", "continue", "stop", "play-selection", "scrub", "tap-tempo", "nudge-up", "nudge-down", "re-enable-automation", "trigger-session-record", "force-link-beat-time"}

    def _transport_action(self, args: dict[str, Any]) -> dict[str, Any]:
        set_ref = args.get("setRef"); action = args.get("action")
        if not isinstance(set_ref, str) or set_ref != self.refs.put("set", self.song, "song") or action not in self._TRANSPORT_ACTIONS or set(args) - {"setRef", "action", "beatTime", "expectedObjectIdentity", "expectedRevision"}:
            raise ValueError("transport action is invalid")
        if not isinstance(args.get("expectedObjectIdentity"), str) or not hmac.compare_digest(self._capture_object_identity(self.song), args["expectedObjectIdentity"]): raise ValueError("Set identity changed since preview")
        playback = self._playback()
        if not isinstance(args.get("expectedRevision"), str) or not hmac.compare_digest(str(playback["revision"]), args["expectedRevision"]): raise ValueError("transport state changed since preview")
        song = self.song
        if action == "start": method, call_args = getattr(song, "start_playing", None), ()
        elif action == "continue": method, call_args = getattr(song, "continue_playing", None), ()
        elif action == "stop": method, call_args = getattr(song, "stop_playing", None), ()
        elif action == "play-selection": method, call_args = getattr(song, "play_selection", None), ()
        elif action == "scrub": method, call_args = getattr(song, "scrub", None), ()
        elif action == "tap-tempo": method, call_args = getattr(song, "tap_tempo", None), ()
        elif action == "nudge-up": method, call_args = getattr(song, "nudge_up", None), ()
        elif action == "nudge-down": method, call_args = getattr(song, "nudge_down", None), ()
        elif action == "re-enable-automation": method, call_args = getattr(song, "re_enable_automation", None), ()
        elif action == "trigger-session-record": method, call_args = getattr(song, "trigger_session_record", None), ()
        else:
            method = getattr(song, "force_link_beat_time", None)
            beat = args.get("beatTime")
            if not isinstance(beat, (int, float)) or isinstance(beat, bool) or not math.isfinite(float(beat)): raise ValueError("beatTime is required for force-link-beat-time")
            call_args = (float(beat),)
        if not callable(method): raise ValueError(f"transport action {action} is unavailable on this Live shape")
        method(*call_args)
        return {"done": True, "revision": str(self._playback()["revision"])}

    def _locator_jump_to(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:locator:") or set(args) - {"ref", "expectedObjectIdentity", "expectedCollectionRevision"}:
            raise ValueError("locator jump authority is invalid")
        locators = self._items(getattr(self.song, "cue_points", [])); parts = reference.split(":"); index = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else -1
        if not 0 <= index < len(locators): raise ValueError("locator hierarchy changed")
        locator = locators[index]
        if not isinstance(args.get("expectedObjectIdentity"), str) or not hmac.compare_digest(self._capture_object_identity(locator), args["expectedObjectIdentity"]): raise ValueError("locator identity changed since preview")
        collection_revision = hashlib.sha256(self._bounded_canonical(self._locator_items()).encode("utf-8")).hexdigest()
        if not isinstance(args.get("expectedCollectionRevision"), str) or not hmac.compare_digest(collection_revision, args["expectedCollectionRevision"]): raise ValueError("locator collection changed since preview")
        jump = getattr(locator, "jump", None)
        if not callable(jump): raise ValueError("locator jump is unavailable on this Live shape")
        jump()
        position = self._read_attr(self.song, "current_song_time")
        locator_time = self._read_attr(locator, "time")
        if not isinstance(position, (int, float)) or isinstance(position, bool) or not math.isfinite(float(position)) or float(position) < 0: raise ValueError("locator jump did not report a readable song position")
        if isinstance(locator_time, (int, float)) and float(position) != float(locator_time): raise ValueError("locator jump was not confirmed")
        return {"position": float(position)}

    def _song_time_convert(self, args: dict[str, Any]) -> dict[str, Any]:
        set_ref = args.get("setRef")
        if not isinstance(set_ref, str) or set_ref != self.refs.put("set", self.song, "song") or set(args) - {"setRef", "beatTime", "smpteSeconds", "format"}:
            raise ValueError("time-convert arguments are invalid")
        song = self.song
        beats_value = None; smpte_value = None; loop_beats = None; loop_smpte = None
        if "smpteSeconds" in args:
            seconds = args["smpteSeconds"]
            if not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or not math.isfinite(float(seconds)) or float(seconds) < 0: raise ValueError("smpteSeconds is invalid")
            tempo = self._read_attr(song, "tempo")
            if not isinstance(tempo, (int, float)) or isinstance(tempo, bool) or not 20 <= float(tempo) <= 999: raise ValueError("tempo is unavailable for time conversion")
            beats_value = float(seconds) * float(tempo) / 60.0
        if "beatTime" in args:
            beat = args["beatTime"]
            if not isinstance(beat, (int, float)) or isinstance(beat, bool) or not math.isfinite(float(beat)): raise ValueError("beatTime is invalid")
            tempo = self._read_attr(song, "tempo")
            if not isinstance(tempo, (int, float)) or isinstance(tempo, bool) or not 20 <= float(tempo) <= 999: raise ValueError("tempo is unavailable for time conversion")
            smpte_value = float(beat) * 60.0 / float(tempo)
        beats_loop = getattr(song, "get_beats_loop_time", None)
        if callable(beats_loop):
            try: loop_beats = float(beats_loop())
            except BaseException: loop_beats = None
        smpte_loop = getattr(song, "get_smpte_loop_time", None)
        if callable(smpte_loop):
            try: loop_smpte = float(smpte_loop())
            except BaseException: loop_smpte = None
        available = beats_value is not None or smpte_value is not None or loop_beats is not None or loop_smpte is not None
        return {"available": available, "beats": beats_value, "smpteSeconds": smpte_value, "loopBeats": loop_beats, "loopSmpteSeconds": loop_smpte}

    def _track_state_fields(self, track: Any, track_index: int) -> dict[str, Any]:
        def optional_bool(obj: Any, name: str) -> bool | None:
            value = self._read_attr(obj, name)
            return value if isinstance(value, bool) else None
        def optional_float(obj: Any, name: str) -> float | None:
            value = self._read_attr(obj, name)
            return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) else None
        group = self._read_attr(track, "group_track")
        group_ref = self.refs.put("track", group, f"group:{track_index}") if group is not None else None
        view = getattr(track, "view", None)
        selected_device = self._read_attr(view, "selected_device") if view is not None else None
        device_insert_mode = self._read_attr(view, "device_insert_mode") if view is not None else None
        selected_track = self._read_attr(getattr(self.song, "view", None), "selected_track")
        return {
            "groupTrackRef": group_ref,
            "isVisible": optional_bool(track, "is_visible"),
            "isSelected": (selected_track is track) if selected_track is not None else None,
            "isFrozen": optional_bool(track, "is_frozen"),
            "foldState": optional_bool(track, "fold_state") if optional_bool(track, "fold_state") is not None else optional_bool(track, "is_folded"),
            "implicitArm": optional_bool(track, "implicit_arm"),
            "backToArranger": optional_bool(track, "back_to_arranger"),
            "mutedViaSolo": optional_bool(track, "muted_via_solo"),
            "inputMeterLeft": optional_float(track, "input_meter_left"),
            "inputMeterRight": optional_float(track, "input_meter_right"),
            "inputMeterLevel": optional_float(track, "input_meter_level"),
            "outputMeterLeft": optional_float(track, "output_meter_left"),
            "outputMeterRight": optional_float(track, "output_meter_right"),
            "outputMeterLevel": optional_float(track, "output_meter_level"),
            "performanceImpact": int(self._read_attr(track, "performance_impact")) if isinstance(self._read_attr(track, "performance_impact"), int) and not isinstance(self._read_attr(track, "performance_impact"), bool) else None,
            "view": {
                "selectedDeviceRef": self.refs.put("device", selected_device, f"view:{track_index}") if selected_device is not None else None,
                "deviceInsertMode": int(device_insert_mode) if isinstance(device_insert_mode, int) and not isinstance(device_insert_mode, bool) else None,
                "isCollapsed": optional_bool(view, "is_collapsed") if view is not None else None,
            },
        }

    def _track_view_state_revision(self, track: Any) -> str:
        view = getattr(track, "view", None)
        collapsed = self._read_attr(view, "is_collapsed") if view is not None else None
        mode = self._read_attr(view, "device_insert_mode") if view is not None else None
        return hashlib.sha256(self._bounded_canonical({"collapsed": collapsed if isinstance(collapsed, bool) else None, "deviceInsertMode": int(mode) if isinstance(mode, int) and not isinstance(mode, bool) else None}).encode("utf-8")).hexdigest()

    def _track_create_return(self, args: dict[str, Any]) -> dict[str, Any]:
        if set(args) - {"name", "expectedStructureRevision"}: raise ValueError("return-track creation arguments are invalid")
        if not isinstance(args.get("expectedStructureRevision"), str) or not hmac.compare_digest(self._structure_revision(), args["expectedStructureRevision"]): raise ValueError("structure changed since preview")
        creator = getattr(self.song, "create_return_track", None)
        if not callable(creator): raise ValueError("return-track creation is unavailable")
        name = args.get("name")
        if name is not None and (not isinstance(name, str) or not 1 <= len(name) <= 256): raise ValueError("name is invalid")
        before = self._items(getattr(self.song, "return_tracks", [])); before_identities = [self._capture_object_identity(item) for item in before]
        track = creator()
        after = self._items(getattr(self.song, "return_tracks", [])); created = [candidate for candidate in after if self._capture_object_identity(candidate) not in set(before_identities)]
        if track is None or len(after) != len(before) + 1 or len(created) != 1: raise ValueError("return-track creation was not confirmed")
        created_track = created[0]
        if name is not None and hasattr(created_track, "name"): created_track.name = name
        if name is not None and str(getattr(created_track, "name", "")) != name: raise ValueError("return-track name was not confirmed")
        index = len(after) - 1; reference = self.refs.put("return_track", created_track, str(index)); identity = self._capture_object_identity(created_track)
        fingerprint = hashlib.sha256(self._bounded_canonical({"ref": reference, "objectIdentity": identity, "name": str(getattr(created_track, "name", "")), "index": index}).encode("utf-8")).hexdigest()
        return {"ref": reference, "objectIdentity": identity, "name": str(getattr(created_track, "name", "")), "index": index, "createdFingerprint": fingerprint}

    def _track_delete_return(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:return_track:") or set(args) - {"ref", "expectedObjectIdentity", "expectedStructureRevision"}: raise ValueError("return-track deletion authority is invalid")
        if not isinstance(args.get("expectedStructureRevision"), str) or not hmac.compare_digest(self._structure_revision(), args["expectedStructureRevision"]): raise ValueError("structure changed since preview")
        returns = self._items(getattr(self.song, "return_tracks", [])); parts = reference.split(":"); index = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else -1
        if not 0 <= index < len(returns): raise ValueError("return-track hierarchy changed")
        track = returns[index]
        if not isinstance(args.get("expectedObjectIdentity"), str) or not hmac.compare_digest(self._capture_object_identity(track), args["expectedObjectIdentity"]): raise ValueError("return-track identity changed since preview")
        deleter = getattr(self.song, "delete_return_track", None)
        if not callable(deleter): raise ValueError("return-track deletion is unavailable")
        deleter(index)
        remaining = self._items(getattr(self.song, "return_tracks", []))
        if len(remaining) != len(returns) - 1 or any(self._capture_object_identity(candidate) == self._capture_object_identity(track) for candidate in remaining): raise ValueError("return-track deletion was not confirmed")
        return {"deleted": reference}

    def _track_duplicate(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:track:") or set(args) - {"ref", "expectedObjectIdentity", "expectedStructureRevision"}: raise ValueError("track duplication authority is invalid")
        if not isinstance(args.get("expectedStructureRevision"), str) or not hmac.compare_digest(self._structure_revision(), args["expectedStructureRevision"]): raise ValueError("structure changed since preview")
        tracks = self._items(getattr(self.song, "tracks", [])); parts = reference.split(":"); index = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else -1
        if not 0 <= index < len(tracks): raise ValueError("track hierarchy changed")
        track = tracks[index]
        if not isinstance(args.get("expectedObjectIdentity"), str) or not hmac.compare_digest(self._capture_object_identity(track), args["expectedObjectIdentity"]): raise ValueError("track identity changed since preview")
        duplicator = getattr(self.song, "duplicate_track", None)
        if not callable(duplicator): raise ValueError("track duplication is unavailable")
        before = len(tracks)
        duplicator(index)
        after = self._items(getattr(self.song, "tracks", []))
        if len(after) != before + 1: raise ValueError("track duplication was not confirmed")
        created = after[index + 1]; reference_new = self.refs.put("track", created, str(index + 1)); identity = self._capture_object_identity(created)
        fingerprint = hashlib.sha256(self._bounded_canonical({"ref": reference_new, "objectIdentity": identity, "name": str(getattr(created, "name", "")), "index": index + 1}).encode("utf-8")).hexdigest()
        return {"ref": reference_new, "objectIdentity": identity, "name": str(getattr(created, "name", "")), "index": index + 1, "createdFingerprint": fingerprint}

    def _scene_duplicate(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:scene:") or set(args) - {"ref", "expectedObjectIdentity", "expectedStructureRevision"}: raise ValueError("scene duplication authority is invalid")
        if not isinstance(args.get("expectedStructureRevision"), str) or not hmac.compare_digest(self._structure_revision(), args["expectedStructureRevision"]): raise ValueError("structure changed since preview")
        scenes = self._items(getattr(self.song, "scenes", [])); parts = reference.split(":"); index = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else -1
        if not 0 <= index < len(scenes): raise ValueError("scene hierarchy changed")
        scene = scenes[index]
        if not isinstance(args.get("expectedObjectIdentity"), str) or not hmac.compare_digest(self._capture_object_identity(scene), args["expectedObjectIdentity"]): raise ValueError("scene identity changed since preview")
        duplicator = getattr(self.song, "duplicate_scene", None)
        if not callable(duplicator): raise ValueError("scene duplication is unavailable")
        before = len(scenes)
        duplicator(index)
        after = self._items(getattr(self.song, "scenes", []))
        if len(after) != before + 1: raise ValueError("scene duplication was not confirmed")
        created = after[index + 1]; reference_new = self.refs.put("scene", created, str(index + 1)); identity = self._capture_object_identity(created)
        fingerprint = hashlib.sha256(self._bounded_canonical({"ref": reference_new, "objectIdentity": identity, "name": str(getattr(created, "name", "")), "index": index + 1}).encode("utf-8")).hexdigest()
        return {"ref": reference_new, "objectIdentity": identity, "name": str(getattr(created, "name", "")), "index": index + 1, "createdFingerprint": fingerprint}

    def _track_view_set(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:track:") or set(args) - {"ref", "collapsed", "deviceInsertMode", "expectedObjectIdentity", "expectedStateRevision"}: raise ValueError("track view authority is invalid")
        tracks = self._items(getattr(self.song, "tracks", [])); parts = reference.split(":"); index = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else -1
        if not 0 <= index < len(tracks): raise ValueError("track hierarchy changed")
        track = tracks[index]; view = getattr(track, "view", None)
        if view is None: raise ValueError("track view is unavailable")
        if not isinstance(args.get("expectedObjectIdentity"), str) or not hmac.compare_digest(self._capture_object_identity(track), args["expectedObjectIdentity"]): raise ValueError("track identity changed since preview")
        if not isinstance(args.get("expectedStateRevision"), str) or not hmac.compare_digest(self._track_view_state_revision(track), args["expectedStateRevision"]): raise ValueError("track view state changed since preview")
        proposals = []
        if "collapsed" in args:
            value = args["collapsed"]
            if not isinstance(value, bool): raise ValueError("collapsed is invalid")
            proposals.append(("is_collapsed", value))
        if "deviceInsertMode" in args:
            value = args["deviceInsertMode"]
            if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 8: raise ValueError("deviceInsertMode is invalid")
            proposals.append(("device_insert_mode", value))
        if not proposals: raise ValueError("track view mutation has no fields")
        assignments = [(attribute, value, self._read_attr(view, attribute)) for attribute, value in proposals]
        before_revision = self._track_view_state_revision(track)
        try:
            for attribute, value, _ in assignments: setattr(view, attribute, value)
            for attribute, value, _ in assignments:
                observed = self._read_attr(view, attribute)
                if isinstance(value, bool):
                    if observed is not value: raise ValueError("track view change was not confirmed")
                elif not isinstance(observed, int) or isinstance(observed, bool) or observed != value: raise ValueError("track view change was not confirmed")
        except BaseException as error:
            rollback_failed = False
            for attribute, _, prior in reversed(assignments):
                try: setattr(view, attribute, prior)
                except BaseException: rollback_failed = True
            if rollback_failed or self._track_view_state_revision(track) != before_revision: raise ValueError("track view change failed and exact rollback failed") from error
            raise
        revision = self.refs.touch(reference)
        return {"changed": True, "revision": revision}

    def _track_select_instrument(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:track:") or set(args) - {"ref", "expectedObjectIdentity", "expectedStateRevision"}: raise ValueError("track instrument selection authority is invalid")
        tracks = self._items(getattr(self.song, "tracks", [])); parts = reference.split(":"); index = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else -1
        if not 0 <= index < len(tracks): raise ValueError("track hierarchy changed")
        track = tracks[index]
        if not isinstance(args.get("expectedObjectIdentity"), str) or not hmac.compare_digest(self._capture_object_identity(track), args["expectedObjectIdentity"]): raise ValueError("track identity changed since preview")
        if not isinstance(args.get("expectedStateRevision"), str) or not hmac.compare_digest(self._track_view_state_revision(track), args["expectedStateRevision"]): raise ValueError("track view state changed since preview")
        view = getattr(track, "view", None); selector = getattr(view, "select_instrument", None) if view is not None else None
        if not callable(selector): raise ValueError("instrument selection is unavailable")
        selector()
        return {"done": True}

    def _selection_state(self) -> dict[str, Any]:
        view = getattr(self.song, "view", None)
        def ref_or_none(value: Any, kind: str, key: str) -> str | None:
            return self.refs.put(kind, value, key) if value is not None else None
        track = self._read_attr(view, "selected_track"); scene = self._read_attr(view, "selected_scene")
        slot = self._read_attr(view, "highlighted_clip_slot"); detail_clip = self._read_attr(view, "detail_clip")
        device = self._read_attr(view, "selected_device"); parameter = self._read_attr(view, "selected_parameter"); chain = self._read_attr(view, "selected_chain")
        return {
            "trackRef": ref_or_none(track, "track", "selected") if track is not None else None,
            "sceneRef": ref_or_none(scene, "scene", "selected") if scene is not None else None,
            "slotRef": ref_or_none(slot, "clip_slot", "highlighted") if slot is not None else None,
            "detailClipRef": ref_or_none(detail_clip, "clip", "detail") if detail_clip is not None else None,
            "deviceRef": ref_or_none(device, "device", "selected") if device is not None else None,
            "parameterRef": ref_or_none(parameter, "parameter", "selected") if parameter is not None else None,
            "chainRef": ref_or_none(chain, "chain", "selected") if chain is not None else None,
        }

    def _selection_revision(self) -> str:
        return hashlib.sha256(self._bounded_canonical(self._selection_state()).encode("utf-8")).hexdigest()

    def _selection_set(self, args: dict[str, Any]) -> dict[str, Any]:
        allowed = {"trackRef", "sceneRef", "detailClipRef", "slotRef", "deviceRef", "parameterRef", "chainRef", "expectedStateRevision"}
        if set(args) - allowed: raise ValueError("selection fields are invalid")
        if not isinstance(args.get("expectedStateRevision"), str) or not hmac.compare_digest(self._selection_revision(), args["expectedStateRevision"]): raise ValueError("selection state changed since preview")
        view = getattr(self.song, "view", None)
        if view is None: raise ValueError("song view is unavailable")
        proposals = []
        for key, attribute, kind in (("trackRef", "selected_track", "track"), ("sceneRef", "selected_scene", "scene"), ("slotRef", "highlighted_clip_slot", "clip_slot"), ("detailClipRef", "detail_clip", "clip"), ("deviceRef", "selected_device", "device"), ("parameterRef", "selected_parameter", "parameter"), ("chainRef", "selected_chain", "chain")):
            if key not in args: continue
            reference = args[key]
            if reference is None:
                if key == "detailClipRef": proposals.append((attribute, None))
                continue
            if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:{kind}:"): raise ValueError(f"{key} is stale or invalid")
            proposals.append((attribute, self.refs.get(reference)))
        if not proposals: raise ValueError("selection mutation has no fields")
        assignments = []
        for attribute, value in proposals:
            prior = self._read_attr(view, attribute)
            try: setattr(view, attribute, value)
            except BaseException as error: raise ValueError(f"selection target {attribute} cannot be assigned") from error
            assignments.append((attribute, prior))
        return {"changed": True, "revision": self._selection_revision()}

    def _song_view_set(self, args: dict[str, Any]) -> dict[str, Any]:
        if set(args) - {"drawMode", "expectedStateRevision"}: raise ValueError("song view fields are invalid")
        view = getattr(self.song, "view", None)
        if view is None: raise ValueError("song view is unavailable")
        revision = hashlib.sha256(self._bounded_canonical({"drawMode": self._read_attr(view, "draw_mode")}).encode("utf-8")).hexdigest()
        if not isinstance(args.get("expectedStateRevision"), str) or not hmac.compare_digest(revision, args["expectedStateRevision"]): raise ValueError("song view state changed since preview")
        if "drawMode" not in args: raise ValueError("song view mutation has no fields")
        value = args["drawMode"]
        if not isinstance(value, bool): raise ValueError("drawMode is invalid")
        prior = self._read_attr(view, "draw_mode")
        if not isinstance(prior, bool): raise ValueError("draw mode is unavailable")
        try:
            view.draw_mode = value
            if self._read_attr(view, "draw_mode") is not value: raise ValueError("draw mode change was not confirmed")
        except BaseException as error:
            try: view.draw_mode = prior
            except BaseException: raise ValueError("draw mode change failed and exact rollback failed") from error
            raise
        return {"changed": True, "revision": hashlib.sha256(self._bounded_canonical({"drawMode": self._read_attr(view, "draw_mode")}).encode("utf-8")).hexdigest()}

    def _clip_view_state(self, clip: Any) -> dict[str, Any]:
        view = getattr(clip, "view", None)
        grid = self._read_attr(view, "grid_quantization") if view is not None else None
        return {
            "gridQuantization": int(grid) if isinstance(grid, int) and not isinstance(grid, bool) else None,
            "tripletGrid": self._read_attr(view, "triplet_grid") if isinstance(self._read_attr(view, "triplet_grid"), bool) else None,
            "showEnvelope": self._read_attr(view, "show_envelope") if isinstance(self._read_attr(view, "show_envelope"), bool) else None,
        }

    def _clip_view_set(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:") or set(args) - {"ref", "gridQuantization", "tripletGrid", "showEnvelope", "showLoop", "expectedObjectIdentity", "expectedStateRevision"}: raise ValueError("clip view authority is invalid")
        clip = self.refs.get(reference); view = getattr(clip, "view", None)
        if view is None: raise ValueError("clip view is unavailable")
        current = self.get(reference)
        if not isinstance(args.get("expectedObjectIdentity"), str) or not hmac.compare_digest(str(current.get("objectIdentity", "")), args["expectedObjectIdentity"]): raise ValueError("clip identity changed since preview")
        state_revision = hashlib.sha256(self._bounded_canonical(self._clip_view_state(clip)).encode("utf-8")).hexdigest()
        if not isinstance(args.get("expectedStateRevision"), str) or not hmac.compare_digest(state_revision, args["expectedStateRevision"]): raise ValueError("clip view state changed since preview")
        proposals = []
        if "gridQuantization" in args:
            value = args["gridQuantization"]
            if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 16: raise ValueError("gridQuantization is invalid")
            proposals.append(("grid_quantization", value))
        if "tripletGrid" in args:
            value = args["tripletGrid"]
            if not isinstance(value, bool): raise ValueError("tripletGrid is invalid")
            proposals.append(("triplet_grid", value))
        if "showEnvelope" in args:
            value = args["showEnvelope"]
            if not isinstance(value, bool): raise ValueError("showEnvelope is invalid")
            proposals.append(("show_envelope", value))
        assignments = [(attribute, value, self._read_attr(view, attribute)) for attribute, value in proposals]
        before_revision = state_revision
        try:
            for attribute, value, _ in assignments: setattr(view, attribute, value)
            for attribute, value, _ in assignments:
                observed = self._read_attr(view, attribute)
                if isinstance(value, bool):
                    if observed is not value: raise ValueError("clip view change was not confirmed")
                elif not isinstance(observed, int) or isinstance(observed, bool) or observed != value: raise ValueError("clip view change was not confirmed")
        except BaseException as error:
            rollback_failed = False
            for attribute, _, prior in reversed(assignments):
                try: setattr(view, attribute, prior)
                except BaseException: rollback_failed = True
            if rollback_failed or hashlib.sha256(self._bounded_canonical(self._clip_view_state(clip)).encode("utf-8")).hexdigest() != before_revision: raise ValueError("clip view change failed and exact rollback failed") from error
            raise
        if args.get("showLoop") is True:
            shower = getattr(view, "show_loop", None)
            if not callable(shower): raise ValueError("clip show-loop is unavailable")
            shower()
        revision = self.refs.touch(reference)
        return {"changed": True, "revision": revision}

    def _device_view_set(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:device:") or set(args) - {"ref", "collapsed", "expectedObjectIdentity", "expectedStateRevision"}: raise ValueError("device view authority is invalid")
        device = self.refs.get(reference); view = getattr(device, "view", None)
        if view is None or self._read_attr(view, "is_collapsed") is None: raise ValueError("device view collapsed state is unavailable on this Live shape")
        if not isinstance(args.get("expectedObjectIdentity"), str) or not hmac.compare_digest(self._capture_object_identity(device), args["expectedObjectIdentity"]): raise ValueError("device identity changed since preview")
        state_revision = hashlib.sha256(self._bounded_canonical({"collapsed": self._read_attr(view, "is_collapsed")}).encode("utf-8")).hexdigest()
        if not isinstance(args.get("expectedStateRevision"), str) or not hmac.compare_digest(state_revision, args["expectedStateRevision"]): raise ValueError("device view state changed since preview")
        value = args.get("collapsed")
        if not isinstance(value, bool): raise ValueError("collapsed is invalid")
        prior = self._read_attr(view, "is_collapsed")
        try:
            view.is_collapsed = value
            if self._read_attr(view, "is_collapsed") is not value: raise ValueError("device collapse change was not confirmed")
        except BaseException as error:
            try: view.is_collapsed = prior
            except BaseException: raise ValueError("device collapse change failed and exact rollback failed") from error
            raise
        revision = self.refs.touch(reference)
        return {"changed": True, "revision": revision}

    def _application_dialog(self, args: dict[str, Any]) -> dict[str, Any]:
        action = args.get("action")
        if action not in {"read", "press"} or set(args) - {"action", "button", "expectedState"}: raise ValueError("dialog arguments are invalid")
        application = self._application()
        reader = getattr(application, "get_dialog_state", None)
        state = None
        if callable(reader):
            try: raw = reader(); state = int(raw) if isinstance(raw, int) and not isinstance(raw, bool) else None
            except BaseException: state = None
        if action == "read": return {"state": state, "done": True}
        presser = getattr(application, "press_dialog_button", None)
        if not callable(presser): raise ValueError("dialog button presses are unavailable")
        button = args.get("button")
        if not isinstance(button, int) or isinstance(button, bool) or not 0 <= button <= 16: raise ValueError("dialog button is invalid")
        expected = args.get("expectedState")
        if not isinstance(expected, int) or isinstance(expected, bool) or expected < -1: raise ValueError("expectedState is required for a guarded dialog press")
        if state != expected: raise ValueError("dialog state changed since preview")
        presser(button)
        new_state = None
        if callable(reader):
            try: raw = reader(); new_state = int(raw) if isinstance(raw, int) and not isinstance(raw, bool) else None
            except BaseException: new_state = None
        return {"state": new_state, "done": True}

    def _performance_read(self, args: dict[str, Any]) -> dict[str, Any]:
        set_ref = args.get("setRef")
        if not isinstance(set_ref, str) or set_ref != self.refs.put("set", self.song, "song") or set(args) - {"setRef"}:
            raise ValueError("performance read arguments are invalid")
        try:
            application = self._application()
        except ValueError:
            application = None
        average = self._read_attr(application, "average_process_usage") if application is not None else None
        peak = self._read_attr(application, "peak_process_usage") if application is not None else None
        snapshot = self.snapshot()
        tracks = []
        for track in snapshot["tracks"]:
            devices = []
            def collect(rows: list[dict[str, Any]]) -> None:
                for row in rows:
                    devices.append({"ref": row["ref"], "latencySamples": row.get("latencySamples"), "latencyMs": row.get("latencyMs")})
                    for chain in row.get("chains", []): collect(chain.get("devices", []))
                    for pad in row.get("drumPads", []):
                        for chain in pad.get("chains", []): collect(chain.get("devices", []))
            collect(track.get("devices", []))
            if len(devices) > 256: raise ValueError("device performance collection exceeds its bound")
            tracks.append({
                "ref": track["ref"],
                "performanceImpact": track.get("performanceImpact"),
                "inputMeterLeft": track.get("inputMeterLeft"), "inputMeterRight": track.get("inputMeterRight"), "inputMeterLevel": track.get("inputMeterLevel"),
                "outputMeterLeft": track.get("outputMeterLeft"), "outputMeterRight": track.get("outputMeterRight"), "outputMeterLevel": track.get("outputMeterLevel"),
                "devices": devices,
            })
        if len(tracks) > 256: raise ValueError("track performance collection exceeds its bound")
        state = {"averageProcessUsage": average, "peakProcessUsage": peak, "tracks": tracks}
        return {**state, "sampledAt": int(time.time() * 1000), "revision": hashlib.sha256(self._bounded_canonical(state).encode("utf-8")).hexdigest()}

    def _slot_state_fields(self, slot: Any) -> dict[str, Any]:
        def optional_bool(name: str) -> bool | None:
            value = self._read_attr(slot, name)
            return value if isinstance(value, bool) else None
        color = self._read_attr(slot, "color_index")
        playing = self._read_attr(slot, "playing_status")
        return {
            "colorIndex": int(color) if isinstance(color, int) and not isinstance(color, bool) and 0 <= color <= 69 else None,
            "controlsOtherClips": optional_bool("controls_other_clips"),
            "hasStopButton": optional_bool("has_stop_button"),
            "isGroupSlot": optional_bool("is_group_slot"),
            "playingStatus": int(playing) if isinstance(playing, int) and not isinstance(playing, bool) else None,
            "willRecordOnStart": optional_bool("will_record_on_start"),
            "fireButtonState": optional_bool("fire_button_state"),
        }

    def _scene_row(self, scene: Any, index: int) -> dict[str, Any]:
        def optional_bool(name: str) -> bool | None:
            value = self._read_attr(scene, name)
            return value if isinstance(value, bool) else None
        def optional_int(name: str) -> int | None:
            value = self._read_attr(scene, name)
            return int(value) if isinstance(value, int) and not isinstance(value, bool) else None
        color = self._read_attr(scene, "color_index")
        tempo = self._read_attr(scene, "tempo")
        return {
            "ref": self.refs.put("scene", scene, str(index)), "parentRef": self.refs.put("set", self.song, "song"), "objectIdentity": self._capture_object_identity(scene),
            "name": str(getattr(scene, "name", f"Scene {index + 1}")), "index": index,
            "triggerable": callable(getattr(scene, "fire", None)) or callable(getattr(scene, "launch", None)),
            "colorIndex": int(color) if isinstance(color, int) and not isinstance(color, bool) and 0 <= color <= 69 else None,
            "isEmpty": optional_bool("is_empty"),
            "isTriggered": optional_bool("is_triggered"),
            "tempo": float(tempo) if isinstance(tempo, (int, float)) and not isinstance(tempo, bool) and math.isfinite(float(tempo)) else None,
            "tempoEnabled": optional_bool("tempo_enabled"),
            "signatureNumerator": optional_int("time_signature_numerator"),
            "signatureDenominator": optional_int("time_signature_denominator"),
            "timeSignatureEnabled": optional_bool("time_signature_enabled"),
            "fireButtonState": optional_bool("fire_button_state"),
        }

    def _scene_state_fields(self, scene: Any) -> dict[str, Any]:
        def optional_bool(name: str) -> bool | None:
            value = self._read_attr(scene, name)
            return value if isinstance(value, bool) else None
        def optional_int(name: str) -> int | None:
            value = self._read_attr(scene, name)
            return int(value) if isinstance(value, int) and not isinstance(value, bool) else None
        color = self._read_attr(scene, "color_index"); tempo = self._read_attr(scene, "tempo")
        return {
            "colorIndex": int(color) if isinstance(color, int) and not isinstance(color, bool) and 0 <= color <= 69 else None,
            "tempo": float(tempo) if isinstance(tempo, (int, float)) and not isinstance(tempo, bool) and math.isfinite(float(tempo)) else None,
            "tempoEnabled": optional_bool("tempo_enabled"),
            "signatureNumerator": optional_int("time_signature_numerator"),
            "signatureDenominator": optional_int("time_signature_denominator"),
            "timeSignatureEnabled": optional_bool("time_signature_enabled"),
        }

    def _scene_collection_revision(self) -> str:
        scenes = self._items(getattr(self.song, "scenes", []))
        rows = [{"ref": self.refs.put("scene", scene, str(index)), "objectIdentity": self._capture_object_identity(scene), "name": str(getattr(scene, "name", "")), **self._scene_state_fields(scene)} for index, scene in enumerate(scenes)]
        if len(rows) > 512: raise ValueError("scene collection exceeds authority bound")
        return hashlib.sha256(self._bounded_canonical(rows).encode("utf-8")).hexdigest()

    def _mixer_row(self, track: Any, track_index: int) -> dict[str, Any]:
        mixer = self._read_attr(track, "mixer_device")

        def param_value(obj: Any) -> float | None:
            value = self._read_attr(obj, "value") if obj is not None else None
            return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) else None

        def flag(name: str) -> bool | None:
            value = self._read_attr(track, name)
            return bool(value) if isinstance(value, bool) else None

        volume_param = self._read_attr(mixer, "volume") if mixer is not None else None
        pan_param = self._read_attr(mixer, "panning") if mixer is not None else None
        cue_param = self._read_attr(mixer, "cue_volume") if mixer is not None else None
        send_params = self._items(self._read_attr(mixer, "sends") or []) if mixer is not None else []
        return {
            "volume": param_value(volume_param),
            "pan": param_value(pan_param),
            "cueVolume": param_value(cue_param),
            "mute": flag("mute"),
            "solo": flag("solo"),
            "sends": [param_value(send) for send in send_params],
            "volumeRef": self.refs.put("parameter", volume_param, f"mixer:{track_index}:volume") if volume_param is not None else None,
            "volumeIdentity": self._capture_object_identity(volume_param) if volume_param is not None else None,
            "panRef": self.refs.put("parameter", pan_param, f"mixer:{track_index}:panning") if pan_param is not None else None,
            "panIdentity": self._capture_object_identity(pan_param) if pan_param is not None else None,
            "cueRef": self.refs.put("parameter", cue_param, f"mixer:{track_index}:cue_volume") if cue_param is not None else None,
            "cueIdentity": self._capture_object_identity(cue_param) if cue_param is not None else None,
            "sendRefs": [self.refs.put("parameter", send, f"mixer:{track_index}:sends:{send_index}") for send_index, send in enumerate(send_params)],
            "sendIdentities": [self._capture_object_identity(send) for send in send_params],
        }

    def _resolve_parameter(self, reference: str) -> Any:
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:parameter:"):
            raise ValueError("parameter reference is stale or invalid")
        key = ":".join(reference.split(":")[2:])
        if key.startswith("mixer:"):
            parts = key.split(":")
            if len(parts) < 3 or not parts[1].isdigit():
                raise ValueError("mixer parameter reference is malformed")
            track_index = int(parts[1])
            tracks = self._all_track_objects()
            if not 0 <= track_index < len(tracks):
                raise ValueError("mixer parameter track is stale")
            mixer = self._read_attr(tracks[track_index], "mixer_device")
            if parts[2] == "sends":
                if len(parts) != 4 or not parts[3].isdigit():
                    raise ValueError("send parameter reference is malformed")
                sends = self._items(self._read_attr(mixer, "sends") or [])
                send_index = int(parts[3])
                if not 0 <= send_index < len(sends):
                    raise ValueError("send parameter is stale")
                return sends[send_index]
            parameter = self._read_attr(mixer, parts[2])
            if parameter is None:
                raise ValueError("mixer parameter is unavailable")
            return parameter
        return self.refs.get(reference)

    def _realtime_parameter_authority(self, reference: str) -> dict[str, Any]:
        """Resolve a realtime target to its exact current parameter, owner,
        track, traversal path, and ordered parameter siblings. Recomputing this
        descriptor on every Live-thread packet invalidates stale topology."""
        target = self._resolve_parameter(reference); target_identity = self._capture_object_identity(target)
        tracks = self._all_track_objects()
        budget = [0]
        def consume(amount: int = 1) -> None:
            budget[0] += amount
            if budget[0] > 1024: raise ValueError("realtime parameter identity traversal exceeded its bound")
        def descriptor(current_ref: str, parameter: Any, owner_ref: str, owner: Any, track_ref: str, track: Any, siblings: list[dict[str, str]]) -> dict[str, Any]:
            return {"ref": current_ref, "parameterIdentity": self._capture_object_identity(parameter), "ownerRef": owner_ref, "ownerIdentity": self._capture_object_identity(owner), "trackRef": track_ref, "trackIdentity": self._capture_object_identity(track), "siblings": siblings}
        for track_index, track in enumerate(tracks):
            if track is None: continue
            track_ref = self.refs.put("track", track, str(track_index)); mixer = self._read_attr(track, "mixer_device")
            mixer_parameters: list[tuple[str, Any]] = []
            if mixer is not None:
                for key, attribute in (("volume", "volume"), ("panning", "panning"), ("cue_volume", "cue_volume")):
                    parameter = self._read_attr(mixer, attribute)
                    if parameter is not None: mixer_parameters.append((f"mixer:{track_index}:{key}", parameter))
                for send_index, parameter in enumerate(self._items(self._read_attr(mixer, "sends") or [])):
                    mixer_parameters.append((f"mixer:{track_index}:sends:{send_index}", parameter))
            if len(mixer_parameters) > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("realtime mixer parameter collection exceeds its bound")
            mixer_siblings = [{"ref": self.refs.put("parameter", parameter, key), "objectIdentity": self._capture_object_identity(parameter)} for key, parameter in mixer_parameters]
            consume(len(mixer_siblings))
            for sibling, (_, parameter) in zip(mixer_siblings, mixer_parameters):
                if sibling["ref"] == reference and self._capture_same_object(parameter, target, target_identity): return descriptor(sibling["ref"], parameter, track_ref, track, track_ref, track, mixer_siblings)
            seen: set[str] = set()
            def visit(owner: Any, path: str) -> dict[str, Any] | None:
                owner_identity = self._capture_object_identity(owner)
                if owner_identity in seen: return None
                seen.add(owner_identity); devices = self._items(self._read_attr(owner, "devices", "device_chain") or [])
                if len(devices) > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("realtime device collection exceeds its bound")
                for device_index, device in enumerate(devices):
                    consume(); device_path = f"{path}:{device_index}"; device_ref = self.refs.put("device", device, device_path)
                    parameters: list[tuple[int, Any]] = []; native_parameters = self._items(self._read_attr(device, "parameters") or [])
                    if len(native_parameters) > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("realtime device parameter collection exceeds its complete-state bound")
                    for parameter_index, parameter in enumerate(native_parameters):
                        numeric = (self._read_attr(parameter, "min", "min_value"), self._read_attr(parameter, "max", "max_value"), self._read_attr(parameter, "value"))
                        if all(isinstance(item, (int, float)) and not isinstance(item, bool) and math.isfinite(float(item)) for item in numeric): parameters.append((parameter_index, parameter))
                    macros = self._items(self._read_attr(device, "macros") or []) if self._read_attr(device, "can_have_chains") is True else []
                    if len(parameters) + len(macros) > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("realtime device parameter collection exceeds its bound")
                    parameter_rows = [(self.refs.put("parameter", parameter, f"{device_ref}:{parameter_index}"), parameter) for parameter_index, parameter in parameters]
                    parameter_rows.extend((self.refs.put("parameter", macro, f"{device_ref}:macro:{macro_index}"), macro) for macro_index, macro in enumerate(macros))
                    siblings = [{"ref": current_ref, "objectIdentity": self._capture_object_identity(parameter)} for current_ref, parameter in parameter_rows]; consume(len(siblings))
                    for sibling, (_, parameter) in zip(siblings, parameter_rows):
                        if sibling["ref"] == reference and self._capture_same_object(parameter, target, target_identity): return descriptor(sibling["ref"], parameter, device_ref, device, track_ref, track, siblings)
                    chains = self._items(self._read_attr(device, "chains") or []) if self._read_attr(device, "can_have_chains") is True else []
                    if len(chains) > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("realtime device chain collection exceeds its bound")
                    for chain_index, chain in enumerate(chains):
                        consume(); found = visit(chain, f"{device_path}:{chain_index}")
                        if found is not None: return found
                    pads = self._items(self._read_attr(device, "visible_drum_pads") or self._read_attr(device, "drum_pads") or []) if self._read_attr(device, "can_have_drum_pads") is True else []
                    if len(pads) > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("realtime drum-pad collection exceeds its bound")
                    for pad_index, pad in enumerate(pads):
                        consume(); pad_chains = self._items(self._read_attr(pad, "chains") or [])
                        if len(pad_chains) > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("realtime drum-pad chain collection exceeds its bound")
                        for chain_index, chain in enumerate(pad_chains):
                            consume(); found = visit(chain, f"{device_path}:{pad_index}:{chain_index}")
                            if found is not None: return found
                return None
            found = visit(track, str(track_index))
            if found is not None: return found
        raise ValueError("realtime parameter target is no longer in the authoritative hierarchy")

    def _mixer_set(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:track:"):
            raise ValueError("track reference is stale or invalid")
        self.snapshot()
        track = self.refs.get(reference)
        mixer = self._read_attr(track, "mixer_device")
        if mixer is None:
            raise ValueError("mixer is unavailable")
        expected_track_identity = args.get("expectedObjectIdentity")
        expected_volume_identity = args.get("expectedVolumeIdentity")
        expected_pan_identity = args.get("expectedPanIdentity")
        expected_cue_identity = args.get("expectedCueIdentity")
        expected_send_identities = args.get("expectedSendIdentities")
        identity = lambda parameter: self._capture_object_identity(parameter) if parameter is not None else None
        send_parameters = self._items(self._read_attr(mixer, "sends") or [])
        current_authority = {
            "track": self._capture_object_identity(track),
            "volume": identity(self._read_attr(mixer, "volume")),
            "pan": identity(self._read_attr(mixer, "panning")),
            "cue": identity(self._read_attr(mixer, "cue_volume")),
            "sends": [identity(parameter) for parameter in send_parameters],
        }
        expected_authority = {"track": expected_track_identity, "volume": expected_volume_identity, "pan": expected_pan_identity, "cue": expected_cue_identity, "sends": expected_send_identities}
        if not isinstance(expected_track_identity, str) or expected_volume_identity is not None and not isinstance(expected_volume_identity, str) or expected_pan_identity is not None and not isinstance(expected_pan_identity, str) or expected_cue_identity is not None and not isinstance(expected_cue_identity, str) or not isinstance(expected_send_identities, list) or not hmac.compare_digest(self._bounded_canonical(current_authority), self._bounded_canonical(expected_authority)):
            raise ValueError("mixer track or parameter identity changed since preview")
        tracks = self._all_track_objects(); track_index = self._capture_index(tracks, track, expected_track_identity)
        if track_index is None or reference != f"{self.refs.epoch}:track:{track_index}": raise ValueError("mixer track hierarchy is stale or ambiguous")
        before_row = self._mixer_row(track, track_index); state = {field: before_row.get(field) for field in ("volume", "pan", "mute", "solo", "cueVolume", "sends")}; expected_state = args.get("expectedStateRevision"); state_revision = hashlib.sha256(self._bounded_canonical(state).encode("utf-8")).hexdigest()
        if not isinstance(expected_state, str) or not hmac.compare_digest(state_revision, expected_state): raise ValueError("mixer state changed since preview")
        allowed = {"ref", "volume", "pan", "mute", "solo", "cueVolume", "sends", "expectedObjectIdentity", "expectedVolumeIdentity", "expectedPanIdentity", "expectedCueIdentity", "expectedSendIdentities", "expectedStateRevision"}
        if set(args) - allowed:
            raise ValueError("mixer fields are invalid")

        def bounded(name: str, lo: float, hi: float) -> float | None:
            value = args.get(name)
            if value is None:
                return None
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or not lo <= float(value) <= hi:
                raise ValueError(f"{name} is invalid")
            return float(value)

        volume = bounded("volume", 0, 1)
        pan = bounded("pan", -1, 1)
        cue = bounded("cueVolume", 0, 1)
        mute = args.get("mute")
        if mute is not None and not isinstance(mute, bool):
            raise ValueError("mute is invalid")
        solo = args.get("solo")
        if solo is not None and not isinstance(solo, bool):
            raise ValueError("solo is invalid")
        sends = args.get("sends")
        if volume is not None and self._read_attr(mixer, "volume") is None:
            raise ValueError("volume is unavailable on this track")
        if pan is not None and self._read_attr(mixer, "panning") is None:
            raise ValueError("pan is unavailable on this track")
        if cue is not None and self._read_attr(mixer, "cue_volume") is None:
            raise ValueError("cue volume is unavailable on this track")
        if sends is not None:
            send_params = self._items(self._read_attr(mixer, "sends") or [])
            if not isinstance(sends, list) or len(sends) > len(send_params) or not all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) and 0 <= float(value) <= 1 for value in sends):
                raise ValueError("sends are invalid")
        assignments: list[tuple[Any, str, Any, Any]] = []
        if volume is not None: assignments.append((self._read_attr(mixer, "volume"), "value", volume, self._read_attr(self._read_attr(mixer, "volume"), "value")))
        if pan is not None: assignments.append((self._read_attr(mixer, "panning"), "value", pan, self._read_attr(self._read_attr(mixer, "panning"), "value")))
        if cue is not None: assignments.append((self._read_attr(mixer, "cue_volume"), "value", cue, self._read_attr(self._read_attr(mixer, "cue_volume"), "value")))
        if mute is not None: assignments.append((track, "mute", mute, self._read_attr(track, "mute")))
        if solo is not None: assignments.append((track, "solo", solo, self._read_attr(track, "solo")))
        send_params = self._items(self._read_attr(mixer, "sends") or [])
        if sends is not None:
            for send_index, value in enumerate(sends): assignments.append((send_params[send_index], "value", float(value), self._read_attr(send_params[send_index], "value")))
        if not assignments: raise ValueError("mixer mutation has no fields")
        try:
            for owner, name, value, _ in assignments: setattr(owner, name, value)
            row = self._mixer_row(track, track_index); checks = []
            if volume is not None: checks.append(isinstance(row["volume"], (int, float)) and float(row["volume"]) == volume)
            if pan is not None: checks.append(isinstance(row["pan"], (int, float)) and float(row["pan"]) == pan)
            if cue is not None: checks.append(isinstance(row["cueVolume"], (int, float)) and float(row["cueVolume"]) == cue)
            if mute is not None: checks.append(row["mute"] is mute)
            if solo is not None: checks.append(row["solo"] is solo)
            if sends is not None: checks.append(all(isinstance(row["sends"][i], (int, float)) and float(row["sends"][i]) == float(value) for i, value in enumerate(sends)))
            if not all(checks): raise ValueError("mixer change was not confirmed by fresh state")
        except BaseException as error:
            rollback_failed = False
            for owner, name, _, prior in reversed(assignments):
                try: setattr(owner, name, prior)
                except BaseException: rollback_failed = True
            restored = self._mixer_row(track, track_index); restored_state = {field: restored.get(field) for field in ("volume", "pan", "mute", "solo", "cueVolume", "sends")}
            if self._bounded_canonical(restored_state) != self._bounded_canonical(state): rollback_failed = True
            if rollback_failed: raise ValueError("mixer change failed and exact rollback failed") from error
            raise
        revision = self.refs.touch(reference)
        return {"changed": True, "revision": revision}

    def _envelope(self, clip_ref: str, parameter_ref: str, create: bool = False) -> tuple[Any, Any]:
        _, slot, _, _ = self._clip_location(clip_ref)
        clip = getattr(slot, "clip", None)
        if clip is None:
            raise ValueError("automation requires a Session clip")
        parameter = self._resolve_parameter(parameter_ref)
        reader = getattr(clip, "automation_envelope", None)
        if not callable(reader):
            raise ValueError("clip envelopes are unavailable on this Live shape")
        envelope = reader(parameter)
        if envelope is None and create:
            creator = getattr(clip, "create_automation_envelope", None)
            if not callable(creator):
                raise ValueError("envelope creation is unavailable")
            envelope = creator(parameter)
        return clip, envelope

    def _envelope_points(self, envelope: Any, limit: int = 512) -> list[dict[str, Any]]:
        clip = getattr(envelope, "canonical_parent", None); length = self._read_attr(clip, "length") if clip is not None else None
        if not isinstance(length, (int, float)) or isinstance(length, bool) or not math.isfinite(float(length)) or not 0 <= float(length) <= 100000: raise ValueError("complete automation envelope range is unavailable or exceeds its bound")
        window = float(length) + 4.0
        reader = getattr(envelope, "events_in_range", None)
        if not callable(reader): raise ValueError("complete automation envelope event enumeration is unavailable")
        events = list(reader(0.0, window))
        if len(events) > limit: raise ValueError("automation envelope exceeds its authoritative point bound")
        points: list[dict[str, Any]] = []
        for event in events:
            time_value = getattr(event, "time", None); value = getattr(event, "value", None)
            if not isinstance(time_value, (int, float)) or isinstance(time_value, bool) or not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(time_value)) or not math.isfinite(float(value)): raise ValueError("automation envelope contains an unreadable event")
            points.append({"time": float(time_value), "value": float(value)})
        return points

    def _envelope_event_class(self) -> Any:
        try: event_class = getattr(__import__("Live.Envelope", fromlist=["EnvelopeEvent"]), "EnvelopeEvent", None)
        except Exception: event_class = None
        if event_class is None:
            class _Event:
                def __init__(self, time: float, value: float): self.time = time; self.value = value
            event_class = _Event
        return event_class

    def _restore_envelope_state(self, clip: Any, parameter: Any, existed: bool, points: list[dict[str, Any]], mode: str = "clear-recreate") -> None:
        reader = getattr(clip, "automation_envelope", None); clearer = getattr(clip, "clear_envelope", None); creator = getattr(clip, "create_automation_envelope", None)
        if not callable(reader) or not callable(clearer): raise ValueError("automation rollback is unavailable")
        current = reader(parameter)
        if not existed:
            if current is not None: clearer(parameter)
            if reader(parameter) is not None: raise ValueError("automation envelope cleanup was not confirmed")
            return
        if mode == "clear-recreate":
            if not callable(creator): raise ValueError("automation envelope recreation is unavailable")
            if current is not None: clearer(parameter)
            current = creator(parameter)
        elif mode == "range-reset":
            if current is None:
                if not callable(creator): raise ValueError("automation envelope recreation is unavailable")
                current = creator(parameter)
            else:
                delete = getattr(current, "delete_events_in_range", None); clip_length = self._read_attr(clip, "length")
                if not callable(delete) or not isinstance(clip_length, (int, float)): raise ValueError("automation point reset is unavailable")
                delete(0.0, float(clip_length) + 4.0)
        else: raise ValueError("automation rollback mode is invalid")
        create = getattr(current, "create_event", None)
        if current is None or not callable(create): raise ValueError("automation point restoration is unavailable")
        event_class = self._envelope_event_class()
        for point in points: create(event_class(point["time"], point["value"]))
        restored = reader(parameter)
        if restored is None or self._bounded_canonical(self._envelope_points(restored)) != self._bounded_canonical(points): raise ValueError("automation point restoration was not confirmed")

    def _envelope_read(self, args: dict[str, Any]) -> dict[str, Any]:
        _, envelope = self._envelope(str(args["clipRef"]), str(args["parameterRef"]))
        result = {"available": True, "exists": envelope is not None, "points": self._envelope_points(envelope) if envelope is not None else []}
        result["revision"] = hashlib.sha256(self._bounded_canonical({"exists": result["exists"], "points": result["points"]}).encode("utf-8")).hexdigest()
        return result

    def _envelope_authority_digest(self, clip_ref: str, parameter_ref: str) -> str:
        authority = {"clip": self._session_clip_authority(clip_ref), "parameter": self._realtime_parameter_authority(parameter_ref)}
        return hashlib.sha256(self._bounded_canonical(authority).encode("utf-8")).hexdigest()

    def _guard_envelope_mutation(self, args: dict[str, Any]) -> None:
        clip_ref, parameter_ref = str(args.get("clipRef")), str(args.get("parameterRef"))
        self.snapshot(); authority_digest = self._envelope_authority_digest(clip_ref, parameter_ref); current = self._envelope_read({"clipRef": clip_ref, "parameterRef": parameter_ref})
        if not isinstance(args.get("expectedAuthorityDigest"), str) or not hmac.compare_digest(authority_digest, args["expectedAuthorityDigest"]):
            raise ValueError("automation clip or parameter identity changed since preview")
        if not isinstance(args.get("expectedEnvelopeRevision"), str) or not hmac.compare_digest(current["revision"], args["expectedEnvelopeRevision"]):
            raise ValueError("automation envelope changed since preview")

    def _envelope_create(self, args: dict[str, Any]) -> dict[str, Any]:
        self._guard_envelope_mutation(args); clip, envelope = self._envelope(str(args["clipRef"]), str(args["parameterRef"])); parameter = self._resolve_parameter(str(args["parameterRef"])); clearer = getattr(clip, "clear_envelope", None)
        if envelope is not None: raise ValueError("automation envelope already exists")
        if not callable(clearer): raise ValueError("envelope creation cannot guarantee exact rollback")
        try:
            creator = getattr(clip, "create_automation_envelope", None)
            if not callable(creator) or creator(parameter) is None or getattr(clip, "automation_envelope", lambda _parameter: None)(parameter) is None: raise ValueError("envelope creation was not confirmed")
        except BaseException as error:
            try: self._restore_envelope_state(clip, parameter, False, [])
            except BaseException as rollback_error: raise ValueError("envelope creation failed and exact rollback failed") from rollback_error
            raise
        return {"created": True}

    def _envelope_delete(self, args: dict[str, Any]) -> dict[str, Any]:
        self._guard_envelope_mutation(args); clip, envelope = self._envelope(str(args["clipRef"]), str(args["parameterRef"]))
        if envelope is None: raise ValueError("envelope does not exist")
        parameter = self._resolve_parameter(str(args["parameterRef"])); clearer = getattr(clip, "clear_envelope", None); creator = getattr(clip, "create_automation_envelope", None); prior_points = self._envelope_points(envelope)
        if not callable(clearer) or not callable(creator) or not callable(getattr(envelope, "create_event", None)) or not callable(getattr(envelope, "delete_events_in_range", None)): raise ValueError("envelope deletion cannot guarantee exact restoration")
        try:
            clearer(parameter)
            if getattr(clip, "automation_envelope", lambda _p: None)(parameter) is not None: raise ValueError("envelope deletion was not confirmed")
        except BaseException as error:
            try: self._restore_envelope_state(clip, parameter, True, prior_points, "range-reset")
            except BaseException as rollback_error: raise ValueError("envelope deletion failed and exact rollback failed") from rollback_error
            raise
        return {"deleted": True}

    def _envelope_point_insert(self, args: dict[str, Any]) -> dict[str, Any]:
        self._guard_envelope_mutation(args); points = args.get("points")
        if not isinstance(points, list) or not 1 <= len(points) <= 512: raise ValueError("points are invalid")
        clip, prior_envelope = self._envelope(str(args["clipRef"]), str(args["parameterRef"])); parameter = self._resolve_parameter(str(args["parameterRef"])); clip_length = self._read_attr(clip, "length"); minimum = self._read_attr(parameter, "min", "min_value"); maximum = self._read_attr(parameter, "max", "max_value")
        if not isinstance(clip_length, (int, float)) or isinstance(clip_length, bool) or not math.isfinite(float(clip_length)) or float(clip_length) <= 0 or not isinstance(minimum, (int, float)) or not isinstance(maximum, (int, float)): raise ValueError("automation bounds are unavailable")
        for point in points:
            if not isinstance(point, dict) or set(point) != {"time", "value"} or not isinstance(point["time"], (int, float)) or isinstance(point["time"], bool) or not math.isfinite(float(point["time"])) or not 0 <= float(point["time"]) <= float(clip_length) or not isinstance(point["value"], (int, float)) or isinstance(point["value"], bool) or not math.isfinite(float(point["value"])) or not float(minimum) <= float(point["value"]) <= float(maximum): raise ValueError("points are outside the exact clip or parameter bounds")
        try: event_class = getattr(__import__("Live.Envelope", fromlist=["EnvelopeEvent"]), "EnvelopeEvent", None)
        except Exception: event_class = None
        if event_class is None:
            class _Event:
                def __init__(self, time: float, value: float): self.time = time; self.value = value
            event_class = _Event
        events = [event_class(float(point["time"]), float(point["value"])) for point in points]; before_points = self._envelope_points(prior_envelope) if prior_envelope is not None else []; prior_exists = prior_envelope is not None; clearer = getattr(clip, "clear_envelope", None); creator = getattr(clip, "create_automation_envelope", None)
        if not callable(clearer) or not callable(creator) or prior_envelope is not None and not callable(getattr(prior_envelope, "create_event", None)): raise ValueError("automation insertion cannot guarantee exact rollback on this Live shape")
        envelope = prior_envelope
        try:
            if envelope is None:
                _, envelope = self._envelope(str(args["clipRef"]), str(args["parameterRef"]), create=True)
            if envelope is None or not callable(getattr(envelope, "create_event", None)): raise ValueError("envelope creation was not confirmed")
            for event in events: envelope.create_event(event)
            after_points = self._envelope_points(envelope); expected_points = before_points + [{"time": float(point["time"]), "value": float(point["value"])} for point in points]; normalize = lambda rows: sorted(rows, key=lambda row: (row["time"], row["value"]))
            if self._bounded_canonical(normalize(after_points)) != self._bounded_canonical(normalize(expected_points)): raise ValueError("envelope point insert did not produce the exact requested state")
        except BaseException as error:
            try: self._restore_envelope_state(clip, parameter, prior_exists, before_points, "clear-recreate")
            except BaseException as rollback_error: raise ValueError("automation point insertion failed and exact rollback failed") from rollback_error
            raise
        return {"inserted": len(points)}

    def _envelope_point_delete(self, args: dict[str, Any]) -> dict[str, Any]:
        self._guard_envelope_mutation(args); from_time, to_time = args.get("from"), args.get("to")
        if not isinstance(from_time, (int, float)) or isinstance(from_time, bool) or not math.isfinite(float(from_time)) or float(from_time) < 0: raise ValueError("from is invalid")
        if not isinstance(to_time, (int, float)) or isinstance(to_time, bool) or not math.isfinite(float(to_time)) or float(to_time) <= float(from_time): raise ValueError("to is invalid")
        clip, envelope = self._envelope(str(args["clipRef"]), str(args["parameterRef"])); parameter = self._resolve_parameter(str(args["parameterRef"]))
        if envelope is None or not callable(getattr(envelope, "delete_events_in_range", None)) or not callable(getattr(envelope, "create_event", None)) or not callable(getattr(clip, "clear_envelope", None)) or not callable(getattr(clip, "create_automation_envelope", None)): raise ValueError("envelope point deletion cannot guarantee exact rollback")
        before_points = self._envelope_points(envelope); expected = [point for point in before_points if not float(from_time) <= point["time"] < float(to_time)]
        if len(expected) == len(before_points): raise ValueError("automation delete range contains no authoritative points")
        try:
            envelope.delete_events_in_range(float(from_time), float(to_time)); after_points = self._envelope_points(envelope)
            if self._bounded_canonical(after_points) != self._bounded_canonical(expected): raise ValueError("automation point deletion changed unexpected points")
        except BaseException as error:
            try: self._restore_envelope_state(clip, parameter, True, before_points)
            except BaseException as rollback_error: raise ValueError("automation point deletion failed and exact rollback failed") from rollback_error
            raise
        return {"deleted": len(before_points) - len(expected)}

    def _device_location(self, reference: str, expected_identity: str | None = None, expected_owner_ref: str | None = None, expected_owner_identity: str | None = None, expected_siblings: Any = None, expected_track_ref: str | None = None, expected_track_identity: str | None = None) -> tuple[Any, Any, int, int, str]:
        """Resolve a discovered device to its exact track/chain owner without
        trusting a parseable traversal key or Live proxy object identity."""
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:device:"):
            raise ValueError("device reference is stale or invalid")
        target = self.refs.get(reference)
        target_identity = self._capture_object_identity(target)
        if not isinstance(expected_identity, str) or not hmac.compare_digest(target_identity, expected_identity) or not isinstance(expected_owner_ref, str) or not isinstance(expected_owner_identity, str):
            raise ValueError("device object or owner identity is stale or missing")
        if not isinstance(expected_siblings, list) or len(expected_siblings) > MAX_DISCOVERY_COLLECTION_LENGTH or any(not isinstance(item, dict) or set(item) != {"ref", "objectIdentity"} or not isinstance(item["ref"], str) or not isinstance(item["objectIdentity"], str) for item in expected_siblings):
            raise ValueError("device sibling identity fence is invalid")
        expected_siblings_canonical = AuthenticatedRemoteScript._bounded_canonical(expected_siblings)
        tracks = self._all_track_objects()
        target_occurrences = 0; traversed = 0; counted_owners: set[str] = set()
        def count(owner: Any) -> None:
            nonlocal target_occurrences, traversed
            owner_identity = self._capture_object_identity(owner)
            if owner_identity in counted_owners: raise ValueError("device hierarchy is cyclic or identity-ambiguous")
            counted_owners.add(owner_identity); devices = self._items(self._read_attr(owner, "devices") or [])
            if len(devices) > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("device sibling collection exceeds the authoritative bound")
            for device in devices:
                traversed += 1
                if traversed > 1024: raise ValueError("device hierarchy traversal exceeds its bound")
                if self._capture_object_identity(device) == target_identity: target_occurrences += 1
                for chain in self._items(self._read_attr(device, "chains") or []): count(chain)
                for pad in self._items(self._read_attr(device, "visible_drum_pads") or self._read_attr(device, "drum_pads") or []):
                    for chain in self._items(self._read_attr(pad, "chains") or []): count(chain)
        for current_track in tracks: count(current_track)
        if target_occurrences != 1: raise ValueError("device target identity is stale or ambiguous")
        def locate(owner: Any, owner_ref: str, path: str, track_index: int, seen: set[str]) -> tuple[Any, Any, int, int, str] | None:
            owner_identity = self._capture_object_identity(owner)
            if owner_identity in seen: return None
            seen.add(owner_identity); devices = self._items(self._read_attr(owner, "devices") or [])
            if len(devices) > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("device sibling collection exceeds the authoritative bound")
            current_siblings = [{"ref": self.refs.put("device", candidate, f"{path}:{candidate_index}"), "objectIdentity": self._capture_object_identity(candidate)} for candidate_index, candidate in enumerate(devices)]
            for device_index, device in enumerate(devices):
                device_path = f"{path}:{device_index}"
                if self._capture_same_object(device, target, target_identity):
                    if current_siblings[device_index]["ref"] != reference: continue
                    owner_identity = self._capture_object_identity(owner)
                    if not hmac.compare_digest(owner_ref, expected_owner_ref) or not hmac.compare_digest(owner_identity, expected_owner_identity) or not hmac.compare_digest(AuthenticatedRemoteScript._bounded_canonical(current_siblings), expected_siblings_canonical): raise ValueError("device owner or siblings changed since preview")
                    return owner, device, track_index, device_index, owner_ref
                for chain_index, chain in enumerate(self._items(self._read_attr(device, "chains") or [])):
                    chain_path = f"{device_path}:{chain_index}"; chain_ref = self.refs.put("chain", chain, chain_path)
                    found = locate(chain, chain_ref, chain_path, track_index, seen)
                    if found is not None: return found
                for pad_index, pad in enumerate(self._items(self._read_attr(device, "visible_drum_pads") or self._read_attr(device, "drum_pads") or [])):
                    pad_path = f"{device_path}:{pad_index}"; pad_ref = self.refs.put("drum_pad", pad, pad_path)
                    for chain_index, chain in enumerate(self._items(self._read_attr(pad, "chains") or [])):
                        chain_path = f"{pad_path}:{chain_index}"; chain_ref = self.refs.put("chain", chain, chain_path)
                        found = locate(chain, chain_ref, chain_path, track_index, seen)
                        if found is not None: return found
            return None
        for track_index, track in enumerate(tracks):
            track_ref = self.refs.put("track", track, str(track_index))
            found = locate(track, track_ref, str(track_index), track_index, set())
            if found is not None:
                if not isinstance(expected_track_ref, str) or not isinstance(expected_track_identity, str) or not hmac.compare_digest(track_ref, expected_track_ref) or not hmac.compare_digest(self._capture_object_identity(track), expected_track_identity): raise ValueError("device containing track identity changed since preview")
                return found
        raise ValueError("device owner is stale or unavailable")

    def _top_level_device_authority(self, track: Any, track_ref: str) -> dict[str, Any]:
        tracks = self._all_track_objects()
        track_identity = self._capture_object_identity(track); matches = [(index, candidate) for index, candidate in enumerate(tracks) if self._capture_same_object(candidate, track, track_identity)]
        if len(matches) != 1: raise ValueError("device target track is stale")
        track_index, track = matches[0]; devices = self._items(getattr(track, "devices", []))
        if len(devices) > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("device sibling collection exceeds its bound")
        return {"expectedTrackIdentity": self._capture_object_identity(track), "expectedSiblings": [{"ref": self.refs.put("device", device, f"{track_index}:{index}"), "objectIdentity": self._capture_object_identity(device)} for index, device in enumerate(devices)]}

    def _device_insert(self, args: dict[str, Any]) -> dict[str, Any]:
        track_ref = args.get("trackRef")
        if not isinstance(track_ref, str) or not track_ref.startswith(f"{self.refs.epoch}:track:"):
            raise ValueError("track reference is stale or invalid")
        self.snapshot(); track = self.refs.get(track_ref)
        authority = self._top_level_device_authority(track, track_ref); expected_authority = {"expectedTrackIdentity": args.get("expectedTrackIdentity"), "expectedSiblings": args.get("expectedSiblings")}
        if not hmac.compare_digest(self._bounded_canonical(authority), self._bounded_canonical(expected_authority)):
            raise ValueError("device insertion target changed since preview")
        name = args.get("deviceName")
        if not isinstance(name, str) or not 1 <= len(name) <= 256:
            raise ValueError("device name is invalid")
        index = args.get("index")
        if index is not None and (not isinstance(index, int) or isinstance(index, bool) or not -1 <= index <= 256):
            raise ValueError("device index is invalid")
        inserter = getattr(track, "insert_device", None)
        if not callable(inserter):
            raise ValueError("device insertion is unavailable")
        all_tracks = self._all_track_objects(); track_index = self._capture_index(all_tracks, track, str(args.get("expectedTrackIdentity")))
        if track_index is None or track_ref != f"{self.refs.epoch}:track:{track_index}": raise ValueError("device insertion track hierarchy is stale")
        before_devices = self._items(getattr(track, "devices", []))
        if before_devices: raise ValueError("device insertion requires an empty exact owner so cleanup cannot affect siblings")
        before_identity_order = [self._capture_object_identity(device) for device in before_devices]; before_identities = set(before_identity_order); checkpoint = self.refs.checkpoint(); expected_position = len(before_devices) if index is None or index == -1 else index
        if expected_position > len(before_devices): raise ValueError("device insertion index exceeds the exact sibling boundary")
        try:
            inserter(name, -1 if index is None else index); devices = self._items(getattr(track, "devices", [])); created = [(position, device) for position, device in enumerate(devices) if self._capture_object_identity(device) not in before_identities]
            if len(devices) != len(before_devices) + 1 or len(created) != 1: raise ValueError("device insertion did not produce one identity-distinct device")
            position, device = created[0]; final_identity_order = [self._capture_object_identity(candidate) for candidate in devices]; expected_identity_order = list(before_identity_order); device_identity = self._capture_object_identity(device); expected_identity_order.insert(expected_position, device_identity)
            if position != expected_position or final_identity_order != expected_identity_order or str(self._read_attr(device, "name") or "") != name: raise ValueError("device insertion did not confirm the exact requested name, index, and siblings")
            created_ref = self.refs.put("device", device, f"{track_index}:{position}"); fingerprint = self._mapped_fingerprint(created_ref)
            return {"ref": created_ref, "objectIdentity": device_identity, "name": name, "index": position, "createdFingerprint": fingerprint}
        except BaseException as error:
            rollback_failed = False; deleter = getattr(track, "delete_device", None); current = self._items(getattr(track, "devices", [])); owned = [(position, device) for position, device in enumerate(current) if self._capture_object_identity(device) not in before_identities]
            if owned and not callable(deleter): rollback_failed = True
            if callable(deleter):
                for position, _ in reversed(owned):
                    try: deleter(position)
                    except BaseException: pass
            if [self._capture_object_identity(device) for device in self._items(getattr(track, "devices", []))] != before_identity_order: rollback_failed = True
            if rollback_failed: raise ValueError("device insertion failed and exact transaction-owned cleanup failed") from error
            self.refs.restore(checkpoint); raise

    def _device_delete(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        owner, device, _, _, _ = self._device_location(str(reference), args.get("expectedObjectIdentity"), args.get("expectedOwnerRef"), args.get("expectedOwnerIdentity"), args.get("expectedSiblings"), args.get("expectedTrackRef"), args.get("expectedTrackIdentity"))
        deleter = getattr(owner, "delete_device", None)
        if not callable(deleter):
            raise ValueError("device deletion is unavailable")
        devices_before = self._items(getattr(owner, "devices", []))
        if len(devices_before) != 1: raise ValueError("transaction-owned device cleanup requires the target to be the sole sibling")
        index = self._capture_index(devices_before, device, str(args.get("expectedObjectIdentity")))
        if index is None: raise ValueError("device deletion target identity is stale or ambiguous")
        before_identity_order = [self._capture_object_identity(candidate) for candidate in devices_before]; expected_order = list(before_identity_order); expected_order.pop(index); deletion_error: BaseException | None = None
        try: deleter(index)
        except BaseException as error: deletion_error = error
        if [self._capture_object_identity(candidate) for candidate in self._items(getattr(owner, "devices", []))] != expected_order: raise ValueError("device deletion did not preserve the exact authorized siblings") from deletion_error
        self.refs.delete(str(reference)); return {"deleted": reference}

    def _device_on_parameter(self, device: Any) -> Any | None:
        """Name-independent structural probe for the conventional first
        'Device On' parameter. Device.is_active is get/observe in the public
        LOM and is never written; this is the only writable bypass surface,
        and it never matches on localized parameter names."""
        parameters = self._items(getattr(device, "parameters", []))
        if not parameters: return None
        candidate = parameters[0]
        if self._read_attr(candidate, "is_enabled", "enabled") is not True: return None
        minimum = self._read_attr(candidate, "min", "min_value"); maximum = self._read_attr(candidate, "max", "max_value"); value = self._read_attr(candidate, "value")
        if not all(isinstance(item, (int, float)) and not isinstance(item, bool) and math.isfinite(float(item)) for item in (minimum, maximum, value)): return None
        if float(maximum) - float(minimum) != 1.0 or float(value) not in (float(minimum), float(maximum)): return None
        quantization = self._read_attr(candidate, "quantization")
        if not isinstance(quantization, (int, float)) or isinstance(quantization, bool) or float(quantization) != 1.0: return None
        return candidate

    def _device_enable(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        enabled = args.get("enabled")
        if not isinstance(enabled, bool):
            raise ValueError("enabled must be boolean")
        _, device, _, _, _ = self._device_location(str(reference), args.get("expectedObjectIdentity"), args.get("expectedOwnerRef"), args.get("expectedOwnerIdentity"), args.get("expectedSiblings"), args.get("expectedTrackRef"), args.get("expectedTrackIdentity"))
        current_enabled = self._read_attr(device, "is_active", "is_enabled", "enabled"); expected_state = args.get("expectedStateRevision"); state_revision = hashlib.sha256(self._bounded_canonical({"enabled": current_enabled if isinstance(current_enabled, bool) else None}).encode("utf-8")).hexdigest()
        if not isinstance(expected_state, str) or not hmac.compare_digest(state_revision, expected_state): raise ValueError("device enable state changed since preview")
        if current_enabled is enabled:
            revision = self.refs.touch(reference); return {"changed": True, "enabled": enabled, "revision": revision}
        parameter = self._device_on_parameter(device)
        if parameter is None:
            raise ValueError("device enable is unavailable")
        minimum = float(self._read_attr(parameter, "min", "min_value")); maximum = float(self._read_attr(parameter, "max", "max_value"))
        target = maximum if enabled else minimum
        prior_value = self._read_attr(parameter, "value")
        setter_error: BaseException | None = None
        try: parameter.value = target
        except BaseException as error: setter_error = error
        observed = self._read_attr(parameter, "value")
        authoritative_enabled = self._read_attr(device, "is_active", "is_enabled", "enabled")
        if setter_error is None and isinstance(observed, (int, float)) and float(observed) == target and (not isinstance(authoritative_enabled, bool) or authoritative_enabled is enabled):
            revision = self.refs.touch(reference); return {"changed": True, "enabled": enabled, "revision": revision}
        if isinstance(prior_value, (int, float)) and observed != prior_value:
            try: parameter.value = prior_value
            except BaseException: pass
            restored = self._read_attr(parameter, "value")
            if not isinstance(restored, (int, float)) or float(restored) != float(prior_value): raise ValueError("device enable failed and exact rollback failed") from setter_error
        if self._read_attr(device, "is_active", "is_enabled", "enabled") is not current_enabled: raise ValueError("device enable failed and exact authoritative rollback failed")
        raise ValueError("device enable is unavailable") from setter_error

    def _device_move(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref"); index = args.get("index")
        if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index <= 256: raise ValueError("device index is invalid")
        owner, device, _, current, owner_ref = self._device_location(str(reference), args.get("expectedObjectIdentity"), args.get("expectedOwnerRef"), args.get("expectedOwnerIdentity"), args.get("expectedSiblings"), args.get("expectedTrackRef"), args.get("expectedTrackIdentity"))
        devices_before = self._items(getattr(owner, "devices", [])); expected_identity = str(args.get("expectedObjectIdentity"))
        if index >= len(devices_before): raise ValueError("device index is outside the exact sibling collection")
        if index == current: return {"ref": reference, "objectIdentity": self._capture_object_identity(device), "index": index}
        mover = getattr(self.song, "move_device", None)
        if not callable(mover): raise ValueError("device move is unavailable")
        before_identities = [self._capture_object_identity(candidate) for candidate in devices_before]
        try:
            mover(device, owner, index)
            devices = self._items(getattr(owner, "devices", []))
            if len(devices) != len(devices_before) or index >= len(devices) or not self._capture_same_object(devices[index], device, expected_identity): raise ValueError("device move was not confirmed")
            after_identities = [self._capture_object_identity(candidate) for candidate in devices]
            expected_order = list(before_identities); moved_identity = expected_order.pop(current); expected_order.insert(index, moved_identity)
            if after_identities != expected_order: raise ValueError("device move changed an unexpected sibling")
        except BaseException as error:
            rollback_failed = False; current_devices = self._items(getattr(owner, "devices", [])); moved_index = self._capture_index(current_devices, device, expected_identity)
            if moved_index is None: rollback_failed = True
            elif moved_index != current:
                try: mover(device, owner, current)
                except BaseException: rollback_failed = True
            if [self._capture_object_identity(candidate) for candidate in self._items(getattr(owner, "devices", []))] != before_identities: rollback_failed = True
            if rollback_failed: raise ValueError("device move failed and exact rollback failed") from error
            raise
        owner_path = ":".join(owner_ref.split(":")[2:]); new_ref = self.refs.put("device", device, f"{owner_path}:{index}")
        return {"ref": new_ref, "objectIdentity": expected_identity, "index": index}

    def _browser(self) -> Any:
        try:
            import Live  # type: ignore[import-not-found]
            application = Live.Application.get_application()
        except Exception as error:
            raise ValueError("the Live Browser is unavailable") from error
        browser = getattr(application, "browser", None)
        if browser is None:
            raise ValueError("the Live Browser is unavailable")
        return browser

    def _application(self) -> Any:
        try:
            import Live  # type: ignore[import-not-found]
            application = Live.Application.get_application()
        except Exception as error:
            raise ValueError("the Live application is unavailable") from error
        if application is None:
            raise ValueError("the Live application is unavailable")
        return application

    _BROWSER_CATEGORIES = {"instruments", "audio_effects", "midi_effects", "drums", "plugins", "packs", "max_for_live", "clips"}
    _DEVICE_BROWSER_CATEGORIES = {"instruments", "audio_effects", "midi_effects", "plugins"}

    def _browser_item_identity(self, path: str) -> str:
        return f"browser-path:{hashlib.sha256(path.encode('utf-8')).hexdigest()}"

    def _browser_search(self, args: dict[str, Any]) -> dict[str, Any]:
        browser = self._browser()
        category = args.get("category")
        if category is not None and category not in self._BROWSER_CATEGORIES:
            raise ValueError("browser category is invalid")
        query = args.get("query")
        if query is not None and (not isinstance(query, str) or len(query) > 256):
            raise ValueError("browser query is invalid")
        limit = args.get("limit", 50)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
            raise ValueError("browser limit is invalid")
        needle = query.strip().lower() if isinstance(query, str) else ""
        items: list[dict[str, Any]] = []; seen_ids: set[str] = set(); traversal_count = 0

        def walk(node: Any, path: str, depth: int) -> None:
            nonlocal traversal_count
            if len(items) >= limit or depth > 6:
                return
            children = self._items(self._read_attr(node, "children") or [])
            if len(children) > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("browser child collection exceeds its traversal bound")
            for child in children:
                traversal_count += 1
                if traversal_count > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("browser search exceeds its traversal bound")
                if len(items) >= limit: return
                name = str(self._read_attr(child, "name") or "")
                child_path = f"{path}/{name}"
                if len(name) > 256 or len(child_path) > 256: continue
                explicit_device = self._read_attr(child, "is_device"); is_loadable = self._read_attr(child, "is_loadable") is True
                is_device = explicit_device is True or (explicit_device is None and category_name in self._DEVICE_BROWSER_CATEGORIES and is_loadable)
                if not self._items(self._read_attr(child, "children") or []) or is_device:
                    if not needle or needle in name.lower() or needle in child_path.lower():
                        if child_path in seen_ids: raise ValueError("browser item identity collision")
                        object_identity = self._browser_item_identity(child_path)
                        seen_ids.add(child_path); items.append({"id": child_path, "objectIdentity": object_identity, "name": name, "category": category_name, "path": child_path, "isDevice": is_device})
                if not is_device:
                    walk(child, child_path, depth + 1)

        categories = [category] if category else sorted(self._BROWSER_CATEGORIES)
        for category_name in categories:
            if len(items) >= limit:
                break
            node = self._read_attr(browser, category_name)
            if node is not None:
                walk(node, category_name, 0)
        return {"items": items}

    def _browser_find(self, item_id: Any) -> tuple[Any, dict[str, Any]]:
        if not isinstance(item_id, str) or not 1 <= len(item_id) <= 256:
            raise ValueError("browser item id is invalid")
        browser = self._browser(); item_category = item_id.split("/", 1)[0] if "/" in item_id else ""
        if item_category not in self._BROWSER_CATEGORIES: raise ValueError("browser item id is invalid")
        matches: list[Any] = []; traversal_count = 0
        def find(node: Any, path: str, depth: int) -> None:
            nonlocal traversal_count
            if depth > 6: return
            children = self._items(self._read_attr(node, "children") or [])
            if len(children) > MAX_DISCOVERY_COLLECTION_LENGTH: raise ValueError("browser child collection exceeds its traversal bound")
            for child in children:
                traversal_count += 1
                if traversal_count > MAX_DISCOVERY_COLLECTION_LENGTH * 7: raise ValueError("browser lookup exceeds its path traversal bound")
                name = str(self._read_attr(child, "name") or ""); child_path = f"{path}/{name}"
                if len(name) > 256 or len(child_path) > 256: continue
                if child_path == item_id:
                    matches.append(child)
                    if len(matches) > 1: raise ValueError("browser item identity is ambiguous")
                elif item_id.startswith(f"{child_path}/"):
                    find(child, child_path, depth + 1)
        find(self._read_attr(browser, item_category), item_category, 0)
        if len(matches) != 1: raise ValueError("browser item identity is missing or ambiguous")
        item = matches[0]; name = str(self._read_attr(item, "name") or ""); explicit_device = self._read_attr(item, "is_device"); is_device = explicit_device is True or (explicit_device is None and item_category in self._DEVICE_BROWSER_CATEGORIES and self._read_attr(item, "is_loadable") is True)
        return item, {"id": item_id, "objectIdentity": self._browser_item_identity(item_id), "name": name, "category": item_category, "path": item_id, "isDevice": is_device}

    def _browser_inspect(self, args: dict[str, Any]) -> dict[str, Any]:
        return self._browser_find(args.get("itemId"))[1]

    def _browser_load(self, args: dict[str, Any]) -> dict[str, Any]:
        item, metadata = self._browser_find(args.get("itemId")); track_ref = args.get("trackRef")
        if metadata["isDevice"] is not True or args.get("expectedName") != metadata["name"] or not isinstance(args.get("expectedItemIdentity"), str) or not hmac.compare_digest(metadata["objectIdentity"], args["expectedItemIdentity"]):
            raise ValueError("browser item identity is not an exact loadable device")
        browser = self._browser()
        loader = getattr(browser, "load_item", None)
        if not callable(loader):
            raise ValueError("browser loading is unavailable")
        if not isinstance(track_ref, str) or not track_ref.startswith(f"{self.refs.epoch}:track:"):
            raise ValueError("an exact regular-track reference is required")
        self.snapshot(); track = self.refs.get(track_ref); regular_tracks = self._items(getattr(self.song, "tracks", [])); track_identity = self._capture_object_identity(track); track_matches = [(index, candidate) for index, candidate in enumerate(regular_tracks) if self._capture_same_object(candidate, track, track_identity)]
        if len(track_matches) != 1:
            raise ValueError("browser loading is limited to one exact regular Set track")
        track_index, track = track_matches[0]
        if track_ref != f"{self.refs.epoch}:track:{track_index}": raise ValueError("browser target track reference is stale")
        authority = self._top_level_device_authority(track, track_ref)
        expected_authority = {"expectedTrackIdentity": args.get("expectedTrackIdentity"), "expectedSiblings": args.get("expectedSiblings")}
        if not hmac.compare_digest(self._bounded_canonical(authority), self._bounded_canonical(expected_authority)):
            raise ValueError("browser target track or devices changed since preview")
        view = getattr(self.song, "view", None)
        if view is None or not hasattr(view, "selected_track"):
            raise ValueError("track-targeted browser loading is unavailable")
        previous_selection = getattr(view, "selected_track", None); previous_identity = self._capture_object_identity(previous_selection) if previous_selection is not None else None; before_devices = self._items(getattr(track, "devices", []))
        if before_devices: raise ValueError("Browser loading requires an empty exact device owner so cleanup cannot affect siblings")
        before_identities = [self._capture_object_identity(prior) for prior in before_devices]
        if len(set(before_identities)) != len(before_identities): raise ValueError("browser target device identities are ambiguous")
        registry_checkpoint = self.refs.checkpoint()
        failure: BaseException | None = None
        try:
            view.selected_track = track
            if not self._capture_same_object(getattr(view, "selected_track", None), track, track_identity): raise ValueError("target-track selection was not confirmed")
            loader(item)
        except BaseException as error: failure = error
        try:
            view.selected_track = previous_selection; restored_selection = getattr(view, "selected_track", None)
            if (previous_selection is None and restored_selection is not None) or (previous_selection is not None and not self._capture_same_object(restored_selection, previous_selection, str(previous_identity))): raise ValueError("selection restoration was not confirmed")
        except BaseException as error:
            if failure is None: failure = ValueError("browser load selection restoration failed")
        devices = self._items(getattr(track, "devices", [])); created = [(index, candidate) for index, candidate in enumerate(devices) if self._capture_object_identity(candidate) not in set(before_identities)]
        shape_valid = len(devices) == len(before_devices) + 1 and len(created) == 1 and [self._capture_object_identity(candidate) for candidate in devices if self._capture_object_identity(candidate) in set(before_identities)] == before_identities
        if failure is not None or not shape_valid:
            rollback_failed = False; deleter = getattr(track, "delete_device", None)
            if created and not callable(deleter): rollback_failed = True
            if callable(deleter):
                for _, candidate in reversed(created):
                    candidate_identity = self._capture_object_identity(candidate); current_devices = self._items(getattr(track, "devices", [])); candidate_index = self._capture_index(current_devices, candidate, candidate_identity)
                    if candidate_index is None: rollback_failed = True; continue
                    try: deleter(candidate_index)
                    except BaseException: pass
            if [self._capture_object_identity(candidate) for candidate in self._items(getattr(track, "devices", []))] != before_identities: rollback_failed = True
            try:
                view.selected_track = previous_selection; restored_selection = getattr(view, "selected_track", None)
                if (previous_selection is None and restored_selection is not None) or (previous_selection is not None and not self._capture_same_object(restored_selection, previous_selection, str(previous_identity))): rollback_failed = True
            except BaseException: rollback_failed = True
            cause = failure or ValueError("browser load did not produce one identity-distinct device on the target track")
            if rollback_failed:
                try: self.snapshot()
                except BaseException: pass
                raise ValueError("browser load failed and exact transaction-owned cleanup failed") from cause
            self.refs.restore(registry_checkpoint)
            raise ValueError("browser load failed without a residual device") from cause
        device_index, device = created[0]; created_ref: str | None = None
        try:
            created_ref = self.refs.put("device", device, f"{track_index}:{device_index}"); device_identity = self._capture_object_identity(device); fingerprint = self._mapped_fingerprint(created_ref)
        except BaseException as error:
            rollback_failed = False; deleter = getattr(track, "delete_device", None); current_devices = self._items(getattr(track, "devices", [])); current_index = self._capture_index(current_devices, device, self._capture_object_identity(device))
            if not callable(deleter) or current_index is None: rollback_failed = True
            else:
                try: deleter(current_index)
                except BaseException: pass
            if [self._capture_object_identity(candidate) for candidate in self._items(getattr(track, "devices", []))] != before_identities: rollback_failed = True
            if rollback_failed:
                try: self.snapshot()
                except BaseException: pass
                raise ValueError("browser load result mapping failed and exact transaction-owned cleanup failed") from error
            self.refs.restore(registry_checkpoint)
            raise ValueError("browser load result mapping failed without a residual device") from error
        return {"loaded": True, "deviceRef": created_ref, "deviceObjectIdentity": device_identity, "createdFingerprint": fingerprint}

    @staticmethod
    def _capture_object_identity(value: Any) -> str:
        """Bind capture authority to the clip object, not its traversal slot."""
        if value is None:
            raise ValueError("capture object identity is unavailable")
        for candidate in (value, getattr(value, "_live_ptr", None), getattr(value, "live_ptr", None)):
            if candidate is None:
                continue
            if isinstance(candidate, (str, int)) and not isinstance(candidate, bool):
                return f"live:{candidate}"
            for name in ("_object_id", "object_id"):
                identity = getattr(candidate, name, None)
                if isinstance(identity, (str, int)) and not isinstance(identity, bool):
                    return f"live:{identity}"
        # The mapper holds the expected proxy strongly for this bridge epoch;
        # if Live regenerates proxies without a stable pointer, matching fails
        # closed rather than deleting a traversal-slot replacement.
        return f"proxy:{id(value)}"

    @classmethod
    def _capture_same_object(cls, current: Any, expected: Any, identity: str) -> bool:
        return current is not None and expected is not None and cls._capture_object_identity(current) == identity

    @classmethod
    def _capture_index(cls, items: list[Any], expected: Any, identity: str | None = None) -> int | None:
        if expected is None: return None
        expected_identity = identity or cls._capture_object_identity(expected)
        matches = [index for index, candidate in enumerate(items) if cls._capture_same_object(candidate, expected, expected_identity)]
        return matches[0] if len(matches) == 1 else None

    @staticmethod
    def _capture_route_label(value: Any) -> str | None:
        if value is None:
            return None
        if isinstance(value, dict):
            label = value.get("display_name") or value.get("name")
            return str(label) if isinstance(label, str) and label else None
        for name in ("display_name", "name"):
            label = getattr(value, name, None)
            if isinstance(label, str) and label:
                return label
        if isinstance(value, (str, int, float)) and not isinstance(value, bool):
            text = str(value)
            return text if text else None
        # Opaque routing proxy reprs contain process addresses and are neither
        # selectable labels nor stable revision evidence.
        return None

    def _capture_current_route(self, track: Any) -> Any:
        value = self._read_attr(track, "input_routing_type")
        return value if value is not None else self._read_attr(track, "current_input_routing")

    def _capture_resampling_choice(self, track: Any) -> Any:
        matches = []
        for candidate in self._items(self._read_attr(track, "available_input_routing_types") or []):
            labels = [self._capture_route_label(candidate), str(getattr(candidate, "name", "")), str(getattr(candidate, "display_name", ""))]
            if any(isinstance(label, str) and label.casefold() == "resampling" for label in labels): matches.append(candidate)
        if len(matches) != 1: raise ValueError("the destination track does not expose one exact unambiguous Resampling input")
        return matches[0]

    def _capture_shape_supported(self) -> bool:
        if not callable(getattr(self.song, "stop_playing", None)):
            return False
        tracks = self._items(getattr(self.song, "tracks", []))
        has_source = any(getattr(slot, "clip", None) is not None and callable(getattr(slot, "fire", None)) for track in tracks for slot in self._items(getattr(track, "clip_slots", [])))
        if not has_source:
            return False
        for track in tracks:
            # Status advertises the provider from stable, non-mutating shape:
            # one exact Resampling choice and one fireable empty slot. Target-
            # specific arm/monitor/audio-input requirements are rechecked by
            # inspect and again atomically by start, where useful refusal detail
            # can be returned instead of silently hiding the whole provider.
            if not any(getattr(slot, "clip", None) is None and callable(getattr(slot, "fire", None)) for slot in self._items(getattr(track, "clip_slots", []))):
                continue
            try:
                self._capture_resampling_choice(track)
                return True
            except ValueError:
                continue
        return False

    def _capture_plan(self, args: dict[str, Any]) -> dict[str, Any]:
        set_name = args.get("setName")
        source_ref = args.get("sourceSlotRef")
        destination_ref = args.get("destinationSlotRef")
        if not isinstance(set_name, str) or not 1 <= len(set_name) <= 256 or not isinstance(source_ref, str) or not isinstance(destination_ref, str):
            raise ValueError("capture Set and slot identities are invalid")
        if str(self._read_attr(self.song, "name") or "") != set_name:
            raise ValueError("capture is limited to the exact named disposable Set")
        source_track, source_slot, source_track_index, source_slot_index = self._clip_location(source_ref)
        destination_track, destination_slot, destination_track_index, destination_slot_index = self._clip_location(destination_ref)
        if source_ref == destination_ref or source_track_index == destination_track_index:
            raise ValueError("capture source and destination must be distinct tracks and slots")
        if getattr(source_slot, "clip", None) is None or not callable(getattr(source_slot, "fire", None)):
            raise ValueError("capture source must be an authoritative playable Session clip")
        if getattr(destination_slot, "clip", None) is not None or not callable(getattr(destination_slot, "fire", None)) or not callable(getattr(destination_slot, "delete_clip", None)):
            raise ValueError("capture destination must be an exact empty deletable Session slot")
        if self._read_attr(destination_track, "has_audio_input") is not True or self._read_attr(destination_track, "has_midi_input") is True:
            raise ValueError("capture destination must be an audio-input track")
        if not isinstance(self._read_attr(destination_track, "arm"), bool) or not isinstance(self._read_attr(destination_track, "current_monitoring_state"), int):
            raise ValueError("capture destination does not expose guarded arm and monitoring state")
        resampling = self._capture_resampling_choice(destination_track)
        playback = self._playback()
        transport = playback["transport"]
        if transport.get("playing") is not False or transport.get("arrangementRecord") is not False or transport.get("sessionRecord") is not False or playback.get("firedTargets") or playback.get("playingTargets"):
            raise ValueError("capture requires stopped, non-recording, empty playback state")
        baseline_tracks = []
        for index, track in enumerate(self._items(getattr(self.song, "tracks", []))):
            armed = self._read_attr(track, "arm")
            monitoring = self._monitoring_state(self._read_attr(track, "current_monitoring_state"))
            if armed is not False:
                raise ValueError("capture requires every track to be authoritatively unarmed")
            if monitoring not in {"off", "auto"}:
                raise ValueError("capture refuses input-monitored or unknown-monitoring tracks")
            baseline_tracks.append({"index": index, "armed": armed, "monitoring": monitoring})
        destination_track_ref = self.refs.put("track", destination_track, str(destination_track_index))
        prior_route = self._capture_current_route(destination_track)
        prior_route_label = self._capture_route_label(prior_route)
        if not isinstance(prior_route_label, str):
            raise ValueError("capture destination input route is not authoritatively named")
        try:
            self._routing_choice(destination_track, "available_input_routing_types", prior_route_label)
        except ValueError as error:
            raise ValueError("capture destination input route cannot be restored; select an available safe input before preview") from error
        source_clip = getattr(source_slot, "clip")
        source_clip_identity = self._capture_object_identity(source_clip)
        source_track_identity = self._capture_object_identity(source_track)
        source_slot_identity = self._capture_object_identity(source_slot)
        destination_track_identity = self._capture_object_identity(destination_track)
        destination_slot_identity = self._capture_object_identity(destination_slot)
        identity_digest = lambda value: hashlib.sha256(value.encode("utf-8")).hexdigest()
        baseline = {
            "setName": set_name,
            "playbackRevision": playback["revision"],
            "sourceSlotRef": source_ref,
            "sourceTrackIdentity": identity_digest(source_track_identity),
            "sourceSlotIdentity": identity_digest(source_slot_identity),
            "sourceClipRef": self.refs.put("clip", source_clip, f"{source_track_index}:{source_slot_index}"),
            "sourceClipIdentity": identity_digest(source_clip_identity),
            "destinationSlotRef": destination_ref,
            "destinationTrackRef": destination_track_ref,
            "destinationTrackIdentity": identity_digest(destination_track_identity),
            "destinationSlotIdentity": identity_digest(destination_slot_identity),
            "destinationRoute": prior_route_label,
            "destinationName": str(self._read_attr(destination_track, "name") or ""),
            "destinationArm": self._read_attr(destination_track, "arm"),
            "destinationMonitoring": self._monitoring_state(self._read_attr(destination_track, "current_monitoring_state")),
            "position": float(self._read_attr(self.song, "current_song_time") or 0.0),
            "tracks": baseline_tracks,
        }
        fence = hashlib.sha256(json.dumps(baseline, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        return {
            "supported": True,
            "fence": fence,
            "sourceSlotRef": source_ref,
            "destinationSlotRef": destination_ref,
            "destinationTrackRef": destination_track_ref,
            "captureMode": "session-slot-resampling",
            "rawRetention": "ephemeral",
            "prior": {"route": baseline["destinationRoute"], "arm": baseline["destinationArm"], "monitoring": baseline["destinationMonitoring"], "position": baseline["position"]},
            "_sourceTrack": source_track,
            "_sourceSlot": source_slot,
            "_sourceClip": source_clip,
            "_sourceClipIdentity": source_clip_identity,
            "_sourceTrackIdentity": source_track_identity,
            "_sourceSlotIdentity": source_slot_identity,
            "_destinationTrack": destination_track,
            "_destinationTrackIdentity": destination_track_identity,
            "_destinationSlotIdentity": destination_slot_identity,
            "_destinationSlot": destination_slot,
            "_priorRouteLabel": prior_route_label,
            "_priorDestinationName": str(self._read_attr(destination_track, "name") or ""),
            "_priorMonitoringRaw": self._read_attr(destination_track, "current_monitoring_state"),
            "_resampling": resampling,
            "_sourceTrackIndex": source_track_index,
            "_sourceSlotIndex": source_slot_index,
            "_destinationTrackIndex": destination_track_index,
            "_destinationSlotIndex": destination_slot_index,
            "_priorLaunchQuantization": self._read_attr(self.song, "clip_trigger_quantization"),
        }

    @staticmethod
    def _capture_public_plan(plan: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in plan.items() if not key.startswith("_")}

    def _capture_inspect(self, args: dict[str, Any]) -> dict[str, Any]:
        if self._capture_state is not None and self._capture_state.get("state") not in {"cleaned"}:
            raise ValueError("a prior capture must be stopped and cleaned before another preview")
        return self._capture_public_plan(self._capture_plan(args))

    @staticmethod
    def _capture_stop_track(track: Any) -> None:
        stop = getattr(track, "stop_all_clips", None)
        if not callable(stop):
            raise ValueError("capture track stop is unavailable")
        try:
            stop(False)
        except TypeError:
            stop()

    def _capture_start(self, args: dict[str, Any]) -> dict[str, Any]:
        capture_id = args.get("captureId")
        max_duration = args.get("maxDurationMs")
        fence = args.get("fence")
        if not isinstance(capture_id, str) or not 16 <= len(capture_id) <= 128 or not isinstance(max_duration, int) or isinstance(max_duration, bool) or not 1000 <= max_duration <= 10000 or not isinstance(fence, str):
            raise ValueError("capture authority is invalid")
        self._capture_refresh()
        if self._capture_state is not None and self._capture_state.get("state") not in {"cleaned"}:
            raise ValueError("another capture lifecycle is active or awaiting cleanup")
        plan = self._capture_plan(args)
        if plan["fence"] != fence:
            raise ValueError("capture state changed since preview")
        token = secrets.token_urlsafe(32)
        expires_at = int(time.time() * 1000) + max_duration
        state = {
            **plan,
            "captureId": capture_id,
            "token": token,
            "state": "starting",
            "startedAt": int(time.time() * 1000),
            "expiresAt": expires_at,
            "deadlineMonotonic": time.monotonic() + max_duration / 1000.0,
            "ownershipTag": f"MCP Capture {hashlib.sha256(token.encode('utf-8')).hexdigest()[:16]}",
            "preserveOwnershipTag": False,
            "fireDispatched": False,
            "residual": [],
        }
        self._capture_state = state
        destination_track = plan["_destinationTrack"]
        destination_slot = plan["_destinationSlot"]
        source_slot = plan["_sourceSlot"]
        try:
            destination_track.name = state["ownershipTag"]
            if str(self._read_attr(destination_track, "name") or "") != state["ownershipTag"]:
                raise ValueError("capture destination ownership tag was not confirmed")
            setattr(destination_track, "input_routing_type", plan["_resampling"])
            destination_track.current_monitoring_state = 2
            destination_track.arm = True
            if self._capture_route_label(self._capture_current_route(destination_track)) != self._capture_route_label(plan["_resampling"]) or self._monitoring_state(self._read_attr(destination_track, "current_monitoring_state")) != "off" or self._read_attr(destination_track, "arm") is not True:
                raise ValueError("capture setup was not confirmed by fresh state")
            prior_quantization = plan["_priorLaunchQuantization"]
            if not isinstance(prior_quantization, int) or isinstance(prior_quantization, bool):
                raise ValueError("capture launch quantization is not authoritatively controllable")
            try:
                self.song.clip_trigger_quantization = 0
                # Mark potential authority before the side-effecting call: Live
                # can schedule recording and still raise before returning.
                state["fireDispatched"] = True
                destination_slot.fire()
                source_slot.fire()
                current_source = getattr(source_slot, "clip", None)
                if not self._capture_same_object(current_source, plan["_sourceClip"], plan["_sourceClipIdentity"]):
                    raise ValueError("capture source clip identity changed during dispatch")
                owned_clip = getattr(destination_slot, "clip", None)
                if owned_clip is not None:
                    owned_name = self._read_attr(owned_clip, "name")
                    if self._read_attr(owned_clip, "is_recording") is not True or not isinstance(owned_name, str) or not owned_name.startswith(state["ownershipTag"]):
                        raise ValueError("capture destination was occupied by a clip without the private recording ownership tag")
                    state["_ownedClip"] = owned_clip
                    state["_ownedClipIdentity"] = self._capture_object_identity(owned_clip)
            finally:
                self.song.clip_trigger_quantization = prior_quantization
            if self._read_attr(self.song, "clip_trigger_quantization") != prior_quantization:
                raise ValueError("capture launch quantization was not restored")
            state["state"] = "active"
            if state.get("_ownedClipIdentity"):
                state["residual"] = list(dict.fromkeys(state.get("residual", []) + self._capture_restore_name(state)))
            else:
                state["preserveOwnershipTag"] = True
            return {"captureId": capture_id, "token": token, "expiresAt": expires_at, "state": "active", "sourceSlotRef": plan["sourceSlotRef"], "destinationSlotRef": plan["destinationSlotRef"], "destinationTrackRef": plan["destinationTrackRef"]}
        except BaseException:
            state["preserveOwnershipTag"] = bool(state.get("fireDispatched") and not state.get("_ownedClipIdentity"))
            self._capture_stop_state(state, failed=True)
            clip = getattr(destination_slot, "clip", None)
            if not state.get("fireDispatched") and clip is None and self._capture_status().get("playbackStopped") is True:
                state["state"] = "cleaned"
                state["token"] = None
            else:
                # Once fire may have created media, retain the clip/path and
                # mapper token for host-side raw cleanup. Remote Script never
                # deletes a potentially recorded clip on partial-start failure.
                state["state"] = "failed"
                if clip is not None and (not state.get("_ownedClipIdentity") or not self._capture_same_object(clip, state.get("_ownedClip"), state["_ownedClipIdentity"])):
                    state["residual"] = list(dict.fromkeys(state.get("residual", []) + ["destination-clip-identity-unresolved"]))
            raise

    def _capture_restore_name(self, state: dict[str, Any]) -> list[str]:
        if state.get("preserveOwnershipTag"):
            return []
        track = state["_destinationTrack"]
        current_name = str(self._read_attr(track, "name") or "")
        if current_name == state.get("ownershipTag"):
            try:
                track.name = state["_priorDestinationName"]
                return [] if str(self._read_attr(track, "name") or "") == state["_priorDestinationName"] else ["destination-name-not-restored"]
            except (AttributeError, RuntimeError, TypeError, ValueError):
                return ["destination-name-not-restored"]
        return [] if current_name == state["_priorDestinationName"] else ["destination-name-changed-externally"]

    def _capture_restore(self, state: dict[str, Any]) -> list[str]:
        residual: list[str] = []
        track = state["_destinationTrack"]
        owned_route = self._capture_route_label(state["_resampling"])
        current_route = self._capture_route_label(self._capture_current_route(track))
        prior_route_label = state["_priorRouteLabel"]
        residual.extend(self._capture_restore_name(state))
        # Disarm before selecting a no-input baseline; Live can mark a track as
        # non-armable once that route is selected.
        current_arm = self._read_attr(track, "arm")
        if current_arm is True:
            try: track.arm = state["prior"]["arm"]
            except (AttributeError, RuntimeError, TypeError, ValueError): residual.append("destination-arm-not-restored")
        elif current_arm != state["prior"]["arm"]:
            residual.append("destination-arm-changed-externally")
        current_monitoring = self._monitoring_state(self._read_attr(track, "current_monitoring_state"))
        if current_monitoring == "off":
            try: track.current_monitoring_state = state["_priorMonitoringRaw"]
            except (AttributeError, RuntimeError, TypeError, ValueError): residual.append("destination-monitoring-not-restored")
        elif current_monitoring != state["prior"]["monitoring"]:
            residual.append("destination-monitoring-changed-externally")
        if current_route == owned_route:
            try:
                prior_choice = self._routing_choice(track, "available_input_routing_types", prior_route_label)
                setattr(track, "input_routing_type", prior_choice)
                if self._capture_route_label(self._capture_current_route(track)) != prior_route_label:
                    residual.append("destination-route-not-restored")
            except (AttributeError, RuntimeError, TypeError, ValueError):
                residual.append("destination-route-not-restored")
        elif current_route != prior_route_label:
            residual.append("destination-route-changed-externally")
        try:
            self.song.current_song_time = state["prior"]["position"]
        except (AttributeError, TypeError, ValueError):
            residual.append("transport-position-not-restored")
        return residual

    def _capture_stop_state(self, state: dict[str, Any], failed: bool = False) -> None:
        errors: list[str] = []
        for slot in (state["_sourceSlot"], state["_destinationSlot"]):
            stop_slot = getattr(slot, "stop", None)
            if callable(stop_slot):
                try: stop_slot()
                except (RuntimeError, TypeError, ValueError): errors.append("slot-stop-failed")
        for track in (state["_sourceTrack"], state["_destinationTrack"]):
            try:
                self._capture_stop_track(track)
            except (AttributeError, RuntimeError, TypeError, ValueError):
                errors.append("track-stop-failed")
        stop_playing = getattr(self.song, "stop_playing", None)
        if callable(stop_playing):
            try:
                stop_playing()
            except (RuntimeError, TypeError, ValueError):
                errors.append("transport-stop-failed")
        else:
            errors.append("transport-stop-unavailable")
        if self._read_attr(self.song, "record_mode") is True:
            try: self.song.record_mode = False
            except (AttributeError, RuntimeError, TypeError, ValueError): errors.append("arrangement-record-stop-failed")
        if self._read_attr(self.song, "session_record") is True:
            try: self.song.session_record = False
            except (AttributeError, RuntimeError, TypeError, ValueError): errors.append("session-record-stop-failed")
        errors.extend(self._capture_restore(state))
        state["residual"] = list(dict.fromkeys(state.get("residual", []) + errors))
        state["state"] = "failed" if failed or any(item.endswith("failed") or item.endswith("unavailable") for item in errors) else "stopped"
        state["stoppedAt"] = int(time.time() * 1000)

    @staticmethod
    def _capture_playback_stopped(playback: dict[str, Any]) -> bool:
        transport = playback["transport"]
        return transport.get("playing") is False and transport.get("arrangementRecord") is False and transport.get("sessionRecord") is False and not playback.get("firedTargets") and not playback.get("playingTargets")

    def _capture_refresh(self) -> None:
        state = self._capture_state
        if state is None or state.get("state") == "cleaned":
            return
        playback = self._playback()
        playback_stopped = self._capture_playback_stopped(playback)
        if state.get("state") == "active" and time.monotonic() >= state.get("deadlineMonotonic", 0):
            self._capture_stop_state(state)
            state["watchdogStopped"] = True
            playback = self._playback()
            playback_stopped = self._capture_playback_stopped(playback)
        destination_slot = state["_destinationSlot"]
        clip = getattr(destination_slot, "clip", None)
        owned_recording = clip is not None and state.get("_ownedClipIdentity") and self._capture_same_object(clip, state.get("_ownedClip"), state["_ownedClipIdentity"]) and self._read_attr(clip, "is_recording") is not False
        # Failed/unverified stop is not terminal authority. Retry when either
        # playback or the exact owned recording remains active.
        if state.get("state") in {"stopped", "captured", "failed"} and (not playback_stopped or owned_recording):
            self._capture_stop_state(state)
            clip = getattr(destination_slot, "clip", None)
        if state.get("state") == "active":
            if clip is not None and not state.get("_ownedClipIdentity"):
                clip_name = self._read_attr(clip, "name")
                if self._read_attr(clip, "is_recording") is not True or not isinstance(clip_name, str) or not clip_name.startswith(state["ownershipTag"]):
                    state["residual"] = list(dict.fromkeys(state.get("residual", []) + ["destination-clip-lacks-private-ownership-tag"]))
                    state["state"] = "failed"
                    self._capture_stop_state(state, failed=True)
                    return
                state["_ownedClip"] = clip
                state["_ownedClipIdentity"] = self._capture_object_identity(clip)
                state["preserveOwnershipTag"] = False
                state["residual"] = list(dict.fromkeys(state.get("residual", []) + self._capture_restore_name(state)))
            elif clip is not None and not self._capture_same_object(clip, state.get("_ownedClip"), state["_ownedClipIdentity"]):
                state["residual"] = list(dict.fromkeys(state.get("residual", []) + ["destination-clip-changed-externally"]))
                state["state"] = "failed"
                self._capture_stop_state(state, failed=True)
            return
        if state.get("state") not in {"stopped", "captured", "failed"}:
            return
        if clip is None:
            return
        if not state.get("_ownedClipIdentity"):
            clip_name = self._read_attr(clip, "name")
            if not isinstance(clip_name, str) or not clip_name.startswith(state["ownershipTag"]):
                state["residual"] = list(dict.fromkeys(state.get("residual", []) + ["destination-clip-lacks-private-ownership-tag"]))
                state["state"] = "failed"
                return
            state["_ownedClip"] = clip
            state["_ownedClipIdentity"] = self._capture_object_identity(clip)
            state["preserveOwnershipTag"] = False
            state["residual"] = list(dict.fromkeys(state.get("residual", []) + self._capture_restore_name(state)))
        elif not self._capture_same_object(clip, state.get("_ownedClip"), state["_ownedClipIdentity"]):
            state["residual"] = list(dict.fromkeys(state.get("residual", []) + ["destination-clip-changed-externally"]))
            state["state"] = "failed"
            return
        # Live can expose the newly recorded clip proxy before its properties
        # are readable and before file_path is assigned. Treat that as pending
        # finalization, not capture failure; the host polls this bounded state.
        if self._read_attr(clip, "is_recording") is not False:
            return
        name = self._read_attr(clip, "name")
        length = self._read_attr(clip, "length")
        if name is None or not isinstance(length, (int, float)) or isinstance(length, bool) or not math.isfinite(float(length)):
            return
        clip_ref = self.refs.put("clip", clip, f"{state['_destinationTrackIndex']}:{state['_destinationSlotIndex']}")
        state["clipRef"] = clip_ref
        fields = self._audio_fields(clip)
        state["clip"] = {"ref": clip_ref, "name": str(name), "length": float(length), **fields}
        if fields.get("filePath"):
            state["state"] = "captured" if self._capture_playback_stopped(self._playback()) else "failed"

    def _capture_status(self) -> dict[str, Any]:
        state = self._capture_state
        if state is None:
            return {"active": False, "playbackStopped": True, "state": "idle", "residual": []}
        playback = self._playback()
        playback_stopped = self._capture_playback_stopped(playback)
        current_clip = getattr(state.get("_destinationSlot"), "clip", None); owned_clip = state.get("_ownedClip"); owned_identity = state.get("_ownedClipIdentity")
        current_is_owned = current_clip is not None and owned_clip is not None and isinstance(owned_identity, str) and self._capture_same_object(current_clip, owned_clip, owned_identity)
        recording = self._read_attr(current_clip, "is_recording") is not False if current_is_owned else False
        output = {
            "active": state.get("state") in {"starting", "active"} or not playback_stopped or recording,
            "unsafe": not playback_stopped or recording or state.get("state") == "failed",
            "playbackStopped": playback_stopped,
            "state": state.get("state"),
            "captureId": state.get("captureId"),
            "sourceSlotRef": state.get("sourceSlotRef"),
            "destinationSlotRef": state.get("destinationSlotRef"),
            "destinationTrackRef": state.get("destinationTrackRef"),
            "startedAt": state.get("startedAt"),
            "expiresAt": state.get("expiresAt"),
            "recoveryToken": state.get("token"),
            "residual": state.get("residual", []),
            "watchdogStopped": bool(state.get("watchdogStopped", False)),
        }
        if state.get("clip") is not None:
            output["clip"] = state["clip"]
        return output

    def _capture_stop(self, args: dict[str, Any]) -> dict[str, Any]:
        state = self._capture_state
        if state is None or args.get("captureId") != state.get("captureId") or not secrets.compare_digest(str(args.get("token") or ""), str(state.get("token") or "")):
            raise ValueError("capture stop authority is invalid")
        if state.get("state") != "cleaned":
            self._capture_stop_state(state)
        self._capture_refresh()
        status = self._capture_status()
        # Live can apply slot stop asynchronously across one display tick. The
        # truthful active/playbackStopped fields keep cleanup fenced while the
        # watchdog reasserts the exact stop; the host polls for verification.
        return {"stopped": True, **status}

    def _capture_emergency_stop(self, args: dict[str, Any]) -> dict[str, Any]:
        state = self._capture_state
        if state is None or args.get("captureId") != state.get("captureId") or args.get("sourceSlotRef") != state.get("sourceSlotRef") or args.get("destinationSlotRef") != state.get("destinationSlotRef"):
            raise ValueError("capture emergency-stop observation is stale or inexact")
        if state.get("state") != "cleaned":
            self._capture_stop_state(state)
        self._capture_refresh()
        status = self._capture_status()
        return {"stopped": True, **status}

    def _capture_cleanup(self, args: dict[str, Any]) -> dict[str, Any]:
        state = self._capture_state
        if state is None or args.get("captureId") != state.get("captureId") or not secrets.compare_digest(str(args.get("token") or ""), str(state.get("token") or "")):
            raise ValueError("capture cleanup authority is invalid")
        if state.get("state") == "active":
            raise ValueError("active capture must be stopped before cleanup")
        self._capture_refresh(); capture_status = self._capture_status()
        if capture_status.get("playbackStopped") is not True or capture_status.get("active") is not False:
            raise ValueError("capture playback and owned recording must be authoritatively stopped before cleanup")
        if args.get("expectedClipRef") != state.get("clipRef"):
            raise ValueError("capture cleanup clip identity is stale or inexact")
        slot = state["_destinationSlot"]
        clip = getattr(slot, "clip", None)
        if clip is None or not state.get("_ownedClipIdentity") or not self._capture_same_object(clip, state.get("_ownedClip"), state["_ownedClipIdentity"]) or not callable(getattr(slot, "delete_clip", None)):
            raise ValueError("transaction-owned capture clip identity is unavailable for cleanup")
        file_path = (state.get("clip") or {}).get("filePath"); deletion_error: BaseException | None = None
        try: slot.delete_clip()
        except BaseException as error: deletion_error = error
        if getattr(slot, "clip", None) is not None: raise ValueError("capture clip cleanup was not confirmed") from deletion_error
        clip_reference = str(state.get("clipRef"))
        try: self.refs.delete(clip_reference)
        except (KeyError, ValueError): raise ValueError("capture cleanup reference retirement failed") from deletion_error
        state["state"] = "cleaned"
        state["token"] = None
        state.pop("clip", None)
        state.pop("clipRef", None)
        return {"cleaned": True, "filePath": file_path, "captureId": state.get("captureId"), "residual": state.get("residual", [])}

    def capture_tick(self) -> None:
        try:
            self._capture_refresh()
        except BaseException:
            _debug_trace("capture-tick-failure")
            if self._capture_state is not None:
                try: self._capture_stop_state(self._capture_state, failed=True)
                except BaseException: self._capture_state["state"] = "failed"

    def capture_shutdown(self) -> None:
        state = self._capture_state
        if state is None or state.get("state") == "cleaned":
            return
        self._capture_stop_state(state, failed=True)
        self._capture_refresh()
        state["preserveOwnershipTag"] = False
        state["residual"] = list(dict.fromkeys(state.get("residual", []) + self._capture_restore_name(state)))
        # Remote Script cannot unlink raw media. Preserve any exact clip/path
        # rather than destroying the host's recovery identity on Live/bridge
        # teardown; the visible residual requires host or manual cleanup.
        state["residual"] = list(dict.fromkeys(state.get("residual", []) + ["bridge-shutdown-requires-host-or-manual-media-cleanup"]))
        state["state"] = "failed"

    def _routing_row(self, track: Any) -> dict[str, Any]:
        def choice(*names: str) -> Any:
            value = self._read_attr(track, *names)
            return self._capture_route_label(value)
        return {
            "inputType": choice("input_routing_type", "current_input_routing"),
            "inputSubRouting": choice("input_routing_channel", "input_sub_routing", "current_input_sub_routing"),
            "outputType": choice("output_routing_type", "current_output_routing"),
            "outputSubRouting": choice("output_routing_channel", "output_sub_routing", "current_output_sub_routing"),
            "availableInputTypes": len(self._items(self._read_attr(track, "available_input_routing_types") or [])),
            "availableInputChannels": len(self._items(self._read_attr(track, "available_input_routing_channels") or [])),
            "availableOutputTypes": len(self._items(self._read_attr(track, "available_output_routing_types") or [])),
            "availableOutputChannels": len(self._items(self._read_attr(track, "available_output_routing_channels") or [])),
        }

    def _routing_choice(self, track: Any, available_name: str, label: str) -> Any:
        if label is None:
            return None
        matches = []
        for candidate in self._items(self._read_attr(track, available_name) or []):
            candidate_label = candidate.get("display_name") or candidate.get("name") if isinstance(candidate, dict) else getattr(candidate, "display_name", None) or getattr(candidate, "name", "")
            if str(candidate_label) == label: matches.append(candidate)
        if len(matches) != 1: raise ValueError(f"routing choice is unavailable or ambiguous: {label}")
        return matches[0]

    def _routing_would_cycle(self, target: Any, args: dict[str, Any]) -> bool:
        tracks = self._items(getattr(self.song, "tracks", [])) + self._items(getattr(self.song, "return_tracks", []))
        main = getattr(self.song, "master_track", getattr(self.song, "main_track", None))
        if main is not None: tracks.append(main)
        names: dict[str, list[int]] = {}
        for index, track in enumerate(tracks): names.setdefault(str(self._read_attr(track, "name") or ""), []).append(index)
        edges: dict[int, set[int]] = {index: set() for index in range(len(tracks))}
        for index, track in enumerate(tracks):
            output = args.get("outputType") if self._capture_same_object(track, target, self._capture_object_identity(target)) and "outputType" in args else self._capture_route_label(self._read_attr(track, "output_routing_type", "current_output_routing"))
            if isinstance(output, str): edges[index].update(names.get(output, []))
            input_route = args.get("inputType") if self._capture_same_object(track, target, self._capture_object_identity(target)) and "inputType" in args else self._capture_route_label(self._read_attr(track, "input_routing_type", "current_input_routing"))
            if isinstance(input_route, str):
                for source in names.get(input_route, []): edges[source].add(index)
        visiting: set[int] = set(); visited: set[int] = set()
        def cycle(index: int) -> bool:
            if index in visiting: return True
            if index in visited: return False
            visiting.add(index)
            if any(cycle(destination) for destination in edges[index]): return True
            visiting.remove(index); visited.add(index); return False
        return any(cycle(index) for index in edges)

    def _routing_set(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:track:"):
            raise ValueError("track reference is stale or invalid")
        self.snapshot()
        track = self.refs.get(reference)
        expected_identity = args.get("expectedObjectIdentity"); tracks = self._all_track_objects(); track_index = self._capture_index(tracks, track, expected_identity if isinstance(expected_identity, str) else None)
        if not isinstance(expected_identity, str) or track_index is None or reference != f"{self.refs.epoch}:track:{track_index}" or not hmac.compare_digest(self._capture_object_identity(track), expected_identity):
            raise ValueError("routing track identity changed since preview")
        routing_before = self._routing_row(track); state = {"inputType": routing_before.get("inputType"), "inputSubRouting": routing_before.get("inputSubRouting"), "outputType": routing_before.get("outputType"), "outputSubRouting": routing_before.get("outputSubRouting"), "arm": self._read_attr(track, "arm"), "monitoring": self._monitoring_state(self._read_attr(track, "current_monitoring_state"))}; expected_state = args.get("expectedStateRevision"); state_revision = hashlib.sha256(self._bounded_canonical(state).encode("utf-8")).hexdigest()
        if not isinstance(expected_state, str) or not hmac.compare_digest(state_revision, expected_state): raise ValueError("routing state changed since preview")
        allowed = {"ref", "inputType", "inputSubRouting", "outputType", "outputSubRouting", "arm", "monitoring", "expectedObjectIdentity", "expectedStateRevision"}
        if set(args) - allowed:
            raise ValueError("routing fields are invalid")
        for field in ("inputType", "inputSubRouting", "outputType", "outputSubRouting"):
            value = args.get(field)
            if value is not None and (not isinstance(value, str) or len(value) > 256):
                raise ValueError(f"{field} is invalid")
        arm = args.get("arm")
        if arm is not None and not isinstance(arm, bool):
            raise ValueError("arm is invalid")
        monitoring = args.get("monitoring")
        if monitoring is not None and monitoring not in {"in", "auto", "off"}:
            raise ValueError("monitoring is invalid")
        # Refuse any direct or transitive track routing cycle before the first
        # Live mutation; label ambiguity is treated conservatively as every
        # matching track edge rather than guessed away.
        if self._routing_would_cycle(track, args):
            raise ValueError("routing would create a direct or transitive feedback loop")
        def route_group(direction: str) -> dict[str, Any] | None:
            type_field, channel_field = f"{direction}Type", f"{direction}SubRouting"; type_attribute, channel_attribute = f"{direction}_routing_type", f"{direction}_routing_channel"; available_types, available_channels = f"available_{direction}_routing_types", f"available_{direction}_routing_channels"
            if args.get(type_field) is None and args.get(channel_field) is None: return None
            return {"direction": direction, "proposed": {key: args[key] for key in (type_field, channel_field) if key in args}, "typeAttribute": type_attribute, "channelAttribute": channel_attribute, "availableTypes": available_types, "availableChannels": available_channels, "typeLabel": args.get(type_field), "channelLabel": args.get(channel_field), "priorType": self._read_attr(track, type_attribute), "priorChannel": self._read_attr(track, channel_attribute)}
        route_groups = [group for group in (route_group("input"), route_group("output")) if group is not None]
        if len(route_groups) == 2:
            safe_order = None
            for order in (route_groups, list(reversed(route_groups))):
                staged: dict[str, Any] = {}; safe = True
                for group in order:
                    staged.update(group["proposed"])
                    if self._routing_would_cycle(track, staged): safe = False; break
                if safe: safe_order = order; break
            if safe_order is None: raise ValueError("routing cannot transition without a transient feedback loop")
            route_groups = safe_order
        if arm is not None and self._read_attr(track, "can_be_armed") is not True: raise ValueError("track cannot be armed")
        if monitoring is not None and not isinstance(self._read_attr(track, "current_monitoring_state"), int): raise ValueError("monitoring control is unavailable on this track")
        extra_assignments: list[tuple[Any, str, Any, Any]] = []
        if arm is not None: extra_assignments.append((track, "arm", arm, self._read_attr(track, "arm")))
        if monitoring is not None: extra_assignments.append((track, "current_monitoring_state", {"in": 0, "auto": 1, "off": 2}[monitoring], self._read_attr(track, "current_monitoring_state")))
        applied_groups: list[dict[str, Any]] = []
        try:
            for group in route_groups:
                applied_groups.append(group)
                if group["typeLabel"] is not None:
                    route_type = self._routing_choice(track, group["availableTypes"], group["typeLabel"]); setattr(track, group["typeAttribute"], route_type)
                if group["channelLabel"] is not None:
                    channel = self._routing_choice(track, group["availableChannels"], group["channelLabel"]); setattr(track, group["channelAttribute"], channel)
            for owner, name, value, _ in extra_assignments: setattr(owner, name, value)
            row = self._routing_row(track); checks = []
            if args.get("inputType") is not None: checks.append(row["inputType"] == args["inputType"])
            if args.get("inputSubRouting") is not None: checks.append(row["inputSubRouting"] == args["inputSubRouting"])
            if args.get("outputType") is not None: checks.append(row["outputType"] == args["outputType"])
            if args.get("outputSubRouting") is not None: checks.append(row["outputSubRouting"] == args["outputSubRouting"])
            if arm is not None: checks.append(self._read_attr(track, "arm") is arm)
            if monitoring is not None: checks.append(self._monitoring_state(self._read_attr(track, "current_monitoring_state")) == monitoring)
            if not all(checks): raise ValueError("routing change was not confirmed by fresh state")
        except BaseException as error:
            rollback_failed = False
            for owner, name, _, prior in reversed(extra_assignments):
                try: setattr(owner, name, prior)
                except BaseException: rollback_failed = True
            for group in reversed(applied_groups):
                try:
                    if group["typeLabel"] is not None: setattr(track, group["typeAttribute"], group["priorType"])
                    setattr(track, group["channelAttribute"], group["priorChannel"])
                except BaseException: rollback_failed = True
            restored_routing = self._routing_row(track); restored_state = {"inputType": restored_routing.get("inputType"), "inputSubRouting": restored_routing.get("inputSubRouting"), "outputType": restored_routing.get("outputType"), "outputSubRouting": restored_routing.get("outputSubRouting"), "arm": self._read_attr(track, "arm"), "monitoring": self._monitoring_state(self._read_attr(track, "current_monitoring_state"))}
            if self._bounded_canonical(restored_state) != self._bounded_canonical(state): rollback_failed = True
            if rollback_failed: raise ValueError("routing change failed and exact rollback failed") from error
            raise
        revision = self.refs.touch(reference)
        return {"changed": True, "revision": revision}

    def _recording_authority(self, args: dict[str, Any], lane: str) -> str:
        action = args.get("action")
        expected_session, expected_arrangement = args.get("expectedSessionRecord"), args.get("expectedArrangementRecord")
        destination_ref, destination_identity, output_safety = args.get("destinationTrackRef"), args.get("destinationTrackIdentity"), args.get("outputSafety")
        if action not in {"start", "stop"} or not isinstance(expected_session, bool) or not isinstance(expected_arrangement, bool):
            raise ValueError("recording authority is invalid")
        current_session, current_arrangement = self._read_attr(self.song, "session_record"), self._read_attr(self.song, "record_mode")
        if not isinstance(current_session, bool) or not isinstance(current_arrangement, bool):
            raise ValueError("recording control is unavailable")
        if current_session is not expected_session or current_arrangement is not expected_arrangement:
            raise ValueError("recording state changed since preview")
        if not isinstance(output_safety, dict) or output_safety.get("safe") is not True or not isinstance(output_safety.get("provenance"), str) or output_safety.get("provenance") in {"", "unknown", "simulator"}:
            raise ValueError("authoritative output safety is required")
        self.snapshot(); tracks = self._items(getattr(self.song, "tracks", [])); destination = None
        if destination_ref is not None:
            if not isinstance(destination_ref, str) or not isinstance(destination_identity, str):
                raise ValueError("recording destination identity is invalid")
            referenced = self.refs.get(destination_ref); matches = [candidate for candidate in tracks if self._capture_same_object(candidate, referenced, destination_identity)]
            if not hmac.compare_digest(self._capture_object_identity(referenced), destination_identity) or len(matches) != 1:
                raise ValueError("recording destination identity is stale, foreign, or ambiguous")
            destination = matches[0]
        elif action == "start" or destination_identity is not None:
            raise ValueError("recording start requires an exact destination track identity")
        if action == "start":
            armed_tracks = [track for track in tracks if self._read_attr(track, "arm") is True]
            armed_matches = [track for track in armed_tracks if self._capture_same_object(track, destination, str(destination_identity))]
            if destination is None or self._read_attr(destination, "arm") is not True or len(armed_tracks) != 1 or len(armed_matches) != 1:
                raise ValueError("recording destination must be the only unambiguous armed track")
        if lane == "session" and action == "start" and current_session:
            raise ValueError("Session recording is already active")
        if lane == "arrangement" and action == "start" and current_arrangement:
            raise ValueError("Arrangement recording is already active")
        return action

    def _recording_session(self, args: dict[str, Any]) -> dict[str, Any]:
        action = self._recording_authority(args, "session")
        # Recording state applies asynchronously; the host confirms through
        # fresh playback reads rather than a synchronous postcondition.
        self.song.session_record = action == "start"
        return {"recording": action == "start"}

    def _recording_arrangement(self, args: dict[str, Any]) -> dict[str, Any]:
        action = self._recording_authority(args, "arrangement")
        self.song.record_mode = action == "start"
        return {"recording": action == "start"}

    def _validated_note(self, clip: Any, value: Any) -> dict[str, Any]:
        if not isinstance(value, dict) or not hasattr(clip, "add_new_notes"):
            raise ValueError("note is invalid")
        note = dict(value)
        if (not isinstance(note.get("pitch"), int) or isinstance(note["pitch"], bool) or not 0 <= note["pitch"] <= 127
                or not isinstance(note.get("velocity"), (int, float)) or isinstance(note["velocity"], bool) or not 1 <= float(note["velocity"]) <= 127
                or not isinstance(note.get("channel"), int) or isinstance(note["channel"], bool) or not 1 <= note["channel"] <= 16
                or not isinstance(note.get("start"), (int, float)) or isinstance(note["start"], bool)
                or not isinstance(note.get("duration"), (int, float)) or isinstance(note["duration"], bool)
                or not math.isfinite(float(note["start"])) or not math.isfinite(float(note["duration"]))
                or float(note["start"]) < 0 or float(note["duration"]) <= 0
                or float(note["start"]) + float(note["duration"]) > float(getattr(clip, "length", 0))):
            raise ValueError("note is invalid")
        probability = note.get("probability")
        if probability is not None and (not isinstance(probability, (int, float)) or isinstance(probability, bool) or not 0 <= float(probability) <= 1):
            raise ValueError("note probability is invalid")
        velocity_deviation = note.get("velocityDeviation")
        if velocity_deviation is not None and (not isinstance(velocity_deviation, (int, float)) or isinstance(velocity_deviation, bool) or not -127 <= float(velocity_deviation) <= 127):
            raise ValueError("note velocity deviation is invalid")
        release_velocity = note.get("releaseVelocity")
        if release_velocity is not None and (not isinstance(release_velocity, (int, float)) or isinstance(release_velocity, bool) or not 0 <= float(release_velocity) <= 127):
            raise ValueError("note release velocity is invalid")
        if note.get("mute") is not None and not isinstance(note["mute"], bool):
            raise ValueError("note mute is invalid")
        return note

    def _note_add_batch(self, args: dict[str, Any]) -> dict[str, Any]:
        clip = self._guard_note_clip(args)
        values = args.get("notes")
        if not isinstance(values, list) or not 1 <= len(values) <= 512:
            raise ValueError("note batch is invalid")
        notes = [self._validated_note(clip, value) for value in values]; prior_rows = self._read_notes(clip)
        if len(prior_rows) + len(notes) > MAX_WIRE_ARRAY_LENGTH: raise ValueError("note batch would exceed the authoritative clip-note bound")
        prior_candidates = list(clip.get_all_notes_extended()) if hasattr(clip, "get_all_notes_extended") else []
        prior_ids = {int(candidate.note_id) for candidate in prior_candidates if isinstance(getattr(candidate, "note_id", None), int) and not isinstance(candidate.note_id, bool)}
        try:
            spec_class = getattr(__import__("Live.Clip", fromlist=["MidiNoteSpecification"]), "MidiNoteSpecification", None)
        except Exception:
            spec_class = None
        if spec_class is None and hasattr(clip, "set_notes"): raise ValueError("legacy set_notes replacement is refused because additive completeness cannot be proven")
        prior_row_ids = [row.get("id") for row in prior_rows]
        if not callable(getattr(clip, "remove_notes_by_id", None)) or any(not isinstance(note_id, int) for note_id in prior_row_ids) or len(set(prior_row_ids)) != len(prior_row_ids): raise ValueError("complete unique stable note identity and exact additive rollback are required")
        note_ids: list[int | None] = []
        try:
            if spec_class is not None:
                specifications = [spec_class(note["pitch"], float(note["start"]), float(note["duration"]), float(note["velocity"]), bool(note.get("mute", False)), float(note.get("probability", 1.0)), float(note.get("velocityDeviation", 0.0)), float(note.get("releaseVelocity", 64.0))) for note in notes]; clip.add_new_notes(specifications)
            elif hasattr(clip, "set_notes"): raise ValueError("legacy set_notes replacement is refused because additive completeness cannot be proven")
            else:
                clip.add_new_notes([{"pitch": note["pitch"], "start_time": float(note["start"]), "duration": float(note["duration"]), "velocity": note["velocity"], "mute": bool(note.get("mute", False)), "channel": note["channel"], "probability": float(note.get("probability", 1.0)), "velocityDeviation": float(note.get("velocityDeviation", 0.0)), "velocity_deviation": float(note.get("velocityDeviation", 0.0)), "releaseVelocity": float(note.get("releaseVelocity", 64.0)), "release_velocity": float(note.get("releaseVelocity", 64.0))} for note in notes])
            after_rows = self._read_notes(clip); content = lambda row: {"pitch": int(row.get("pitch", 0)), "start": float(row.get("start", row.get("start_time", 0))), "duration": float(row.get("duration", 0)), "velocity": row.get("velocity", 0), "channel": int(row.get("channel", 1)), "mute": bool(row.get("mute", False)), "probability": float(row.get("probability", 1.0) if row.get("probability") is not None else 1.0), "velocityDeviation": float(row.get("velocityDeviation", 0.0) if row.get("velocityDeviation") is not None else 0.0), "releaseVelocity": float(row.get("releaseVelocity", 64.0) if row.get("releaseVelocity") is not None else 64.0)}; canonical_content = lambda rows: self._bounded_canonical(sorted([content(row) for row in rows], key=lambda row: self._bounded_canonical(row)))
            unmatched = [row for row in after_rows if isinstance(row.get("id"), int) and row["id"] not in prior_ids]
            for note in notes:
                expected_note = content(note); match = next((index for index, row in enumerate(unmatched) if self._bounded_canonical(content(row)) == self._bounded_canonical(expected_note)), None)
                if match is None: note_ids.append(None)
                else: note_ids.append(int(unmatched[match]["id"])); unmatched.pop(match)
            expected_content = canonical_content(prior_rows + notes)
            after_ids = [row.get("id") for row in after_rows]
            if len(after_rows) != len(prior_rows) + len(notes) or any(not isinstance(note_id, int) for note_id in after_ids) or len(set(after_ids)) != len(after_ids) or any(note_id is None for note_id in note_ids) or canonical_content(after_rows) != expected_content: raise ValueError("note batch did not produce the exact complete expected state")
            notes_revision = hashlib.sha256(self._bounded_canonical(after_rows).encode("utf-8")).hexdigest()
            return {"added": len(notes), "noteIds": note_ids, "notesRevision": notes_revision}
        except BaseException as error:
            rollback_failed = False
            try:
                current_rows = self._read_notes(clip); new_ids = [row["id"] for row in current_rows if isinstance(row.get("id"), int) and row["id"] not in prior_ids]
                if new_ids:
                    remover = getattr(clip, "remove_notes_by_id", None)
                    if not callable(remover): raise ValueError("new-note removal is unavailable")
                    remover(new_ids)
                if self._bounded_canonical(self._read_notes(clip)) != self._bounded_canonical(prior_rows): rollback_failed = True
            except BaseException: rollback_failed = True
            if rollback_failed: raise ValueError("note batch failed and exact rollback failed") from error
            raise

    def _note_add(self, args: dict[str, Any]) -> dict[str, Any]:
        result = self._note_add_batch({"ref": args.get("ref"), "notes": [args.get("note")], "expectedClipAuthority": args.get("expectedClipAuthority"), "expectedNotesRevision": args.get("expectedNotesRevision")})
        return {"added": True, "noteId": result["noteIds"][0]}


MAX_PENDING_EVENTS = 256
_EVENT_TYPES = {"transport", "object", "reset"}


def _supported_event_types(song: Any) -> set[str]:
    supported = {"reset"}
    if any(callable(getattr(song, f"add_{name}_listener", None)) for name in ("is_playing", "record_mode", "session_record")): supported.add("transport")
    if any(callable(getattr(song, f"add_{name}_listener", None)) for name in ("tracks", "scenes")): supported.add("object")
    return supported


class _Subscription:
    """Per-connection Live listener subscription with bounded coalesced events."""

    def __init__(self, mapper: "LiveObjectMapper", filters: set[str]):
        self.filters = filters
        self.mapper = mapper
        self.epoch = mapper.refs.epoch
        self.events: deque[dict[str, Any]] = deque(maxlen=MAX_PENDING_EVENTS)
        self.dropped = 0
        self.sequence = 1
        self._lock = threading.Lock()
        self._registrations: list[tuple[Any, str, Callable[[], Any]]] = []
        self.events.append({"epoch": self.epoch, "sequence": self.sequence, "type": "reset", "payload": {"subscription": True, "resnapshot": True}})
        self._register(mapper)

    def _register(self, mapper: "LiveObjectMapper") -> None:
        song = mapper.song

        def make_event(event_type: str, payload: dict[str, Any], ref: str | None = None) -> None:
            self._emit(event_type, payload, ref)

        listeners = (
            ("is_playing", "transport", lambda: make_event("transport", {"playing": bool(getattr(song, "is_playing", False))})),
            ("record_mode", "transport", lambda: make_event("transport", {"arrangementRecord": bool(getattr(song, "record_mode", False))})),
            ("session_record", "transport", lambda: make_event("transport", {"sessionRecord": bool(getattr(song, "session_record", False))})),
            ("tracks", "object", lambda: make_event("object", {"changed": "tracks"})),
            ("scenes", "object", lambda: make_event("object", {"changed": "scenes"})),
        )
        for name, event_type, callback in listeners:
            if event_type not in self.filters:
                continue
            register = getattr(song, f"add_{name}_listener", None)
            if callable(register):
                register(callback)
                self._registrations.append((song, name, callback))

    def _emit(self, event_type: str, payload: dict[str, Any], ref: str | None = None) -> None:
        if event_type not in self.filters:
            return
        with self._lock:
            current_epoch = self.mapper.refs.epoch
            if current_epoch != self.epoch:
                self.epoch = current_epoch; self.sequence = 1; self.events.clear(); self.dropped = 0
                self.events.append({"epoch": self.epoch, "sequence": self.sequence, "type": "reset", "payload": {"reconnect": True, "resnapshot": True}})
            event: dict[str, Any] = {"epoch": self.epoch, "type": event_type, "payload": payload}
            if ref is not None:
                event["ref"] = ref
            # A replaced event was never delivered, so retain its sequence and
            # do not misreport ordinary coalescing as continuity loss.
            if self.events and self.events[-1]["type"] == event_type and self.events[-1].get("ref") == event.get("ref"):
                previous = self.events[-1]
                event["sequence"] = previous["sequence"]
                event["coalesced"] = int(previous.get("coalesced", 0)) + 1
                self.events[-1] = event
            elif len(self.events) >= MAX_PENDING_EVENTS:
                self.dropped += 1
            else:
                self.sequence += 1
                event["sequence"] = self.sequence
                self.events.append(event)

    def drain(self) -> list[dict[str, Any]]:
        with self._lock:
            drained = list(self.events)
            self.events.clear()
            if self.dropped > 0:
                dropped = self.dropped; self.dropped = 0; self.sequence += 1
                return [{"epoch": self.epoch, "sequence": self.sequence, "type": "reset", "payload": {"overflow": dropped, "resnapshot": True}}]
            return drained

    def close(self) -> None:
        for owner, name, callback in self._registrations:
            remover = getattr(owner, f"remove_{name}_listener", None)
            if callable(remover):
                try:
                    remover(callback)
                except Exception:
                    pass
        self._registrations.clear()


REALTIME_MAX_DATAGRAM = 512
REALTIME_RATE_PER_SECOND = 64.0
REALTIME_RATE_BURST = 16
REALTIME_CHANNELS = {"udp-json", "osc", "xy", "max"}
_REALTIME_JSON_KEYS = {"token", "seq", "channel", "op", "sentAtMs", "ref", "value", "xRef", "x", "yRef", "y"}


def _osc_string(data: bytes, offset: int) -> tuple[str, int]:
    end = data.find(b"\x00", offset)
    if end < offset:
        raise ValueError("OSC string is unterminated")
    try:
        value = data[offset:end].decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("OSC string is invalid UTF-8") from error
    next_offset = (end + 4) & ~3
    if next_offset > len(data):
        raise ValueError("OSC string padding is truncated")
    return value, next_offset


def _decode_osc(data: bytes) -> dict[str, Any]:
    address, offset = _osc_string(data, 0)
    if address.startswith("#"):
        raise ValueError("OSC bundles are unavailable")
    tags, offset = _osc_string(data, offset)
    if not tags.startswith(",") or len(tags) > 16:
        raise ValueError("OSC type tags are invalid")
    values: list[Any] = []
    for tag in tags[1:]:
        if tag == "s":
            value, offset = _osc_string(data, offset)
        elif tag == "i":
            if offset + 4 > len(data): raise ValueError("OSC integer is truncated")
            value = struct.unpack_from(">i", data, offset)[0]; offset += 4
        elif tag == "h":
            if offset + 8 > len(data): raise ValueError("OSC integer is truncated")
            value = struct.unpack_from(">q", data, offset)[0]; offset += 8
        elif tag == "f":
            if offset + 4 > len(data): raise ValueError("OSC float is truncated")
            value = struct.unpack_from(">f", data, offset)[0]; offset += 4
        elif tag == "d":
            if offset + 8 > len(data): raise ValueError("OSC float is truncated")
            value = struct.unpack_from(">d", data, offset)[0]; offset += 8
        else:
            raise ValueError("OSC type is unsupported")
        values.append(value)
    if offset != len(data):
        raise ValueError("OSC packet has trailing bytes")
    if address == "/ableton-mcp/parameter" and len(values) in {4, 5}:
        token, sequence, reference, value, *sent = values
        return {"token": token, "seq": sequence, "channel": "osc", "op": "parameter.set", "ref": reference, "value": value, **({"sentAtMs": sent[0]} if sent else {})}
    if address == "/ableton-mcp/xy" and len(values) in {6, 7}:
        token, sequence, x_ref, x, y_ref, y, *sent = values
        return {"token": token, "seq": sequence, "channel": "osc", "op": "xy.set", "xRef": x_ref, "x": x, "yRef": y_ref, "y": y, **({"sentAtMs": sent[0]} if sent else {})}
    if address == "/ableton-mcp/emergency-stop" and len(values) in {2, 3}:
        token, sequence, *sent = values
        return {"token": token, "seq": sequence, "channel": "osc", "op": "emergency-stop", **({"sentAtMs": sent[0]} if sent else {})}
    raise ValueError("OSC address or arguments are unavailable")


class _RealtimeAuthorityChanged(ValueError):
    pass


class _RealtimePlane:
    """Short-lived loopback realtime ingress shared by JSON UDP, OSC, XY,
    and Max clients. Authentication, endpoint/channel allowlists, sequence and
    rate bounds are enforced before a nonblocking handoff to Live's main thread."""

    def __init__(self, bridge: "AbletonMcpBridge", host: str, port: int) -> None:
        self._bridge = bridge
        self.host = host
        self.port = port
        self._socket: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._armed: tuple[str, float, tuple[str, ...], frozenset[int], dict[str, str]] | None = None
        self._generation = 0
        self._last_sequence = 0
        self._tokens = float(REALTIME_RATE_BURST)
        self._refill_at = time.monotonic()
        self._last_arrival_ms: float | None = None
        self._last_interval_ms: float | None = None
        self._last_transit_ms: float | None = None
        self._jitter_ms = 0.0
        self._max_jitter_ms = 0.0
        self.accepted = 0
        self.applied = 0
        self.apply_failures = 0
        self.dropped_unarmed = 0
        self.dropped_endpoint = 0
        self.dropped_target = 0
        self.dropped_invalid = 0
        self.dropped_replay = 0
        self.dropped_rate_limited = 0
        self.dropped_queue_full = 0
        self.dropped_before_dispatch = 0
        self.revoked_before_apply = 0
        self.sequence_gaps = 0
        if port > 0:
            family = socket.AF_INET6 if ":" in host else socket.AF_INET
            self._socket = socket.socket(family, socket.SOCK_DGRAM)
            try:
                self._socket.bind((host, port))
                self._socket.settimeout(0.2)
                self._thread = threading.Thread(target=self._recv_loop, name="AbletonMcpRealtime", daemon=True)
                self._thread.start()
            except BaseException:
                self._socket.close()
                self._socket = None
                raise

    def _armed_now_locked(self) -> tuple[str, float, tuple[str, ...], frozenset[int], dict[str, str]] | None:
        if self._armed is not None and time.time() >= self._armed[1]:
            self._armed = None
            self._generation += 1
        return self._armed

    def arm(self, ttl_ms: int, channels: Any, parameter_refs: Any, source_ports: Any = None, target_authorities: Any = None) -> dict[str, Any]:
        if self._socket is None:
            raise ValueError("realtime control plane is disabled by configuration")
        if not isinstance(ttl_ms, int) or isinstance(ttl_ms, bool) or not 1000 <= ttl_ms <= 30000:
            raise ValueError("arming ttl is invalid")
        if not isinstance(channels, list) or not 1 <= len(channels) <= 4 or len(set(channels)) != len(channels) or any(not isinstance(item, str) or item not in REALTIME_CHANNELS for item in channels):
            raise ValueError("realtime channels are invalid")
        if not isinstance(parameter_refs, list) or len(parameter_refs) > 32 or len(set(parameter_refs)) != len(parameter_refs) or any(not isinstance(item, str) or not 1 <= len(item) <= 256 for item in parameter_refs):
            raise ValueError("realtime parameter allowlist is invalid")
        source_ports = [] if source_ports is None else source_ports
        if not isinstance(source_ports, list) or len(source_ports) > 16 or len(set(source_ports)) != len(source_ports) or any(not isinstance(item, int) or isinstance(item, bool) or not 1 <= item <= 65535 for item in source_ports):
            raise ValueError("realtime source ports are invalid")
        authority_keys = {"ref", "parameterIdentity", "ownerRef", "ownerIdentity", "trackRef", "trackIdentity", "siblings"}
        if not isinstance(target_authorities, list) or len(target_authorities) != len(parameter_refs) or len(target_authorities) > 32 or any(not isinstance(item, dict) or set(item) != authority_keys or not all(isinstance(item.get(key), str) for key in authority_keys - {"siblings"}) or not isinstance(item.get("siblings"), list) or len(item["siblings"]) > MAX_DISCOVERY_COLLECTION_LENGTH or any(not isinstance(sibling, dict) or set(sibling) != {"ref", "objectIdentity"} or not isinstance(sibling["ref"], str) or not isinstance(sibling["objectIdentity"], str) for sibling in item["siblings"]) for item in target_authorities):
            raise ValueError("realtime target identity authorities are invalid")
        parameter_authorities: dict[str, str] = {}
        for reference, expected_authority in zip(parameter_refs, target_authorities):
            if expected_authority.get("ref") != reference: raise ValueError("realtime target identity order is invalid")
            current_authority = self._bridge.mapper._realtime_parameter_authority(reference)
            expected_canonical = AuthenticatedRemoteScript._bounded_canonical(expected_authority)
            if not hmac.compare_digest(AuthenticatedRemoteScript._bounded_canonical(current_authority), expected_canonical): raise ValueError("realtime parameter identity changed before arming")
            parameter_authorities[reference] = expected_canonical
        token = secrets.token_urlsafe(24)
        expires = time.time() + ttl_ms / 1000.0
        with self._lock:
            self._generation += 1
            self._armed = (token, expires, tuple(channels), frozenset(source_ports), parameter_authorities)
            self._last_sequence = 0
            self._tokens = float(REALTIME_RATE_BURST)
            self._refill_at = time.monotonic()
            self._last_arrival_ms = None
            self._last_interval_ms = None
            self._last_transit_ms = None
            self._jitter_ms = 0.0
            self._max_jitter_ms = 0.0
        return {"host": self.host, "port": self.port, "token": token, "expiresAt": int(expires * 1000), "channels": list(channels), "parameterRefs": list(parameter_refs), "packetLimitBytes": REALTIME_MAX_DATAGRAM, "ratePerSecond": int(REALTIME_RATE_PER_SECOND), "burst": REALTIME_RATE_BURST}

    def disarm(self) -> dict[str, Any]:
        with self._lock:
            self._generation += 1
            self._armed = None
            self._last_sequence = 0
        return {"armed": False}

    def stats(self) -> dict[str, Any]:
        with self._lock:
            armed = self._armed_now_locked() is not None
            return {
                "armed": armed,
                "accepted": self.accepted,
                "applied": self.applied,
                "applyFailures": self.apply_failures,
                "pending": max(0, self.accepted - self.applied - self.apply_failures - self.dropped_before_dispatch),
                "droppedUnarmed": self.dropped_unarmed,
                "droppedEndpoint": self.dropped_endpoint,
                "droppedTarget": self.dropped_target,
                "droppedInvalid": self.dropped_invalid,
                "droppedReplay": self.dropped_replay,
                "droppedRateLimited": self.dropped_rate_limited,
                "droppedQueueFull": self.dropped_queue_full,
                "droppedBeforeDispatch": self.dropped_before_dispatch,
                "revokedBeforeApply": self.revoked_before_apply,
                "sequenceGaps": self.sequence_gaps,
                "lastSequence": self._last_sequence,
                "jitterMs": round(self._jitter_ms, 6),
                "maxJitterMs": round(self._max_jitter_ms, 6),
            }

    def close(self) -> None:
        self._stop.set()
        with self._lock:
            self._generation += 1
            self._armed = None
        if self._socket is not None:
            try:
                self._socket.close()
            except OSError:
                pass
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=1)

    def _recv_loop(self) -> None:
        assert self._socket is not None
        while not self._stop.is_set():
            try:
                # Read one byte beyond the contract so oversized datagrams are
                # distinguishable from exactly-full datagrams.
                data, address = self._socket.recvfrom(REALTIME_MAX_DATAGRAM + 1)
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                self._handle(data, address)
            except BaseException:
                # Never let a malformed or failing datagram kill the ingress.
                with self._lock:
                    self.dropped_invalid += 1
                _debug_trace("realtime-packet-failure")

    def _decode(self, data: bytes) -> dict[str, Any]:
        if len(data) > REALTIME_MAX_DATAGRAM:
            raise ValueError("realtime datagram exceeds packet bound")
        if data.lstrip().startswith(b"{"):
            try:
                message = json.loads(data.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError("realtime JSON is invalid") from error
            if not isinstance(message, dict) or set(message) - _REALTIME_JSON_KEYS:
                raise ValueError("realtime JSON shape is invalid")
            return message
        return _decode_osc(data)

    @staticmethod
    def _valid_number(value: Any) -> bool:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))

    def _validate_message(self, message: dict[str, Any]) -> tuple[str, int, str, str]:
        token, sequence, channel, operation = message.get("token"), message.get("seq"), message.get("channel"), message.get("op")
        if not isinstance(token, str) or not 16 <= len(token) <= 128:
            raise ValueError("realtime token is invalid")
        if not isinstance(sequence, int) or isinstance(sequence, bool) or not 1 <= sequence <= 2**53 - 1:
            raise ValueError("realtime sequence is invalid")
        if not isinstance(channel, str) or channel not in REALTIME_CHANNELS or not isinstance(operation, str):
            raise ValueError("realtime channel or operation is invalid")
        sent_at = message.get("sentAtMs")
        if sent_at is not None and (not self._valid_number(sent_at) or not 0 <= float(sent_at) <= 2**53 - 1):
            raise ValueError("realtime sentAtMs is invalid")
        base_keys = {"token", "seq", "channel", "op", "sentAtMs"}
        if operation == "parameter.set":
            if set(message) - (base_keys | {"ref", "value"}) or channel not in {"udp-json", "osc", "max"} or not isinstance(message.get("ref"), str) or not 1 <= len(message["ref"]) <= 256 or not self._valid_number(message.get("value")):
                raise ValueError("realtime parameter packet is invalid")
        elif operation == "xy.set":
            if set(message) - (base_keys | {"xRef", "x", "yRef", "y"}) or channel not in {"xy", "osc", "max"} or not isinstance(message.get("xRef"), str) or not isinstance(message.get("yRef"), str) or not 1 <= len(message["xRef"]) <= 256 or not 1 <= len(message["yRef"]) <= 256 or message["xRef"] == message["yRef"] or not self._valid_number(message.get("x")) or not self._valid_number(message.get("y")):
                raise ValueError("realtime XY packet is invalid")
        elif operation == "emergency-stop":
            if set(message) - base_keys:
                raise ValueError("realtime emergency packet is invalid")
        else:
            raise ValueError("realtime operation is unavailable")
        return token, sequence, channel, operation

    def _take_token_locked(self) -> bool:
        now = time.monotonic()
        elapsed = now - self._refill_at
        self._refill_at = now
        self._tokens = min(float(REALTIME_RATE_BURST), self._tokens + elapsed * REALTIME_RATE_PER_SECOND)
        if self._tokens < 1.0:
            return False
        self._tokens -= 1.0
        return True

    def _measure_jitter_locked(self, message: dict[str, Any], arrival_ms: float) -> None:
        sent_at = message.get("sentAtMs")
        variation: float | None = None
        if self._valid_number(sent_at):
            transit = arrival_ms - float(sent_at)
            if self._last_transit_ms is not None:
                variation = abs(transit - self._last_transit_ms)
            self._last_transit_ms = transit
        elif self._last_arrival_ms is not None:
            interval = arrival_ms - self._last_arrival_ms
            if self._last_interval_ms is not None:
                variation = abs(interval - self._last_interval_ms)
            self._last_interval_ms = interval
        self._last_arrival_ms = arrival_ms
        if variation is not None and math.isfinite(variation):
            variation = min(60000.0, variation)
            self._jitter_ms += (variation - self._jitter_ms) / 16.0
            self._max_jitter_ms = max(self._max_jitter_ms, variation)

    def _increment(self, field: str) -> None:
        with self._lock:
            setattr(self, field, getattr(self, field) + 1)

    def _handle(self, data: bytes, address: tuple[Any, ...] | None = None) -> None:
        try:
            message = self._decode(data)
            token, sequence, channel, operation = self._validate_message(message)
        except ValueError:
            self._increment("dropped_invalid")
            return
        address = address or (self.host, 0)
        arrival_ms = time.time() * 1000.0
        with self._lock:
            armed = self._armed_now_locked()
            if armed is None:
                self.dropped_unarmed += 1
                return
            expected_token, _, channels, source_ports, parameter_authorities = armed
            source_host = str(address[0]) if address else ""
            source_port = address[1] if len(address) > 1 else 0
            if source_host != self.host or (source_ports and source_port not in source_ports):
                self.dropped_endpoint += 1
                return
            if not hmac.compare_digest(token, expected_token) or channel not in channels:
                self.dropped_unarmed += 1
                return
            targets = {str(message["ref"])} if operation == "parameter.set" else ({str(message["xRef"]), str(message["yRef"])} if operation == "xy.set" else set())
            if not targets <= set(parameter_authorities):
                self.dropped_target += 1
                return
            if sequence <= self._last_sequence:
                self.dropped_replay += 1
                return
            if sequence > self._last_sequence + 1:
                self.sequence_gaps += sequence - self._last_sequence - 1
            self._last_sequence = sequence
            self._measure_jitter_locked(message, arrival_ms)
            if not self._take_token_locked():
                self.dropped_rate_limited += 1
                return
            generation = self._generation
        if operation == "emergency-stop":
            callback = self._realtime_emergency_stop
        elif operation == "parameter.set":
            reference = str(message["ref"]); expected_authority = parameter_authorities[reference]
            callback = lambda: self._realtime_parameter_set(reference, float(message["value"]), expected_authority)
        else:
            x_reference, y_reference = str(message["xRef"]), str(message["yRef"])
            x_authority, y_authority = parameter_authorities[x_reference], parameter_authorities[y_reference]
            callback = lambda: self._realtime_xy_set(x_reference, float(message["x"]), y_reference, float(message["y"]), x_authority, y_authority)
        try:
            queued = self._bridge.queue.submit_nowait(self._tracked_callback(callback, generation), deadline_ms=int(time.time() * 1000) + 1000, on_cancel=lambda _: self._increment("dropped_before_dispatch"))
        except BaseException:
            self._increment("dropped_before_dispatch")
            return
        if queued:
            self._increment("accepted")
        else:
            self._increment("dropped_queue_full")

    def _tracked_callback(self, callback: Callable[[], Any], generation: int) -> Callable[[], Any]:
        def tracked() -> Any:
            # Keep authority check + Live-thread mutation atomic with respect to
            # expiry, disarm, and re-arm generation changes.
            with self._lock:
                if self._armed_now_locked() is None or generation != self._generation:
                    self.revoked_before_apply += 1
                    self.apply_failures += 1
                    raise ValueError("realtime authority expired or was revoked before apply")
                try:
                    result = callback()
                except _RealtimeAuthorityChanged:
                    self._armed = None; self._generation += 1; self.revoked_before_apply += 1; self.apply_failures += 1
                    raise
                except BaseException:
                    self.apply_failures += 1
                    raise
                self.applied += 1
                return result
        return tracked

    def _realtime_emergency_stop(self) -> dict[str, Any]:
        mapper = self._bridge.mapper
        playback = mapper._playback(); expected = [mapper._target_key(target) for target in mapper._active_targets(playback)]
        session_record, arrangement_record = playback["transport"].get("sessionRecord") is True, playback["transport"].get("arrangementRecord") is True
        expected_recording = "both" if session_record and arrangement_record else "session" if session_record else "arrangement" if arrangement_record else "stopped"
        return mapper._guarded_emergency_stop({"expectedTargets": expected, "expectedRecording": expected_recording})

    def _parameter_target(self, reference: str, value: float, expected_authority: str) -> tuple[Any, float]:
        mapper = self._bridge.mapper
        try: current_authority = AuthenticatedRemoteScript._bounded_canonical(mapper._realtime_parameter_authority(reference))
        except (KeyError, ValueError) as error: raise _RealtimeAuthorityChanged("realtime parameter hierarchy changed after arming") from error
        if not hmac.compare_digest(current_authority, expected_authority): raise _RealtimeAuthorityChanged("realtime parameter hierarchy changed after arming")
        parameter = mapper._resolve_parameter(reference)
        current = mapper._read_attr(parameter, "value")
        minimum = mapper._read_attr(parameter, "min", "min_value")
        maximum = mapper._read_attr(parameter, "max", "max_value")
        enabled = mapper._read_attr(parameter, "is_enabled", "enabled")
        quantization = mapper._read_attr(parameter, "quantized_step_size", "quantization")
        if not self._valid_number(current) or not self._valid_number(minimum) or not self._valid_number(maximum) or float(minimum) > float(maximum):
            raise ValueError("realtime parameter bounds are unavailable")
        if enabled is False or not float(minimum) <= value <= float(maximum):
            raise ValueError("realtime parameter is disabled or outside bounds")
        if self._valid_number(quantization) and float(quantization) > 0:
            steps = (value - float(minimum)) / float(quantization)
            if abs(steps - round(steps)) > 1e-6:
                raise ValueError("realtime parameter value violates quantization")
        return parameter, float(current)

    @staticmethod
    def _verify_parameter(parameter: Any, expected: float) -> None:
        observed = getattr(parameter, "value", None)
        if not isinstance(observed, (int, float)) or isinstance(observed, bool) or not math.isfinite(float(observed)) or float(observed) != expected:
            raise ValueError("realtime parameter write was not confirmed")

    def _realtime_parameter_set(self, reference: str, value: float, expected_authority: str) -> None:
        parameter, prior = self._parameter_target(reference, value, expected_authority)
        try:
            parameter.value = value
            self._verify_parameter(parameter, value)
        except BaseException as error:
            try: parameter.value = prior
            except BaseException: pass
            try: self._verify_parameter(parameter, prior)
            except BaseException as rollback_error: raise ValueError("realtime parameter write failed and exact rollback failed") from rollback_error
            raise error

    def _realtime_xy_set(self, x_reference: str, x: float, y_reference: str, y: float, x_authority: str, y_authority: str) -> None:
        x_parameter, x_prior = self._parameter_target(x_reference, x, x_authority)
        y_parameter, y_prior = self._parameter_target(y_reference, y, y_authority)
        try:
            x_parameter.value = x
            y_parameter.value = y
            self._verify_parameter(x_parameter, x)
            self._verify_parameter(y_parameter, y)
        except BaseException as error:
            try: x_parameter.value = x_prior
            except BaseException: pass
            try: y_parameter.value = y_prior
            except BaseException: pass
            rollback_failed = False
            try: self._verify_parameter(x_parameter, x_prior)
            except BaseException: rollback_failed = True
            try: self._verify_parameter(y_parameter, y_prior)
            except BaseException: rollback_failed = True
            if rollback_failed: raise ValueError("realtime XY write failed and exact rollback failed") from error
            raise error


class _DispatchToken:
    def __init__(self, deadline_ms: int):
        self.deadline_ms = deadline_ms
        self.state = "queued"
        self._lock = threading.Lock()

    def claim(self) -> bool:
        with self._lock:
            if self.state != "queued" or int(time.time() * 1000) >= self.deadline_ms:
                if self.state == "queued": self.state = "cancelled"
                return False
            self.state = "running"
            return True

    def cancel(self) -> bool:
        with self._lock:
            if self.state == "queued":
                self.state = "cancelled"
                return True
            return False

    def complete(self) -> None:
        with self._lock:
            if self.state == "running": self.state = "completed"


class _MainThreadQueue:
    def __init__(self) -> None:
        self.items: queue.Queue[tuple[Callable[[], Any], threading.Event, list[Any], _DispatchToken, Callable[[BaseException], None] | None]] = queue.Queue(MAX_QUEUE_ITEMS)
        self._closed = False
        self._lock = threading.Lock()

    def submit(self, callback: Callable[[], Any], timeout: float = DEFAULT_TIMEOUT_SECONDS, deadline_ms: int | None = None) -> Any:
        now_ms = int(time.time() * 1000)
        deadline_ms = deadline_ms if isinstance(deadline_ms, int) and not isinstance(deadline_ms, bool) else now_ms + int(timeout * 1000)
        if deadline_ms <= now_ms or deadline_ms > now_ms + 60000: raise TimeoutError("Live main-thread operation deadline expired")
        event = threading.Event()
        result: list[Any] = []
        token = _DispatchToken(deadline_ms)
        with self._lock:
            if self._closed: raise RuntimeError("Live bridge is disconnected")
            self.items.put_nowait((callback, event, result, token, None))
        wait_seconds = max(0.0, min(timeout, (deadline_ms - int(time.time() * 1000)) / 1000.0))
        if not event.wait(wait_seconds):
            if token.cancel(): raise TimeoutError("Live main-thread operation timed out before dispatch")
            raise RuntimeError("Live main-thread operation state uncertain after dispatch")
        if result and isinstance(result[0], BaseException): raise result[0]
        return result[0] if result else None

    def submit_nowait(self, callback: Callable[[], Any], deadline_ms: int, on_cancel: Callable[[BaseException], None] | None = None) -> bool:
        now_ms = int(time.time() * 1000)
        if not isinstance(deadline_ms, int) or isinstance(deadline_ms, bool) or deadline_ms <= now_ms or deadline_ms > now_ms + 60000:
            return False
        event = threading.Event()
        result: list[Any] = []
        token = _DispatchToken(deadline_ms)
        with self._lock:
            if self._closed:
                return False
            try:
                self.items.put_nowait((callback, event, result, token, on_cancel))
            except queue.Full:
                return False
        return True

    @staticmethod
    def _notify_cancel(callback: Callable[[BaseException], None] | None, error: BaseException) -> None:
        if callback is not None:
            try: callback(error)
            except BaseException: pass

    def close(self) -> None:
        with self._lock:
            self._closed = True
            while True:
                try: _, event, result, token, on_cancel = self.items.get_nowait()
                except queue.Empty: break
                error = RuntimeError("Live bridge is disconnected")
                token.cancel(); result.append(error); event.set()
                self._notify_cancel(on_cancel, error)

    def drain(self, budget: int = MAX_QUEUE_ITEMS) -> int:
        count = 0
        while count < budget:
            try: callback, event, result, token, on_cancel = self.items.get_nowait()
            except queue.Empty: break
            if not token.claim():
                error = TimeoutError("Live main-thread operation timed out before dispatch")
                result.append(error); event.set(); self._notify_cancel(on_cancel, error)
                count += 1; continue
            try: result.append(callback())
            except BaseException as exc: result.append(exc)
            finally: token.complete(); event.set()
            count += 1
        return count


def _authority_state_digest(mapper: LiveObjectMapper, args: dict[str, Any], operation: str | None = None) -> str:
    if operation in {"audio.capture.stop", "audio.capture.emergency-stop"}:
        # Stop authority must survive the capture watchdog winning the race
        # between prepare and invoke. Bind the exact lifecycle identity while
        # deliberately excluding active/stopped playback state and late clip
        # ownership discovery; the stop operation rechecks its token or exact
        # emergency observation on the Live thread.
        state = mapper._capture_state
        capture = None if state is None else {
            "captureId": state.get("captureId"), "startedAt": state.get("startedAt"),
            "sourceSlotRef": state.get("sourceSlotRef"), "destinationSlotRef": state.get("destinationSlotRef"),
            "destinationTrackRef": state.get("destinationTrackRef"),
        }
        identity = {"epoch": mapper.refs.epoch, "capture": capture}
        return hashlib.sha256(AuthenticatedRemoteScript._bounded_canonical(identity).encode("utf-8")).hexdigest()
    if operation == "audio.capture.cleanup":
        # Recovery authority is bound to the exact mapper-owned capture, not
        # unrelated Set state or native clip metadata that can finalize after
        # recording stops. Cleanup itself repeats these identity/stopped-state
        # checks atomically immediately before deleting the owned clip.
        state = mapper._capture_state
        expected_ref = args.get("expectedClipRef")
        reference_revision = None
        if isinstance(expected_ref, str):
            try: reference_revision = mapper.refs.revision(expected_ref)
            except (KeyError, ValueError): pass
        capture = None
        if state is not None:
            slot = state.get("_destinationSlot")
            clip = getattr(slot, "clip", None) if slot is not None else None
            owned_identity = state.get("_ownedClipIdentity")
            status = mapper._capture_status()
            capture = {
                "captureId": state.get("captureId"), "state": state.get("state"),
                "sourceSlotRef": state.get("sourceSlotRef"), "destinationSlotRef": state.get("destinationSlotRef"),
                "clipRef": state.get("clipRef"), "expectedClipRef": expected_ref,
                "referenceRevision": reference_revision,
                "ownedIdentityDigest": hashlib.sha256(str(owned_identity).encode("utf-8")).hexdigest() if isinstance(owned_identity, str) else None,
                "ownedClipMatches": clip is not None and isinstance(owned_identity, str) and mapper._capture_same_object(clip, state.get("_ownedClip"), owned_identity),
                "playbackStopped": status.get("playbackStopped"), "active": status.get("active"),
                "residual": status.get("residual", []),
            }
        identity = {"epoch": mapper.refs.epoch, "capture": capture}
        return hashlib.sha256(AuthenticatedRemoteScript._bounded_canonical(identity).encode("utf-8")).hexdigest()
    references: list[str] = []
    def collect(value: Any, key: str = "") -> None:
        if isinstance(value, dict):
            for child_key, child in value.items(): collect(child, child_key)
        elif isinstance(value, list):
            for child in value: collect(child, key)
        elif isinstance(value, str) and (key == "ref" or key.endswith("Ref") or key.endswith("Refs")):
            references.append(value)
    collect(args)
    observed = []
    attributes = ("name", "value", "min", "max", "is_enabled", "is_automatable", "arm", "mute", "solo", "current_monitoring_state", "input_routing_type", "input_routing_channel", "output_routing_type", "output_routing_channel", "gain", "pitch_coarse", "pitch_fine", "warping", "warp_mode", "fade_in_length", "fade_out_length", "loop_start", "loop_end", "start_time", "length", "is_playing", "is_triggered", "is_recording")
    for reference in sorted(set(references)):
        try:
            revision = mapper.refs.revision(reference); row = mapper.get(reference)
            if row is None:
                obj = mapper.refs.get(reference)
                if isinstance(obj, dict): row = {key: value for key, value in obj.items() if isinstance(value, (str, int, float, bool, type(None)))}
                else: row = {attribute: mapper._read_attr(obj, attribute) for attribute in attributes if isinstance(mapper._read_attr(obj, attribute), (str, int, float, bool, type(None)))}
            observed.append([reference, revision, row])
        except (KeyError, ValueError, StopIteration): observed.append([reference, None, None])
    playback = mapper._playback()
    playback_transport = dict(playback.get("transport", {})); playback_transport.pop("position", None)
    playback = {**playback, "transport": playback_transport}
    song_state = {key: mapper._read_attr(mapper.song, key) for key in ("tempo", "loop", "loop_start", "loop_length", "is_playing", "record_mode", "session_record")}
    locator_items = mapper._locator_items(); arrangement_items = mapper._arrangement_clip_items()
    if len(locator_items) > 256 or len(arrangement_items) > 256: raise ValueError("mutation authority collection exceeds its complete-state bound")
    locators = [{key: row.get(key) for key in ("ref", "name", "position")} for row in locator_items]
    arrangement = [{key: row.get(key) for key in ("ref", "trackRef", "name", "start", "length")} for row in arrangement_items]
    identity = {"epoch": mapper.refs.epoch, "structure": mapper._structure_revision(), "song": song_state, "playback": playback, "locators": locators, "arrangement": arrangement, "references": observed}
    return hashlib.sha256(AuthenticatedRemoteScript._bounded_canonical(identity).encode("utf-8")).hexdigest()


class AbletonMcpBridge:
    """Installable Control Surface boundary with fail-closed loopback listener."""

    def __init__(self, c_instance: Any, config: dict[str, Any] | None = None, song: Any = None, provenance: str = "fake-live", diagnostics_validator: Callable[[Path], bool] | None = None):
        config = config or {}
        host = config.get("host", "")
        port = config.get("port", 0)
        secret = config.get("secret", "")
        realtime_port = config.get("realtimePort")
        diagnostics = config.get("diagnostics")
        if host not in {"127.0.0.1", "::1"} or not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535 or not isinstance(secret, str) or len(secret) < 32:
            raise ValueError("explicit loopback host, port, and strong secret are required")
        if realtime_port is not None and (not isinstance(realtime_port, int) or isinstance(realtime_port, bool) or not 1 <= realtime_port <= 65535 or realtime_port == port):
            raise ValueError("realtime port must be distinct and between 1 and 65535")
        self.c_instance = c_instance
        self.queue = _MainThreadQueue()
        if song is None:
            candidate = getattr(c_instance, "song", None)
            # Live versions differ: c_instance.song may be the Song object or a
            # zero-argument accessor. Resolve only the accessor form.
            song = candidate() if callable(candidate) else candidate
        self.mapper = LiveObjectMapper(song, provenance=provenance)
        self._bridge_epoch = secrets.token_urlsafe(24)
        self.auth = AuthenticatedRemoteScript(secret, self._dispatch, self._bridge_epoch, "internal-bridge-channel")
        self._server = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind((host, port))
        self._server.listen(4)
        self.address = self._server.getsockname()
        try:
            self._realtime = _RealtimePlane(self, host, int(realtime_port or 0))
        except BaseException:
            self._server.close()
            self.queue.close()
            raise
        self.mapper.realtime_available = self._realtime.port > 0
        self._diagnostics = _DiagnosticsSink(str(diagnostics.get("path")), diagnostics.get("maxBytes"), security_validator=diagnostics_validator) if isinstance(diagnostics, dict) and set(diagnostics) == {"path", "maxBytes"} else None
        _set_diagnostics_sink(self._diagnostics if self._diagnostics is not None and self._diagnostics.enabled else None)
        self._stop = threading.Event()
        self._clients: set[socket.socket] = set()
        self._workers: set[threading.Thread] = set()
        self._secret_value = secret
        self._executed_mutations: dict[str, dict[str, Any]] = {}
        self._pending_mutations: dict[str, dict[str, Any]] = {}
        self._retired_mutation_keys: dict[str, int] = {}
        self._finalized_transactions: set[str] = set()
        self._executed_lock = threading.Lock()
        self._thread = threading.Thread(target=self._accept, name="AbletonMcpBridge", daemon=True)
        self._thread.start()

    def _dispatch(self, method: str, request: dict[str, Any]) -> Any:
        if method == "invoke" and request.get("operation") == "realtime.stats":
            return self._realtime_op(str(request["operation"]), dict(request.get("args", {})))
        if method == "invoke" and request.get("operation") in {"realtime.arm", "realtime.disarm"}:
            return self.queue.submit(lambda: self._realtime_op(str(request["operation"]), dict(request.get("args", {}))), deadline_ms=request.get("deadlineMs"))
        return self.queue.submit(lambda: self._dispatch_main(method, request), deadline_ms=request.get("deadlineMs"))

    def _dispatch_main(self, method: str, request: dict[str, Any]) -> Any:
        return self._dispatch_main_for(method, request, self.mapper)

    @staticmethod
    def _dispatch_main_for(method: str, request: dict[str, Any], mapper: LiveObjectMapper) -> Any:
        if method == "status": return mapper.status()
        if method == "snapshot": return mapper.snapshot()
        if method == "discover":
            args = dict(request.get("args", {}))
            if args.get("kind") == "session_playback": return mapper._playback()
            return mapper.discover(args.get("kind", "track"), args.get("limit", 100), args.get("cursor"), args.get("parent"), args.get("filters"), args.get("requestedFields"), args.get("traversalBudget", 1000))
        if method == "get": return mapper.get(str(request.get("ref")))
        if method == "reconnect": return mapper.invoke("session.reconnect", {})
        if method == "invoke": return mapper.invoke(str(request.get("operation")), dict(request.get("args", {})))
        raise ValueError("operation unavailable")

    def drain_main_thread(self) -> int:
        return self.queue.drain()

    def update_display(self) -> None:
        """Control Surface callback: execute queued Live work on Live's thread."""
        self.queue.drain()
        self.mapper.capture_tick()

    def _accept(self) -> None:
        self._server.settimeout(0.2)
        while not self._stop.is_set():
            try: client, _ = self._server.accept()
            except (socket.timeout, OSError): continue
            self._clients.add(client)
            worker = threading.Thread(target=self._client, args=(client,), daemon=True)
            self._workers.add(worker)
            worker.start()

    def _subscribe_main(self, request: dict[str, Any], holder: dict[str, Any]) -> Any:
        args = request.get("args", {})
        types = args.get("types") if isinstance(args, dict) else None
        existing = holder.get("subscription")
        if existing is not None:
            existing.close()
            holder["subscription"] = None
        supported = _supported_event_types(self.mapper.song)
        if types is None:
            types = sorted(supported)
        if not isinstance(types, list) or len(types) > 3 or len(set(types)) != len(types) or any(not isinstance(item, str) or item not in supported for item in types):
            raise ValueError("subscription types are invalid or unavailable on this Live shape")
        if not types:
            return {"subscribed": False, "subscriptionId": "none"}
        holder["subscription"] = _Subscription(self.mapper, set(types))
        return {"subscribed": True, "subscriptionId": secrets.token_urlsafe(12)}

    def _dispatch_with_holder(self, method: str, request: dict[str, Any], holder: dict[str, Any]) -> Any:
        if method == "subscribe":
            return self.queue.submit(lambda: self._subscribe_main(request, holder), deadline_ms=request.get("deadlineMs"))
        if method == "preflight":
            def preflight() -> dict[str, Any]:
                operation = str(request["operation"]); args = dict(request.get("args", {})); transaction_id = request.get("transactionId"); ownership_token = request.get("ownershipToken"); now = int(time.time() * 1000); preflights = holder.setdefault("preflights", {})
                if not isinstance(transaction_id, str) or not 8 <= len(transaction_id) <= 128: raise ValueError("mutation transaction identity is required")
                if operation in _TRANSACTION_DELETIONS: self.mapper._require_cleanup_ownership(operation, args, transaction_id, ownership_token)
                for key, row in list(preflights.items()):
                    if row["expiresAt"] <= now: preflights.pop(key, None)
                if len(preflights) >= 64: raise ValueError("too many pending mutation preflights")
                args_digest = hashlib.sha256(AuthenticatedRemoteScript._bounded_canonical(args).encode("utf-8")).hexdigest(); state_digest = _authority_state_digest(self.mapper, args, operation)
                token = secrets.token_urlsafe(24); confirmation = secrets.token_urlsafe(24); expires_at = now + 10000
                preflights[token] = {"operation": operation, "argsDigest": args_digest, "stateDigest": state_digest, "confirmation": confirmation, "transactionId": transaction_id, "ownershipToken": ownership_token, "expiresAt": expires_at}
                return {"preflightToken": token, "confirmation": confirmation, "operation": operation, "argsDigest": args_digest, "stateDigest": state_digest, "impact": "mutates-live", "expiresAt": expires_at}
            return self.queue.submit(preflight, deadline_ms=request.get("deadlineMs"))
        if method == "prepare":
            def prepare() -> dict[str, Any]:
                operation = str(request["operation"]); args = dict(request.get("args", {})); transaction_id = request.get("transactionId"); ownership_token = request.get("ownershipToken"); now = int(time.time() * 1000); preflight_token = str(request["preflightToken"])
                if not isinstance(transaction_id, str) or not 8 <= len(transaction_id) <= 128: raise ValueError("mutation transaction identity is required")
                preflight_row = holder.setdefault("preflights", {}).pop(preflight_token, None); authorities = holder.setdefault("authorities", {})
                for key, row in list(authorities.items()):
                    if row["expiresAt"] <= now: authorities.pop(key, None)
                args_digest = hashlib.sha256(AuthenticatedRemoteScript._bounded_canonical(args).encode("utf-8")).hexdigest(); state_digest = _authority_state_digest(self.mapper, args, operation)
                if preflight_row is None or preflight_row["expiresAt"] <= now or preflight_row["operation"] != operation or preflight_row["argsDigest"] != args_digest or preflight_row["stateDigest"] != state_digest or preflight_row["transactionId"] != transaction_id or preflight_row.get("ownershipToken") != ownership_token or not hmac.compare_digest(preflight_row["confirmation"], str(request["confirmation"])):
                    raise ValueError("missing, expired, stale, or mismatched mutation preflight")
                if len(authorities) >= 64: raise ValueError("too many pending mutation authorities")
                token = secrets.token_urlsafe(24); expires_at = now + 10000
                authorities[token] = {"operation": operation, "argsDigest": args_digest, "stateDigest": state_digest, "transactionId": transaction_id, "ownershipToken": ownership_token, "expiresAt": expires_at, "idempotencyKey": request["idempotencyKey"]}
                return {"authorityToken": token, "operation": operation, "argsDigest": args_digest, "stateDigest": state_digest, "expiresAt": expires_at}
            return self.queue.submit(prepare, deadline_ms=request.get("deadlineMs"))
        if method == "invoke" and _mutation_authority_required(str(request.get("operation"))):
            token = str(request.get("authorityToken", "")); authority = holder.setdefault("authorities", {}).pop(token, None); now = int(time.time() * 1000)
            args = dict(request.get("args", {})); digest = hashlib.sha256(AuthenticatedRemoteScript._bounded_canonical(args).encode("utf-8")).hexdigest()
            transaction_id = request.get("transactionId")
            if authority is None or authority["expiresAt"] <= now or authority["operation"] != request.get("operation") or authority["argsDigest"] != digest or authority["transactionId"] != transaction_id or authority.get("ownershipToken") != request.get("ownershipToken"):
                raise ValueError("missing, expired, or mismatched mutation authority")
            if not isinstance(transaction_id, str): raise ValueError("mutation transaction identity is required")
            idempotency_key = authority["idempotencyKey"]
            with self._executed_lock:
                retired = getattr(self, "_retired_mutation_keys", None)
                if retired is None: retired = self._retired_mutation_keys = {}
                pending = getattr(self, "_pending_mutations", None)
                if pending is None: pending = self._pending_mutations = {}
                for key, expires_at in list(retired.items()):
                    if expires_at <= now: retired.pop(key, None)
                for key, row in list(pending.items()):
                    if row["expiresAt"] <= now: pending.pop(key, None)
                finalized = getattr(self, "_finalized_transactions", set())
                if transaction_id in finalized: raise ValueError("transaction recovery authority has been terminally finalized")
                if idempotency_key in retired: raise ValueError("mutation replay authority has been retired")
                prior_pending = pending.get(idempotency_key)
                if prior_pending is not None and (prior_pending["transactionId"] != transaction_id or prior_pending["operation"] != request.get("operation") or prior_pending["argsDigest"] != digest): raise ValueError("idempotency key conflicts with a pending mutation")
                if prior_pending is None:
                    if len(pending) >= 256: raise ValueError("pending mutation ledger is full")
                    pending[idempotency_key] = {"transactionId": transaction_id, "operation": request.get("operation"), "argsDigest": digest, "count": 1, "expiresAt": int(request.get("deadlineMs", now + 60000))}
                else:
                    prior_pending["count"] += 1; prior_pending["expiresAt"] = max(prior_pending["expiresAt"], int(request.get("deadlineMs", now + 60000)))
            def replay_or_apply(apply: Callable[[], Any]) -> Any:
                with self._executed_lock:
                    retired = getattr(self, "_retired_mutation_keys", {}); finalized = getattr(self, "_finalized_transactions", set())
                    if transaction_id in finalized: raise ValueError("transaction recovery authority has been terminally finalized")
                    if idempotency_key in retired: raise ValueError("mutation replay authority has been retired")
                    prior = self._executed_mutations.get(idempotency_key)
                    if prior is not None:
                        if prior["operation"] != request.get("operation") or prior["argsDigest"] != digest or prior.get("transactionId") != transaction_id: raise ValueError("idempotency key conflicts with an executed mutation")
                        return prior["result"]
                    if len(self._executed_mutations) >= 256: raise ValueError("executed mutation ledger is full; reconnect after authoritative recovery")
                    result = apply(); self._executed_mutations[idempotency_key] = {"operation": request["operation"], "argsDigest": digest, "transactionId": transaction_id, "result": result}; return result
            def invoke_authorized() -> Any:
                try:
                    operation = str(request["operation"])
                    if _authority_state_digest(self.mapper, args, operation) != authority["stateDigest"]: raise ValueError("Live state changed after mutation authority preparation")
                    if operation in {"realtime.arm", "realtime.disarm"}: return replay_or_apply(lambda: self._realtime_op(operation, args))
                    return replay_or_apply(lambda: self.mapper.invoke(operation, args, transaction_id, request.get("ownershipToken")))
                finally:
                    with self._executed_lock:
                        pending = getattr(self, "_pending_mutations", {}); row = pending.get(idempotency_key)
                        if row is not None and row.get("transactionId") == transaction_id and row.get("operation") == request.get("operation") and row.get("argsDigest") == digest:
                            row["count"] -= 1
                            if row["count"] <= 0: pending.pop(idempotency_key, None)
            return self.queue.submit(invoke_authorized, deadline_ms=request.get("deadlineMs"))
        if method == "invoke" and request.get("operation") == "realtime.stats":
            return self._realtime_op(request["operation"], request.get("args", {}))
        if method == "retire":
            transaction_id = str(request["transactionId"])
            def retire() -> dict[str, int]:
                # The Live-thread queue is also the transaction-ledger barrier:
                # retirement must run after every earlier accepted mutation so
                # a disconnected callback cannot apply after authority retires.
                terminal = request.get("terminal") is True
                if terminal:
                    playback = self.mapper._playback(); transport = playback.get("transport", {}); realtime = self._realtime.stats()
                    if transport.get("playing") is not False or transport.get("arrangementRecord") is not False or transport.get("sessionRecord") is not False or playback.get("firedTargets") or playback.get("playingTargets") or realtime.get("armed") is not False or realtime.get("pending") != 0: raise ValueError("terminal recovery finalization requires stopped playback, recording, and realtime authority")
                with self._executed_lock:
                    now = int(time.time() * 1000); retired = getattr(self, "_retired_mutation_keys", None)
                    if retired is None: retired = self._retired_mutation_keys = {}
                    pending = getattr(self, "_pending_mutations", None)
                    if pending is None: pending = self._pending_mutations = {}
                    for key, expires_at in list(retired.items()):
                        if expires_at <= now: retired.pop(key, None)
                    for key, row in list(pending.items()):
                        if row["expiresAt"] <= now: pending.pop(key, None)
                    keys = [key for key, row in self._executed_mutations.items() if row.get("transactionId") == transaction_id]
                    pending_keys = [key for key, row in pending.items() if row.get("transactionId") == transaction_id]
                    retiring = set(keys + pending_keys)
                    if len(set(retired).union(retiring)) > 4096: raise ValueError("retired mutation ledger is full; reconnect after authoritative recovery")
                    finalized = getattr(self, "_finalized_transactions", None)
                    if finalized is None: finalized = self._finalized_transactions = set()
                    if terminal and transaction_id not in finalized and len(finalized) >= 4096: raise ValueError("finalized transaction ledger is full; reconnect after authoritative recovery")
                    for key in keys: self._executed_mutations.pop(key, None)
                    for key in retiring: retired[key] = now + 60000
                    if terminal: finalized.add(transaction_id)
                    if getattr(self, "mapper", None) is not None: self.mapper.retire_transaction_ownership(transaction_id, terminal)
                return {"retired": len(keys)}
            return self.queue.submit(retire, deadline_ms=request.get("deadlineMs"))
        if method == "reconnect":
            def reconnect() -> Any:
                result = self._dispatch_main_for(method, request, self.mapper)
                with self._executed_lock: self._executed_mutations.clear(); self._pending_mutations.clear(); self._retired_mutation_keys.clear(); self._finalized_transactions.clear()
                return result
            return self.queue.submit(reconnect, deadline_ms=request.get("deadlineMs"))
        return self.queue.submit(lambda: self._dispatch_main_for(method, request, self.mapper), deadline_ms=request.get("deadlineMs"))

    def _realtime_op(self, operation: str, args: dict[str, Any]) -> Any:
        if operation == "realtime.arm":
            _require_output_safety(args)
            return self._realtime.arm(args.get("ttlMs", 30000), args.get("channels"), args.get("parameterRefs"), args.get("sourcePorts"), args.get("targetAuthorities"))
        if operation == "realtime.disarm":
            return self._realtime.disarm()
        return self._realtime.stats()

    def _client(self, client: socket.socket) -> None:
        client.settimeout(0.2); buffer = b""
        challenge = secrets.token_urlsafe(24)
        holder: dict[str, Any] = {"subscription": None}
        auth = AuthenticatedRemoteScript(self._secret_value, lambda method, request: self._dispatch_with_holder(method, request, holder), self._bridge_epoch, challenge)
        try:
            client.sendall(json.dumps(auth.hello_response(), ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
            while not self._stop.is_set():
                subscription = holder.get("subscription")
                if subscription is not None:
                    for event in subscription.drain():
                        frame: dict[str, Any] = {"version": PROTOCOL, "id": "event", "ok": True, "bridgeEpoch": auth.bridge_epoch, "connectionChallenge": auth.connection_challenge, "result": {"event": event}}
                        frame["mac"] = auth.sign(frame)
                        client.sendall(json.dumps(frame, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
                try: chunk = client.recv(65536)
                except socket.timeout: continue
                if not chunk: break
                buffer += chunk
                if len(buffer) > MAX_WIRE_BYTES: break
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if not line: continue
                    try: request = json.loads(line.decode("utf-8")); response = auth.dispatch(request)
                    except Exception: response = auth.error_response()
                    client.sendall(json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
                    if auth.invalid: return
        finally:
            subscription = holder.get("subscription")
            if subscription is not None:
                subscription.close()
            self._clients.discard(client); client.close(); self._workers.discard(threading.current_thread())

    def disconnect(self) -> None:
        self._stop.set()
        try: self._server.close()
        except OSError: pass
        for client in list(self._clients):
            try: client.close()
            except OSError: pass
        self._clients.clear()
        self._realtime.close()
        try: self.mapper.capture_shutdown()
        except BaseException: pass
        self.queue.close()
        with self._executed_lock: self._executed_mutations.clear()
        self.mapper.refs.reset()
        if self._thread is not threading.current_thread():
            self._thread.join(timeout=1)
        for worker in list(self._workers):
            worker.join(timeout=1)
        if self._diagnostics is not None:
            _clear_diagnostics_sink(self._diagnostics)

    def __del__(self) -> None:
        try:
            if not self._stop.is_set():
                self.disconnect()
        except Exception:
            pass


def create_instance(c_instance: Any, config: dict[str, Any] | None = None) -> AbletonMcpBridge:
    """Ableton Control Surface entrypoint. Missing explicit config fails closed."""
    return AbletonMcpBridge(c_instance, config=config)
