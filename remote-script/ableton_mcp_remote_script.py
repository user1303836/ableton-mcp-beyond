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
from typing import Any, Callable

PROTOCOL = "ableton-loopback/v1"
METHODS = {"status", "snapshot", "get", "set", "invoke", "subscribe", "reconnect"}
MAX_NONCE_LENGTH = 256


class AuthenticatedRemoteScript:
    def __init__(self, secret: str, operation: Callable[[str, dict[str, Any]], Any]):
        if len(secret) < 32:
            raise ValueError("loopback secret must contain at least 32 characters")
        self._secret = secret.encode("utf-8")
        self._operation = operation
        self._last_sequence = 0

    def sign(self, payload: dict[str, Any]) -> str:
        encoded = self._canonical(payload).encode("utf-8")
        return base64.urlsafe_b64encode(hmac.new(self._secret, encoded, hashlib.sha256).digest()).decode("ascii").rstrip("=")

    @classmethod
    def _canonical(cls, value: Any) -> str:
        if value is None or isinstance(value, (str, bool)):
            return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        if isinstance(value, int):
            return str(value)
        if isinstance(value, float):
            if not math.isfinite(value):
                raise ValueError("non-finite wire number")
            if value == 0 or value.is_integer():
                return str(int(value))
            encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            return re.sub(r"e([+-])0+(\d+)", r"e\1\2", encoded)
        if isinstance(value, list):
            return "[" + ",".join(cls._canonical(item) for item in value) + "]"
        if isinstance(value, dict):
            return "{" + ",".join(json.dumps(key, ensure_ascii=False) + ":" + cls._canonical(value[key]) for key in sorted(value)) + "}"
        raise TypeError("unsupported wire value")

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
            or not isinstance(request["mac"], str)
        ):
            return self._error(request.get("id", "invalid"), "invalid request")
        if request["method"] == "invoke":
            if not isinstance(request.get("operation"), str) or not re.fullmatch(r"[a-z]+\.[a-z]+", request["operation"]):
                return self._error(request["id"], "operation is required")
            if not isinstance(request.get("args", {}), dict) or len(request.get("args", {})) > 32:
                return self._error(request["id"], "args must be a bounded object")
        if len(request["nonce"]) < 16 or len(request["nonce"]) > MAX_NONCE_LENGTH or request["sequence"] <= self._last_sequence or not hmac.compare_digest(self.sign(unsigned), request["mac"]):
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
