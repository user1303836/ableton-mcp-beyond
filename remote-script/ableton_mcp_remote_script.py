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
import threading
import time
import traceback
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

METHODS = {"status", "snapshot", "discover", "get", "set", "invoke", "subscribe", "reconnect"}
REQUIRED_REGISTRY_OPERATIONS = {"status", "snapshot", "discover", "get", "set", "reconnect", "session.playback"}
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
    allowed_schema = {"type", "properties", "required", "additionalProperties", "items", "enum", "const", "minLength", "maxLength", "minimum", "maximum", "maxItems", "maxProperties", "pattern"}
    types = {"object", "array", "string", "number", "integer", "boolean", "null"}
    def validate_schema(schema: Any, depth: int = 0) -> None:
        if not isinstance(schema, dict) or depth > 8 or set(schema) - allowed_schema:
            raise ValueError("invalid operation schema")
        declared = schema.get("type")
        declared_types = declared if isinstance(declared, list) else [declared]
        if not declared_types or len(declared_types) > 4 or any(item not in types for item in declared_types):
            raise ValueError("invalid operation schema type")
        for key in ("minLength", "maxLength", "maxItems", "maxProperties"):
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
        if "maxItems" in schema and len(value) > schema["maxItems"]: raise ValueError(f"{path} exceeds item bound")
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
MAX_WIRE_COLLECTION_LENGTH = 256
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
            if len(value) > MAX_WIRE_COLLECTION_LENGTH:
                raise ValueError("wire array is too large")
            return "[" + ",".join(cls._canonical(item, depth + 1) for item in value) + "]"
        if isinstance(value, dict):
            if len(value) > MAX_WIRE_COLLECTION_LENGTH:
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
        if method == "set": return "set", {"ref": request.get("ref"), "property": request.get("property"), "value": request.get("value")}
        if method == "invoke": return str(request.get("operation")), dict(request.get("args", {}))
        return method, dict(request.get("args", {}))

    def dispatch(self, request: dict[str, Any]) -> dict[str, Any]:
        required = {"version", "id", "method", "nonce", "sequence", "bridgeEpoch", "connectionChallenge", "deadlineMs", "mac"}
        optional = {"ref", "property", "value", "operation", "args"}
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
            or not isinstance(request["nonce"], str)
            or not isinstance(request["sequence"], int) or isinstance(request["sequence"], bool)
            or not 1 <= request["sequence"] <= (2**53 - 1)
            or not isinstance(request["mac"], str)
        ):
            return self._error(request.get("id", "invalid"), "invalid request")
        if request["method"] in {"invoke", "discover"}:
            if request["method"] == "invoke" and (not isinstance(request.get("operation"), str) or not re.fullmatch(r"[a-z]+(?:[.-][a-z]+)+", request["operation"])):
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

    def status(self) -> dict[str, Any]:
        registry, registry_hash = operation_registry()
        operations = [item["id"] for item in registry["operations"] if self._operation_supported(item["id"])]
        return {
            "connected": self.song is not None,
            "adapter": "remote-script" if self.song is not None else "unavailable",
            "epoch": self.refs.epoch if self.song is not None else None,
            "protocol": "ableton-live/v1",
            "capabilities": self.capabilities(),
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
        if operation == "session.audition-launch":
            return any(callable(getattr(scene, "fire", None)) or callable(getattr(scene, "launch", None)) for scene in self._items(getattr(self.song, "scenes", [])))
        if operation in {"session.audition-stop", "session.emergency-stop"}:
            return callable(getattr(self.song, "stop_all_clips", None)) and callable(getattr(self.song, "stop_playing", None))
        if operation == "set":
            return True
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
        if operation == "note.add":
            return any(callable(getattr(getattr(slot, "clip", None), "add_new_notes", None)) for track in tracks for slot in self._items(getattr(track, "clip_slots", [])))
        if operation == "device.parameter.set":
            return any(
                any(device.get("parameters") for device in self._device_items(track, track_index))
                for track_index, track in enumerate(tracks)
            )
        return False

    def capabilities(self) -> list[str]:
        if self.song is None:
            return []
        capabilities = [
            "session.read", "session.write", "tracks", "scenes", "clips", "notes", "session.discovery", "session.structure",
            "session.midi_clip.create", "session.midi_clip.delete",
            "session.midi_note.read", "session.midi_note.write", "transport", "reconnect",
        ]
        if self._locator_supported():
            capabilities.extend(("arrangement.read", "arrangement.write"))
        if any(self._device_items(track, track_index) for track_index, track in enumerate(self._items(getattr(self.song, "tracks", [])))):
            capabilities.extend(("devices", "parameters", "device.parameter.write"))
        return capabilities

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

    def _playback(self, track_rows: list[dict[str, Any]] | None = None, scene_rows: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        if track_rows is None or scene_rows is None:
            snapshot = self.snapshot()
            return snapshot["playback"]
        transport = {
            "playing": getattr(self.song, "is_playing", None) if isinstance(getattr(self.song, "is_playing", None), bool) else None,
            "arrangementRecord": getattr(self.song, "record_mode", None) if isinstance(getattr(self.song, "record_mode", None), bool) else None,
            "sessionRecord": getattr(self.song, "session_record", None) if isinstance(getattr(self.song, "session_record", None), bool) else None,
            "position": float(getattr(self.song, "current_song_time", getattr(self.song, "song_time", 0))) if isinstance(getattr(self.song, "current_song_time", getattr(self.song, "song_time", None)), (int, float)) and not isinstance(getattr(self.song, "current_song_time", getattr(self.song, "song_time", None)), bool) and math.isfinite(float(getattr(self.song, "current_song_time", getattr(self.song, "song_time", 0)))) and float(getattr(self.song, "current_song_time", getattr(self.song, "song_time", 0))) >= 0 else None,
            "launchQuantization": self._quantization(getattr(self.song, "clip_trigger_quantization", getattr(self.song, "launch_quantization", None))),
        }
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
        revision_payload = {"transport": transport, "firedTargets": fired, "playingTargets": playing}
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
        if not 0 <= offset <= MAX_WIRE_COLLECTION_LENGTH * MAX_WIRE_COLLECTION_LENGTH:
            raise ValueError("invalid discovery cursor")
        return offset

    def _arrangement_clip_items(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for index, clip in enumerate(self._items(getattr(self.song, "arrangement_clips", []))):
            reference = self.refs.put("arrangement_clip", clip, str(index))
            rows.append({
                "ref": reference,
                "parentRef": self.refs.put("set", self.song, "song"),
                "name": str(getattr(clip, "name", "")),
                "kind": "midi" if hasattr(clip, "add_new_notes") else "audio",
                "start": float(getattr(clip, "start_time", getattr(clip, "start", 0.0)) or 0.0),
                "length": float(getattr(clip, "length", 0.0) or 0.0),
            })
        return rows

    def _device_items(self, track: Any, track_index: int) -> list[dict[str, Any]]:
        devices = self._items(getattr(track, "devices", getattr(track, "device_chain", [])))
        rows: list[dict[str, Any]] = []
        track_ref = self.refs.put("track", track, str(track_index))
        for index, device in enumerate(devices):
            parameters: list[dict[str, Any]] = []
            device_ref = self.refs.put("device", device, f"{track_index}:{index}")
            for parameter_index, parameter in enumerate(self._items(getattr(device, "parameters", []))):
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
            rows.append({
                "ref": device_ref, "parentRef": track_ref, "chainPosition": index,
                "className": str(getattr(device, "class_name", device.__class__.__name__)),
                "name": str(getattr(device, "name", "Device")),
                "enabled": bool(getattr(device, "is_enabled", getattr(device, "enabled", True))),
                "parameters": parameters,
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
        """Read the first available attribute, treating Live's per-shape
        RuntimeError on unsupported properties as unavailable."""
        for name in names:
            try:
                return getattr(obj, name, None)
            except Exception:
                continue
        return None

    def snapshot(self) -> dict[str, Any]:
        set_ref = self.refs.put("set", self.song, "song")
        set_row: dict[str, Any] = {"ref": set_ref, "name": str(getattr(self.song, "name", "Live Set"))}
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
                clips.append({"ref": clip_ref, "parentRef": slot_ref, "name": str(getattr(clip, "name", "")), "kind": "midi" if hasattr(clip, "add_new_notes") else "audio", "start": slot_index * 4, "length": float(getattr(clip, "length", 0.0)), "notes": notes})
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
                "clips": clips, "clipSlots": slot_rows, "devices": self._device_items(track, index),
            })
        scene_rows = [{"ref": self.refs.put("scene", scene, str(i)), "parentRef": self.refs.put("set", self.song, "song"), "name": str(getattr(scene, "name", f"Scene {i + 1}")), "index": i, "triggerable": callable(getattr(scene, "fire", None)) or callable(getattr(scene, "launch", None))} for i, scene in enumerate(scenes)]
        locators = self._locator_items()
        return {"set": set_row, "tracks": track_rows, "scenes": scene_rows, "arrangement": {"locators": locators}, "playback": self._playback(track_rows, scene_rows), "epoch": self.refs.epoch}

    def _read_notes(self, clip: Any) -> list[dict[str, Any]]:
        if hasattr(clip, "get_all_notes_extended"):
            raw = list(clip.get_all_notes_extended())
        elif hasattr(clip, "get_notes"):
            raw = clip.get_notes(0, 0, 4096, 128)
        else:
            raw = []
        rows: list[dict[str, Any]] = []
        for item in self._items(raw):
            if isinstance(item, dict):
                rows.append({"pitch": int(item.get("pitch", 0)), "start": float(item.get("start_time", item.get("start", 0))), "duration": float(item.get("duration", 0)), "velocity": int(item.get("velocity", 0)), "channel": int(item.get("channel", 1))})
            elif isinstance(item, (list, tuple)):
                values = list(item)
                rows.append({"pitch": int(values[0]) if len(values) > 0 else 0, "start": float(values[1]) if len(values) > 1 else 0.0, "duration": float(values[2]) if len(values) > 2 else 0.0, "velocity": int(values[3]) if len(values) > 3 else 0, "channel": 1})
            else:
                rows.append({"pitch": int(getattr(item, "pitch", 0)), "start": float(getattr(item, "start_time", getattr(item, "start", 0))), "duration": float(getattr(item, "duration", 0)), "velocity": int(getattr(item, "velocity", 0)), "channel": int(getattr(item, "channel", 1))})
        return rows[:MAX_WIRE_COLLECTION_LENGTH]
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
                for device in track.get("devices", []):
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

    def set(self, reference: str, property_name: str, value: Any) -> dict[str, Any]:
        if property_name == "value":
            parameter = self.refs.get(reference)
            if not hasattr(parameter, "value"):
                raise ValueError("property is unavailable")
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
            return {"changed": True, "ref": reference, "property": property_name, "value": float(parameter.value), "revision": revision}
        if property_name not in {"name", "tempo"}:
            raise ValueError("property is unavailable")
        obj = self.refs.get(reference)
        if obj is None:
            raise ValueError("object reference is stale or unknown")
        if property_name == "name":
            if not isinstance(value, str) or not 1 <= len(value) <= 128:
                raise ValueError("name is invalid")
            obj.name = value
        elif obj is not self.song or not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or not 20 <= float(value) <= 999:
            raise ValueError("tempo is invalid")
        else:
            obj.tempo = float(value)
        return {"changed": True, "ref": reference, "property": property_name, "value": value}

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
        elif kind == "device": items = [device for track in snapshot["tracks"] for device in track["devices"]]
        elif kind == "parameter": items = [parameter for track in snapshot["tracks"] for device in track["devices"] for parameter in device["parameters"]]
        elif kind == "session_playback": items = [snapshot["playback"]]
        elif kind == "selection": items = [{"ref": f"{self.refs.epoch}:selection:current", "parentRef": set_row["ref"], "selectedRef": getattr(self.song, "view", None) and getattr(getattr(self.song, "view", None), "selected_track", None) and self.refs.put("track", getattr(self.song.view, "selected_track"), "selected")}]
        else:
            items = []
            for index, choice in enumerate(self._items(getattr(self.song, "routing_choices", []))):
                if isinstance(choice, dict):
                    row = dict(choice)
                else:
                    row = {"name": str(getattr(choice, "name", "")), "type": str(getattr(choice, "type", ""))}
                row["ref"] = self.refs.put("routing_choice", choice, str(index))
                row["parentRef"] = set_row["ref"]
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
        expected = args.get("expectedTargets")
        if not isinstance(expected, list) or len(expected) > 256 or len(set(expected)) != len(expected) or not all(isinstance(item, str) and 1 <= len(item) <= 1024 for item in expected):
            raise ValueError("expected targets are invalid")
        active = self._active_targets(self._playback())
        active_keys = {self._target_key(target) for target in active}
        if not active_keys <= set(expected):
            raise ValueError("active playback exceeds the separately authorized observation; perform fresh discovery")
        self._stop_playback()
        return {"stopped": True, "stoppedTargets": sorted(active_keys)}

    def invoke(self, operation: str, args: dict[str, Any]) -> Any:
        if operation == "session.audition-launch":
            return self._guarded_audition_launch(args)
        if operation == "session.audition-stop":
            return self._guarded_audition_stop(args)
        if operation == "session.emergency-stop":
            return self._guarded_emergency_stop(args)
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
        if operation in {"clip.create", "clip.delete", "note.add"}:
            return self._mutate(operation, args)
        if operation in {"track.create", "track.delete", "scene.create", "scene.delete"}:
            return self._structure_mutate(operation, args)
        if operation == "device.parameter.set":
            return self.set(str(args.get("ref")), "value", args.get("value"))
        raise ValueError("live operation unavailable")

    def _structure_mutate(self, operation: str, args: dict[str, Any]) -> dict[str, Any]:
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
            clip = self.refs.get(str(args["ref"]))
            for track in self._items(getattr(self.song, "tracks", [])):
                for slot in self._items(getattr(track, "clip_slots", [])):
                    if getattr(slot, "clip", None) is clip:
                        slot.delete_clip()
                        return {"deleted": args["ref"]}
            raise ValueError("clip reference is not deletable")
        clip = self.refs.get(str(args["ref"]))
        if not isinstance(args.get("note"), dict):
            raise ValueError("note is invalid")
        note = dict(args["note"])
        if not hasattr(clip, "add_new_notes"):
            raise ValueError("target is not a MIDI clip")
        if (not isinstance(note.get("pitch"), int) or isinstance(note["pitch"], bool) or not 0 <= note["pitch"] <= 127
                or not isinstance(note.get("velocity"), int) or isinstance(note["velocity"], bool) or not 1 <= note["velocity"] <= 127
                or not isinstance(note.get("channel"), int) or isinstance(note["channel"], bool) or not 1 <= note["channel"] <= 16
                or not isinstance(note.get("start"), (int, float)) or isinstance(note["start"], bool)
                or not isinstance(note.get("duration"), (int, float)) or isinstance(note["duration"], bool)
                or not math.isfinite(float(note["start"])) or not math.isfinite(float(note["duration"]))
                or float(note["start"]) < 0 or float(note["duration"]) <= 0
                or float(note["start"]) + float(note["duration"]) > float(getattr(clip, "length", 0))):
            raise ValueError("note is invalid")
        note_tuple = (note["pitch"], float(note["start"]), float(note["duration"]), note["velocity"], False)
        if hasattr(clip, "set_notes") and hasattr(clip, "get_notes"):
            # Live's note setter replaces the full note list; merge to append.
            existing = [tuple(item) for item in clip.get_notes(0, 0, 0, 128)]
            existing.append(note_tuple)
            clip.set_notes(tuple(existing))
        elif hasattr(clip, "add_new_notes"):
            note_spec = {"pitch": note["pitch"], "start_time": float(note["start"]), "duration": float(note["duration"]), "velocity": note["velocity"], "mute": False, "channel": note["channel"]}
            clip.add_new_notes([note_spec])
        else:
            raise ValueError("note writing is unavailable")
        return {"added": True}


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
        self.items: queue.Queue[tuple[Callable[[], Any], threading.Event, list[Any], _DispatchToken]] = queue.Queue(MAX_QUEUE_ITEMS)
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
            self.items.put_nowait((callback, event, result, token))
        wait_seconds = max(0.0, min(timeout, (deadline_ms - int(time.time() * 1000)) / 1000.0))
        if not event.wait(wait_seconds):
            if token.cancel(): raise TimeoutError("Live main-thread operation timed out before dispatch")
            raise RuntimeError("Live main-thread operation state uncertain after dispatch")
        if result and isinstance(result[0], BaseException): raise result[0]
        return result[0] if result else None

    def close(self) -> None:
        with self._lock:
            self._closed = True
            while True:
                try: _, event, result, token = self.items.get_nowait()
                except queue.Empty: break
                token.cancel(); result.append(RuntimeError("Live bridge is disconnected")); event.set()

    def drain(self, budget: int = MAX_QUEUE_ITEMS) -> int:
        count = 0
        while count < budget:
            try: callback, event, result, token = self.items.get_nowait()
            except queue.Empty: break
            if not token.claim():
                event.set(); count += 1; continue
            try: result.append(callback())
            except BaseException as exc: result.append(exc)
            finally: token.complete(); event.set()
            count += 1
        return count


class AbletonMcpBridge:
    """Installable Control Surface boundary with fail-closed loopback listener."""

    def __init__(self, c_instance: Any, config: dict[str, Any] | None = None, song: Any = None, provenance: str = "fake-live"):
        config = config or {}
        host = config.get("host", "")
        port = config.get("port", 0)
        secret = config.get("secret", "")
        if host not in {"127.0.0.1", "::1"} or not isinstance(port, int) or not 1 <= port <= 65535 or not isinstance(secret, str) or len(secret) < 32:
            raise ValueError("explicit loopback host, port, and strong secret are required")
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
        self._stop = threading.Event()
        self._clients: set[socket.socket] = set()
        self._workers: set[threading.Thread] = set()
        self._secret_value = secret
        self._thread = threading.Thread(target=self._accept, name="AbletonMcpBridge", daemon=True)
        self._thread.start()

    def _dispatch(self, method: str, request: dict[str, Any]) -> Any:
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
        if method == "set": return mapper.set(str(request.get("ref")), str(request.get("property")), request.get("value"))
        if method == "reconnect": return mapper.invoke("session.reconnect", {})
        if method == "invoke": return mapper.invoke(str(request.get("operation")), dict(request.get("args", {})))
        raise ValueError("operation unavailable")

    def drain_main_thread(self) -> int:
        return self.queue.drain()

    def update_display(self) -> None:
        """Control Surface callback: execute queued Live work on Live's thread."""
        self.queue.drain()

    def _accept(self) -> None:
        self._server.settimeout(0.2)
        while not self._stop.is_set():
            try: client, _ = self._server.accept()
            except (socket.timeout, OSError): continue
            self._clients.add(client)
            worker = threading.Thread(target=self._client, args=(client,), daemon=True)
            self._workers.add(worker)
            worker.start()

    def _client(self, client: socket.socket) -> None:
        client.settimeout(0.2); buffer = b""
        challenge = secrets.token_urlsafe(24)
        auth = AuthenticatedRemoteScript(self._secret_value, lambda method, request: self.queue.submit(lambda: self._dispatch_main_for(method, request, self.mapper), deadline_ms=request.get("deadlineMs")), self._bridge_epoch, challenge)
        try:
            client.sendall(json.dumps(auth.hello_response(), ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
            while not self._stop.is_set():
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
            self._clients.discard(client); client.close(); self._workers.discard(threading.current_thread())

    def disconnect(self) -> None:
        self._stop.set()
        try: self._server.close()
        except OSError: pass
        for client in list(self._clients):
            try: client.close()
            except OSError: pass
        self._clients.clear()
        self.queue.close()
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
