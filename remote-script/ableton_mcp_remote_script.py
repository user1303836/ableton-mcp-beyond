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
from pathlib import Path
from typing import Any, Callable

PROTOCOL = "ableton-loopback/v1"
METHODS = {"status", "snapshot", "get", "set", "invoke", "subscribe", "reconnect"}
SUPPORTED_OPERATIONS = {
    "session.discover", "session.reconnect", "clip.create", "clip.delete", "note.add",
    "locator.add", "locator.delete", "track.create", "track.delete", "scene.create", "scene.delete", "device.parameter.set",
}
REQUIRED_REGISTRY_OPERATIONS = {"status", "discover", "get", "set", "reconnect"}
_MODULE_PATH = Path(__file__).resolve()
_REGISTRY_CANDIDATES = (
    _MODULE_PATH.with_name("ableton-live-v1.operations.json"),
    _MODULE_PATH.parents[1] / "protocol" / "ableton-live-v1.operations.json",
    _MODULE_PATH.parents[2] / "protocol" / "ableton-live-v1.operations.json",
)


def operation_registry() -> tuple[dict[str, Any], str]:
    """Load and hash the source-controlled operation registry."""
    try:
        registry_path = next(path for path in _REGISTRY_CANDIDATES if path.is_file())
        raw = registry_path.read_bytes()
        registry = json.loads(raw.decode("utf-8"))
    except (OSError, StopIteration, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("operation registry is unavailable or malformed") from error
    operations = registry.get("operations") if isinstance(registry, dict) else None
    if registry.get("version") != 1 or registry.get("protocol") != "ableton-live/v1" or not isinstance(operations, list):
        raise ValueError("unsupported operation registry")
    identifiers = [item.get("id") for item in operations if isinstance(item, dict)]
    if len(identifiers) != len(operations) or identifiers != sorted(identifiers) or len(set(identifiers)) != len(identifiers):
        raise ValueError("operation registry identifiers are not canonical")
    for item in operations:
        if set(item) != {"id", "method", "request", "result"} or not isinstance(item["id"], str) or not isinstance(item["method"], str) or not isinstance(item["request"], dict) or not isinstance(item["result"], dict):
            raise ValueError("operation registry entry is malformed")
    if not REQUIRED_REGISTRY_OPERATIONS.issubset(identifiers):
        raise ValueError("operation registry is missing required operations")
    return registry, hashlib.sha256(raw).hexdigest()
MAX_NONCE_LENGTH = 256
MAX_WIRE_BYTES = 1_048_576
MAX_WIRE_DEPTH = 16
MAX_WIRE_STRING_LENGTH = 16_384
MAX_WIRE_COLLECTION_LENGTH = 256
MAX_QUEUE_ITEMS = 128
DEFAULT_TIMEOUT_SECONDS = 5.0


class AuthenticatedRemoteScript:
    def __init__(self, secret: str, operation: Callable[[str, dict[str, Any]], Any]):
        if len(secret) < 32:
            raise ValueError("loopback secret must contain at least 32 characters")
        self._secret = secret.encode("utf-8")
        self._operation = operation
        self._last_sequence = 0

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
            return str(value)
        if isinstance(value, float):
            if not math.isfinite(value):
                raise ValueError("non-finite wire number")
            # Match JSON.stringify's integer range: decimal notation is used
            # below 1e21, while larger values retain exponent notation.
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

    def dispatch(self, request: dict[str, Any]) -> dict[str, Any]:
        required = {"version", "id", "method", "nonce", "sequence", "mac"}
        if not isinstance(request, dict) or set(request) - required - {"ref", "property", "value", "operation", "args"} or not required <= set(request):
            return self._error("invalid", "invalid request")
        unsigned = {key: value for key, value in request.items() if key != "mac"}
        if (
            request["version"] != PROTOCOL
            or not isinstance(request["id"], str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request["id"])
            or not isinstance(request["method"], str)
            or request["method"] not in METHODS
            or not isinstance(request["nonce"], str)
            or not isinstance(request["sequence"], int)
            or isinstance(request["sequence"], bool)
            or not 1 <= request["sequence"] <= (2**53 - 1)
            or not isinstance(request["mac"], str)
        ):
            return self._error(request.get("id", "invalid"), "invalid request")
        if request["method"] == "invoke":
            if not isinstance(request.get("operation"), str) or not re.fullmatch(r"[a-z]+(?:\.[a-z]+)+", request["operation"]):
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
            result = self._operation(request["method"], unsigned)
            return self._response(request["id"], True, result=result)
        except Exception:  # Remote Script must never leak operation details into the wire.
            return self._error(request["id"], "request failed")

    def new_nonce(self) -> str:
        return secrets.token_urlsafe(18)

    def _response(self, request_id: str, ok: bool, result: Any = None, error: str | None = None) -> dict[str, Any]:
        response: dict[str, Any] = {"version": PROTOCOL, "id": request_id, "ok": ok}
        if result is not None:
            response["result"] = result
        if error is not None:
            response["error"] = error
        response["mac"] = self.sign(response)
        return response

    def _error(self, request_id: str, message: str) -> dict[str, Any]:
        return self._response(request_id, False, error=message)

    def error_response(self, message: str = "malformed request") -> dict[str, Any]:
        """Return a MAC-bearing, redacted response for an unparseable frame."""
        return self._error("invalid", message)


class ReferenceRegistry:
    """Epoch-scoped opaque references; references never expose Live objects."""

    def __init__(self) -> None:
        self.epoch = secrets.randbelow(2**53 - 1) + 1
        self._objects: dict[str, Any] = {}
        self._revisions: dict[str, int] = {}
        self._object_keys: dict[tuple[str, int], str] = {}

    def reset(self) -> None:
        self.epoch = secrets.randbelow(2**53 - 1) + 1
        self._objects.clear()
        self._revisions.clear()
        self._object_keys.clear()

    def put(self, kind: str, obj: Any, key: str) -> str:
        stable_key = self._object_keys.setdefault((kind, id(obj)), key)
        reference = f"{self.epoch}:{kind}:{stable_key}"
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

    def __init__(self, song: Any, registry: ReferenceRegistry | None = None):
        self.song = song
        self.refs = registry or ReferenceRegistry()

    def status(self) -> dict[str, Any]:
        registry, registry_hash = operation_registry()
        operations = [item["id"] for item in registry["operations"] if item["id"] in SUPPORTED_OPERATIONS or item["id"] in {"status", "discover", "get", "set", "reconnect"}]
        return {
            "connected": self.song is not None,
            "adapter": "remote-script" if self.song is not None else "unavailable",
            "epoch": self.refs.epoch if self.song is not None else None,
            "protocol": "ableton-live/v1",
            "capabilities": self.capabilities(),
            "registryHash": registry_hash,
            "operations": operations,
        }

    def capabilities(self) -> list[str]:
        if self.song is None:
            return []
        capabilities = [
            "session.read", "session.write", "tracks", "scenes", "clips", "notes", "session.discovery", "session.structure",
            "session.midi_clip.create", "session.midi_clip.delete",
            "session.midi_note.read", "session.midi_note.write", "reconnect",
        ]
        if self._locator_supported():
            capabilities.extend(("arrangement.read", "arrangement.write"))
        if any(self._device_items(track) for track in self._items(getattr(self.song, "tracks", []))):
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

    def _device_items(self, track: Any) -> list[dict[str, Any]]:
        devices = self._items(getattr(track, "devices", getattr(track, "device_chain", [])))
        rows: list[dict[str, Any]] = []
        tracks = self._items(getattr(self.song, "tracks", []))
        track_index = tracks.index(track) if track in tracks else -1
        track_ref = self.refs.put("track", track, str(track_index))
        for index, device in enumerate(devices):
            parameters: list[dict[str, Any]] = []
            device_ref = self.refs.put("device", device, f"{id(track)}:{index}")
            for parameter_index, parameter in enumerate(self._items(getattr(device, "parameters", []))):
                minimum = getattr(parameter, "min", getattr(parameter, "min_value", None))
                maximum = getattr(parameter, "max", getattr(parameter, "max_value", None))
                value = getattr(parameter, "value", None)
                numeric = (minimum, maximum, value)
                if any(not isinstance(item, (int, float)) or isinstance(item, bool) or not math.isfinite(float(item)) for item in numeric):
                    continue
                parameter_ref = self.refs.put("parameter", parameter, f"{device_ref}:{parameter_index}")
                display = getattr(parameter, "display_value", None)
                if display is None:
                    display = getattr(parameter, "str_for_value", value)
                    if callable(display):
                        try:
                            display = display(value)
                        except Exception:
                            display = value
                parameters.append({
                    "ref": parameter_ref, "parentRef": device_ref,
                    "name": str(getattr(parameter, "name", f"Parameter {parameter_index + 1}")),
                    "value": float(value), "min": float(minimum), "max": float(maximum),
                    "quantization": float(getattr(parameter, "quantization", 0) or 0),
                    "enabled": bool(getattr(parameter, "is_enabled", getattr(parameter, "enabled", True))),
                    "automatable": bool(getattr(parameter, "is_automatable", getattr(parameter, "automatable", True))),
                    "automationState": str(getattr(parameter, "automation_state", "none")),
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

    def snapshot(self) -> dict[str, Any]:
        set_ref = self.refs.put("set", self.song, "song")
        tempo = getattr(self.song, "tempo", 120.0)
        position = getattr(self.song, "current_song_time", getattr(self.song, "song_time", 0.0))
        playing = getattr(self.song, "is_playing", False)
        if not isinstance(tempo, (int, float)) or isinstance(tempo, bool) or not math.isfinite(float(tempo)):
            tempo = 120.0
        if not isinstance(position, (int, float)) or isinstance(position, bool) or not math.isfinite(float(position)) or float(position) < 0:
            position = 0.0
        if not isinstance(playing, bool):
            playing = False
        tracks = self._items(getattr(self.song, "tracks", []))
        scenes = self._items(getattr(self.song, "scenes", []))
        track_rows = []
        for index, track in enumerate(tracks):
            track_ref = self.refs.put("track", track, str(index))
            slots = self._items(getattr(track, "clip_slots", []))
            clips = []
            slot_rows = []
            for slot_index, slot in enumerate(slots):
                clip = getattr(slot, "clip", None)
                if clip is None:
                    slot_rows.append({"ref": f"{self.refs.epoch}:clip_slot:{index}:{slot_index}", "trackRef": track_ref, "sceneIndex": slot_index, "empty": True})
                    continue
                clip_ref = self.refs.put("clip", clip, f"{index}:{slot_index}")
                notes = self._read_notes(clip)
                clips.append({"ref": clip_ref, "name": str(getattr(clip, "name", "")), "kind": "midi" if hasattr(clip, "add_new_notes") else "audio", "start": slot_index * 4, "length": float(getattr(clip, "length", 0.0)), "notes": notes})
                slot_rows.append({"ref": f"{self.refs.epoch}:clip_slot:{index}:{slot_index}", "trackRef": track_ref, "sceneIndex": slot_index, "clipRef": clip_ref, "empty": False})
            track_rows.append({"ref": track_ref, "name": str(getattr(track, "name", f"Track {index + 1}")), "kind": "midi" if bool(getattr(track, "has_midi_input", True)) else "audio", "clips": clips, "clipSlots": slot_rows, "devices": self._device_items(track)})
        scene_rows = [{"ref": self.refs.put("scene", scene, str(i)), "name": str(getattr(scene, "name", f"Scene {i + 1}")), "index": i} for i, scene in enumerate(scenes)]
        locators = self._locator_items()
        return {"set": {"ref": set_ref, "name": str(getattr(self.song, "name", "Live Set")), "tempo": float(tempo), "playing": playing, "position": float(position), "loop": {"enabled": bool(getattr(self.song, "loop", False)), "start": 0.0, "length": float(getattr(self.song, "loop_length", 4.0) or 4.0)}}, "tracks": track_rows, "scenes": scene_rows, "arrangement": {"locators": locators}, "epoch": self.refs.epoch}

    def _read_notes(self, clip: Any) -> list[dict[str, Any]]:
        if hasattr(clip, "get_notes"):
            raw = clip.get_notes(0, 0, 0, 128)
            return [dict(note) if isinstance(note, dict) else {"pitch": int(getattr(note, "pitch", 0)), "start": float(getattr(note, "start", 0)), "duration": float(getattr(note, "duration", 0)), "velocity": int(getattr(note, "velocity", 0)), "channel": int(getattr(note, "channel", 1))} for note in self._items(raw)][:MAX_WIRE_COLLECTION_LENGTH]
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

    def discover(self, kind: str, limit: int = 100, cursor: str | None = None) -> dict[str, Any]:
        if kind not in {"track", "scene", "clip", "note", "locator", "device", "parameter"}:
            raise ValueError("unsupported discovery kind")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
            raise ValueError("discovery limit is invalid")
        snapshot = self.snapshot()
        if kind == "track": items = snapshot["tracks"]
        elif kind == "scene": items = snapshot["scenes"]
        elif kind == "clip": items = [clip for track in snapshot["tracks"] for clip in track["clips"]]
        elif kind == "note": items = [note | {"ref": f"note:{clip['ref']}:{index}"} for track in snapshot["tracks"] for clip in track["clips"] for index, note in enumerate(clip["notes"])]
        elif kind == "locator": items = snapshot["arrangement"]["locators"]
        elif kind == "device": items = [device for track in snapshot["tracks"] for device in track["devices"]]
        else: items = [parameter for track in snapshot["tracks"] for device in track["devices"] for parameter in device["parameters"]]
        offset = 0
        if cursor is not None:
            try:
                decoded = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode("ascii")
                epoch, offset_text = decoded.split(":", 1)
                if int(epoch) != self.refs.epoch:
                    raise ValueError("stale discovery cursor")
                offset = int(offset_text)
            except (ValueError, TypeError, UnicodeError) as error:
                raise ValueError("invalid discovery cursor") from error
        if not 0 <= offset <= len(items):
            raise ValueError("invalid discovery cursor")
        page = items[offset:offset + limit]
        next_offset = offset + len(page)
        next_cursor = base64.urlsafe_b64encode(f"{self.refs.epoch}:{next_offset}".encode("ascii")).decode("ascii").rstrip("=") if next_offset < len(items) else None
        return {"epoch": self.refs.epoch, "items": page, "truncated": next_cursor is not None, "revision": f"{self.refs.epoch}:{len(items)}", **({"nextCursor": next_cursor} if next_cursor else {})}

    def invoke(self, operation: str, args: dict[str, Any]) -> Any:
        if operation == "session.discover":
            return self.discover(str(args.get("kind", "track")), int(args.get("limit", 100)), args.get("cursor") if isinstance(args.get("cursor"), str) else None)
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
            ref = self.refs.put("track", track, f"created:{id(track)}")
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
            ref = self.refs.put("scene", scene, f"created:{id(scene)}")
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
            return {"ref": self.refs.put("clip", clip, f"{args['trackRef']}:{index}"), "name": getattr(clip, "name", ""), "length": float(getattr(clip, "length", length))}
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
        clip.add_new_notes([note])
        return {"added": True}


class _MainThreadQueue:
    def __init__(self) -> None:
        self.items: queue.Queue[tuple[Callable[[], Any], threading.Event, list[Any]]] = queue.Queue(MAX_QUEUE_ITEMS)
        self._closed = False
        self._lock = threading.Lock()

    def submit(self, callback: Callable[[], Any], timeout: float = DEFAULT_TIMEOUT_SECONDS) -> Any:
        event = threading.Event()
        result: list[Any] = []
        with self._lock:
            if self._closed:
                raise RuntimeError("Live bridge is disconnected")
            self.items.put_nowait((callback, event, result))
        if not event.wait(timeout):
            raise TimeoutError("Live main-thread operation timed out")
        if result and isinstance(result[0], BaseException):
            raise result[0]
        return result[0] if result else None

    def close(self) -> None:
        with self._lock:
            self._closed = True
            while True:
                try:
                    _, event, result = self.items.get_nowait()
                except queue.Empty:
                    break
                result.append(RuntimeError("Live bridge is disconnected"))
                event.set()

    def drain(self, budget: int = MAX_QUEUE_ITEMS) -> int:
        count = 0
        while count < budget:
            try: callback, event, result = self.items.get_nowait()
            except queue.Empty: break
            try: result.append(callback())
            except BaseException as exc: result.append(exc)
            event.set(); count += 1
        return count


class AbletonMcpBridge:
    """Installable Control Surface boundary with fail-closed loopback listener."""

    def __init__(self, c_instance: Any, config: dict[str, Any] | None = None, song: Any = None):
        config = config or {}
        host = config.get("host", "")
        port = config.get("port", 0)
        secret = config.get("secret", "")
        if host not in {"127.0.0.1", "::1"} or not isinstance(port, int) or not 1 <= port <= 65535 or not isinstance(secret, str) or len(secret) < 32:
            raise ValueError("explicit loopback host, port, and strong secret are required")
        self.c_instance = c_instance
        self.queue = _MainThreadQueue()
        self.mapper = LiveObjectMapper(song if song is not None else getattr(c_instance, "song", None))
        self.auth = AuthenticatedRemoteScript(secret, self._dispatch)
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
        return self.queue.submit(lambda: self._dispatch_main(method, request))

    def _dispatch_main(self, method: str, request: dict[str, Any]) -> Any:
        return self._dispatch_main_for(method, request, self.mapper)

    @staticmethod
    def _dispatch_main_for(method: str, request: dict[str, Any], mapper: LiveObjectMapper) -> Any:
        if method == "status": return mapper.status()
        if method == "snapshot": return mapper.snapshot()
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
        mapper = LiveObjectMapper(self.mapper.song)
        auth = AuthenticatedRemoteScript(self._secret_value, lambda method, request: self.queue.submit(lambda: self._dispatch_main_for(method, request, mapper)))
        try:
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
                    except Exception: response = self.auth.error_response()
                    client.sendall(json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
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
