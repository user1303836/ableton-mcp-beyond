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
import queue
import socket
import struct
import threading
import time
import traceback
from collections import deque
from pathlib import Path
from typing import Any, Callable

PROTOCOL = "ableton-loopback/v1"
# Opt-in developer traceback sink enabled by creating this file before Live
# starts; never leaks operation details to the wire.
_DEBUG_LOG = Path("/tmp/ableton-mcp-bridge-debug.log")
_DEBUG_ENABLED = _DEBUG_LOG.exists()


def _debug_trace(context: str) -> None:
    if not _DEBUG_ENABLED:
        return
    try:
        with open(_DEBUG_LOG, "a", encoding="utf-8") as log:
            log.write(f"--- {context} ---\n{traceback.format_exc()}\n")
    except OSError:
        pass

METHODS = {"status", "snapshot", "discover", "get", "preflight", "prepare", "invoke", "subscribe", "reconnect"}
_READ_ONLY_INVOKES = {"session.playback", "automation.envelope.read", "browser.search", "browser.inspect", "audio.capture.inspect", "audio.capture.status", "realtime.stats", "session.reconnect"}
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
            if not isinstance(schema.get("additionalProperties"), bool) or schema["additionalProperties"] and "maxProperties" not in schema:
                raise ValueError("object schema must be bounded")
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
        if schema.get("additionalProperties") is False and set(value) - set(properties): raise ValueError(f"{path} contains unknown properties")
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
        if method == "discover":
            args = dict(request.get("args", {}))
            return ("session.playback", {}) if args.get("kind") == "session_playback" else ("discover", args)
        if method == "get": return "get", {"ref": request.get("ref")}
        if method in {"preflight", "prepare"}:
            args = dict(request.get("args", {})); operation = str(request.get("operation")); digest = hashlib.sha256(self._bounded_canonical(args).encode("utf-8")).hexdigest()
            if method == "preflight": return "authority.preflight", {"operation": operation, "argsDigest": digest}
            return "authority.prepare", {"operation": operation, "argsDigest": digest, "preflightToken": request.get("preflightToken"), "confirmation": request.get("confirmation"), "idempotencyKey": request.get("idempotencyKey")}
        if method == "invoke": return str(request.get("operation")), dict(request.get("args", {}))
        return method, dict(request.get("args", {}))

    def dispatch(self, request: dict[str, Any]) -> dict[str, Any]:
        required = {"version", "id", "method", "nonce", "sequence", "bridgeEpoch", "connectionChallenge", "deadlineMs", "mac"}
        optional = {"ref", "property", "value", "operation", "args", "preflightToken", "confirmation", "idempotencyKey", "authorityToken"}
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
            or (request["method"] == "invoke" and _mutation_authority_required(str(request.get("operation"))) and (not isinstance(request.get("authorityToken"), str) or not 24 <= len(request["authorityToken"]) <= 128))
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
            _debug_trace(f"dispatch {request.get('method')}")
            return self._error(request["id"], "request failed")
        try:
            validate_operation_payload(operation_id, "result", result)
        except Exception:
            _debug_trace(f"result-contract {operation_id}")
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
        self._object_keys: dict[tuple[str, int], str] = {}

    def reset(self) -> None:
        self.epoch = secrets.randbelow(2**53 - 1) + 1
        self._cursor_key = secrets.token_bytes(32)
        self._objects.clear()
        self._revisions.clear()
        self._object_keys.clear()

    def put(self, kind: str, obj: Any, key: str) -> str:
        # Live hands out fresh proxy objects per read and CPython recycles
        # id() values, so a setdefault memo keyed by id() aliases stale keys
        # onto unrelated objects. Always re-assert the traversal-derived key.
        self._object_keys[(kind, id(obj))] = key
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
        suffix = reference.rsplit(":", 1)[-1]
        for identity, key in list(self._object_keys.items()):
            if key == suffix:
                self._object_keys.pop(identity, None)


