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
        if operation == "transport.set":
            return callable(getattr(self.song, "stop_playing", None)) or hasattr(self.song, "current_song_time")
        if operation == "clip.launch":
            return any(getattr(slot, "clip", None) is not None and callable(getattr(slot, "fire", None)) for track in self._items(getattr(self.song, "tracks", [])) for slot in self._items(getattr(track, "clip_slots", [])))
        if operation == "track.stop":
            return any(callable(getattr(track, "stop_all_clips", None)) for track in self._items(getattr(self.song, "tracks", [])))
        if operation == "playback.stop-all-clips":
            return callable(getattr(self.song, "stop_all_clips", None)) and callable(getattr(self.song, "stop_playing", None))
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
            return any(self._read_attr(getattr(slot, "clip", None), "is_audio_clip") is True for track in self._items(getattr(self.song, "tracks", [])) for slot in self._items(getattr(track, "clip_slots", [])))
        if operation == "mixer.set":
            return any(self._read_attr(track, "mixer_device") is not None for track in self._items(getattr(self.song, "tracks", [])))
        if operation in {"automation.envelope.read", "automation.envelope.create", "automation.point.insert", "automation.point.delete"}:
            return any(getattr(slot, "clip", None) is not None and callable(getattr(getattr(slot, "clip", None), "create_automation_envelope", None)) for track in self._items(getattr(self.song, "tracks", [])) for slot in self._items(getattr(track, "clip_slots", [])))
        if operation == "automation.envelope.delete":
            return any(getattr(slot, "clip", None) is not None and callable(getattr(getattr(slot, "clip", None), "clear_envelope", None)) for track in self._items(getattr(self.song, "tracks", [])) for slot in self._items(getattr(track, "clip_slots", [])))
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
        if not 0 <= offset <= MAX_WIRE_COLLECTION_LENGTH * MAX_WIRE_COLLECTION_LENGTH:
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
        return {
            "isAudio": bool(is_audio) if isinstance(is_audio, bool) else None,
            "gain": finite("gain"),
            "pitchCoarse": finite("pitch_coarse"),
            "pitchFine": finite("pitch_fine"),
            "warpMode": warp,
            "warping": self._read_attr(clip, "warping") if isinstance(self._read_attr(clip, "warping"), bool) else None,
            "loopStart": finite("loop_start"),
            "loopEnd": finite("loop_end"),
            "startMarker": finite("start_marker"),
            "endMarker": finite("end_marker"),
            "filePath": str(file_path) if isinstance(file_path, str) and file_path else None,
        }

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
                "clips": clips, "clipSlots": slot_rows, "devices": self._device_items(track, index),
            })
        scene_rows = [{"ref": self.refs.put("scene", scene, str(i)), "parentRef": self.refs.put("set", self.song, "song"), "name": str(getattr(scene, "name", f"Scene {i + 1}")), "index": i, "triggerable": callable(getattr(scene, "fire", None)) or callable(getattr(scene, "launch", None))} for i, scene in enumerate(scenes)]
        locators = self._locator_items()
        return {"set": set_row, "tracks": track_rows, "scenes": scene_rows, "arrangement": {"locators": locators, "clips": self._arrangement_clip_items()}, "playback": self._playback(track_rows, scene_rows), "epoch": self.refs.epoch}

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
        captured: list[str] = []
        for track_index, track in enumerate(self._items(getattr(self.song, "tracks", []))):
            for slot_index, slot in enumerate(self._items(getattr(track, "clip_slots", []))):
                clip = getattr(slot, "clip", None)
                if clip is not None and (track_index, slot_index) not in before:
                    captured.append(self.refs.put("clip", clip, f"{track_index}:{slot_index}"))
        return {"captured": bool(captured), "clips": captured}

    def _scene_capture(self) -> dict[str, Any]:
        capture = getattr(self.song, "capture_and_insert_scene", None)
        if not callable(capture):
            raise ValueError("scene capture is unavailable")
        before = [scene.name for scene in self._items(getattr(self.song, "scenes", []))]
        capture()
        after_scenes = self._items(getattr(self.song, "scenes", []))
        if len(after_scenes) <= len(before):
            raise ValueError("scene capture did not create a scene")
        inserted = next((index for index, scene in enumerate(after_scenes) if index >= len(before) or scene.name != before[index]), len(before))
        scene = after_scenes[inserted]
        return {"captured": True, "ref": self.refs.put("scene", scene, str(inserted))}

    def invoke(self, operation: str, args: dict[str, Any]) -> Any:
        if operation == "session.audition-launch":
            return self._guarded_audition_launch(args)
        if operation == "session.audition-stop":
            return self._guarded_audition_stop(args)
        if operation == "session.emergency-stop":
            return self._guarded_emergency_stop(args)
        if operation == "transport.set":
            return self._transport_set(args)
        if operation == "clip.launch":
            return self._clip_launch(args)
        if operation == "track.stop":
            return self._track_stop(args)
        if operation == "playback.stop-all-clips":
            self._stop_playback()
            return {"stopped": True}
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
            _, slot, _, _ = self._clip_location(str(args["ref"]))
            if getattr(slot, "clip", None) is None or not callable(getattr(slot, "delete_clip", None)):
                raise ValueError("clip reference is not deletable")
            slot.delete_clip()
            return {"deleted": args["ref"]}
        clip = self.refs.get(str(args["ref"]))
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
        allowed = {"ref", "gain", "pitchCoarse", "pitchFine", "loopStart", "loopEnd", "warpMode"}
        if set(args) - allowed:
            raise ValueError("audio clip fields are invalid")
        applied: dict[str, Any] = {}
        if "gain" in args:
            value = args["gain"]
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or not 0 <= float(value) <= 1000000:
                raise ValueError("gain is invalid")
            clip.gain = float(value)
            applied["gain"] = float(value)
        if "pitchCoarse" in args:
            value = args["pitchCoarse"]
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or not -48 <= float(value) <= 48:
                raise ValueError("pitchCoarse is invalid")
            clip.pitch_coarse = float(value)
            applied["pitchCoarse"] = float(value)
        if "pitchFine" in args:
            value = args["pitchFine"]
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or not -50 <= float(value) <= 50:
                raise ValueError("pitchFine is invalid")
            clip.pitch_fine = float(value)
            applied["pitchFine"] = float(value)
        if "loopStart" in args:
            value = args["loopStart"]
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or float(value) < 0:
                raise ValueError("loopStart is invalid")
            clip.loop_start = float(value)
            applied["loopStart"] = float(value)
        if "loopEnd" in args:
            value = args["loopEnd"]
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)) or float(value) < 0:
                raise ValueError("loopEnd is invalid")
            clip.loop_end = float(value)
            applied["loopEnd"] = float(value)
        if "warpMode" in args:
            value = args["warpMode"]
            if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 16:
                raise ValueError("warpMode is invalid")
            clip.warping_mode = value
            applied["warpMode"] = value
        fields = self._audio_fields(clip)
        checks = []
        for key, value in applied.items():
            if key == "warpMode":
                checks.append(fields["warpMode"] == value)
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
        events = envelope.events_in_range(-1.0, 1_000_000_000.0) if callable(getattr(envelope, "events_in_range", None)) else []
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

    def _note_add(self, args: dict[str, Any]) -> dict[str, Any]:
        clip = self.refs.get(str(args["ref"]))
        if not isinstance(args.get("note"), dict):
            raise ValueError("note is invalid")
        note = dict(args["note"])
        if not hasattr(clip, "add_new_notes"):
            raise ValueError("target is not a MIDI clip")
        if (not isinstance(note.get("pitch"), int) or isinstance(note["pitch"], bool) or not 0 <= note["pitch"] <= 127
                or not isinstance(note.get("velocity"), (int, float)) or isinstance(note["velocity"], bool) or not 0 <= float(note["velocity"]) <= 127
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
        mute = note.get("mute")
        if mute is not None and not isinstance(mute, bool):
            raise ValueError("note mute is invalid")
        try:
            spec_class = getattr(__import__("Live.Clip", fromlist=["MidiNoteSpecification"]), "MidiNoteSpecification", None)
        except Exception:
            spec_class = None
        if spec_class is not None:
            clip.add_new_notes([spec_class(
                note["pitch"], float(note["start"]), float(note["duration"]), float(note["velocity"]),
                bool(mute) if mute is not None else False,
                float(probability) if probability is not None else 1.0,
                float(velocity_deviation) if velocity_deviation is not None else 0.0,
                float(release_velocity) if release_velocity is not None else 64.0,
            )])
        elif hasattr(clip, "set_notes"):
            # Legacy fallback carries no advanced fields.
            if any(field is not None for field in (probability, velocity_deviation, release_velocity, mute)):
                raise ValueError("advanced note fields are unavailable on this Live shape")
            if hasattr(clip, "get_all_notes_extended"):
                existing = [(int(item.pitch), float(item.start_time), float(item.duration), int(item.velocity), bool(item.mute)) for item in clip.get_all_notes_extended()]
            else:
                existing = [tuple(item) for item in clip.get_notes(0, 0, 4096, 128)]
            existing.append((note["pitch"], float(note["start"]), float(note["duration"]), note["velocity"], False))
            clip.set_notes(tuple(existing))
        else:
            note_spec = {"pitch": note["pitch"], "start_time": float(note["start"]), "duration": float(note["duration"]), "velocity": note["velocity"], "mute": False, "channel": note["channel"]}
            clip.add_new_notes([note_spec])
        note_id = None
        if hasattr(clip, "get_all_notes_extended"):
            for candidate in clip.get_all_notes_extended():
                if int(candidate.pitch) == note["pitch"] and abs(float(candidate.start_time) - float(note["start"])) < 1e-6:
                    note_id = int(candidate.note_id)
        return {"added": True, "noteId": note_id}


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
