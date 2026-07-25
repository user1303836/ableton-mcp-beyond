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
from typing import Any, Callable

PROTOCOL = "ableton-loopback/v1"
METHODS = {"status", "snapshot", "get", "set", "subscribe", "reconnect"}
MAX_NONCE_LENGTH = 256


class AuthenticatedRemoteScript:
    def __init__(self, secret: str, operation: Callable[[str, dict[str, Any]], Any]):
        if len(secret) < 32:
            raise ValueError("loopback secret must contain at least 32 characters")
        self._secret = secret.encode("utf-8")
        self._operation = operation
        self._seen_nonces: set[str] = set()
        self._nonce_order: list[str] = []

    def sign(self, payload: dict[str, Any]) -> str:
        encoded = json.dumps(payload, separators=(",", ":"), sort_keys=False).encode("utf-8")
        return base64.urlsafe_b64encode(hmac.new(self._secret, encoded, hashlib.sha256).digest()).decode("ascii").rstrip("=")

    def dispatch(self, request: dict[str, Any]) -> dict[str, Any]:
        required = {"version", "id", "method", "nonce", "mac"}
        if not isinstance(request, dict) or set(request) - required - {"ref", "property", "value"} or not required <= set(request):
            return self._error("invalid", "invalid request")
        unsigned = {key: value for key, value in request.items() if key != "mac"}
        if (
            request["version"] != PROTOCOL
            or not isinstance(request["id"], str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request["id"])
            or not isinstance(request["method"], str)
            or request["method"] not in METHODS
            or not isinstance(request["nonce"], str)
            or not isinstance(request["mac"], str)
        ):
            return self._error(request.get("id", "invalid"), "invalid request")
        if len(request["nonce"]) < 16 or len(request["nonce"]) > MAX_NONCE_LENGTH or request["nonce"] in self._seen_nonces or not hmac.compare_digest(self.sign(unsigned), request["mac"]):
            return self._error(request["id"], "authentication or replay check failed")
        self._seen_nonces.add(request["nonce"])
        self._nonce_order.append(request["nonce"])
        if len(self._nonce_order) > 4096:
            expired = self._nonce_order.pop(0)
            self._seen_nonces.remove(expired)
        try:
            result = self._operation(request["method"], unsigned)
            return self._response(request["id"], True, result=result)
        except Exception as error:  # Remote Script must never leak a traceback into the wire.
            return self._error(request["id"], str(error))

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