class LiveObjectMapper:
    """Small, version-tolerant Live object mapper used only on Live's main thread."""

    def __init__(self, song: Any, registry: ReferenceRegistry | None = None, provenance: str = "fake-live"):
        if provenance not in {"fake-live", "real-live"}:
            raise ValueError("invalid Live provenance")
        self.song = song
        self.refs = registry or ReferenceRegistry()
        self.provenance = provenance
        self._capture_state: dict[str, Any] | None = None

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
            return True
        if operation == "transport.set":
            return callable(getattr(self.song, "stop_playing", None)) or hasattr(self.song, "current_song_time")
        if operation == "session.clip-launch":
            return any(getattr(slot, "clip", None) is not None and callable(getattr(slot, "fire", None)) for track in self._items(getattr(self.song, "tracks", [])) for slot in self._items(getattr(track, "clip_slots", [])))
        if operation == "session.clip-stop":
            return any(callable(getattr(track, "stop_all_clips", None)) for track in self._items(getattr(self.song, "tracks", [])))
        if operation == "tempo.set":
            return isinstance(self._read_attr(self.song, "tempo"), (int, float))
        if operation == "session.capture-midi":
            return callable(getattr(self.song, "capture_midi", None))
        if operation == "scene.capture":
            return callable(getattr(self.song, "capture_and_insert_scene", None))
        if operation == "clip.duplicate":
            session = any(getattr(slot, "clip", None) is not None and callable(getattr(slot, "duplicate_clip_to", None)) for track in self._items(getattr(self.song, "tracks", [])) for slot in self._items(getattr(track, "clip_slots", [])))
            arrangement = any(getattr(slot, "clip", None) is not None and callable(getattr(track, "duplicate_clip_to_arrangement", None)) for track in self._items(getattr(self.song, "tracks", [])) for slot in self._items(getattr(track, "clip_slots", [])))
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
            return any(any(isinstance(self._read_attr(device, attr), bool) for attr in ("is_active", "is_enabled", "enabled")) for track in self._items(getattr(self.song, "tracks", [])) for device in self._items(getattr(track, "devices", [])))
        if operation == "device.move":
            return any(callable(getattr(track, "move_device", None)) for track in self._items(getattr(self.song, "tracks", [])))
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
            return any(getattr(slot, "clip", None) is not None and callable(getattr(slot, "delete_clip", None)) for track in tracks for slot in self._items(getattr(track, "clip_slots", [])))
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
        if supports("audio.capture.inspect") and supports("audio.capture.start") and supports("audio.capture.stop") and supports("audio.capture.cleanup"): capabilities.append("audio.capture.resampling")
        if supports("automation.envelope.read"): capabilities.append("automation")
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
        result = []
        for index, locator in enumerate(self._items(getattr(self.song, "cue_points", []))):
            position = getattr(locator, "time", getattr(locator, "position", None))
            if not isinstance(position, (int, float)) or not math.isfinite(float(position)):
                continue
            name = getattr(locator, "name", "")
            reference = self.refs.put("locator", locator, str(index))
            result.append({"ref": reference, "name": str(name), "position": float(position)})
        return sorted(result, key=lambda item: (item["position"], item["name"], item["ref"]))

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
        revision = f"{self.refs.epoch}:playback:{hashlib.sha256(json.dumps(revision_payload, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()[:24]}"
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
        warp_mode = self._read_attr(clip, "warping_mode")
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
        markers = self._items(self._read_attr(clip, "warp_markers") or [])
        values["warpMarkers"] = [{"beatTime": float(self._read_attr(marker, "beat_time")), "sampleTime": float(self._read_attr(marker, "sample_time"))} for marker in markers[:256] if isinstance(self._read_attr(marker, "beat_time"), (int, float)) and isinstance(self._read_attr(marker, "sample_time"), (int, float))]
        values["warpMarkerEditingAvailable"] = False
        return values

    def _arrangement_clip_items(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        song_level = self._items(getattr(self.song, "arrangement_clips", []))
        if song_level:
            for index, clip in enumerate(song_level):
                reference = self.refs.put("arrangement_clip", clip, str(index))
                rows.append({
                    "ref": reference,
                    "parentRef": self.refs.put("set", self.song, "song"),
                    "trackRef": None,
                    "name": str(getattr(clip, "name", "")),
                    "kind": "midi" if hasattr(clip, "add_new_notes") else "audio",
                    "start": float(getattr(clip, "start_time", getattr(clip, "start", 0.0)) or 0.0),
                    "length": float(getattr(clip, "length", 0.0) or 0.0),
                    **self._audio_fields(clip),
                })
            return rows
        for track_index, track in enumerate(self._items(getattr(self.song, "tracks", [])) + self._items(getattr(self.song, "return_tracks", []))):
            track_ref = self.refs.put("track", track, str(track_index))
            for clip_index, clip in enumerate(self._items(self._read_attr(track, "arrangement_clips") or [])):
                reference = self.refs.put("arrangement_clip", clip, f"{track_index}:{clip_index}")
                rows.append({
                    "ref": reference,
                    "parentRef": track_ref,
                    "trackRef": track_ref,
                    "name": str(getattr(clip, "name", "")),
                    "kind": "midi" if hasattr(clip, "add_new_notes") else "audio",
                    "start": float(getattr(clip, "start_time", getattr(clip, "start", 0.0)) or 0.0),
                    "length": float(getattr(clip, "length", 0.0) or 0.0),
                    **self._audio_fields(clip),
                })
        return rows

    def _device_items(self, track: Any, track_index: int) -> list[dict[str, Any]]:
        devices = self._items(getattr(track, "devices", getattr(track, "device_chain", [])))
        rows: list[dict[str, Any]] = []
        track_ref = self.refs.put("track", track, str(track_index))
        for index, device in enumerate(devices):
            device_ref = self.refs.put("device", device, f"{track_index}:{index}")
            rows.append(self._device_row(device, device_ref, track_ref, track_index, f"{track_index}:{index}", index))
        return rows

    def _flatten_device_rows(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        flattened: list[dict[str, Any]] = []
        def visit(device: dict[str, Any]) -> None:
            flattened.append(device)
            for chain in device.get("chains", []):
                for nested in chain.get("devices", []): visit(nested)
            for pad in device.get("drumPads", []):
                for chain in pad.get("chains", []):
                    for nested in chain.get("devices", []): visit(nested)
        for row in rows: visit(row)
        return flattened[:MAX_DISCOVERY_COLLECTION_LENGTH]

    def _device_row(self, device: Any, device_ref: str, track_ref: str, track_index: int, path: str, index: int) -> dict[str, Any]:
        parameters: list[dict[str, Any]] = []
        for parameter_index, parameter in enumerate(self._items(getattr(device, "parameters", []))[:MAX_DISCOVERY_COLLECTION_LENGTH]):
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
                "ref": parameter_ref, "parentRef": device_ref,
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
            "className": str(self._read_attr(device, "class_name") or device.__class__.__name__),
            "name": str(self._read_attr(device, "name") or "Device"),
            "kind": "rack" if self._read_attr(device, "can_have_chains") is True else "device",
            "enabled": bool(enabled) if isinstance(enabled, bool) else None,
            "canHaveChains": self._read_attr(device, "can_have_chains") if isinstance(self._read_attr(device, "can_have_chains"), bool) else None,
            "canHaveDrumPads": self._read_attr(device, "can_have_drum_pads") if isinstance(self._read_attr(device, "can_have_drum_pads"), bool) else None,
            "parameters": parameters,
        }
        if row["canHaveChains"] is True:
            row["chains"] = self._chain_rows(device, device_ref, track_index, path)
            row["chainSelector"] = self._read_attr(device, "chain_selector")
            macros = self._items(self._read_attr(device, "macros") or [])
            row["macros"] = [{"ref": self.refs.put("parameter", macro, f"{device_ref}:macro:{macro_index}"), "name": str(self._read_attr(macro, "name") or f"Macro {macro_index + 1}"), "value": self._read_attr(macro, "value")} for macro_index, macro in enumerate(macros)]
            row["variationCount"] = len(self._items(self._read_attr(device, "variations") or []))
        if row["canHaveDrumPads"] is True:
            row["drumPads"] = self._drum_pad_rows(device, device_ref, track_index, path)
        return row

    def _chain_rows(self, parent: Any, parent_ref: str, track_index: int, path: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for chain_index, chain in enumerate(self._items(self._read_attr(parent, "chains") or [])):
            chain_ref = self.refs.put("chain", chain, f"{path}:{chain_index}")
            chain_devices: list[dict[str, Any]] = []
            for device_index, device in enumerate(self._items(self._read_attr(chain, "devices") or [])):
                nested_ref = self.refs.put("device", device, f"{path}:{chain_index}:{device_index}")
                chain_devices.append(self._device_row(device, nested_ref, chain_ref, track_index, f"{path}:{chain_index}:{device_index}", device_index))
            mute = self._read_attr(chain, "mute")
            solo = self._read_attr(chain, "solo")
            rows.append({
                "ref": chain_ref, "parentRef": parent_ref, "index": chain_index,
                "name": str(self._read_attr(chain, "name") or f"Chain {chain_index + 1}"),
                "mute": bool(mute) if isinstance(mute, bool) else None,
                "solo": bool(solo) if isinstance(solo, bool) else None,
                "devices": chain_devices,
            })
        return rows

    def _drum_pad_rows(self, device: Any, device_ref: str, track_index: int, path: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        pads = self._items(self._read_attr(device, "visible_drum_pads") or self._read_attr(device, "drum_pads") or [])
        for pad_index, pad in enumerate(pads):
            pad_ref = self.refs.put("drum_pad", pad, f"{path}:{pad_index}")
            mute = self._read_attr(pad, "mute")
            rows.append({
                "ref": pad_ref, "parentRef": device_ref, "index": pad_index,
                "name": str(self._read_attr(pad, "name") or f"Pad {pad_index + 1}"),
                "mute": bool(mute) if isinstance(mute, bool) else None,
                "chains": self._chain_rows(pad, pad_ref, track_index, f"{path}:{pad_index}"),
            })
        return rows

    @staticmethod
    def _items(value: Any) -> list[Any]:
        try:
            return list(value or [])
        except (TypeError, AttributeError):
            return []

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
        set_row: dict[str, Any] = {"ref": set_ref, "name": str(getattr(self.song, "name", "Live Set"))}
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
        track_kinds: dict[int, str] = {}
        tracks = []
        for track in self._items(getattr(self.song, "tracks", [])):
            track_kinds[id(track)] = self._track_kind(track) if self._track_kind(track) == "group" else "regular"
            tracks.append(track)
        for track in self._items(getattr(self.song, "return_tracks", [])):
            track_kinds[id(track)] = "return"
            tracks.append(track)
        main_track = getattr(self.song, "master_track", getattr(self.song, "main_track", None))
        if main_track is not None:
            track_kinds[id(main_track)] = "main"
            tracks.append(main_track)
        scenes = self._items(getattr(self.song, "scenes", []))
        track_rows = []
        for index, track in enumerate(tracks):
            track_ref = self.refs.put("track", track, str(index))
            track_kind = track_kinds.get(id(track), self._track_kind(track))
            slots = self._items(getattr(track, "clip_slots", []))
            clips = []
            slot_rows = []
            for slot_index, slot in enumerate(slots):
                clip = getattr(slot, "clip", None)
                slot_ref = self.refs.put("clip_slot", slot, f"{index}:{slot_index}")
                if clip is None:
                    slot_rows.append({"ref": slot_ref, "parentRef": track_ref, "trackRef": track_ref, "sceneIndex": slot_index, "empty": True})
                    continue
                clip_ref = self.refs.put("clip", clip, f"{index}:{slot_index}")
                notes = self._read_notes(clip)
                clips.append({"ref": clip_ref, "parentRef": slot_ref, "name": str(getattr(clip, "name", "")), "kind": "midi" if hasattr(clip, "add_new_notes") else "audio", "start": slot_index * 4, "length": float(getattr(clip, "length", 0.0)), "notes": notes, **self._audio_fields(clip)})
                slot_rows.append({"ref": slot_ref, "parentRef": track_ref, "trackRef": track_ref, "sceneIndex": slot_index, "clipRef": clip_ref, "empty": False})
            armed_value = self._read_attr(track, "arm", "armed")
            track_rows.append({
                "ref": track_ref, "parentRef": self.refs.put("set", self.song, "song"),
                "name": str(getattr(track, "name", f"Track {index + 1}")), "kind": track_kind,
                "mediaKind": "midi" if bool(self._read_attr(track, "has_midi_input")) else "audio",
                "armed": armed_value if isinstance(armed_value, bool) else None,
                "monitoringState": self._monitoring_state(self._read_attr(track, "current_monitoring_state", "monitoring")),
                "playingSlotIndex": self._slot_index(self._read_attr(track, "playing_slot_index")),
                "firedSlotIndex": self._slot_index(self._read_attr(track, "fired_slot_index")),
                "mixer": self._mixer_row(track, index),
                "routing": self._routing_row(track),
                "clips": clips, "clipSlots": slot_rows, "devices": self._device_items(track, index),
            })
        scene_rows = [{"ref": self.refs.put("scene", scene, str(i)), "parentRef": self.refs.put("set", self.song, "song"), "name": str(getattr(scene, "name", f"Scene {i + 1}")), "index": i, "triggerable": callable(getattr(scene, "fire", None)) or callable(getattr(scene, "launch", None))} for i, scene in enumerate(scenes)]
        locators = self._locator_items()
        return {"set": set_row, "tracks": track_rows, "scenes": scene_rows, "arrangement": {"locators": locators, "clips": self._arrangement_clip_items()}, "playback": self._playback(track_rows, scene_rows), "epoch": self.refs.epoch}

    def _read_notes(self, clip: Any) -> list[dict[str, Any]]:
        if self._read_attr(clip, "is_audio_clip") is True:
            return []
        try:
            if hasattr(clip, "get_all_notes_extended"):
                raw = list(clip.get_all_notes_extended())
            elif hasattr(clip, "get_notes"):
                raw = clip.get_notes(0, 0, 4096, 128)
            else:
                raw = []
        except (AttributeError, RuntimeError, TypeError, ValueError):
            # Several Live shapes publish MIDI-note methods on audio clips but
            # raise when called. Audio clips truthfully have no MIDI notes.
            raw = []
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
        return rows[:MAX_WIRE_ARRAY_LENGTH]
        return []

    def get(self, reference: str) -> Any:
        if not isinstance(reference, str):
            raise ValueError("object reference is required")
        obj = self.refs.get(reference)
        if obj is None:
            raise ValueError("object reference is stale or unknown")
        kind = reference.split(":", 2)[1] if reference.count(":") >= 2 else ""
        if kind == "set":
            return self.snapshot()["set"]
        if kind == "clip":
            return next((clip for track in self.snapshot()["tracks"] for clip in track["clips"] if clip["ref"] == reference), None)
        if kind in {"device", "parameter"}:
            for track in self.snapshot()["tracks"]:
                for device in self._flatten_device_rows(track.get("devices", [])):
                    if device["ref"] == reference:
                        return device
                    for parameter in device["parameters"]:
                        if parameter["ref"] == reference:
                            return parameter
            return None
        if kind == "locator":
            return next((item for item in self._locator_items() if item["ref"] == reference), None)
        if kind == "scene":
            scenes = self._items(getattr(self.song, "scenes", []))
            return {"ref": reference, "name": str(getattr(obj, "name", "")), "index": scenes.index(obj)}
        if kind == "track":
            tracks = self._items(getattr(self.song, "tracks", []))
            return next(row for row in self.snapshot()["tracks"] if row["ref"] == reference) if obj in tracks else None
        return None

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
        parameter.value = float(value)
        revision = self.refs.touch(reference)
        return {"changed": True, "ref": reference, "property": "value", "value": float(parameter.value), "revision": revision}

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
        if filters is not None and (not isinstance(filters, dict) or len(filters) > 16 or any(not isinstance(key, str) for key in filters)):
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
            track_objects = self._items(getattr(self.song, "tracks", [])) + self._items(getattr(self.song, "return_tracks", [])) + ([getattr(self.song, "master_track")] if getattr(self.song, "master_track", None) is not None else [])
            track_ref = snapshot["tracks"][track_objects.index(selected_track)]["ref"] if selected_track in track_objects and track_objects.index(selected_track) < len(snapshot["tracks"]) else None
            scene_objects = self._items(getattr(self.song, "scenes", [])); scene_ref = snapshot["scenes"][scene_objects.index(selected_scene)]["ref"] if selected_scene in scene_objects else None
            slot_ref = next((slot["ref"] for track in snapshot["tracks"] for slot in track.get("clipSlots", []) if self.refs.get(slot["ref"]) is highlighted_slot), None) if highlighted_slot is not None else None
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
            track_index = tracks.index(track) if track in tracks else 0
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
        if snapshot["set"].get("name") != set_name:
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
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:scene:"):
            raise ValueError("scene reference is stale or invalid")
        if not isinstance(set_name, str) or not 1 <= len(set_name) <= 256:
            raise ValueError("set identity is invalid")
        if not isinstance(eligible, list) or len(eligible) > 256 or len(set(eligible)) != len(eligible) or not all(isinstance(item, str) and 1 <= len(item) <= 1024 for item in eligible):
            raise ValueError("eligible targets are invalid")
        eligible_keys = set(eligible)
        snapshot = self.snapshot()
        if snapshot["set"].get("name") != set_name:
            raise ValueError("disposable Set identity does not match")
        active = self._active_targets(snapshot["playback"])
        if any(self._target_key(target) not in eligible_keys or target.get("sceneRef") != reference for target in active):
            raise ValueError("external or unknown playback is active; owned stop refused")
        self._stop_playback()
        return {"stopped": True}

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

    def _note_update(self, args: dict[str, Any]) -> dict[str, Any]:
        clip = self.refs.get(str(args["ref"]))
        patches = args.get("notes")
        if not isinstance(patches, list) or not 1 <= len(patches) <= 512:
            raise ValueError("note patches are invalid")
        if not callable(getattr(clip, "get_notes_extended", None)) or not callable(getattr(clip, "apply_note_modifications", None)) or not callable(getattr(clip, "get_all_notes_extended", None)):
            raise ValueError("note modification is unavailable on this Live shape")
        extended = clip.get_notes_extended(0, 128, 0, 4096)
        by_id = {}
        for candidate in extended:
            by_id[int(candidate.note_id)] = candidate
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
            seen.add(patch["id"])
            targets.append((target, patch))
        for target, patch in targets:
            if "pitch" in patch: target.pitch = int(patch["pitch"])
            if "start" in patch: target.start_time = float(patch["start"])
            if "duration" in patch: target.duration = float(patch["duration"])
            if "velocity" in patch: target.velocity = float(patch["velocity"])
            if "mute" in patch: target.mute = bool(patch["mute"])
            if "probability" in patch: target.probability = float(patch["probability"])
            if "velocityDeviation" in patch: target.velocity_deviation = float(patch["velocityDeviation"])
            if "releaseVelocity" in patch: target.release_velocity = float(patch["releaseVelocity"])
        clip.apply_note_modifications(extended)
        after = {int(candidate.note_id): candidate for candidate in clip.get_all_notes_extended()}
        for target, patch in targets:
            current = after.get(int(target.note_id))
            if current is None:
                raise ValueError("note update was not confirmed")
            if "pitch" in patch and int(current.pitch) != int(patch["pitch"]): raise ValueError("note update was not confirmed")
            if "start" in patch and abs(float(current.start_time) - float(patch["start"])) > 0.01: raise ValueError("note update was not confirmed")
            if "duration" in patch and abs(float(current.duration) - float(patch["duration"])) > 0.01: raise ValueError("note update was not confirmed")
            if "velocity" in patch and abs(float(current.velocity) - float(patch["velocity"])) > 0.51: raise ValueError("note update was not confirmed")
            if "mute" in patch and bool(current.mute) is not bool(patch["mute"]): raise ValueError("note update was not confirmed")
            if "probability" in patch and abs(float(current.probability) - float(patch["probability"])) > 0.01: raise ValueError("note update was not confirmed")
            if "velocityDeviation" in patch and abs(float(current.velocity_deviation) - float(patch["velocityDeviation"])) > 0.51: raise ValueError("note update was not confirmed")
            if "releaseVelocity" in patch and abs(float(current.release_velocity) - float(patch["releaseVelocity"])) > 0.51: raise ValueError("note update was not confirmed")
        return {"updated": len(targets)}

    def _note_delete(self, args: dict[str, Any]) -> dict[str, Any]:
        clip = self.refs.get(str(args["ref"]))
        note_ids = args.get("noteIds")
        if not isinstance(note_ids, list) or not 1 <= len(note_ids) <= 512 or len(set(note_ids)) != len(note_ids) or not all(isinstance(item, int) and not isinstance(item, bool) and item >= 0 for item in note_ids):
            raise ValueError("note ids are invalid")
        if not callable(getattr(clip, "remove_notes_by_id", None)):
            raise ValueError("note deletion is unavailable on this Live shape")
        existing = {int(candidate.note_id) for candidate in clip.get_all_notes_extended()}
        if any(note_id not in existing for note_id in note_ids):
            raise ValueError("note id is not present in the clip")
        clip.remove_notes_by_id(note_ids)
        after = {int(candidate.note_id) for candidate in clip.get_all_notes_extended()}
        if any(note_id in after for note_id in note_ids):
            raise ValueError("note deletion was not confirmed")
        return {"deleted": len(note_ids)}

    def _transport_set(self, args: dict[str, Any]) -> dict[str, Any]:
        expected = args.get("expectedRevision")
        if not isinstance(expected, str) or not 1 <= len(expected) <= 256:
            raise ValueError("expected revision is required")
        allowed = {"position", "loopEnabled", "loopStart", "loopLength", "metronome", "punchIn", "punchOut", "countIn", "expectedRevision"}
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
        count_in = number("countIn", 1000)
        if loop_length is not None and loop_length <= 0:
            raise ValueError("loopLength is invalid")
        if position is not None:
            self.song.current_song_time = position
        if loop_enabled is not None:
            self.song.loop = loop_enabled
        if loop_start is not None:
            self.song.loop_start = loop_start
        if loop_length is not None:
            self.song.loop_length = loop_length
        if metronome is not None:
            self.song.metronome = metronome
        if punch_in is not None:
            self.song.punch_in = punch_in
        if punch_out is not None:
            self.song.punch_out = punch_out
        if count_in is not None:
            self.song.count_in_duration = count_in
        transport = self._transport_dict()
        loop = transport["loop"]
        after_revision = self._playback()["revision"]
        checks = []
        # Position changes are applied asynchronously by Live (the playhead
        # lands on a later tick), so the mapper cannot verify position
        # synchronously; the host verifies it through fresh playback reads.
        if position is not None and not isinstance(transport["position"], (int, float)):
            checks.append(False)
        if loop_enabled is not None:
            checks.append(loop["enabled"] is loop_enabled)
        if loop_start is not None:
            checks.append(isinstance(loop["start"], (int, float)) and abs(loop["start"] - loop_start) < 0.26)
        if loop_length is not None:
            checks.append(isinstance(loop["length"], (int, float)) and abs(loop["length"] - loop_length) < 0.26)
        if metronome is not None:
            checks.append(transport["metronome"] is metronome)
        if punch_in is not None:
            checks.append(transport["punchIn"] is punch_in)
        if punch_out is not None:
            checks.append(transport["punchOut"] is punch_out)
        if count_in is not None:
            checks.append(isinstance(transport["countIn"], (int, float)) and abs(transport["countIn"] - count_in) < 0.26)
        if not all(checks):
            _debug_trace(f"transport.set postcondition: position={position} transport={transport!r} checks={checks!r}")
            raise ValueError("transport change was not confirmed by fresh state")
        return {"changed": True, "revision": after_revision}

    def _guarded_clip_launch(self, args: dict[str, Any]) -> dict[str, Any]:
        slot_ref, track_ref, scene_ref, clip_ref = (args.get(name) for name in ("slotRef", "trackRef", "sceneRef", "clipRef"))
        scene_index, playback_revision = args.get("sceneIndex"), args.get("playbackRevision")
        if not all(isinstance(item, str) and item.startswith(f"{self.refs.epoch}:") for item in (slot_ref, track_ref, scene_ref, clip_ref)) or not isinstance(scene_index, int) or isinstance(scene_index, bool) or not isinstance(playback_revision, str):
            raise ValueError("guarded clip-launch identity is invalid")
        playback = self._playback()
        if playback.get("revision") != playback_revision or playback["transport"].get("playing") is not False or playback["transport"].get("arrangementRecord") is not False or playback["transport"].get("sessionRecord") is not False or playback["firedTargets"] or playback["playingTargets"]:
            raise ValueError("stopped playback or recording baseline changed since clip-launch preview")
        slot, track, scene, clip = (self.refs.get(item) for item in (slot_ref, track_ref, scene_ref, clip_ref))
        tracks, scenes = self._items(getattr(self.song, "tracks", [])), self._items(getattr(self.song, "scenes", []))
        slots = self._items(getattr(track, "clip_slots", []))
        if track not in tracks or scene_index >= len(scenes) or scene_index >= len(slots) or scenes[scene_index] is not scene or slots[scene_index] is not slot or getattr(slot, "clip", None) is not clip:
            raise ValueError("clip-launch hierarchy changed since preview")
        return self._clip_launch({"ref": slot_ref})

    def _guarded_clip_stop(self, args: dict[str, Any]) -> dict[str, Any]:
        slot_ref, track_ref, scene_ref, clip_ref = (args.get(name) for name in ("slotRef", "trackRef", "sceneRef", "clipRef"))
        scene_index = args.get("sceneIndex")
        if not all(isinstance(item, str) and item.startswith(f"{self.refs.epoch}:") for item in (slot_ref, track_ref, scene_ref, clip_ref)) or not isinstance(scene_index, int) or isinstance(scene_index, bool):
            raise ValueError("guarded clip-stop identity is invalid")
        expected = (track_ref, slot_ref, scene_ref, scene_index, clip_ref)
        active = self._active_targets(self._playback())
        on_track = [(item.get("trackRef"), item.get("clipSlotRef"), item.get("sceneRef"), item.get("sceneIndex"), item.get("clipRef")) for item in active if item.get("trackRef") == track_ref]
        if any(item != expected for item in on_track):
            raise ValueError("track has foreign playback targets; guarded stop refused")
        if on_track:
            self._track_stop({"ref": track_ref})
        return {"stopped": True}

    def _tempo_set(self, args: dict[str, Any]) -> dict[str, Any]:
        reference, value, expected = args.get("ref"), args.get("value"), args.get("expectedTempo")
        if not isinstance(reference, str) or not isinstance(value, (int, float)) or isinstance(value, bool) or not isinstance(expected, (int, float)) or isinstance(expected, bool):
            raise ValueError("tempo authority is invalid")
        if self.refs.get(reference) is not self.song or not math.isclose(float(self._read_attr(self.song, "tempo")), float(expected), rel_tol=0, abs_tol=1e-9):
            raise ValueError("tempo changed since preview")
        self.song.tempo = float(value)
        return {"changed": True, "tempo": float(self.song.tempo), "revision": self.refs.touch(reference)}

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

    def _capture_midi(self) -> dict[str, Any]:
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
        capture()
        captured: list[str] = []; identities: list[dict[str, str]] = []
        for track_index, track in enumerate(self._items(getattr(self.song, "tracks", []))):
            for slot_index, slot in enumerate(self._items(getattr(track, "clip_slots", []))):
                clip = getattr(slot, "clip", None)
                if clip is not None and (track_index, slot_index) not in before:
                    reference = self.refs.put("clip", clip, f"{track_index}:{slot_index}"); captured.append(reference); identities.append({"ref": reference, "objectIdentity": self._capture_object_identity(clip)})
        return {"captured": bool(captured), "clips": captured, "clipIdentities": identities}

    def _scene_capture(self) -> dict[str, Any]:
        capture = getattr(self.song, "capture_and_insert_scene", None)
        if not callable(capture):
            raise ValueError("scene capture is unavailable")
        before_scenes = self._items(getattr(self.song, "scenes", [])); before_identities = {self._capture_object_identity(scene) for scene in before_scenes}
        capture()
        after_scenes = self._items(getattr(self.song, "scenes", []))
        created = [(index, scene, self._capture_object_identity(scene)) for index, scene in enumerate(after_scenes) if self._capture_object_identity(scene) not in before_identities]
        if len(after_scenes) != len(before_scenes) + 1 or len(created) != 1:
            raise ValueError("scene capture did not produce one identity-distinct scene")
        inserted, scene, identity = created[0]
        return {"captured": True, "ref": self.refs.put("scene", scene, str(inserted)), "objectIdentity": identity}

    def invoke(self, operation: str, args: dict[str, Any]) -> Any:
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
            return self._capture_midi()
        if operation == "note.update":
            return self._note_update(args)
        if operation == "note.delete":
            return self._note_delete(args)
        if operation == "clip.duplicate":
            return self._clip_duplicate(args)
        if operation == "arrangement.clip.create":
            return self._arrangement_clip_create(args)
        if operation == "arrangement.clip.delete":
            return self._arrangement_clip_delete(args)
        if operation == "arrangement.clip.move":
            return self._arrangement_clip_move(args)
        if operation == "audio.clip.set":
            return self._audio_clip_set(args)
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
            return self._scene_capture()
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
            if not isinstance(expected, int) or isinstance(expected, bool) or self.refs.revision(reference) != expected:
                raise ValueError("parameter revision changed since preview")
            return self._set_parameter_value(reference, args.get("value"))
        raise ValueError("live operation unavailable")

    def _rename(self, operation: str, args: dict[str, Any]) -> dict[str, Any]:
        reference, name, expected_name = args.get("ref"), args.get("name"), args.get("expectedName")
        kind = operation.split(".", 1)[0]
        if not isinstance(reference, str) or f":{kind}:" not in reference or not isinstance(name, str) or not 1 <= len(name) <= 256 or not isinstance(expected_name, str):
            raise ValueError("rename authority is invalid")
        target = self.refs.get(reference)
        if not hasattr(target, "name") or str(getattr(target, "name", "")) != expected_name:
            raise ValueError("rename target changed since preview")
        if kind == "track" and target not in self._items(getattr(self.song, "tracks", [])): raise ValueError("rename track is stale")
        if kind == "scene" and target not in self._items(getattr(self.song, "scenes", [])): raise ValueError("rename scene is stale")
        if kind == "locator" and target not in self._items(getattr(self.song, "cue_points", [])): raise ValueError("rename locator is stale")
        if kind == "clip":
            current_clips = [getattr(slot, "clip", None) for track in self._items(getattr(self.song, "tracks", [])) for slot in self._items(getattr(track, "clip_slots", []))] + [item for item in self._items(getattr(self.song, "arrangement_clips", []))]
            if target not in current_clips: raise ValueError("rename clip is stale")
        if kind == "device":
            current_refs = {device["ref"] for track in self.snapshot()["tracks"] for device in self._flatten_device_rows(track.get("devices", []))}
            if reference not in current_refs: raise ValueError("rename device is stale")
        target.name = name
        if str(getattr(target, "name", "")) != name: raise ValueError("rename postcondition was not confirmed")
        return {"renamed": reference, "name": name}

    def _structure_revision(self) -> str:
        snapshot = self.snapshot()
        identity = {"tracks": [[item["ref"], item["name"], item["kind"], index] for index, item in enumerate(snapshot["tracks"])], "scenes": [[item["ref"], item["name"], index] for index, item in enumerate(snapshot["scenes"])]}
        return hashlib.sha256(json.dumps(identity, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()

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
            creator = getattr(self.song, "create_midi_track" if kind == "midi" else "create_audio_track", None)
            if not callable(creator): raise ValueError("track creation is unavailable")
            track = creator(index)
            if hasattr(track, "name"): track.name = name
            if track is None: track = self._items(getattr(self.song, "tracks", []))[index]
            ref = self.refs.put("track", track, str(index))
            return {"ref": ref, "name": str(getattr(track, "name", name)), "kind": kind, "index": self._items(getattr(self.song, "tracks", [])).index(track)}
        if operation == "scene.create":
            name, index = args.get("name"), args.get("index")
            scenes = self._items(getattr(self.song, "scenes", []))
            if not isinstance(name, str) or not 1 <= len(name) <= 128 or any(str(getattr(scene, "name", "")) == name for scene in scenes): raise ValueError("scene name is invalid or already exists")
            if index is None: index = len(scenes)
            if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index <= len(scenes): raise ValueError("scene index is invalid")
            creator = getattr(self.song, "create_scene", None)
            if not callable(creator): raise ValueError("scene creation is unavailable")
            scene = creator(index)
            if scene is None: scene = self._items(getattr(self.song, "scenes", []))[index]
            if hasattr(scene, "name"): scene.name = name
            ref = self.refs.put("scene", scene, str(index))
            return {"ref": ref, "name": str(getattr(scene, "name", name)), "index": self._items(getattr(self.song, "scenes", [])).index(scene)}
        reference = args.get("ref")
        if not isinstance(reference, str): raise ValueError("object reference is required")
        obj = self.refs.get(reference)
        collection = self._items(getattr(self.song, "tracks" if operation == "track.delete" else "scenes", []))
        if obj not in collection: raise ValueError("object is not a current Session object")
        expected_identity = args.get("expectedObjectIdentity")
        if expected_identity is not None and (not isinstance(expected_identity, str) or not hmac.compare_digest(expected_identity, self._capture_object_identity(obj))): raise ValueError("Session object identity changed; deletion refused")
        deleter = getattr(self.song, "delete_track" if operation == "track.delete" else "delete_scene", None)
        if not callable(deleter): raise ValueError("object deletion is unavailable")
        deleter(obj)
        self.refs.delete(reference)
        return {"deleted": reference}

    def _locator_mutate(self, args: dict[str, Any], delete: bool) -> dict[str, Any]:
        if not self._locator_supported():
            raise ValueError("Arrangement locators are unavailable")
        if delete:
            reference = args.get("ref")
            if not isinstance(reference, str):
                raise ValueError("locator reference is required")
            locator = self.refs.get(reference)
            position = getattr(locator, "time", getattr(locator, "position", None))
            if not isinstance(position, (int, float)) or not math.isfinite(float(position)):
                raise ValueError("locator position is invalid")
            self.song.set_or_delete_cue(float(position))
            self.refs.delete(reference)
            return {"deleted": reference}
        name = args.get("name")
        position = args.get("position")
        if not isinstance(name, str) or not 1 <= len(name) <= 128 or not isinstance(position, (int, float)) or isinstance(position, bool) or not math.isfinite(float(position)) or not 0 <= float(position) <= 100000:
            raise ValueError("locator name or position is invalid")
        if any(item["name"] == name or item["position"] == float(position) for item in self._locator_items()):
            raise ValueError("locator target collides with existing state")
        before = self._locator_items()
        self.song.set_or_delete_cue(float(position))
        after = self._locator_items()
        created = [item for item in after if item["ref"] not in {old["ref"] for old in before} and item["position"] == float(position)]
        if len(created) != 1:
            raise RuntimeError("Live did not confirm locator creation")
        locator = self.refs.get(created[0]["ref"])
        if hasattr(locator, "name"):
            locator.name = name
        return {"ref": created[0]["ref"], "name": name, "position": float(position)}

    def _mutate(self, operation: str, args: dict[str, Any]) -> Any:
        if operation == "clip.create":
            track = self.refs.get(str(args["trackRef"]))
            if not bool(getattr(track, "has_midi_input", False)):
                raise ValueError("target track is not MIDI-capable")
            slots = self._items(getattr(track, "clip_slots", []))
            if not isinstance(args.get("sceneIndex"), int) or isinstance(args["sceneIndex"], bool):
                raise ValueError("scene index is invalid")
            index = args["sceneIndex"]
            if not 0 <= index < len(slots):
                raise ValueError("scene index is invalid")
            slot = slots[index]
            if getattr(slot, "clip", None) is not None:
                raise ValueError("session slot is occupied")
            length = args.get("length")
            if not isinstance(length, (int, float)) or isinstance(length, bool) or not math.isfinite(float(length)) or not 0 < float(length) <= 1024:
                raise ValueError("clip length is invalid")
            name = args.get("name")
            if not isinstance(name, str) or not 1 <= len(name) <= 256:
                raise ValueError("clip name is invalid")
            clip = slot.create_clip(float(length))
            if hasattr(clip, "name"):
                clip.name = name
            all_tracks = self._items(getattr(self.song, "tracks", [])) + self._items(getattr(self.song, "return_tracks", []))
            main_track = getattr(self.song, "master_track", getattr(self.song, "main_track", None))
            if main_track is not None:
                all_tracks.append(main_track)
            track_index = all_tracks.index(track) if track in all_tracks else 0
            return {"ref": self.refs.put("clip", clip, f"{track_index}:{index}"), "name": getattr(clip, "name", ""), "length": float(getattr(clip, "length", length))}
        if operation == "clip.delete":
            _, slot, _, _ = self._clip_location(str(args["ref"])); clip = getattr(slot, "clip", None)
            if clip is None or not callable(getattr(slot, "delete_clip", None)):
                raise ValueError("clip reference is not deletable")
            expected_identity = args.get("expectedObjectIdentity")
            if expected_identity is not None and (not isinstance(expected_identity, str) or not hmac.compare_digest(expected_identity, self._capture_object_identity(clip))):
                raise ValueError("clip object identity changed; deletion refused")
            slot.delete_clip()
            return {"deleted": args["ref"]}
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

    def _clip_duplicate(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:"):
            raise ValueError("clip reference is stale or invalid")
        clip = self.refs.get(reference)
        arrangement_position = args.get("arrangementPosition")
        if arrangement_position is not None:
            if not isinstance(arrangement_position, (int, float)) or isinstance(arrangement_position, bool) or not math.isfinite(float(arrangement_position)) or float(arrangement_position) < 0:
                raise ValueError("arrangement position is invalid")
            owner, source_slot, _, _ = self._clip_location(reference)
            clip = getattr(source_slot, "clip", None)
            if clip is None:
                raise ValueError("only Session clips can duplicate to the Arrangement")
            duplicate = getattr(owner, "duplicate_clip_to_arrangement", None)
            if not callable(duplicate):
                raise ValueError("arrangement duplication is unavailable")
            owner, source_slot, track_index, _ = self._clip_location(reference)
            clip = getattr(source_slot, "clip", None)
            if clip is None:
                raise ValueError("only Session clips can duplicate to the Arrangement")
            duplicate = getattr(owner, "duplicate_clip_to_arrangement", None)
            if not callable(duplicate):
                raise ValueError("arrangement duplication is unavailable")
            duplicate(clip, float(arrangement_position))
            clips_after = self._items(self._read_attr(owner, "arrangement_clips") or [])
            created = next((candidate for candidate in clips_after if abs(float(getattr(candidate, "start_time", -1)) - float(arrangement_position)) < 0.01), None)
            if created is None:
                raise ValueError("arrangement duplication was not confirmed")
            clip_index = clips_after.index(created)
            return {"ref": self.refs.put("arrangement_clip", created, f"{track_index}:{clip_index}"), "name": str(getattr(created, "name", ""))}
        target_track_ref = args.get("targetTrackRef")
        target_scene_index = args.get("targetSceneIndex")
        if not isinstance(target_track_ref, str) or not target_track_ref.startswith(f"{self.refs.epoch}:track:"):
            raise ValueError("target track reference is required for Session duplication")
        if not isinstance(target_scene_index, int) or isinstance(target_scene_index, bool) or not 0 <= target_scene_index <= 10000:
            raise ValueError("target scene index is invalid")
        target_track = self.refs.get(target_track_ref)
        slots = self._items(getattr(target_track, "clip_slots", []))
        if target_scene_index >= len(slots):
            raise ValueError("target scene index is invalid")
        target_slot = slots[target_scene_index]
        if getattr(target_slot, "clip", None) is not None:
            raise ValueError("target Session slot is occupied")
        _, source_slot, _, _ = self._clip_location(reference)
        clip = getattr(source_slot, "clip", None)
        if clip is None:
            raise ValueError("only Session clips can duplicate to a Session slot")
        duplicate = getattr(source_slot, "duplicate_clip_to", None)
        if not callable(duplicate):
            raise ValueError("Session duplication is unavailable")
        duplicate(target_slot)
        created = getattr(target_slot, "clip", None)
        if created is None:
            raise ValueError("Session duplication was not confirmed")
        track_index = self._items(getattr(self.song, "tracks", [])).index(target_track)
        return {"ref": self.refs.put("clip", created, f"{track_index}:{target_scene_index}"), "name": str(getattr(created, "name", ""))}

    def _arrangement_clip_create(self, args: dict[str, Any]) -> dict[str, Any]:
        track_ref = args.get("trackRef")
        if not isinstance(track_ref, str) or not track_ref.startswith(f"{self.refs.epoch}:track:"):
            raise ValueError("track reference is stale or invalid")
        track = self.refs.get(track_ref)
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
        before = len(self._items(self._read_attr(track, "arrangement_clips") or []))
        clip = creator(float(position), float(length))
        if clip is None:
            raise ValueError("arrangement clip creation failed")
        if hasattr(clip, "name"):
            clip.name = name
        clips = self._items(self._read_attr(track, "arrangement_clips") or [])
        if len(clips) <= before:
            raise ValueError("arrangement clip creation was not confirmed")
        track_index = self._items(getattr(self.song, "tracks", [])).index(track)
        clip_index = clips.index(clip) if clip in clips else len(clips) - 1
        return {"ref": self.refs.put("arrangement_clip", clip, f"{track_index}:{clip_index}"), "name": str(getattr(clip, "name", "")), "start": float(getattr(clip, "start_time", position)), "length": float(getattr(clip, "length", length))}

    def _arrangement_clip_delete(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:arrangement_clip:"):
            raise ValueError("arrangement clip reference is stale or invalid")
        key = ":".join(reference.split(":")[2:])
        if ":" not in key:
            # Song-level arrangement collection (non-track-parented shapes).
            if not key.isdigit():
                raise ValueError("arrangement clip reference is malformed")
            clips = self._items(getattr(self.song, "arrangement_clips", []))
            index = int(key)
            if not 0 <= index < len(clips):
                raise ValueError("arrangement clip is stale")
            deleter = getattr(self.song, "delete_clip", None)
            if not callable(deleter):
                raise ValueError("arrangement clip deletion is unavailable")
            deleter(clips[index])
            return {"deleted": reference}
        owner, clip, _, _ = self._arrangement_location(reference)
        deleter = getattr(owner, "delete_clip", None)
        if not callable(deleter):
            raise ValueError("arrangement clip deletion is unavailable")
        before = len(self._items(self._read_attr(owner, "arrangement_clips") or []))
        deleter(clip)
        if len(self._items(self._read_attr(owner, "arrangement_clips") or [])) >= before:
            raise ValueError("arrangement clip deletion was not confirmed")
        return {"deleted": reference}

    def _arrangement_clip_move(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:arrangement_clip:"):
            raise ValueError("arrangement clip reference is stale or invalid")
        clip = self.refs.get(reference)
        position = args.get("position")
        if not isinstance(position, (int, float)) or isinstance(position, bool) or not math.isfinite(float(position)) or float(position) < 0:
            raise ValueError("position is invalid")
        # start_time is read-only in Live; a move composes duplicate+delete
        # atomically on the main thread and reports the new clip identity.
        owner, clip, track_index, _ = self._arrangement_location(reference)
        duplicate = getattr(owner, "duplicate_clip_to_arrangement", None)
        deleter = getattr(owner, "delete_clip", None)
        if not callable(duplicate) or not callable(deleter):
            raise ValueError("arrangement clip move is unavailable")
        before = len(self._items(self._read_attr(owner, "arrangement_clips") or []))
        duplicate(clip, float(position))
        clips_after = self._items(self._read_attr(owner, "arrangement_clips") or [])
        if len(clips_after) <= before:
            raise ValueError("arrangement clip move duplication was not confirmed")
        created = clips_after[-1] if abs(float(getattr(clips_after[-1], "start_time", -1)) - float(position)) < 0.01 else next((candidate for candidate in clips_after if abs(float(getattr(candidate, "start_time", -1)) - float(position)) < 0.01), None)
        if created is None:
            raise ValueError("arrangement clip move duplication was not confirmed")
        deleter(clip)
        remaining = self._items(self._read_attr(owner, "arrangement_clips") or [])
        if len(remaining) >= len(clips_after):
            raise ValueError("arrangement clip move source delete was not confirmed")
        created_index = remaining.index(created)
        return {"ref": self.refs.put("arrangement_clip", created, f"{track_index}:{created_index}"), "start": float(getattr(created, "start_time", position))}

    def _audio_clip_set(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:"):
            raise ValueError("clip reference is stale or invalid")
        clip = self.refs.get(reference)
        if self._read_attr(clip, "is_audio_clip") is not True:
            raise ValueError("audio properties require an audio clip")
        allowed = {"ref", "gain", "pitchCoarse", "pitchFine", "loopStart", "loopEnd", "warpMode", "warping", "fadeInLength", "fadeOutLength"}
        if set(args) - allowed:
            raise ValueError("audio clip fields are invalid")
        def assign(attribute: str, value: Any) -> None:
            if self._read_attr(clip, attribute) is None: raise ValueError(f"{attribute} is unavailable on this audio clip")
            try: setattr(clip, attribute, value)
            except Exception as error: raise ValueError(f"{attribute} is not writable on this audio clip") from error
        applied: dict[str, Any] = {}
        if "gain" in args:
            value = args["gain"]
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or not 0 <= float(value) <= 1000000:
                raise ValueError("gain is invalid")
            assign("gain", float(value))
            applied["gain"] = float(value)
        if "pitchCoarse" in args:
            value = args["pitchCoarse"]
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or not -48 <= float(value) <= 48:
                raise ValueError("pitchCoarse is invalid")
            assign("pitch_coarse", float(value))
            applied["pitchCoarse"] = float(value)
        if "pitchFine" in args:
            value = args["pitchFine"]
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or not -50 <= float(value) <= 50:
                raise ValueError("pitchFine is invalid")
            assign("pitch_fine", float(value))
            applied["pitchFine"] = float(value)
        if "loopStart" in args:
            value = args["loopStart"]
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or float(value) < 0:
                raise ValueError("loopStart is invalid")
            assign("loop_start", float(value))
            applied["loopStart"] = float(value)
        if "loopEnd" in args:
            value = args["loopEnd"]
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or float(value) < 0:
                raise ValueError("loopEnd is invalid")
            assign("loop_end", float(value))
            applied["loopEnd"] = float(value)
        if "warpMode" in args:
            value = args["warpMode"]
            if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 16:
                raise ValueError("warpMode is invalid")
            assign("warping_mode", value)
            applied["warpMode"] = value
        if "warping" in args:
            value = args["warping"]
            if not isinstance(value, bool): raise ValueError("warping is invalid")
            assign("warping", value); applied["warping"] = value
        for field, attribute in (("fadeInLength", "fade_in_length"), ("fadeOutLength", "fade_out_length")):
            if field in args:
                value = args[field]
                if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or float(value) < 0: raise ValueError(f"{field} is invalid")
                assign(attribute, float(value)); applied[field] = float(value)
        fields = self._audio_fields(clip)
        checks = []
        for key, value in applied.items():
            if key == "warpMode" or isinstance(value, bool):
                checks.append(fields.get(key) == value)
            else:
                current = fields.get(key)
                checks.append(isinstance(current, (int, float)) and abs(current - value) < 0.01)
        if not applied or not all(checks):
            raise ValueError("audio clip change was not confirmed")
        revision = self.refs.touch(reference)
        return {"changed": True, "revision": revision}

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
            "panRef": self.refs.put("parameter", pan_param, f"mixer:{track_index}:panning") if pan_param is not None else None,
            "cueRef": self.refs.put("parameter", cue_param, f"mixer:{track_index}:cue_volume") if cue_param is not None else None,
            "sendRefs": [self.refs.put("parameter", send, f"mixer:{track_index}:sends:{send_index}") for send_index, send in enumerate(send_params)],
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
            tracks = self._items(getattr(self.song, "tracks", [])) + self._items(getattr(self.song, "return_tracks", [])) + ([getattr(self.song, "master_track", None)] if getattr(self.song, "master_track", None) is not None else [])
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

    def _mixer_set(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:track:"):
            raise ValueError("track reference is stale or invalid")
        track = self.refs.get(reference)
        mixer = self._read_attr(track, "mixer_device")
        if mixer is None:
            raise ValueError("mixer is unavailable")
        allowed = {"ref", "volume", "pan", "mute", "solo", "cueVolume", "sends"}
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
        if volume is not None:
            self._read_attr(mixer, "volume").value = volume
        if pan is not None:
            self._read_attr(mixer, "panning").value = pan
        if cue is not None:
            self._read_attr(mixer, "cue_volume").value = cue
        if mute is not None:
            track.mute = mute
        if solo is not None:
            track.solo = solo
        if sends is not None:
            for send_index, value in enumerate(sends):
                self._items(self._read_attr(mixer, "sends") or [])[send_index].value = float(value)
        row = self._mixer_row(track, self._items(getattr(self.song, "tracks", [])).index(track) if track in self._items(getattr(self.song, "tracks", [])) else 0)
        checks = []
        if volume is not None:
            checks.append(isinstance(row["volume"], (int, float)) and abs(row["volume"] - volume) < 0.01)
        if pan is not None:
            checks.append(isinstance(row["pan"], (int, float)) and abs(row["pan"] - pan) < 0.01)
        if cue is not None:
            checks.append(isinstance(row["cueVolume"], (int, float)) and abs(row["cueVolume"] - cue) < 0.01)
        if mute is not None:
            checks.append(row["mute"] is mute)
        if solo is not None:
            checks.append(row["solo"] is solo)
        if sends is not None:
            checks.append(all(isinstance(row["sends"][i], (int, float)) and abs(row["sends"][i] - float(value)) < 0.01 for i, value in enumerate(sends)))
        if not all(checks):
            raise ValueError("mixer change was not confirmed by fresh state")
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
        clip = getattr(envelope, "canonical_parent", None)
        window = float(getattr(clip, "length", 0.0) or 0.0) + 4.0 if clip is not None else 4096.0
        window = min(max(window, 4.0), 4096.0)
        events = envelope.events_in_range(0.0, window) if callable(getattr(envelope, "events_in_range", None)) else []
        points: list[dict[str, Any]] = []
        for event in list(events)[:limit]:
            time_value = getattr(event, "time", None)
            value = getattr(event, "value", None)
            if isinstance(time_value, (int, float)) and isinstance(value, (int, float)) and math.isfinite(float(time_value)) and math.isfinite(float(value)):
                points.append({"time": float(time_value), "value": float(value)})
        return points

    def _envelope_read(self, args: dict[str, Any]) -> dict[str, Any]:
        _, envelope = self._envelope(str(args["clipRef"]), str(args["parameterRef"]))
        return {"available": True, "exists": envelope is not None, "points": self._envelope_points(envelope) if envelope is not None else []}

    def _envelope_create(self, args: dict[str, Any]) -> dict[str, Any]:
        _, envelope = self._envelope(str(args["clipRef"]), str(args["parameterRef"]), create=True)
        if envelope is None:
            raise ValueError("envelope creation was not confirmed")
        return {"created": True}

    def _envelope_delete(self, args: dict[str, Any]) -> dict[str, Any]:
        clip, envelope = self._envelope(str(args["clipRef"]), str(args["parameterRef"]))
        if envelope is None:
            raise ValueError("envelope does not exist")
        parameter = self._resolve_parameter(str(args["parameterRef"]))
        clearer = getattr(clip, "clear_envelope", None)
        if not callable(clearer):
            raise ValueError("envelope deletion is unavailable")
        clearer(parameter)
        if getattr(clip, "automation_envelope", lambda _p: None)(parameter) is not None:
            raise ValueError("envelope deletion was not confirmed")
        return {"deleted": True}

    def _envelope_point_insert(self, args: dict[str, Any]) -> dict[str, Any]:
        points = args.get("points")
        if not isinstance(points, list) or not 1 <= len(points) <= 512:
            raise ValueError("points are invalid")
        for point in points:
            if not isinstance(point, dict) or set(point) != {"time", "value"} or not isinstance(point["time"], (int, float)) or isinstance(point["time"], bool) or not math.isfinite(float(point["time"])) or not 0 <= float(point["time"]) <= 1_000_000_000 or not isinstance(point["value"], (int, float)) or isinstance(point["value"], bool) or not math.isfinite(float(point["value"])) or not -1_000_000 <= float(point["value"]) <= 1_000_000:
                raise ValueError("points are invalid")
        _, envelope = self._envelope(str(args["clipRef"]), str(args["parameterRef"]), create=True)
        if envelope is None:
            raise ValueError("envelope creation was not confirmed")
        try:
            event_class = getattr(__import__("Live.Envelope", fromlist=["EnvelopeEvent"]), "EnvelopeEvent", None)
        except Exception:
            event_class = None
        if event_class is None:
            # Duck-typed event for fakes and shapes without Live's event class.
            class _Event:
                def __init__(self, time: float, value: float):
                    self.time = time
                    self.value = value
            event_class = _Event
        before = len(self._envelope_points(envelope, 1024))
        for point in points:
            envelope.create_event(event_class(float(point["time"]), float(point["value"])))
        after = len(self._envelope_points(envelope, 1024))
        if after < before + len(points):
            raise ValueError("envelope point insert was not confirmed")
        return {"inserted": len(points)}

    def _envelope_point_delete(self, args: dict[str, Any]) -> dict[str, Any]:
        from_time = args.get("from")
        to_time = args.get("to")
        if not isinstance(from_time, (int, float)) or isinstance(from_time, bool) or not math.isfinite(float(from_time)) or float(from_time) < 0:
            raise ValueError("from is invalid")
        if not isinstance(to_time, (int, float)) or isinstance(to_time, bool) or not math.isfinite(float(to_time)) or float(to_time) <= float(from_time):
            raise ValueError("to is invalid")
        _, envelope = self._envelope(str(args["clipRef"]), str(args["parameterRef"]))
        if envelope is None:
            raise ValueError("envelope does not exist")
        if not callable(getattr(envelope, "delete_events_in_range", None)):
            raise ValueError("envelope point deletion is unavailable")
        before = len(self._envelope_points(envelope, 1024))
        envelope.delete_events_in_range(float(from_time), float(to_time))
        after = len(self._envelope_points(envelope, 1024))
        return {"deleted": before - after}

    def _device_location(self, reference: str) -> tuple[Any, Any, int, int]:
        """Resolve a discovered device to its exact track/chain owner without
        trusting a parseable traversal key."""
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:device:"):
            raise ValueError("device reference is stale or invalid")
        target = self.refs.get(reference)
        tracks = self._items(getattr(self.song, "tracks", [])) + self._items(getattr(self.song, "return_tracks", []))
        def locate(owner: Any, track_index: int, seen: set[int]) -> tuple[Any, Any, int, int] | None:
            if id(owner) in seen: return None
            seen.add(id(owner)); devices = self._items(self._read_attr(owner, "devices") or [])
            for device_index, device in enumerate(devices):
                if device is target: return owner, device, track_index, device_index
                for chain in self._items(self._read_attr(device, "chains") or []):
                    found = locate(chain, track_index, seen)
                    if found is not None: return found
                for pad in self._items(self._read_attr(device, "visible_drum_pads") or self._read_attr(device, "drum_pads") or []):
                    for chain in self._items(self._read_attr(pad, "chains") or []):
                        found = locate(chain, track_index, seen)
                        if found is not None: return found
            return None
        for track_index, track in enumerate(tracks):
            found = locate(track, track_index, set())
            if found is not None: return found
        raise ValueError("device owner is stale or unavailable")

    def _device_insert(self, args: dict[str, Any]) -> dict[str, Any]:
        track_ref = args.get("trackRef")
        if not isinstance(track_ref, str) or not track_ref.startswith(f"{self.refs.epoch}:track:"):
            raise ValueError("track reference is stale or invalid")
        track = self.refs.get(track_ref)
        name = args.get("deviceName")
        if not isinstance(name, str) or not 1 <= len(name) <= 256:
            raise ValueError("device name is invalid")
        index = args.get("index")
        if index is not None and (not isinstance(index, int) or isinstance(index, bool) or not -1 <= index <= 256):
            raise ValueError("device index is invalid")
        inserter = getattr(track, "insert_device", None)
        if not callable(inserter):
            raise ValueError("device insertion is unavailable")
        before = len(self._items(getattr(track, "devices", [])))
        try:
            inserter(name, -1 if index is None else index)
        except Exception as error:
            raise ValueError("device name is not loadable on this Live shape") from error
        devices = self._items(getattr(track, "devices", []))
        if len(devices) <= before:
            raise ValueError("device insertion was not confirmed")
        position = len(devices) - 1 if index is None or index < 0 or index >= len(devices) else index
        device = devices[position]
        return {"ref": self.refs.put("device", device, f"{self._items(getattr(self.song, 'tracks', [])).index(track)}:{position}"), "name": str(self._read_attr(device, "name") or name), "index": position}

    def _device_delete(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        owner, device, _, _ = self._device_location(str(reference))
        deleter = getattr(owner, "delete_device", None)
        if not callable(deleter):
            raise ValueError("device deletion is unavailable")
        devices_before = self._items(getattr(owner, "devices", []))
        index = devices_before.index(device)
        deleter(index)
        if len(self._items(getattr(owner, "devices", []))) >= len(devices_before):
            raise ValueError("device deletion was not confirmed")
        return {"deleted": reference}

    def _device_enable(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        enabled = args.get("enabled")
        if not isinstance(enabled, bool):
            raise ValueError("enabled must be boolean")
        _, device, _, _ = self._device_location(str(reference))
        for attribute in ("is_active", "is_enabled", "enabled"):
            current = self._read_attr(device, attribute)
            if not isinstance(current, bool): continue
            if current is enabled:
                revision = self.refs.touch(reference)
                return {"changed": True, "enabled": enabled, "revision": revision}
            try: setattr(device, attribute, enabled)
            except Exception: continue
            if self._read_attr(device, attribute) is enabled:
                revision = self.refs.touch(reference)
                return {"changed": True, "enabled": enabled, "revision": revision}
        # Enable state commonly lives on the "Device On" parameter.
        for parameter in self._items(getattr(device, "parameters", [])):
            name = str(self._read_attr(parameter, "name") or "")
            if name.lower() in {"device on", "on"} or name.lower().startswith("device on"):
                minimum = self._read_attr(parameter, "min", "min_value")
                maximum = self._read_attr(parameter, "max", "max_value")
                target = float(maximum if enabled else minimum) if isinstance(minimum, (int, float)) and isinstance(maximum, (int, float)) else (1.0 if enabled else 0.0)
                parameter.value = target
                current = self._read_attr(parameter, "value")
                if isinstance(current, (int, float)) and abs(float(current) - target) < 0.01:
                    revision = self.refs.touch(reference)
                    return {"changed": True, "enabled": enabled, "revision": revision}
        raise ValueError("device enable is unavailable")

    def _device_move(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        index = args.get("index")
        if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index <= 256:
            raise ValueError("device index is invalid")
        owner, device, _, current = self._device_location(str(reference))
        if index == current:
            return {"ref": reference, "index": index}
        mover = getattr(owner, "move_device", None)
        if not callable(mover):
            raise ValueError("device move is unavailable")
        mover(current, index)
        devices = self._items(getattr(owner, "devices", []))
        if index >= len(devices) or devices[index] is not device:
            raise ValueError("device move was not confirmed")
        return {"ref": reference, "index": index}

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

    _BROWSER_CATEGORIES = {"instruments", "audio_effects", "midi_effects", "drums", "plugins", "packs", "max_for_live", "clips"}
    _DEVICE_BROWSER_CATEGORIES = {"instruments", "audio_effects", "midi_effects", "plugins"}

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
        items: list[dict[str, Any]] = []; seen_ids: set[str] = set()

        def walk(node: Any, path: str, depth: int) -> None:
            if len(items) >= limit or depth > 6:
                return
            children = self._items(self._read_attr(node, "children") or [])
            for child in children:
                if len(items) >= limit:
                    return
                name = str(self._read_attr(child, "name") or "")
                child_path = f"{path}/{name}"
                explicit_device = self._read_attr(child, "is_device"); is_loadable = self._read_attr(child, "is_loadable") is True
                is_device = explicit_device is True or (explicit_device is None and category_name in self._DEVICE_BROWSER_CATEGORIES and is_loadable)
                if not self._items(self._read_attr(child, "children") or []) or is_device:
                    if not needle or needle in name.lower() or needle in child_path.lower():
                        if child_path in seen_ids: raise ValueError("browser item identity collision")
                        seen_ids.add(child_path); items.append({"id": child_path, "name": name, "category": category_name, "path": child_path, "isDevice": is_device})
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
        matches: list[Any] = []
        def find(node: Any, path: str, depth: int) -> None:
            if depth > 6: return
            for child in self._items(self._read_attr(node, "children") or []):
                name = str(self._read_attr(child, "name") or ""); child_path = f"{path}/{name}"
                if child_path == item_id: matches.append(child)
                find(child, child_path, depth + 1)
        find(self._read_attr(browser, item_category), item_category, 0)
        if len(matches) != 1: raise ValueError("browser item identity is missing or ambiguous")
        item = matches[0]; name = str(self._read_attr(item, "name") or ""); explicit_device = self._read_attr(item, "is_device"); is_device = explicit_device is True or (explicit_device is None and item_category in self._DEVICE_BROWSER_CATEGORIES and self._read_attr(item, "is_loadable") is True)
        return item, {"id": item_id, "name": name, "category": item_category, "path": item_id, "isDevice": is_device}

    def _browser_inspect(self, args: dict[str, Any]) -> dict[str, Any]:
        return self._browser_find(args.get("itemId"))[1]

    def _browser_load(self, args: dict[str, Any]) -> dict[str, Any]:
        item, metadata = self._browser_find(args.get("itemId")); track_ref = args.get("trackRef")
        if metadata["isDevice"] is not True or args.get("expectedName") != metadata["name"]:
            raise ValueError("browser item is not an exact loadable device")
        browser = self._browser()
        loader = getattr(browser, "load_item", None)
        if not callable(loader):
            raise ValueError("browser loading is unavailable")
        if not isinstance(track_ref, str) or not track_ref.startswith(f"{self.refs.epoch}:track:"):
            raise ValueError("an exact regular-track reference is required")
        track = self.refs.get(track_ref); regular_tracks = self._items(getattr(self.song, "tracks", []))
        if track not in regular_tracks:
            raise ValueError("browser loading is limited to regular Set tracks")
        view = getattr(self.song, "view", None)
        if view is None or not hasattr(view, "selected_track"):
            raise ValueError("track-targeted browser loading is unavailable")
        previous_selection = getattr(view, "selected_track", None); before_devices = self._items(getattr(track, "devices", []))
        try:
            view.selected_track = track
            if getattr(view, "selected_track", None) is not track: raise ValueError("target-track selection was not confirmed")
            loader(item)
        finally:
            try:
                view.selected_track = previous_selection
                if getattr(view, "selected_track", None) is not previous_selection: raise ValueError("selection restoration was not confirmed")
            except Exception as error: raise ValueError("browser load selection restoration failed") from error
        devices = self._items(getattr(track, "devices", []))
        if len(devices) != len(before_devices) + 1:
            raise ValueError("browser load was not confirmed as one device on the target track")
        created = [candidate for candidate in devices if all(candidate is not prior for prior in before_devices)]
        if len(created) != 1: raise ValueError("browser load device identity is ambiguous")
        device = created[0]; device_index = devices.index(device); track_index = regular_tracks.index(track)
        return {"loaded": True, "deviceRef": self.refs.put("device", device, f"{track_index}:{device_index}")}

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
        return current is expected or (current is not None and cls._capture_object_identity(current) == identity)

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
        for candidate in self._items(self._read_attr(track, "available_input_routing_types") or []):
            labels = [self._capture_route_label(candidate), str(getattr(candidate, "name", "")), str(getattr(candidate, "display_name", ""))]
            if any(isinstance(label, str) and label.casefold() == "resampling" for label in labels):
                return candidate
        raise ValueError("the destination track does not expose an exact Resampling input")

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
        owned_recording = clip is not None and state.get("_ownedClipIdentity") and self._capture_same_object(clip, state.get("_ownedClip"), state["_ownedClipIdentity"]) and self._read_attr(clip, "is_recording") is True
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
        if self._read_attr(clip, "is_recording") is True:
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
        owned_clip = getattr(state.get("_destinationSlot"), "clip", None)
        recording = self._read_attr(owned_clip, "is_recording") is True if owned_clip is not None else False
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
        self._capture_refresh()
        if self._capture_status().get("playbackStopped") is not True:
            raise ValueError("capture playback must be authoritatively stopped before cleanup")
        if args.get("expectedClipRef") != state.get("clipRef"):
            raise ValueError("capture cleanup clip identity is stale or inexact")
        slot = state["_destinationSlot"]
        clip = getattr(slot, "clip", None)
        if clip is None or not state.get("_ownedClipIdentity") or not self._capture_same_object(clip, state.get("_ownedClip"), state["_ownedClipIdentity"]) or not callable(getattr(slot, "delete_clip", None)):
            raise ValueError("transaction-owned capture clip identity is unavailable for cleanup")
        file_path = (state.get("clip") or {}).get("filePath")
        slot.delete_clip()
        if getattr(slot, "clip", None) is not None:
            raise ValueError("capture clip cleanup was not confirmed")
        state["state"] = "cleaned"
        state["token"] = None
        state.pop("clip", None)
        state.pop("clipRef", None)
        return {"cleaned": True, "filePath": file_path, "captureId": state.get("captureId"), "residual": state.get("residual", [])}

    def capture_tick(self) -> None:
        try:
            self._capture_refresh()
        except BaseException:
            _debug_trace("capture tick")
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
        for candidate in self._items(self._read_attr(track, available_name) or []):
            candidate_label = candidate.get("display_name") or candidate.get("name") if isinstance(candidate, dict) else getattr(candidate, "display_name", None) or getattr(candidate, "name", "")
            if str(candidate_label) == label:
                return candidate
        raise ValueError(f"routing choice is unavailable: {label}")

    def _routing_set(self, args: dict[str, Any]) -> dict[str, Any]:
        reference = args.get("ref")
        if not isinstance(reference, str) or not reference.startswith(f"{self.refs.epoch}:track:"):
            raise ValueError("track reference is stale or invalid")
        track = self.refs.get(reference)
        allowed = {"ref", "inputType", "inputSubRouting", "outputType", "outputSubRouting", "arm", "monitoring"}
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
        # Feedback-sensitive guard: refuse routes that point a track's output
        # at itself or at a track that currently routes its output here.
        output_type = args.get("outputType")
        if isinstance(output_type, str) and output_type:
            own_name = str(self._read_attr(track, "name") or "")
            if output_type == own_name or output_type == str(self._read_attr(track, "current_input_routing") and getattr(self._read_attr(track, "current_input_routing"), "name", "") or ""):
                raise ValueError("routing would create a feedback loop")
        changes: list[tuple[str, Any]] = []
        if args.get("inputType") is not None:
            changes.append(("input_routing_type", self._routing_choice(track, "available_input_routing_types", args["inputType"])))
        if args.get("inputSubRouting") is not None:
            changes.append(("input_sub_routing", self._routing_choice(track, "available_input_routing_channels", args["inputSubRouting"])))
        if args.get("outputType") is not None:
            changes.append(("output_routing_type", self._routing_choice(track, "available_output_routing_types", args["outputType"])))
        if args.get("outputSubRouting") is not None:
            changes.append(("output_sub_routing", self._routing_choice(track, "available_output_routing_channels", args["outputSubRouting"])))
        for name, value in changes:
            if value is not None:
                setattr(track, name, value)
        if arm is not None:
            if self._read_attr(track, "can_be_armed") is not True:
                raise ValueError("track cannot be armed")
            track.arm = arm
        if monitoring is not None:
            current = self._read_attr(track, "current_monitoring_state")
            states = self._items(self._read_attr(track, "monitoring_states") or [])
            target = {"in": 0, "auto": 1, "off": 2}[monitoring]
            if isinstance(current, int) and states:
                track.current_monitoring_state = target
            elif isinstance(current, int):
                track.current_monitoring_state = target
            else:
                raise ValueError("monitoring control is unavailable on this track")
        row = self._routing_row(track)
        checks = []
        if args.get("inputType") is not None:
            checks.append(row["inputType"] == args["inputType"])
        if args.get("outputType") is not None:
            checks.append(row["outputType"] == args["outputType"])
        if arm is not None:
            checks.append(self._read_attr(track, "arm") is arm)
        if monitoring is not None:
            checks.append(self._monitoring_state(self._read_attr(track, "current_monitoring_state")) == monitoring)
        if not all(checks):
            raise ValueError("routing change was not confirmed by fresh state")
        revision = self.refs.touch(reference)
        return {"changed": True, "revision": revision}

    def _recording_authority(self, args: dict[str, Any], lane: str) -> str:
        action = args.get("action")
        expected_session, expected_arrangement = args.get("expectedSessionRecord"), args.get("expectedArrangementRecord")
        destination_ref, output_safety = args.get("destinationTrackRef"), args.get("outputSafety")
        if action not in {"start", "stop"} or not isinstance(expected_session, bool) or not isinstance(expected_arrangement, bool):
            raise ValueError("recording authority is invalid")
        current_session, current_arrangement = self._read_attr(self.song, "session_record"), self._read_attr(self.song, "record_mode")
        if not isinstance(current_session, bool) or not isinstance(current_arrangement, bool):
            raise ValueError("recording control is unavailable")
        if current_session is not expected_session or current_arrangement is not expected_arrangement:
            raise ValueError("recording state changed since preview")
        if not isinstance(output_safety, dict) or output_safety.get("safe") is not True or not isinstance(output_safety.get("provenance"), str) or output_safety.get("provenance") in {"", "unknown", "simulator"}:
            raise ValueError("authoritative output safety is required")
        if destination_ref is not None:
            if not isinstance(destination_ref, str):
                raise ValueError("recording destination is invalid")
            destination = self.refs.get(destination_ref)
            if destination not in self._items(getattr(self.song, "tracks", [])):
                raise ValueError("recording destination is stale or foreign")
        elif action == "start":
            raise ValueError("recording start requires an exact destination track")
        if action == "start":
            armed_tracks = [track for track in self._items(getattr(self.song, "tracks", [])) if self._read_attr(track, "arm") is True]
            if self._read_attr(destination, "arm") is not True or armed_tracks != [destination]:
                raise ValueError("recording destination must be the only armed track")
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
        clip = self.refs.get(str(args["ref"]))
        values = args.get("notes")
        if not isinstance(values, list) or not 1 <= len(values) <= 512:
            raise ValueError("note batch is invalid")
        notes = [self._validated_note(clip, value) for value in values]
        prior_candidates = list(clip.get_all_notes_extended()) if hasattr(clip, "get_all_notes_extended") else []
        prior_ids = {int(candidate.note_id) for candidate in prior_candidates if isinstance(getattr(candidate, "note_id", None), int) and not isinstance(candidate.note_id, bool)}
        try:
            spec_class = getattr(__import__("Live.Clip", fromlist=["MidiNoteSpecification"]), "MidiNoteSpecification", None)
        except Exception:
            spec_class = None
        if spec_class is not None:
            specifications = [spec_class(
                note["pitch"], float(note["start"]), float(note["duration"]), float(note["velocity"]),
                bool(note.get("mute", False)), float(note.get("probability", 1.0)),
                float(note.get("velocityDeviation", 0.0)), float(note.get("releaseVelocity", 64.0)),
            ) for note in notes]
            clip.add_new_notes(specifications)
        elif hasattr(clip, "set_notes"):
            if any(any(note.get(field) is not None for field in ("probability", "velocityDeviation", "releaseVelocity", "mute")) for note in notes):
                raise ValueError("advanced note fields are unavailable on this Live shape")
            if hasattr(clip, "get_all_notes_extended"):
                existing = [(int(item.pitch), float(item.start_time), float(item.duration), int(item.velocity), bool(item.mute)) for item in clip.get_all_notes_extended()]
            else:
                existing = [tuple(item) for item in clip.get_notes(0, 0, 4096, 128)]
            existing.extend((note["pitch"], float(note["start"]), float(note["duration"]), note["velocity"], False) for note in notes)
            clip.set_notes(tuple(existing))
        else:
            clip.add_new_notes([{
                "pitch": note["pitch"], "start_time": float(note["start"]), "duration": float(note["duration"]),
                "velocity": note["velocity"], "mute": bool(note.get("mute", False)), "channel": note["channel"],
                "probability": float(note.get("probability", 1.0)), "velocityDeviation": float(note.get("velocityDeviation", 0.0)),
                "releaseVelocity": float(note.get("releaseVelocity", 64.0)),
            } for note in notes])
        note_ids: list[int | None] = []
        candidates = list(clip.get_all_notes_extended()) if hasattr(clip, "get_all_notes_extended") else []
        used: set[int] = set(prior_ids)
        for note in notes:
            note_id = None
            for candidate in candidates:
                raw_id = getattr(candidate, "note_id", None)
                if not isinstance(raw_id, int) or isinstance(raw_id, bool):
                    continue
                candidate_id = int(raw_id)
                if candidate_id not in used and int(candidate.pitch) == note["pitch"] and abs(float(candidate.start_time) - float(note["start"])) < 1e-6 and abs(float(candidate.duration) - float(note["duration"])) < 1e-6:
                    note_id = candidate_id; used.add(candidate_id); break
            note_ids.append(note_id)
        return {"added": len(notes), "noteIds": note_ids}

    def _note_add(self, args: dict[str, Any]) -> dict[str, Any]:
        result = self._note_add_batch({"ref": args.get("ref"), "notes": [args.get("note")]})
        return {"added": True, "noteId": result["noteIds"][0]}


MAX_PENDING_EVENTS = 256
_EVENT_TYPES = {"state", "transport", "object", "meter", "max", "osc", "reset"}


class _Subscription:
    """Per-connection Live listener subscription with bounded coalesced events."""

    def __init__(self, mapper: "LiveObjectMapper", filters: set[str]):
        self.filters = filters
        self.mapper = mapper
        self.epoch = mapper.refs.epoch
        self.events: deque[dict[str, Any]] = deque(maxlen=MAX_PENDING_EVENTS)
        self.dropped = 0
        self.sequence = 0
        self._lock = threading.Lock()
        self._registrations: list[tuple[Any, str, Callable[[], Any]]] = []
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
            self.sequence += 1
            event: dict[str, Any] = {"epoch": self.epoch, "sequence": self.sequence, "type": event_type, "payload": payload}
            if ref is not None:
                event["ref"] = ref
            # Coalesce adjacent same-kind events so a burst cannot flood the queue.
            if self.events and self.events[-1]["type"] == event_type and self.events[-1].get("ref") == event.get("ref"):
                self.dropped += 1
                event["coalesced"] = self.dropped
                self.events[-1] = event
            elif len(self.events) >= MAX_PENDING_EVENTS:
                self.dropped += 1
            else:
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
        self._armed: tuple[str, float, tuple[str, ...], frozenset[int], frozenset[str]] | None = None
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

    def _armed_now_locked(self) -> tuple[str, float, tuple[str, ...], frozenset[int], frozenset[str]] | None:
        if self._armed is not None and time.time() >= self._armed[1]:
            self._armed = None
            self._generation += 1
        return self._armed

    def arm(self, ttl_ms: int, channels: Any, parameter_refs: Any, source_ports: Any = None) -> dict[str, Any]:
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
        token = secrets.token_urlsafe(24)
        expires = time.time() + ttl_ms / 1000.0
        with self._lock:
            self._generation += 1
            self._armed = (token, expires, tuple(channels), frozenset(source_ports), frozenset(parameter_refs))
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
                _debug_trace("realtime packet")

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
            expected_token, _, channels, source_ports, parameter_refs = armed
            source_host = str(address[0]) if address else ""
            source_port = address[1] if len(address) > 1 else 0
            if source_host != self.host or (source_ports and source_port not in source_ports):
                self.dropped_endpoint += 1
                return
            if not hmac.compare_digest(token, expected_token) or channel not in channels:
                self.dropped_unarmed += 1
                return
            targets = {str(message["ref"])} if operation == "parameter.set" else ({str(message["xRef"]), str(message["yRef"])} if operation == "xy.set" else set())
            if not targets <= parameter_refs:
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
            callback = lambda: self._realtime_parameter_set(str(message["ref"]), float(message["value"]))
        else:
            callback = lambda: self._realtime_xy_set(str(message["xRef"]), float(message["x"]), str(message["yRef"]), float(message["y"]))
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

    def _parameter_target(self, reference: str, value: float) -> tuple[Any, float]:
        mapper = self._bridge.mapper
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
        if not isinstance(observed, (int, float)) or isinstance(observed, bool) or not math.isfinite(float(observed)) or abs(float(observed) - expected) > 1e-6:
            raise ValueError("realtime parameter write was not confirmed")

    def _realtime_parameter_set(self, reference: str, value: float) -> None:
        parameter, prior = self._parameter_target(reference, value)
        try:
            parameter.value = value
            self._verify_parameter(parameter, value)
        except BaseException:
            try: parameter.value = prior
            except BaseException: pass
            raise

    def _realtime_xy_set(self, x_reference: str, x: float, y_reference: str, y: float) -> None:
        x_parameter, x_prior = self._parameter_target(x_reference, x)
        y_parameter, y_prior = self._parameter_target(y_reference, y)
        try:
            x_parameter.value = x
            y_parameter.value = y
            self._verify_parameter(x_parameter, x)
            self._verify_parameter(y_parameter, y)
        except BaseException:
            try: x_parameter.value = x_prior
            except BaseException: pass
            try: y_parameter.value = y_prior
            except BaseException: pass
            raise


class _DispatchToken:
    def __init__(self, deadline_ms: int):
        self.deadline_ms = deadline_ms
        self.state = "queued"
        self._lock = threading.Lock()

    def claim(self) -> bool:
        with self._lock:
            if self.state != "queued" or int(time.time() * 1000) > self.deadline_ms:
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


def _authority_state_digest(mapper: LiveObjectMapper, args: dict[str, Any]) -> str:
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
    attributes = ("name", "value", "min", "max", "is_enabled", "is_automatable", "arm", "mute", "solo", "current_monitoring_state", "input_routing_type", "input_routing_channel", "output_routing_type", "output_routing_channel", "gain", "pitch_coarse", "pitch_fine", "warping", "warping_mode", "fade_in_length", "fade_out_length", "loop_start", "loop_end", "start_time", "length", "is_playing", "is_triggered", "is_recording")
    for reference in sorted(set(references)):
        try:
            revision = mapper.refs.revision(reference); row = mapper.get(reference)
            if row is None:
                obj = mapper.refs.get(reference)
                if isinstance(obj, dict): row = {key: value for key, value in obj.items() if isinstance(value, (str, int, float, bool, type(None)))}
                else: row = {attribute: mapper._read_attr(obj, attribute) for attribute in attributes if isinstance(mapper._read_attr(obj, attribute), (str, int, float, bool, type(None)))}
            observed.append([reference, revision, row])
        except (KeyError, ValueError, StopIteration): observed.append([reference, None, None])
    playback = mapper._playback(); playback.pop("position", None)
    song_state = {key: mapper._read_attr(mapper.song, key) for key in ("tempo", "loop", "loop_start", "loop_length", "is_playing", "record_mode", "session_record")}
    locators = [{key: row.get(key) for key in ("ref", "name", "position")} for row in mapper._locator_items()[:256]]
    arrangement = [{key: row.get(key) for key in ("ref", "trackRef", "name", "start", "length")} for row in mapper._arrangement_clip_items()[:256]]
    identity = {"epoch": mapper.refs.epoch, "structure": mapper._structure_revision(), "song": song_state, "playback": playback, "locators": locators, "arrangement": arrangement, "references": observed}
    return hashlib.sha256(AuthenticatedRemoteScript._bounded_canonical(identity).encode("utf-8")).hexdigest()


class AbletonMcpBridge:
    """Installable Control Surface boundary with fail-closed loopback listener."""

    def __init__(self, c_instance: Any, config: dict[str, Any] | None = None, song: Any = None, provenance: str = "fake-live"):
        config = config or {}
        host = config.get("host", "")
        port = config.get("port", 0)
        secret = config.get("secret", "")
        realtime_port = config.get("realtimePort")
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
        self._stop = threading.Event()
        self._clients: set[socket.socket] = set()
        self._workers: set[threading.Thread] = set()
        self._secret_value = secret
        self._executed_mutations: dict[str, dict[str, Any]] = {}
        self._executed_lock = threading.Lock()
        self._thread = threading.Thread(target=self._accept, name="AbletonMcpBridge", daemon=True)
        self._thread.start()

    def _dispatch(self, method: str, request: dict[str, Any]) -> Any:
        if method == "invoke" and request.get("operation") in {"realtime.arm", "realtime.disarm", "realtime.stats"}:
            return self._realtime_op(str(request["operation"]), dict(request.get("args", {})))
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
        if types is None:
            types = sorted(_EVENT_TYPES)
        if not isinstance(types, list) or len(types) > 16 or any(not isinstance(item, str) or item not in _EVENT_TYPES for item in types):
            raise ValueError("subscription types are invalid")
        if not types:
            return {"subscribed": False, "subscriptionId": "none"}
        holder["subscription"] = _Subscription(self.mapper, set(types))
        return {"subscribed": True, "subscriptionId": secrets.token_urlsafe(12)}

    def _dispatch_with_holder(self, method: str, request: dict[str, Any], holder: dict[str, Any]) -> Any:
        if method == "subscribe":
            return self.queue.submit(lambda: self._subscribe_main(request, holder), deadline_ms=request.get("deadlineMs"))
        if method == "preflight":
            def preflight() -> dict[str, Any]:
                operation = str(request["operation"]); args = dict(request.get("args", {})); now = int(time.time() * 1000); preflights = holder.setdefault("preflights", {})
                for key, row in list(preflights.items()):
                    if row["expiresAt"] <= now: preflights.pop(key, None)
                if len(preflights) >= 64: raise ValueError("too many pending mutation preflights")
                args_digest = hashlib.sha256(AuthenticatedRemoteScript._bounded_canonical(args).encode("utf-8")).hexdigest(); state_digest = _authority_state_digest(self.mapper, args)
                token = secrets.token_urlsafe(24); confirmation = secrets.token_urlsafe(24); expires_at = now + 10000
                preflights[token] = {"operation": operation, "argsDigest": args_digest, "stateDigest": state_digest, "confirmation": confirmation, "expiresAt": expires_at}
                return {"preflightToken": token, "confirmation": confirmation, "operation": operation, "argsDigest": args_digest, "stateDigest": state_digest, "impact": "mutates-live", "expiresAt": expires_at}
            return self.queue.submit(preflight, deadline_ms=request.get("deadlineMs"))
        if method == "prepare":
            def prepare() -> dict[str, Any]:
                operation = str(request["operation"]); args = dict(request.get("args", {})); now = int(time.time() * 1000); preflight_token = str(request["preflightToken"])
                preflight_row = holder.setdefault("preflights", {}).pop(preflight_token, None); authorities = holder.setdefault("authorities", {})
                for key, row in list(authorities.items()):
                    if row["expiresAt"] <= now: authorities.pop(key, None)
                args_digest = hashlib.sha256(AuthenticatedRemoteScript._bounded_canonical(args).encode("utf-8")).hexdigest(); state_digest = _authority_state_digest(self.mapper, args)
                if preflight_row is None or preflight_row["expiresAt"] <= now or preflight_row["operation"] != operation or preflight_row["argsDigest"] != args_digest or preflight_row["stateDigest"] != state_digest or not hmac.compare_digest(preflight_row["confirmation"], str(request["confirmation"])):
                    raise ValueError("missing, expired, stale, or mismatched mutation preflight")
                if len(authorities) >= 64: raise ValueError("too many pending mutation authorities")
                token = secrets.token_urlsafe(24); expires_at = now + 10000
                authorities[token] = {"operation": operation, "argsDigest": args_digest, "stateDigest": state_digest, "expiresAt": expires_at, "idempotencyKey": request["idempotencyKey"]}
                return {"authorityToken": token, "operation": operation, "argsDigest": args_digest, "stateDigest": state_digest, "expiresAt": expires_at}
            return self.queue.submit(prepare, deadline_ms=request.get("deadlineMs"))
        if method == "invoke" and _mutation_authority_required(str(request.get("operation"))):
            token = str(request.get("authorityToken", "")); authority = holder.setdefault("authorities", {}).pop(token, None); now = int(time.time() * 1000)
            args = dict(request.get("args", {})); digest = hashlib.sha256(AuthenticatedRemoteScript._bounded_canonical(args).encode("utf-8")).hexdigest()
            if authority is None or authority["expiresAt"] <= now or authority["operation"] != request.get("operation") or authority["argsDigest"] != digest:
                raise ValueError("missing, expired, or mismatched mutation authority")
            idempotency_key = authority["idempotencyKey"]
            def replay_or_apply(apply: Callable[[], Any]) -> Any:
                with self._executed_lock:
                    prior = self._executed_mutations.get(idempotency_key)
                    if prior is not None:
                        if prior["operation"] != request.get("operation") or prior["argsDigest"] != digest: raise ValueError("idempotency key conflicts with an executed mutation")
                        return prior["result"]
                    if len(self._executed_mutations) >= 256: raise ValueError("executed mutation ledger is full; reconnect after authoritative recovery")
                    result = apply(); self._executed_mutations[idempotency_key] = {"operation": request["operation"], "argsDigest": digest, "result": result}; return result
            if request.get("operation") in {"realtime.arm", "realtime.disarm"}:
                return replay_or_apply(lambda: self._realtime_op(request["operation"], args))
            def invoke_authorized() -> Any:
                if _authority_state_digest(self.mapper, args) != authority["stateDigest"]: raise ValueError("Live state changed after mutation authority preparation")
                return replay_or_apply(lambda: self.mapper.invoke(str(request["operation"]), args))
            return self.queue.submit(invoke_authorized, deadline_ms=request.get("deadlineMs"))
        if method == "invoke" and request.get("operation") == "realtime.stats":
            return self._realtime_op(request["operation"], request.get("args", {}))
        if method == "reconnect":
            def reconnect() -> Any:
                result = self._dispatch_main_for(method, request, self.mapper)
                with self._executed_lock: self._executed_mutations.clear()
                return result
            return self.queue.submit(reconnect, deadline_ms=request.get("deadlineMs"))
        return self.queue.submit(lambda: self._dispatch_main_for(method, request, self.mapper), deadline_ms=request.get("deadlineMs"))

    def _realtime_op(self, operation: str, args: dict[str, Any]) -> Any:
        if operation == "realtime.arm":
            _require_output_safety(args)
            return self._realtime.arm(args.get("ttlMs", 30000), args.get("channels"), args.get("parameterRefs"), args.get("sourcePorts"))
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

    def __del__(self) -> None:
        try:
            if not self._stop.is_set():
                self.disconnect()
        except Exception:
            pass


def create_instance(c_instance: Any, config: dict[str, Any] | None = None) -> AbletonMcpBridge:
    """Ableton Control Surface entrypoint. Missing explicit config fails closed."""
    return AbletonMcpBridge(c_instance, config=config)
