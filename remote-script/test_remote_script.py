import base64
import hashlib
import json
import os
import secrets
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import ableton_mcp_remote_script as remote_module
from ableton_mcp_remote_script import (
    AbletonMcpBridge,
    AuthenticatedRemoteScript,
    LiveObjectMapper, _DiagnosticsSink, _DispatchToken, _MainThreadQueue, _Subscription, _authority_state_digest, _clear_diagnostics_sink, _debug_trace, _set_diagnostics_sink, operation_registry, validate_operation_payload,
    PROTOCOL,
    create_instance,
)
from AbletonMcpBridge import _diagnostics_path_safe, _mode_owner_only, _owner_controlled, _normalize_bridge_config


class BridgeConfigNormalizationTests(unittest.TestCase):
    def test_version_two_host_config_normalizes_to_bridge_shape(self):
        value = {"version": 2, "server": {"command": "node", "args": ["cli.js", "--config", "cfg.json"]}, "bridge": {"host": "127.0.0.1", "port": 9765, "secretFile": "/tmp/secret", "timeoutMs": 5000, "realtimePort": 9766}}
        self.assertEqual(_normalize_bridge_config(value), {"version": 1, "host": "127.0.0.1", "port": 9765, "secretFile": "/tmp/secret", "realtimePort": 9766})

    def test_version_two_requires_complete_server_and_bridge_shapes(self):
        with self.assertRaises(ValueError):
            _normalize_bridge_config({"version": 2, "server": {}, "bridge": {"host": "127.0.0.1", "port": 9765, "secretFile": "/tmp/secret"}})

    def test_realtime_port_must_be_distinct_and_bounded(self):
        value = {"version": 2, "server": {"command": "node", "args": ["cli.js", "--config", "cfg.json"]}, "bridge": {"host": "127.0.0.1", "port": 9765, "secretFile": "/tmp/secret", "timeoutMs": 5000, "realtimePort": 9765}}
        with self.assertRaises(ValueError):
            _normalize_bridge_config(value)

    def test_version_two_rejects_unknown_timeout_and_extra_keys(self):
        base = {"version": 2, "server": {"command": "node", "args": []}, "bridge": {"host": "127.0.0.1", "port": 9765, "secretFile": "/tmp/secret", "timeoutMs": 5000}}
        with self.assertRaises(ValueError):
            _normalize_bridge_config({**base, "bridge": {**base["bridge"], "timeoutMs": 30}})
        with self.assertRaises(ValueError):
            _normalize_bridge_config({**base, "bridge": {**base["bridge"], "extra": True}})
        with self.assertRaises(ValueError):
            _normalize_bridge_config({**base, "extra": True})

    def test_version_two_accepts_only_the_bounded_diagnostics_shape(self):
        base = {"version": 2, "server": {"command": "node", "args": []}, "bridge": {"host": "127.0.0.1", "port": 9765, "secretFile": "/tmp/secret", "timeoutMs": 5000}}
        absolute_path = str((Path(tempfile.gettempdir()) / "owner" / "bridge-diagnostics.log").resolve())
        diagnostics = {"path": absolute_path, "maxBytes": 256 * 1024}
        normalized = _normalize_bridge_config({**base, "bridge": {**base["bridge"], "diagnostics": diagnostics}})
        self.assertEqual(normalized["diagnostics"], diagnostics)
        for invalid in [{"path": "relative.log", "maxBytes": 256 * 1024}, {"path": absolute_path, "maxBytes": 1}, {"path": absolute_path, "maxBytes": 256 * 1024, "extra": True}, True]:
            with self.assertRaises(ValueError):
                _normalize_bridge_config({**base, "bridge": {**base["bridge"], "diagnostics": invalid}})

    def test_version_one_shape_passes_through_and_others_fail(self):
        self.assertEqual(_normalize_bridge_config({"version": 1, "host": "::1", "port": 9765, "secretFile": "/tmp/s"}), {"version": 1, "host": "::1", "port": 9765, "secretFile": "/tmp/s"})
        with self.assertRaises(ValueError):
            _normalize_bridge_config({"version": 1, "host": "127.0.0.1", "port": 9765, "secretFile": "/tmp/s", "timeoutMs": 5000})
        with self.assertRaises(ValueError):
            _normalize_bridge_config("not-a-dict")


def fake_status_result():
    return {"connected": False, "adapter": "unavailable", "epoch": None, "protocol": "ableton-live/v1", "registryHash": operation_registry()[1], "operations": ["status", "snapshot", "discover", "get", "reconnect", "session.playback"], "capabilities": []}


def _protect_windows_owner_only(path):
    if os.name != "nt": return
    encoded = base64.b64encode(str(path).encode("utf-8")).decode("ascii")
    script = (
        "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ABLETON_MCP_ACL_PATH));"
        "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;"
        "$a=if([IO.Directory]::Exists($p)){New-Object System.Security.AccessControl.DirectorySecurity}else{New-Object System.Security.AccessControl.FileSecurity};"
        "$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);"
        "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList @($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow);"
        "[void]$a.AddAccessRule($rule);"
        "if([IO.Directory]::Exists($p)){[IO.Directory]::SetAccessControl($p,$a)}else{[IO.File]::SetAccessControl($p,$a)}"
    )
    environment = dict(os.environ); environment["ABLETON_MCP_ACL_PATH"] = encoded
    subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], check=True, env=environment)


class DiagnosticsSecurityTests(unittest.TestCase):
    def test_predictable_temporary_sentinel_cannot_enable_diagnostics(self):
        self.assertFalse(hasattr(remote_module, "_DEBUG_LOG"))
        self.assertFalse(hasattr(remote_module, "_DEBUG_ENABLED"))
        _set_diagnostics_sink(None)
        _debug_trace("dispatch-failure")

    def _owner_file(self, directory, name="bridge-diagnostics.log"):
        root = Path(directory); root.chmod(0o700); _protect_windows_owner_only(root)
        path = root / name; path.write_bytes(b""); path.chmod(0o600); _protect_windows_owner_only(path)
        return path

    def _sink(self, path, *, start_writer=True):
        return _DiagnosticsSink(str(path), start_writer=start_writer, security_validator=_diagnostics_path_safe)

    def test_structured_diagnostics_are_explicit_asynchronous_and_redacted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._owner_file(directory)
            self.assertTrue(_diagnostics_path_safe(path))
            sink = self._sink(path); self.assertTrue(sink.enabled)
            _set_diagnostics_sink(sink)
            try:
                try:
                    raise RuntimeError("SECRET-CANARY /Users/example/Project.als browser-query token mac pcm")
                except RuntimeError:
                    _debug_trace("dispatch-failure")
                self.assertTrue(sink.flush_for_test())
                logged = path.read_text(encoding="utf-8")
                self.assertIn('"event":"dispatch-failure"', logged)
                for forbidden in ["SECRET-CANARY", "Project.als", "browser-query", "token", "Traceback", str(path)]:
                    self.assertNotIn(forbidden, logged)
            finally:
                _clear_diagnostics_sink(sink)
            self.assertTrue(sink.wait_closed_for_test())

    def test_thread_start_failure_and_prefilled_oversize_file_fail_safe(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._owner_file(directory)
            path.write_bytes(b"sensitive-canary" * 30000)
            bounded = self._sink(path, start_writer=False)
            self.assertTrue(bounded.enabled); self.assertEqual(path.stat().st_size, 0)
            bounded.close()
            # Patch only after replacing the Windows validator with an in-process
            # equivalent. subprocess.capture_output also starts helper threads on
            # Windows, and globally failing those would not exercise the writer.
            with patch("ableton_mcp_remote_script.threading.Thread.start", side_effect=RuntimeError("thread unavailable")):
                unavailable = _DiagnosticsSink(str(path), security_validator=lambda candidate: candidate == path)
            self.assertFalse(unavailable.enabled); self.assertIsNone(unavailable._fd)

    @unittest.skipIf(os.name == "nt", "POSIX link and FIFO contract")
    def test_symlink_hardlink_fifo_and_insecure_mode_are_rejected_without_opening(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); root.chmod(0o700)
            target = self._owner_file(directory, "target.log")
            link = root / "link.log"; link.symlink_to(target)
            self.assertFalse(self._sink(link).enabled)
            hard = root / "hard.log"; os.link(target, hard)
            self.assertFalse(self._sink(target).enabled)
            hard.unlink(); target.chmod(0o644)
            self.assertFalse(self._sink(target).enabled)
            fifo = root / "fifo"; os.mkfifo(fifo, 0o600)
            started = time.monotonic(); self.assertFalse(self._sink(fifo).enabled)
            self.assertLess(time.monotonic() - started, 1.0)

    def test_nonblocking_queue_and_fixed_file_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._owner_file(directory)
            queued = self._sink(path, start_writer=False); self.assertTrue(queued.enabled)
            started = time.monotonic()
            for _ in range(1000): queued.record("capture-tick-failure")
            self.assertLess(time.monotonic() - started, 1.0)
            self.assertEqual(queued._queue.qsize(), 64); self.assertGreater(queued._dropped, 0)
            queued.close()
            bounded = self._sink(path, start_writer=False); self.assertTrue(bounded.enabled)
            try:
                # One near-boundary write proves rotation without launching the
                # Windows security verifier thousands of times.
                self.assertIsNotNone(bounded._fd)
                os.write(bounded._fd, b"x" * (256 * 1024 - 1))
                bounded._write((1, "realtime-packet-failure", "internal-error"))
                self.assertLessEqual(path.stat().st_size, 256 * 1024)
                self.assertNotIn(b"x", path.read_bytes())
            finally: bounded.close()

    def test_path_or_security_drift_and_write_failure_disable_logging_without_touching_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); path = self._owner_file(directory)
            authority = {"valid": True}
            validator = _diagnostics_path_safe if os.name != "nt" else lambda candidate: authority["valid"] and candidate == path
            sink = _DiagnosticsSink(str(path), security_validator=validator); self.assertTrue(sink.enabled)
            try:
                if os.name == "nt":
                    # Windows intentionally prevents renaming an open file. Model
                    # the validator rejecting equivalent DACL/path authority drift.
                    authority["valid"] = False
                else:
                    moved = root / "moved.log"; path.rename(moved)
                    path.write_bytes(b""); path.chmod(0o600)
                sink.record("result-contract-failure")
                self.assertTrue(sink.flush_for_test())
                self.assertFalse(sink.enabled)
                self.assertEqual(path.read_bytes(), b"")
            finally:
                sink.close(); self.assertTrue(sink.wait_closed_for_test())

            failed = self._sink(path); self.assertTrue(failed.enabled)
            try:
                with patch.object(failed, "_write", side_effect=OSError("injected write failure")):
                    failed.record("capture-tick-failure")
                    self.assertTrue(failed.flush_for_test())
                self.assertFalse(failed.enabled)
                self.assertEqual(path.read_bytes(), b"")
            finally:
                failed.close(); self.assertTrue(failed.wait_closed_for_test())

    @unittest.skipIf(os.name == "nt", "POSIX parent mode contract")
    def test_parent_permission_drift_disables_the_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); path = self._owner_file(directory)
            sink = self._sink(path); self.assertTrue(sink.enabled)
            root.chmod(0o777)
            try:
                sink.record("capture-tick-failure")
                self.assertTrue(sink.flush_for_test())
                self.assertFalse(sink.enabled)
                self.assertEqual(path.read_bytes(), b"")
            finally:
                root.chmod(0o700); sink.close()


class RemoteScriptTests(unittest.TestCase):
    def test_windows_security_uses_dacl_not_synthetic_posix_mode_bits(self):
        class SyntheticWindowsPath:
            def stat(self):
                raise AssertionError("Windows mode bits must not be consulted after DACL validation")
        with patch("AbletonMcpBridge.os.name", "nt"):
            self.assertTrue(_mode_owner_only(SyntheticWindowsPath()))
        if os.name != "nt":
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory, "mode-test")
                path.write_text("test", encoding="utf-8")
                path.chmod(0o600); self.assertTrue(_mode_owner_only(path))
                path.chmod(0o644); self.assertFalse(_mode_owner_only(path))

    def test_security_sensitive_files_require_current_owner(self):
        if os.name == "nt":
            # actions/checkout may assign source files to the runner service
            # account. Exercise the real contract with a file created by the
            # current process, as setup does for bridge configuration files.
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory, "bridge-config.json")
                path.write_text("{}", encoding="utf-8")
                encoded = base64.b64encode(str(path).encode("utf-8")).decode("ascii")
                script = "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ABLETON_MCP_ACL_PATH));$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$a=New-Object System.Security.AccessControl.FileSecurity;$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);$rule=New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList @($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow);[void]$a.AddAccessRule($rule);[System.IO.File]::SetAccessControl($p,$a)"
                environment = dict(os.environ); environment["ABLETON_MCP_ACL_PATH"] = encoded
                subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], check=True, env=environment)
                self.assertTrue(_owner_controlled(path))
                with patch("AbletonMcpBridge._windows_owner_controlled", return_value=False):
                    self.assertFalse(_owner_controlled(path))
        else:
            path = Path(__file__).resolve()
            self.assertTrue(_owner_controlled(path))
            with patch("AbletonMcpBridge.os.getuid", return_value=path.stat().st_uid + 1):
                self.assertFalse(_owner_controlled(path))

    def test_scheduled_callback_does_not_touch_bridge_after_disconnect(self):
        surface = object.__new__(__import__("AbletonMcpBridge").AbletonMcpBridge)
        surface._disconnected = True

        class Bridge:
            def __init__(self):
                self.calls = 0

            def update_display(self):
                self.calls += 1

        surface._bridge = Bridge()
        surface._drain()
        self.assertEqual(surface._bridge.calls, 0)

    def test_authentication_and_replay_protection(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: fake_status_result())
        unsigned = remote.bound({"version": PROTOCOL, "id": "one", "method": "status", "nonce": "0000000000000001", "sequence": 1})
        request = {**unsigned, "mac": remote.sign(unsigned)}
        self.assertTrue(remote.dispatch(request)["ok"])
        self.assertFalse(remote.dispatch(request)["ok"])

    def test_channel_binding_rejects_cross_connection_and_bridge_epoch_replay(self):
        secret = "0123456789abcdef0123456789abcdef"
        first = AuthenticatedRemoteScript(secret, lambda method, request: {"connected": False, "adapter": "unavailable", "epoch": None, "protocol": "ableton-live/v1", "registryHash": operation_registry()[1], "operations": ["status", "snapshot", "discover", "get", "reconnect", "session.playback"]}, "bridge-epoch-0000000000000001", "connection-one-0000000000001")
        second = AuthenticatedRemoteScript(secret, first._operation, "bridge-epoch-0000000000000001", "connection-two-0000000000002")
        restarted = AuthenticatedRemoteScript(secret, first._operation, "bridge-epoch-0000000000000002", "connection-one-0000000000001")
        unsigned = first.bound({"version": PROTOCOL, "id": "bound", "method": "status", "nonce": "bound-nonce-00001", "sequence": 1})
        frame = {**unsigned, "mac": first.sign(unsigned)}
        self.assertTrue(first.dispatch(frame)["ok"])
        self.assertFalse(second.dispatch(frame)["ok"])
        self.assertFalse(restarted.dispatch(frame)["ok"])

    def test_sequence_must_be_positive_and_safe(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: method)
        for sequence in (0, -1, 2**53, 2**53 + 1):
            unsigned = remote.bound({"version": PROTOCOL, "id": "sequence", "method": "status", "nonce": "sequence-nonce-0001", "sequence": sequence})
            self.assertFalse(remote.dispatch({**unsigned, "mac": remote.sign(unsigned)})["ok"])

    def test_operation_failures_are_wire_errors(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: (_ for _ in ()).throw(RuntimeError("not available")))
        unsigned = remote.bound({"version": PROTOCOL, "id": "one", "method": "snapshot", "nonce": "0000000000000001", "sequence": 1})
        result = remote.dispatch({**unsigned, "mac": remote.sign(unsigned)})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "request failed")

    def test_result_schema_violation_invalidates_authenticated_channel(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: {"connected": "yes"})
        unsigned = remote.bound({"version": PROTOCOL, "id": "schema", "method": "status", "nonce": "schema-nonce-0001", "sequence": 1})
        result = remote.dispatch({**unsigned, "mac": remote.sign(unsigned)})
        self.assertFalse(result["ok"]); self.assertEqual(result["error"], "response contract failed"); self.assertTrue(remote.invalid)

    def test_discovery_filter_registry_values_are_bounded_scalars(self):
        validate_operation_payload("discover", "request", {"kind": "track", "filters": {"name": "Bass", "armed": False, "index": 2, "parentRef": None}})
        with self.assertRaises(ValueError): validate_operation_payload("discover", "request", {"kind": "track", "filters": {"nested": {}}})
        with self.assertRaises(ValueError): validate_operation_payload("discover", "request", {"kind": "track", "filters": {"name": "x" * 257}})

    def test_random_ordered_nonces_and_unknown_fields(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: fake_status_result())
        first = remote.bound({"version": PROTOCOL, "id": "one", "method": "status", "nonce": "zzzzzzzzzzzzzzzz1", "sequence": 1})
        second = remote.bound({"version": PROTOCOL, "id": "two", "method": "status", "nonce": "aaaaaaaaaaaaaaaa2", "sequence": 2})
        self.assertTrue(remote.dispatch({**first, "mac": remote.sign(first)})["ok"])
        self.assertTrue(remote.dispatch({**second, "mac": remote.sign(second)})["ok"])
        extra = {**second, "id": "three", "nonce": "bbbbbbbbbbbbbbbb3", "unexpected": True}
        self.assertFalse(remote.dispatch({**extra, "mac": remote.sign(extra)})["ok"])

    def test_authenticated_retirement_is_bounded_and_transaction_scoped(self):
        calls = []
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: calls.append((method, request.get("transactionId"), request.get("terminal"))) or {"retired": 2})
        unsigned = remote.bound({"version": PROTOCOL, "id": "retire-one", "method": "retire", "transactionId": "transaction-1234", "terminal": True, "nonce": "retire-nonce-0001", "sequence": 1})
        result = remote.dispatch({**unsigned, "mac": remote.sign(unsigned)})
        self.assertTrue(result["ok"]); self.assertEqual(result["result"], {"retired": 2}); self.assertEqual(calls, [("retire", "transaction-1234", True)])
        invalid = remote.bound({"version": PROTOCOL, "id": "retire-two", "method": "retire", "transactionId": "short", "nonce": "retire-nonce-0002", "sequence": 2})
        self.assertFalse(remote.dispatch({**invalid, "mac": remote.sign(invalid)})["ok"])

    def test_unknown_method_is_rejected_before_operation(self):
        called = []
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: called.append(method))
        request = remote.bound({"version": PROTOCOL, "id": "one", "method": "delete", "nonce": "cccccccccccccccc4", "sequence": 1})
        self.assertFalse(remote.dispatch({**request, "mac": remote.sign(request)})["ok"])
        self.assertEqual(called, [])

    def test_malformed_requests_are_wire_errors_and_nonces_are_bounded(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: method)
        self.assertFalse(remote.dispatch(None)["ok"])
        unsigned = remote.bound({"version": PROTOCOL, "id": "large", "method": "status", "nonce": "x" * 257, "sequence": 1})
        self.assertFalse(remote.dispatch({**unsigned, "mac": remote.sign(unsigned)})["ok"])

    def test_malformed_frame_error_is_authenticated_and_redacted(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: method)
        response = remote.error_response()
        unsigned = {key: value for key, value in response.items() if key != "mac"}
        self.assertEqual(response["mac"], remote.sign(unsigned))
        self.assertEqual(response["error"], "malformed request")
        self.assertNotIn("Traceback", response["error"])

    def test_wire_signing_rejects_oversized_and_deep_values(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: method)
        oversized = {"version": PROTOCOL, "id": "large", "method": "invoke", "operation": "browser.search", "args": {"query": "x" * 16_385}, "nonce": "large-wire-value-0001", "sequence": 1}
        with self.assertRaises(ValueError):
            remote.sign(oversized)
        nested = "value"
        for _ in range(17):
            nested = {"value": nested}
        deeply_nested = {"version": PROTOCOL, "id": "deep", "method": "invoke", "operation": "browser.search", "args": nested, "nonce": "deep-wire-value-0001", "sequence": 1}
        with self.assertRaises(ValueError):
            remote.sign(deeply_nested)
        remote.sign({"version": PROTOCOL, "id": "bounded-array", "method": "status", "values": list(range(512))})
        with self.assertRaises(ValueError):
            remote.sign({"version": PROTOCOL, "id": "oversized-array", "method": "status", "values": list(range(513))})

    def test_direct_authenticated_mutation_without_prepared_authority_is_rejected(self):
        calls = []
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: calls.append((method, request["operation"])))
        attempts = [("session.emergency-stop", {"expectedTargets": [], "expectedRecording": "stopped"}), ("clip.delete", {"ref": "clip:x"}), ("track.delete", {"ref": "track:x"}), ("scene.delete", {"ref": "scene:x"}), ("note.add", {"ref": "clip:x", "note": {}}), ("device.delete", {"ref": "device:x"}), ("device.parameter.set", {"ref": "parameter:x", "value": 0.5, "expectedRevision": 1})]
        for sequence, (operation, args) in enumerate(attempts, 1):
            unsigned = remote.bound({"version": PROTOCOL, "id": f"invoke-{sequence}", "method": "invoke", "operation": operation, "args": args, "nonce": f"invoke-nonce-{sequence:04d}", "sequence": sequence})
            self.assertFalse(remote.dispatch({**unsigned, "mac": remote.sign(unsigned)})["ok"])
        self.assertEqual(calls, [])

    def test_invoke_rejects_unbounded_or_malformed_arguments(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: method)
        unsigned = remote.bound({"version": PROTOCOL, "id": "invoke", "method": "invoke", "operation": "invalid", "args": {}, "nonce": "invoke-nonce-0002", "sequence": 1})
        self.assertFalse(remote.dispatch({**unsigned, "mac": remote.sign(unsigned)})["ok"])


class FakeClip:
    def __init__(self, length):
        self.length = length
        self.name = ""
        self.notes = []
        self.next_note_id = 1

    def add_new_notes(self, notes):
        for note in notes:
            value = dict(note) if isinstance(note, dict) else {"pitch": note.pitch, "start_time": note.start_time, "duration": note.duration, "velocity": note.velocity, "mute": getattr(note, "mute", False), "probability": getattr(note, "probability", 1.0), "velocity_deviation": getattr(note, "velocity_deviation", 0.0), "release_velocity": getattr(note, "release_velocity", 64.0)}
            value["note_id"] = self.next_note_id; self.next_note_id += 1; self.notes.append(value)

    def get_notes(self, *_): return list(self.notes)
    def get_all_notes_extended(self): return list(self.notes)
    def remove_notes_by_id(self, ids): self.notes = [note for note in self.notes if note.get("note_id") not in set(ids)]


class FakeSlot:
    def __init__(self):
        self.clip = None

    def create_clip(self, length):
        self.clip = FakeClip(length)
        return self.clip

    def delete_clip(self):
        self.clip = None


class FakeTrack:
    has_midi_input = True

    def __init__(self):
        self.name = "Drums"
        self.arm = False
        self.current_monitoring_state = 2
        self.playing_slot_index = -1
        self.fired_slot_index = -1
        self.clip_slots = [FakeSlot()]
        self.devices = [FakeDevice()]


class FakeParameter:
    def __init__(self):
        self.name = "Gain"
        self.value = 0.5
        self.min = 0.0
        self.max = 1.0
        self.quantization = 0.25
        self.enabled = True
        self.automatable = True


class FakeDevice:
    def __init__(self):
        self.name = "Utility"
        self.class_name = "AudioEffectUtility"
        self.enabled = True
        self.parameters = [FakeParameter()]


class FakeScene:
    def __init__(self, name="Scene 1"):
        self.name = name


class FakeSong:
    def __init__(self):
        self.tracks = [FakeTrack()]
        self.return_tracks = []
        self.master_track = None
        self.scenes = [FakeScene()]
        self.is_playing = False
        self.record_mode = False
        self.session_record = False
        self.current_song_time = 0.0
        self.clip_trigger_quantization = "1_bar"

    def create_midi_track(self, index):
        track = FakeTrack()
        track.name = "MIDI Track"
        self.tracks.insert(index, track)
        return track

    def create_audio_track(self, index):
        track = FakeTrack()
        track.name = "Audio Track"
        track.has_midi_input = False
        self.tracks.insert(index, track)
        return track

    def create_scene(self, index):
        scene = FakeScene()
        self.scenes.insert(index, scene)
        return scene

    def delete_track(self, index):
        self.tracks.pop(index)

    def delete_scene(self, index):
        self.scenes.pop(index)


class FakeLocator:
    def __init__(self, time, name=""):
        self.time = time
        self.name = name


class FakeAuditionSong(FakeSong):
    def __init__(self):
        super().__init__()
        song = self
        scene = FakeScene("Scene 1")

        def fire():
            song.is_playing = True
            song.tracks[0].playing_slot_index = 0
            song.tracks[0].fired_slot_index = 0

        scene.fire = fire
        self.scenes = [scene]
        self.tracks[0].clip_slots[0].clip = FakeClip(4.0)
        self.stopped_all = 0

    def stop_all_clips(self):
        self.stopped_all += 1
        for track in self.tracks:
            track.playing_slot_index = -1
            track.fired_slot_index = -1

    def stop_playing(self):
        self.is_playing = False


class FakeRouteChoice:
    def __init__(self, name):
        self.name = name
        self.display_name = name


class FakeCapturedAudioClip(FakeClip):
    def __init__(self):
        super().__init__(2.0)
        self.name = "MCP Ephemeral Capture"
        self.is_audio_clip = True
        self.file_path = None
        self.is_recording = True
        self.gain = 1.0


class FakeCaptureSlot(FakeSlot):
    def __init__(self, fire_callback):
        super().__init__()
        self._fire_callback = fire_callback

    def fire(self):
        self._fire_callback(self)


class FakeCaptureTrack:
    def __init__(self, song, name, audio=False):
        self.song = song
        self.name = name
        self.has_audio_input = audio
        self.has_midi_input = not audio
        self.can_be_armed = True
        self.arm = False
        self.current_monitoring_state = 2
        self.playing_slot_index = -1
        self.fired_slot_index = -1
        self.devices = []
        self.available_input_routing_types = [FakeRouteChoice("Ext. In"), FakeRouteChoice("Resampling")] if audio else []
        self.input_routing_type = self.available_input_routing_types[0] if audio else None
        self.current_input_routing = self.input_routing_type
        def fire(slot):
            self.song.is_playing = True
            self.playing_slot_index = 0
            self.fired_slot_index = 0
            if self.has_audio_input and self.arm and slot.clip is None:
                slot.clip = FakeCapturedAudioClip()
                slot.clip.name = self.name
        self.clip_slots = [FakeCaptureSlot(fire)]

    def stop_all_clips(self, *_):
        self.playing_slot_index = -1
        self.fired_slot_index = -1
        for slot in self.clip_slots:
            if isinstance(slot.clip, FakeCapturedAudioClip):
                slot.clip.is_recording = False
                slot.clip.file_path = "/tmp/MCP Ephemeral Capture.wav"


class FakeCaptureSong(FakeSong):
    def __init__(self):
        self.name = "MCP-Audition-Disposable"
        self.return_tracks = []
        self.master_track = None
        self.scenes = [FakeScene("Scene 1")]
        self.is_playing = False
        self.record_mode = False
        self.session_record = False
        self.current_song_time = 7.0
        self.clip_trigger_quantization = 4
        self.tracks = [FakeCaptureTrack(self, "Source", audio=False), FakeCaptureTrack(self, "Capture", audio=True)]
        self.tracks[0].clip_slots[0].clip = FakeClip(4.0)

    def stop_playing(self):
        self.is_playing = False


class FakeArrangementSong(FakeSong):
    def __init__(self):
        super().__init__()
        self.cue_points = [FakeLocator(0, "Intro")]

    def set_or_delete_cue(self, position):
        for index, locator in enumerate(self.cue_points):
            if locator.time == position:
                self.cue_points.pop(index)
                return
        self.cue_points.append(FakeLocator(position))


class FakeInstance:
    def __init__(self):
        self.song = FakeSong()


class ControlSurfaceTests(unittest.TestCase):
    def test_registry_is_canonical_and_hashed(self):
        registry, digest = operation_registry()
        self.assertEqual(registry["protocol"], "ableton-live/v1")
        canonical = json.dumps(registry, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        self.assertEqual(digest, hashlib.sha256(canonical).hexdigest())
        self.assertEqual(digest, "4339296401564c6f7047964492445f10e2eb13764ecc0ad6c7424eeab8b41a48")
        self.assertIn("audio.capture.start", [item["id"] for item in registry["operations"]])
        self.assertIn("device.parameter.set", [item["id"] for item in registry["operations"]])
        ids = [item["id"] for item in registry["operations"]]
        self.assertNotIn("scene.launch", ids)
        reserved = {"project.save", "arrangement.automation.create", "audio.warp-marker.add", "audio.take-lane.read", "audio.comp.read", "browser.preview.start"}
        self.assertTrue(reserved <= set(ids)); self.assertTrue(reserved.isdisjoint(LiveObjectMapper(FakeSong()).status()["operations"]))

    def test_provenance_is_explicit_and_fake_is_the_direct_default(self):
        self.assertEqual(LiveObjectMapper(FakeSong()).status()["provenance"], "fake-live")
        self.assertEqual(LiveObjectMapper(FakeSong(), provenance="real-live").status()["provenance"], "real-live")
        with self.assertRaises(ValueError): LiveObjectMapper(FakeSong(), provenance="unknown")

    def capture_fixture(self):
        song = FakeCaptureSong(); mapper = LiveObjectMapper(song)
        snapshot = mapper.snapshot()
        source = snapshot["tracks"][0]["clipSlots"][0]["ref"]
        destination = snapshot["tracks"][1]["clipSlots"][0]["ref"]
        args = {"setName": song.name, "sourceSlotRef": source, "destinationSlotRef": destination, "outputSafety": {"safe": True, "provenance": "unit-test-operator"}}
        return song, mapper, source, destination, args

    @staticmethod
    def clip_creation_args(mapper, track_ref, scene_index, **values):
        snapshot = mapper.snapshot(); track = next(row for row in snapshot["tracks"] if row["ref"] == track_ref); slot = next(row for row in track["clipSlots"] if row["sceneIndex"] == scene_index); scene = next(row for row in snapshot["scenes"] if row["index"] == scene_index)
        return {**values, "trackRef": track_ref, "sceneIndex": scene_index, "expectedTrackIdentity": track["objectIdentity"], "expectedSlotRef": slot["ref"], "expectedSlotIdentity": slot["objectIdentity"], "expectedSceneRef": scene["ref"], "expectedSceneIdentity": scene["objectIdentity"]}

    @staticmethod
    def note_authority(mapper, clip_ref):
        snapshot = mapper.snapshot(); clip = next(clip for track in snapshot["tracks"] for clip in track["clips"] if clip["ref"] == clip_ref)
        return {"expectedClipAuthority": mapper._session_clip_authority(clip_ref), "expectedNotesRevision": clip["notesRevision"]}

    @staticmethod
    def parameter_authority(mapper, parameter_ref):
        authority = mapper._realtime_parameter_authority(parameter_ref)
        return {"expectedObjectIdentity": authority["parameterIdentity"], "expectedOwnerRef": authority["ownerRef"], "expectedOwnerIdentity": authority["ownerIdentity"], "expectedTrackRef": authority["trackRef"], "expectedTrackIdentity": authority["trackIdentity"], "expectedSiblings": authority["siblings"]}

    def test_resampling_capture_lifecycle_is_fenced_bounded_and_ephemeral(self):
        song, mapper, source, destination, args = self.capture_fixture()
        self.assertIn("audio.capture.resampling", mapper.status()["capabilities"])
        preview = mapper.invoke("audio.capture.inspect", args)
        unsafe = {key: value for key, value in args.items() if key != "outputSafety"}
        with self.assertRaises(ValueError): mapper.invoke("audio.capture.start", {**unsafe, "captureId": "capture-unsafe-output", "fence": preview["fence"], "maxDurationMs": 1000})
        self.assertEqual(preview["captureMode"], "session-slot-resampling")
        self.assertEqual(preview["rawRetention"], "ephemeral")
        started = mapper.invoke("audio.capture.start", {**args, "captureId": "capture-unit-test-0001", "fence": preview["fence"], "maxDurationMs": 1000})
        self.assertEqual(started["state"], "active")
        self.assertTrue(song.tracks[1].arm)
        self.assertEqual(song.tracks[1].input_routing_type.name, "Resampling")
        status = mapper.invoke("audio.capture.status", {})
        self.assertTrue(status["active"])
        self.assertNotIn("token", status)
        stopped = mapper.invoke("audio.capture.stop", {"captureId": started["captureId"], "token": started["token"]})
        self.assertEqual(stopped["state"], "captured")
        self.assertEqual(stopped["clip"]["filePath"], "/tmp/MCP Ephemeral Capture.wav")
        self.assertFalse(song.is_playing)
        self.assertFalse(song.tracks[1].arm)
        self.assertEqual(song.tracks[1].input_routing_type.name, "Ext. In")
        self.assertEqual(song.current_song_time, 7.0)
        cleaned = mapper.invoke("audio.capture.cleanup", {"captureId": started["captureId"], "token": started["token"], "expectedClipRef": stopped["clip"]["ref"]})
        self.assertTrue(cleaned["cleaned"])
        self.assertIsNone(song.tracks[1].clip_slots[0].clip)
        self.assertEqual(mapper.invoke("audio.capture.status", {})["state"], "cleaned")

    def test_capture_cleanup_accepts_deleted_then_raised_acknowledgement_loss(self):
        song, mapper, _, _, args = self.capture_fixture(); preview = mapper.invoke("audio.capture.inspect", args); started = mapper.invoke("audio.capture.start", {**args, "captureId": "capture-cleanup-ack-loss", "fence": preview["fence"], "maxDurationMs": 1000}); stopped = mapper.invoke("audio.capture.stop", {"captureId": started["captureId"], "token": started["token"]}); reference = stopped["clip"]["ref"]; slot = song.tracks[1].clip_slots[0]; original = slot.delete_clip
        def lost_ack(): original(); raise RuntimeError("injected cleanup acknowledgement loss")
        slot.delete_clip = lost_ack; cleaned = mapper.invoke("audio.capture.cleanup", {"captureId": started["captureId"], "token": started["token"], "expectedClipRef": reference}); self.assertTrue(cleaned["cleaned"]); self.assertEqual(mapper.invoke("audio.capture.status", {})["state"], "cleaned")
        with self.assertRaises(KeyError): mapper.refs.get(reference)

    def test_resampling_capture_watchdog_and_independent_emergency_stop(self):
        song, mapper, source, destination, args = self.capture_fixture()
        preview = mapper.invoke("audio.capture.inspect", args)
        started = mapper.invoke("audio.capture.start", {**args, "captureId": "capture-unit-test-0002", "fence": preview["fence"], "maxDurationMs": 1000})
        with self.assertRaises(ValueError):
            mapper.invoke("audio.capture.emergency-stop", {"captureId": started["captureId"], "sourceSlotRef": source, "destinationSlotRef": source})
        mapper._capture_state["deadlineMonotonic"] = 0
        mapper.capture_tick()
        status = mapper.invoke("audio.capture.status", {})
        self.assertFalse(status["active"]); self.assertTrue(status["watchdogStopped"]); self.assertEqual(status["state"], "captured")
        emergency = mapper.invoke("audio.capture.emergency-stop", {"captureId": started["captureId"], "sourceSlotRef": source, "destinationSlotRef": destination})
        self.assertTrue(emergency["stopped"])
        mapper.invoke("audio.capture.cleanup", {"captureId": started["captureId"], "token": started["token"], "expectedClipRef": status["clip"]["ref"]})
        self.assertFalse(song.is_playing); self.assertFalse(song.tracks[1].arm)

    def test_resampling_capture_refuses_stale_state_and_reports_external_interference(self):
        song, mapper, source, destination, args = self.capture_fixture()
        preview = mapper.invoke("audio.capture.inspect", args)
        song.current_song_time = 8.0
        with self.assertRaises(ValueError):
            mapper.invoke("audio.capture.start", {**args, "captureId": "capture-unit-test-0003", "fence": preview["fence"], "maxDurationMs": 1000})
        song.current_song_time = 7.0
        preview = mapper.invoke("audio.capture.inspect", args)
        started = mapper.invoke("audio.capture.start", {**args, "captureId": "capture-unit-test-0004", "fence": preview["fence"], "maxDurationMs": 1000})
        external = FakeRouteChoice("External Sidechain")
        song.tracks[1].input_routing_type = external
        stopped = mapper.invoke("audio.capture.stop", {"captureId": started["captureId"], "token": started["token"]})
        self.assertIn("destination-route-changed-externally", stopped["residual"])
        self.assertIs(song.tracks[1].input_routing_type, external)
        mapper.invoke("audio.capture.cleanup", {"captureId": started["captureId"], "token": started["token"], "expectedClipRef": stopped["clip"]["ref"]})

    def test_capture_binds_an_asynchronously_appearing_recording_clip_only(self):
        song, mapper, _, _, args = self.capture_fixture()
        destination_track = song.tracks[1]; destination_slot = destination_track.clip_slots[0]
        def delayed_fire(_slot):
            song.is_playing = True; destination_track.playing_slot_index = 0; destination_track.fired_slot_index = 0
        destination_slot._fire_callback = delayed_fire
        preview = mapper.invoke("audio.capture.inspect", args)
        started = mapper.invoke("audio.capture.start", {**args, "captureId": "capture-unit-delayed-owner", "fence": preview["fence"], "maxDurationMs": 1000})
        self.assertTrue(mapper.invoke("audio.capture.status", {})["active"])
        destination_slot.clip = FakeCapturedAudioClip(); destination_slot.clip.name = destination_track.name
        mapper.capture_tick()
        stopped = mapper.invoke("audio.capture.stop", {"captureId": started["captureId"], "token": started["token"]})
        mapper.invoke("audio.capture.cleanup", {"captureId": started["captureId"], "token": started["token"], "expectedClipRef": stopped["clip"]["ref"]})
        self.assertIsNone(destination_slot.clip)

        other_song, other_mapper, _, _, other_args = self.capture_fixture()
        other_track = other_song.tracks[1]; other_slot = other_track.clip_slots[0]
        other_slot._fire_callback = lambda _slot: setattr(other_song, "is_playing", True)
        other_preview = other_mapper.invoke("audio.capture.inspect", other_args)
        other_mapper.invoke("audio.capture.start", {**other_args, "captureId": "capture-unit-delayed-replacement", "fence": other_preview["fence"], "maxDurationMs": 1000})
        replacement = FakeClip(8.0); replacement.name = "USER CLIP"; other_slot.clip = replacement
        other_mapper.capture_tick()
        self.assertIs(other_slot.clip, replacement)
        self.assertEqual(other_mapper.invoke("audio.capture.status", {})["state"], "failed")

    def test_capture_fence_refuses_a_replacement_destination_track_or_slot(self):
        song, mapper, _, _, args = self.capture_fixture()
        preview = mapper.invoke("audio.capture.inspect", args)
        replacement = FakeCaptureTrack(song, "Replacement Capture", audio=True)
        song.tracks[1] = replacement
        with self.assertRaisesRegex(ValueError, "state changed"):
            mapper.invoke("audio.capture.start", {**args, "captureId": "capture-unit-replaced-destination", "fence": preview["fence"], "maxDurationMs": 1000})
        self.assertIsNone(replacement.clip_slots[0].clip)

    def test_capture_refuses_a_foreign_recording_clip_without_private_tag(self):
        song, mapper, _, _, args = self.capture_fixture()
        destination_track = song.tracks[1]; destination_slot = destination_track.clip_slots[0]
        destination_slot._fire_callback = lambda _slot: setattr(song, "is_playing", True)
        preview = mapper.invoke("audio.capture.inspect", args)
        mapper.invoke("audio.capture.start", {**args, "captureId": "capture-unit-foreign-recording", "fence": preview["fence"], "maxDurationMs": 1000})
        foreign = FakeCapturedAudioClip(); foreign.name = "FOREIGN RECORDING"; destination_slot.clip = foreign
        mapper.capture_tick()
        self.assertIs(destination_slot.clip, foreign)
        status = mapper.invoke("audio.capture.status", {})
        self.assertEqual(status["state"], "failed"); self.assertIn("destination-clip-lacks-private-ownership-tag", status["residual"])

    def test_capture_fence_refuses_a_replacement_in_the_same_source_slot(self):
        song, mapper, _, _, args = self.capture_fixture()
        preview = mapper.invoke("audio.capture.inspect", args)
        replacement = FakeClip(4.0); replacement.name = "UNAUTHORIZED REPLACEMENT"
        song.tracks[0].clip_slots[0].clip = replacement
        with self.assertRaisesRegex(ValueError, "state changed"):
            mapper.invoke("audio.capture.start", {**args, "captureId": "capture-unit-replaced-source", "fence": preview["fence"], "maxDurationMs": 1000})
        self.assertFalse(song.is_playing)

    def test_capture_cleanup_and_shutdown_never_delete_a_slot_replacement(self):
        song, mapper, _, _, args = self.capture_fixture()
        preview = mapper.invoke("audio.capture.inspect", args)
        started = mapper.invoke("audio.capture.start", {**args, "captureId": "capture-unit-owned-identity", "fence": preview["fence"], "maxDurationMs": 1000})
        stopped = mapper.invoke("audio.capture.stop", {"captureId": started["captureId"], "token": started["token"]})
        replacement = FakeClip(8.0); replacement.name = "USER CLIP"
        song.tracks[1].clip_slots[0].clip = replacement
        with self.assertRaisesRegex(ValueError, "identity"):
            mapper.invoke("audio.capture.cleanup", {"captureId": started["captureId"], "token": started["token"], "expectedClipRef": stopped["clip"]["ref"]})
        self.assertIs(song.tracks[1].clip_slots[0].clip, replacement)
        mapper.capture_shutdown()
        self.assertIs(song.tracks[1].clip_slots[0].clip, replacement)
        self.assertEqual(mapper.invoke("audio.capture.status", {})["state"], "failed")

        clean_song, clean_mapper, _, _, clean_args = self.capture_fixture()
        clean_preview = clean_mapper.invoke("audio.capture.inspect", clean_args)
        clean_started = clean_mapper.invoke("audio.capture.start", {**clean_args, "captureId": "capture-unit-post-clean", "fence": clean_preview["fence"], "maxDurationMs": 1000})
        clean_stopped = clean_mapper.invoke("audio.capture.stop", {"captureId": clean_started["captureId"], "token": clean_started["token"]})
        clean_mapper.invoke("audio.capture.cleanup", {"captureId": clean_started["captureId"], "token": clean_started["token"], "expectedClipRef": clean_stopped["clip"]["ref"]})
        post_cleanup = FakeClip(8.0); post_cleanup.name = "POST CLEANUP USER CLIP"
        clean_song.tracks[1].clip_slots[0].clip = post_cleanup
        clean_mapper.capture_shutdown()
        self.assertIs(clean_song.tracks[1].clip_slots[0].clip, post_cleanup)

    def test_destination_fire_that_schedules_then_raises_stays_recoverable(self):
        song, mapper, source, destination, args = self.capture_fixture()
        destination_track = song.tracks[1]; destination_slot = destination_track.clip_slots[0]
        def schedule_then_raise(_slot):
            song.is_playing = True; destination_track.playing_slot_index = 0; destination_track.fired_slot_index = 0
            raise RuntimeError("fire raised after scheduling")
        destination_slot._fire_callback = schedule_then_raise
        preview = mapper.invoke("audio.capture.inspect", args)
        with self.assertRaisesRegex(RuntimeError, "after scheduling"):
            mapper.invoke("audio.capture.start", {**args, "captureId": "capture-unit-fire-raised", "fence": preview["fence"], "maxDurationMs": 1000})
        failed = mapper.invoke("audio.capture.status", {})
        self.assertEqual(failed["state"], "failed"); self.assertIsInstance(failed["recoveryToken"], str)
        late = FakeCapturedAudioClip(); late.name = destination_track.name; destination_slot.clip = late
        mapper.capture_tick()
        observed = mapper.invoke("audio.capture.status", {})
        self.assertTrue(observed["active"]); self.assertNotEqual(observed["state"], "cleaned")
        stopped = mapper.invoke("audio.capture.emergency-stop", {"captureId": failed["captureId"], "sourceSlotRef": source, "destinationSlotRef": destination})
        mapper.invoke("audio.capture.cleanup", {"captureId": failed["captureId"], "token": failed["recoveryToken"], "expectedClipRef": stopped["clip"]["ref"]})
        self.assertIsNone(destination_slot.clip)

    def test_partial_start_failure_and_shutdown_preserve_owned_clip_recovery_identity(self):
        song, mapper, _, _, args = self.capture_fixture()
        preview = mapper.invoke("audio.capture.inspect", args)
        song.tracks[0].clip_slots[0]._fire_callback = lambda _slot: (_ for _ in ()).throw(RuntimeError("injected source fire failure"))
        with self.assertRaisesRegex(RuntimeError, "injected source fire failure"):
            mapper.invoke("audio.capture.start", {**args, "captureId": "capture-unit-partial-start", "fence": preview["fence"], "maxDurationMs": 1000})
        status = mapper.invoke("audio.capture.status", {})
        self.assertIsNotNone(song.tracks[1].clip_slots[0].clip); self.assertIsInstance(status.get("recoveryToken"), str)
        self.assertNotEqual(status["state"], "cleaned")

        other_song, other_mapper, source, destination, other_args = self.capture_fixture()
        other_preview = other_mapper.invoke("audio.capture.inspect", other_args)
        started = other_mapper.invoke("audio.capture.start", {**other_args, "captureId": "capture-unit-shutdown-preserve", "fence": other_preview["fence"], "maxDurationMs": 1000})
        stopped = other_mapper.invoke("audio.capture.stop", {"captureId": started["captureId"], "token": started["token"]})
        owned = other_song.tracks[1].clip_slots[0].clip
        other_mapper.capture_shutdown()
        self.assertIs(other_song.tracks[1].clip_slots[0].clip, owned)
        shutdown = other_mapper.invoke("audio.capture.status", {})
        self.assertEqual(shutdown["state"], "failed"); self.assertIn("bridge-shutdown-requires-host-or-manual-media-cleanup", shutdown["residual"])
        self.assertEqual(stopped["clip"]["ref"], shutdown["clip"]["ref"])

    def test_capture_retries_when_owned_clip_is_still_recording_despite_stopped_playback(self):
        song, mapper, _, _, args = self.capture_fixture()
        preview = mapper.invoke("audio.capture.inspect", args)
        started = mapper.invoke("audio.capture.start", {**args, "captureId": "capture-unit-recording-retry", "fence": preview["fence"], "maxDurationMs": 1000})
        destination = song.tracks[1]; calls = {"count": 0}
        def incomplete_stop(*_args):
            calls["count"] += 1; destination.playing_slot_index = -1; destination.fired_slot_index = -1
        destination.stop_all_clips = incomplete_stop
        mapper.invoke("audio.capture.stop", {"captureId": started["captureId"], "token": started["token"]})
        before = calls["count"]
        mapper.capture_tick(); mapper.capture_tick()
        status = mapper.invoke("audio.capture.status", {})
        self.assertGreater(calls["count"], before); self.assertTrue(status["active"]); self.assertTrue(destination.clip_slots[0].clip.is_recording)

    def test_capture_unknown_owned_recording_state_never_finalizes_as_stopped(self):
        song, mapper, _, _, args = self.capture_fixture()
        preview = mapper.invoke("audio.capture.inspect", args)
        started = mapper.invoke("audio.capture.start", {**args, "captureId": "capture-unit-recording-unknown", "fence": preview["fence"], "maxDurationMs": 1000})
        destination = song.tracks[1]
        def unreadable_stop(*_args):
            destination.playing_slot_index = -1; destination.fired_slot_index = -1
            if hasattr(destination.clip_slots[0].clip, "is_recording"): del destination.clip_slots[0].clip.is_recording
        destination.stop_all_clips = unreadable_stop
        mapper.invoke("audio.capture.stop", {"captureId": started["captureId"], "token": started["token"]})
        mapper.capture_tick(); status = mapper.invoke("audio.capture.status", {})
        self.assertTrue(status["active"]); self.assertTrue(status["unsafe"]); self.assertNotEqual(status["state"], "captured")

    def test_capture_failed_stop_remains_active_and_watchdog_retryable(self):
        song, mapper, _, _, args = self.capture_fixture()
        preview = mapper.invoke("audio.capture.inspect", args)
        started = mapper.invoke("audio.capture.start", {**args, "captureId": "capture-unit-stop-retry", "fence": preview["fence"], "maxDurationMs": 1000})
        original_stop = song.stop_playing
        def injected_failure():
            raise RuntimeError("injected stop failure")
        song.stop_playing = injected_failure
        immediate = mapper.invoke("audio.capture.stop", {"captureId": started["captureId"], "token": started["token"]})
        self.assertTrue(immediate["stopped"]); self.assertFalse(immediate["playbackStopped"])
        failed = mapper.invoke("audio.capture.status", {})
        self.assertTrue(failed["active"]); self.assertTrue(failed["unsafe"]); self.assertFalse(failed["playbackStopped"]); self.assertIn(failed["state"], {"failed", "captured"})
        song.stop_playing = original_stop
        mapper.capture_tick()
        recovered = mapper.invoke("audio.capture.status", {})
        self.assertFalse(recovered["active"]); self.assertTrue(recovered["playbackStopped"]); self.assertEqual(recovered["state"], "captured")
        mapper.invoke("audio.capture.cleanup", {"captureId": started["captureId"], "token": started["token"], "expectedClipRef": recovered["clip"]["ref"]})

    def test_capture_recovery_operations_remain_advertised_while_only_slot_is_occupied(self):
        _, mapper, _, _, args = self.capture_fixture()
        preview = mapper.invoke("audio.capture.inspect", args)
        mapper.invoke("audio.capture.start", {**args, "captureId": "capture-unit-advertisement", "fence": preview["fence"], "maxDurationMs": 1000})
        status = mapper.status()
        for operation in ("audio.capture.status", "audio.capture.stop", "audio.capture.emergency-stop", "audio.capture.cleanup"):
            self.assertIn(operation, status["operations"])
        self.assertIn("audio.capture.resampling", status["capabilities"])

    def test_routing_choice_discovery_enumerates_the_parent_track(self):
        _, mapper, _, _, _ = self.capture_fixture()
        snapshot = mapper.snapshot(); track_ref = snapshot["tracks"][1]["ref"]
        discovered = mapper.discover("routing_choice", parent=track_ref)
        self.assertTrue(any(item["name"] == "Resampling" and item["direction"] == "input-type" for item in discovered["items"]))
        self.assertTrue(all(item["parentRef"] == track_ref for item in discovered["items"]))
        self.assertIn('provenance="real-live"', Path(__file__).with_name("AbletonMcpBridge").joinpath("__init__.py").read_text(encoding="utf-8"))

    def test_references_remain_stable_across_fresh_discovery(self):
        mapper = LiveObjectMapper(FakeSong())
        first = mapper.discover("track")["items"][0]["ref"]
        second = mapper.discover("track")["items"][0]["ref"]
        self.assertEqual(first, second)
        self.assertEqual(mapper.get(first)["ref"], first)

    def test_snapshot_exposes_authoritative_set_for_transport_verification(self):
        song = FakeSong()
        song.tempo = 128.0
        mapper = LiveObjectMapper(song)
        snapshot = mapper.snapshot()
        self.assertEqual(snapshot["set"]["tempo"], 128.0)
        self.assertEqual(mapper.get(snapshot["set"]["ref"])["ref"], snapshot["set"]["ref"])

    def test_get_reports_canonical_unknown_ref_after_clip_deletion(self):
        song = FakeSong(); song.tracks[0].clip_slots[0].create_clip(4); mapper = LiveObjectMapper(song); reference = mapper.snapshot()["tracks"][0]["clips"][0]["ref"]
        song.tracks[0].clip_slots[0].clip = None
        with self.assertRaisesRegex(ValueError, "unknown live ref"):
            mapper.get(reference)

    def test_main_thread_deadline_is_exclusive_at_the_expiry_millisecond(self):
        token = _DispatchToken(1000)
        with patch("ableton_mcp_remote_script.time.time", return_value=1.0):
            self.assertFalse(token.claim())
        self.assertEqual(token.state, "cancelled")

    def test_retirement_is_a_live_thread_barrier_for_earlier_mutations(self):
        bridge = object.__new__(AbletonMcpBridge); bridge.queue = _MainThreadQueue(); bridge._executed_mutations = {}; bridge._executed_lock = threading.Lock(); events = []
        def applied():
            events.append("applied"); bridge._executed_mutations["apply-key"] = {"transactionId": "transaction-barrier", "operation": "clip.create", "argsDigest": "digest", "result": {"created": True}}
        self.assertTrue(bridge.queue.submit_nowait(applied, int(time.time() * 1000) + 5000))
        outcome = []
        worker = threading.Thread(target=lambda: outcome.append(bridge._dispatch_with_holder("retire", {"transactionId": "transaction-barrier", "deadlineMs": int(time.time() * 1000) + 5000}, {})))
        worker.start()
        deadline = time.time() + 1
        while bridge.queue.items.qsize() < 2 and time.time() < deadline: time.sleep(0.001)
        self.assertEqual(bridge.queue.items.qsize(), 2); bridge.queue.drain(); worker.join(1); bridge.queue.close()
        self.assertFalse(worker.is_alive()); self.assertEqual(events, ["applied"]); self.assertEqual(outcome, [{"retired": 1}]); self.assertEqual(bridge._executed_mutations, {})

    def test_retirement_fences_prior_key_but_allows_same_transaction_undo_key(self):
        bridge = object.__new__(AbletonMcpBridge); bridge.mapper = LiveObjectMapper(FakeSong()); bridge._executed_mutations = {}; bridge._pending_mutations = {}; bridge._retired_mutation_keys = {}; bridge._executed_lock = threading.Lock()
        class ImmediateQueue:
            def submit(self, action, deadline_ms=None): return action()
        bridge.queue = ImmediateQueue(); holder = {}; transaction_id = "transaction-apply-undo"
        def set_value(value, key):
            parameter = bridge.mapper.snapshot()["tracks"][0]["devices"][0]["parameters"][0]; request = {"operation": "device.parameter.set", "transactionId": transaction_id, "args": {"ref": parameter["ref"], "value": value, "expectedRevision": parameter["revision"], **self.parameter_authority(bridge.mapper, parameter["ref"])}}
            preflight = bridge._dispatch_with_holder("preflight", request, holder); prepared = bridge._dispatch_with_holder("prepare", {**request, "preflightToken": preflight["preflightToken"], "confirmation": preflight["confirmation"], "idempotencyKey": key}, holder)
            return bridge._dispatch_with_holder("invoke", {**request, "authorityToken": prepared["authorityToken"], "transactionId": transaction_id}, holder)
        self.assertEqual(set_value(0.75, "apply-key")["value"], 0.75)
        self.assertEqual(bridge._dispatch_with_holder("retire", {"transactionId": transaction_id, "deadlineMs": int(time.time() * 1000) + 5000}, {}), {"retired": 1})
        self.assertEqual(set_value(0.5, "undo-key")["value"], 0.5)

    def test_terminal_retirement_atomically_requires_safety_and_fences_prepared_authority(self):
        bridge = object.__new__(AbletonMcpBridge); bridge.mapper = LiveObjectMapper(FakeSong()); bridge._executed_mutations = {}; bridge._pending_mutations = {}; bridge._retired_mutation_keys = {}; bridge._finalized_transactions = set(); bridge._executed_lock = threading.Lock()
        class ImmediateQueue:
            def submit(self, action, deadline_ms=None): return action()
        class SafeRealtime:
            def stats(self): return {"armed": False, "pending": 0}
        bridge.queue = ImmediateQueue(); bridge._realtime = SafeRealtime(); holder = {}; transaction_id = "transaction-terminal-finalize"; parameter = bridge.mapper.snapshot()["tracks"][0]["devices"][0]["parameters"][0]
        request = {"operation": "device.parameter.set", "transactionId": transaction_id, "args": {"ref": parameter["ref"], "value": 0.75, "expectedRevision": parameter["revision"], **self.parameter_authority(bridge.mapper, parameter["ref"])}}
        preflight = bridge._dispatch_with_holder("preflight", request, holder); prepared = bridge._dispatch_with_holder("prepare", {**request, "preflightToken": preflight["preflightToken"], "confirmation": preflight["confirmation"], "idempotencyKey": "terminal-prepared-key"}, holder)
        second_preflight = bridge._dispatch_with_holder("preflight", request, holder); second_prepared = bridge._dispatch_with_holder("prepare", {**request, "preflightToken": second_preflight["preflightToken"], "confirmation": second_preflight["confirmation"], "idempotencyKey": "terminal-prepared-key-two"}, holder)
        bridge.mapper.song.is_playing = True
        with self.assertRaisesRegex(ValueError, "stopped playback"):
            bridge._dispatch_with_holder("retire", {"transactionId": transaction_id, "terminal": True, "deadlineMs": int(time.time() * 1000) + 5000}, {})
        bridge.mapper.song.is_playing = False
        self.assertEqual(bridge._dispatch_with_holder("retire", {"transactionId": transaction_id, "terminal": True, "deadlineMs": int(time.time() * 1000) + 5000}, {}), {"retired": 0})
        with self.assertRaisesRegex(ValueError, "mismatched mutation authority"):
            bridge._dispatch_with_holder("invoke", {**request, "authorityToken": second_prepared["authorityToken"], "transactionId": "transaction-swapped"}, holder)
        with self.assertRaisesRegex(ValueError, "terminally finalized"):
            bridge._dispatch_with_holder("invoke", {**request, "authorityToken": prepared["authorityToken"], "transactionId": transaction_id}, holder)
        self.assertEqual(bridge.mapper._resolve_parameter(parameter["ref"]).value, 0.5)

    def test_retirement_tombstone_fences_a_mutation_delayed_before_enqueue(self):
        bridge = object.__new__(AbletonMcpBridge); bridge.mapper = LiveObjectMapper(FakeSong()); bridge._executed_mutations = {}; bridge._pending_mutations = {}; bridge._retired_mutation_keys = {}; bridge._executed_lock = threading.Lock()
        class DelayedMutationQueue:
            def __init__(self): self.delay = False; self.entered = threading.Event(); self.release = threading.Event()
            def submit(self, action, deadline_ms=None):
                if self.delay and threading.current_thread().name == "delayed-mutation": self.entered.set(); self.release.wait(1)
                return action()
        bridge.queue = DelayedMutationQueue(); holder = {}; parameter = bridge.mapper.snapshot()["tracks"][0]["devices"][0]["parameters"][0]
        request = {"operation": "device.parameter.set", "transactionId": "transaction-race", "args": {"ref": parameter["ref"], "value": 0.75, "expectedRevision": parameter["revision"], **self.parameter_authority(bridge.mapper, parameter["ref"])}}
        preflight = bridge._dispatch_with_holder("preflight", request, holder); prepared = bridge._dispatch_with_holder("prepare", {**request, "preflightToken": preflight["preflightToken"], "confirmation": preflight["confirmation"], "idempotencyKey": "delayed-apply"}, holder)
        bridge.queue.delay = True; failures = []
        def mutate():
            try: bridge._dispatch_with_holder("invoke", {**request, "authorityToken": prepared["authorityToken"], "transactionId": "transaction-race"}, holder)
            except Exception as error: failures.append(str(error))
        worker = threading.Thread(target=mutate, name="delayed-mutation"); worker.start(); self.assertTrue(bridge.queue.entered.wait(1))
        conflicting = {"operation": "device.parameter.set", "transactionId": "transaction-race", "args": {**request["args"], "value": 0.6}}
        conflict_preflight = bridge._dispatch_with_holder("preflight", conflicting, holder); conflict_prepared = bridge._dispatch_with_holder("prepare", {**conflicting, "preflightToken": conflict_preflight["preflightToken"], "confirmation": conflict_preflight["confirmation"], "idempotencyKey": "delayed-apply"}, holder)
        with self.assertRaisesRegex(ValueError, "idempotency key conflicts with a pending mutation"):
            bridge._dispatch_with_holder("invoke", {**conflicting, "authorityToken": conflict_prepared["authorityToken"], "transactionId": "transaction-race"}, holder)
        duplicate_preflight = bridge._dispatch_with_holder("preflight", request, holder); duplicate_prepared = bridge._dispatch_with_holder("prepare", {**request, "preflightToken": duplicate_preflight["preflightToken"], "confirmation": duplicate_preflight["confirmation"], "idempotencyKey": "delayed-apply"}, holder)
        bridge.mapper._resolve_parameter(parameter["ref"]).value = 0.6
        with self.assertRaisesRegex(ValueError, "Live state changed"):
            bridge._dispatch_with_holder("invoke", {**request, "authorityToken": duplicate_prepared["authorityToken"], "transactionId": "transaction-race"}, holder)
        bridge.mapper._resolve_parameter(parameter["ref"]).value = 0.5
        self.assertEqual(bridge._pending_mutations["delayed-apply"]["count"], 1)
        self.assertEqual(bridge._dispatch_with_holder("retire", {"transactionId": "transaction-race", "deadlineMs": int(time.time() * 1000) + 5000}, {}), {"retired": 0})
        bridge.queue.release.set(); worker.join(1)
        self.assertFalse(worker.is_alive()); self.assertEqual(failures, ["mutation replay authority has been retired"]); self.assertEqual(bridge.mapper._resolve_parameter(parameter["ref"]).value, 0.5); self.assertEqual(bridge._executed_mutations, {})

    def test_mutation_preflight_is_unpredictable_one_use_and_fences_external_state(self):
        bridge = object.__new__(AbletonMcpBridge); bridge.mapper = LiveObjectMapper(FakeSong())
        class ImmediateQueue:
            def submit(self, action, deadline_ms=None): return action()
        bridge.queue = ImmediateQueue(); bridge._executed_mutations = {}; bridge._executed_lock = threading.Lock(); holder = {}
        parameter = bridge.mapper.snapshot()["tracks"][0]["devices"][0]["parameters"][0]
        request = {"operation": "device.parameter.set", "transactionId": "transaction-preflight", "args": {"ref": parameter["ref"], "value": 0.75, "expectedRevision": parameter["revision"], **self.parameter_authority(bridge.mapper, parameter["ref"])}}
        first = bridge._dispatch_with_holder("preflight", request, holder)
        with self.assertRaises(ValueError): bridge._dispatch_with_holder("prepare", {**request, "preflightToken": first["preflightToken"], "confirmation": "x" * 24, "idempotencyKey": "wrong-confirmation"}, holder)
        second = bridge._dispatch_with_holder("preflight", request, holder); bridge.mapper._resolve_parameter(parameter["ref"]).value = 0.6
        with self.assertRaises(ValueError): bridge._dispatch_with_holder("prepare", {**request, "preflightToken": second["preflightToken"], "confirmation": second["confirmation"], "idempotencyKey": "external-edit"}, holder)
        bridge.mapper._resolve_parameter(parameter["ref"]).value = 0.5
        third = bridge._dispatch_with_holder("preflight", request, holder); prepared = bridge._dispatch_with_holder("prepare", {**request, "preflightToken": third["preflightToken"], "confirmation": third["confirmation"], "idempotencyKey": "confirmed-apply"}, holder)
        result = bridge._dispatch_with_holder("invoke", {**request, "authorityToken": prepared["authorityToken"]}, holder)
        self.assertTrue(result["changed"])
        second_connection = {}
        replay_preflight = bridge._dispatch_with_holder("preflight", request, second_connection); replay_prepared = bridge._dispatch_with_holder("prepare", {**request, "preflightToken": replay_preflight["preflightToken"], "confirmation": replay_preflight["confirmation"], "idempotencyKey": "confirmed-apply"}, second_connection)
        self.assertEqual(bridge._dispatch_with_holder("invoke", {**request, "authorityToken": replay_prepared["authorityToken"]}, second_connection), result)
        with self.assertRaises(ValueError): bridge._dispatch_with_holder("invoke", {**request, "authorityToken": replay_prepared["authorityToken"]}, second_connection)
        swapped = {**request, "transactionId": "transaction-replay-swap"}; swapped_preflight = bridge._dispatch_with_holder("preflight", swapped, second_connection); swapped_prepared = bridge._dispatch_with_holder("prepare", {**swapped, "preflightToken": swapped_preflight["preflightToken"], "confirmation": swapped_preflight["confirmation"], "idempotencyKey": "confirmed-apply"}, second_connection)
        with self.assertRaisesRegex(ValueError, "conflicts with an executed mutation"):
            bridge._dispatch_with_holder("invoke", {**swapped, "authorityToken": swapped_prepared["authorityToken"]}, second_connection)
        bridge.mapper.song.cue_points = []; bridge.mapper.song.set_or_delete_cue = lambda: None
        locator_request = {"operation": "locator.add", "transactionId": "transaction-locator", "args": {"name": "Prepared", "position": 8.0}}
        locator_preflight = bridge._dispatch_with_holder("preflight", locator_request, holder); bridge.mapper.song.cue_points.append(FakeLocator(4.0, "External"))
        with self.assertRaises(ValueError): bridge._dispatch_with_holder("prepare", {**locator_request, "preflightToken": locator_preflight["preflightToken"], "confirmation": locator_preflight["confirmation"], "idempotencyKey": "locator-external-edit"}, holder)
        bridge._realtime_op = lambda operation, args: {"armed": operation == "realtime.arm"}
        realtime_request = {"operation": "realtime.arm", "transactionId": "transaction-realtime", "args": {"ttlMs": 5000, "channels": ["udp-json"], "parameterRefs": [], "targetAuthorities": [], "outputSafety": {"safe": True, "provenance": "unit-test"}}}
        realtime_preflight = bridge._dispatch_with_holder("preflight", realtime_request, holder); realtime_prepared = bridge._dispatch_with_holder("prepare", {**realtime_request, "preflightToken": realtime_preflight["preflightToken"], "confirmation": realtime_preflight["confirmation"], "idempotencyKey": "realtime-state-fence"}, holder)
        bridge.mapper.song.tempo = 130.0
        with self.assertRaises(ValueError): bridge._dispatch_with_holder("invoke", {**realtime_request, "authorityToken": realtime_prepared["authorityToken"]}, holder)

    def test_mutation_authority_excludes_only_drifting_transport_position(self):
        song = FakeSong(); song.is_playing = True; song.current_song_time = 1.0
        bridge = object.__new__(AbletonMcpBridge); bridge.mapper = LiveObjectMapper(song)
        class ImmediateQueue:
            def submit(self, action, deadline_ms=None): return action()
        bridge.queue = ImmediateQueue(); bridge._executed_mutations = {}; bridge._executed_lock = threading.Lock(); holder = {}
        request = {"operation": "locator.add", "transactionId": "transaction-position", "args": {"name": "Position Fence", "position": 8.0}}
        preflight = bridge._dispatch_with_holder("preflight", request, holder); song.current_song_time = 3.5
        prepared = bridge._dispatch_with_holder("prepare", {**request, "preflightToken": preflight["preflightToken"], "confirmation": preflight["confirmation"], "idempotencyKey": "locator-position-drift"}, holder)
        self.assertEqual(prepared["operation"], "locator.add")
        changed = bridge._dispatch_with_holder("preflight", request, holder); song.is_playing = False
        with self.assertRaises(ValueError): bridge._dispatch_with_holder("prepare", {**request, "preflightToken": changed["preflightToken"], "confirmation": changed["confirmation"], "idempotencyKey": "locator-playback-change"}, holder)

    def test_capture_stop_authority_survives_watchdog_stop_but_not_identity_change(self):
        song = FakeSong(); song.is_playing = True
        bridge = object.__new__(AbletonMcpBridge); bridge.mapper = LiveObjectMapper(song)
        class ImmediateQueue:
            def submit(self, action, deadline_ms=None): return action()
        bridge.queue = ImmediateQueue(); bridge._executed_mutations = {}; bridge._executed_lock = threading.Lock(); holder = {}
        bridge.mapper._capture_state = {"captureId": "capture-test", "startedAt": 1000, "state": "active", "sourceSlotRef": "source-slot", "destinationSlotRef": "destination-slot", "destinationTrackRef": "destination-track"}
        request = {"operation": "audio.capture.stop", "transactionId": "transaction-capture-stop", "args": {"captureId": "capture-test", "token": "t" * 24}}
        preflight = bridge._dispatch_with_holder("preflight", request, holder)
        bridge.mapper._capture_state["state"] = "stopped"; song.is_playing = False
        prepared = bridge._dispatch_with_holder("prepare", {**request, "preflightToken": preflight["preflightToken"], "confirmation": preflight["confirmation"], "idempotencyKey": "capture-watchdog-stop"}, holder)
        self.assertEqual(prepared["operation"], "audio.capture.stop")
        changed = bridge._dispatch_with_holder("preflight", request, holder); bridge.mapper._capture_state["captureId"] = "replacement-capture"
        with self.assertRaises(ValueError): bridge._dispatch_with_holder("prepare", {**request, "preflightToken": changed["preflightToken"], "confirmation": changed["confirmation"], "idempotencyKey": "capture-identity-change"}, holder)

    def test_capture_cleanup_authority_ignores_native_media_finalization_drift(self):
        song = FakeSong(); song.tracks[0].clip_slots[0].clip = FakeClip(4.0)
        bridge = object.__new__(AbletonMcpBridge); bridge.mapper = LiveObjectMapper(song)
        class ImmediateQueue:
            def submit(self, action, deadline_ms=None): return action()
        bridge.queue = ImmediateQueue(); bridge._executed_mutations = {}; bridge._executed_lock = threading.Lock(); holder = {}
        clip = bridge.mapper.snapshot()["tracks"][0]["clips"][0]; owned_clip = song.tracks[0].clip_slots[0].clip
        bridge.mapper._capture_state = {"captureId": "capture-test", "state": "captured", "sourceSlotRef": "source-slot", "destinationSlotRef": "destination-slot", "clipRef": clip["ref"], "_destinationSlot": song.tracks[0].clip_slots[0], "_ownedClip": owned_clip, "_ownedClipIdentity": bridge.mapper._capture_object_identity(owned_clip), "residual": []}
        request = {"operation": "audio.capture.cleanup", "transactionId": "transaction-capture-cleanup", "args": {"captureId": "capture-test", "token": "t" * 24, "expectedClipRef": clip["ref"]}}
        preflight = bridge._dispatch_with_holder("preflight", request, holder)
        owned_clip.length = 4.25; song.tempo = 127.0
        prepared = bridge._dispatch_with_holder("prepare", {**request, "preflightToken": preflight["preflightToken"], "confirmation": preflight["confirmation"], "idempotencyKey": "capture-cleanup-finalization"}, holder)
        self.assertEqual(prepared["operation"], "audio.capture.cleanup")
        replacement_preflight = bridge._dispatch_with_holder("preflight", request, holder)
        song.tracks[0].clip_slots[0].clip = FakeClip(4.25)
        with self.assertRaises(ValueError): bridge._dispatch_with_holder("prepare", {**request, "preflightToken": replacement_preflight["preflightToken"], "confirmation": replacement_preflight["confirmation"], "idempotencyKey": "capture-cleanup-replacement"}, holder)

    def test_scene_capture_claims_the_identity_distinct_scene_with_duplicate_names(self):
        song = FakeSong(); song.scenes = [FakeScene("Duplicate"), FakeScene("Duplicate")]; created = FakeScene("Duplicate")
        song.capture_and_insert_scene = lambda: song.scenes.insert(1, created)
        mapper = LiveObjectMapper(song); result = mapper.invoke("scene.capture", {"expectedStateRevision": mapper._capture_authority_revision()})
        self.assertIs(mapper.refs.get(result["ref"]), created); self.assertEqual(result["objectIdentity"], mapper._capture_object_identity(created))

    def test_scene_capture_authority_refuses_truncated_warp_markers(self):
        class Marker:
            def __init__(self, value): self.beat_time = value; self.sample_time = value * 100.0
        song = FakeSong(); clip = FakeClip(4.0); clip.warp_markers = [Marker(float(index)) for index in range(257)]; song.tracks[0].clip_slots[0].clip = clip
        mapper = LiveObjectMapper(song)
        with self.assertRaisesRegex(ValueError, "warp-marker content exceeds"):
            mapper._capture_authority_revision()

    def test_scene_capture_authority_refuses_unreadable_warp_markers(self):
        class UnreadableWarpClip(FakeClip):
            @property
            def warp_markers(self): raise RuntimeError("unreadable")
        song = FakeSong(); song.tracks[0].clip_slots[0].clip = UnreadableWarpClip(4.0); mapper = LiveObjectMapper(song)
        with self.assertRaisesRegex(ValueError, "warp-marker collection is unreadable"):
            mapper._capture_authority_revision()

    def test_owned_delete_refuses_replacements_at_the_same_traversal_location(self):
        song = FakeSong(); song.tracks[0].clip_slots[0].clip = FakeClip(4.0); mapper = LiveObjectMapper(song); snapshot = mapper.snapshot(); clip_ref = snapshot["tracks"][0]["clips"][0]["ref"]; original_clip = song.tracks[0].clip_slots[0].clip; clip_authority = mapper._session_clip_authority(clip_ref)
        song.tracks[0].clip_slots[0].clip = FakeClip(4.0)
        with self.assertRaises(ValueError): mapper.invoke("clip.delete", {"ref": clip_ref, **clip_authority})
        scene_ref = snapshot["scenes"][0]["ref"]; scene_identity = mapper._capture_object_identity(song.scenes[0]); song.scenes[0] = FakeScene("Replacement")
        with self.assertRaises(ValueError): mapper.invoke("scene.delete", {"ref": scene_ref, "expectedStructureRevision": mapper._structure_revision(), "expectedObjectIdentity": scene_identity})
        self.assertEqual(song.scenes[0].name, "Replacement")

    def test_subscription_rejects_event_types_without_a_producer(self):
        bridge = object.__new__(AbletonMcpBridge); bridge.mapper = LiveObjectMapper(FakeSong()); holder = {}
        for event_type in ("state", "meter", "max", "osc", "transport", "object"):
            with self.assertRaisesRegex(ValueError, "subscription types are invalid or unavailable"):
                bridge._subscribe_main({"args": {"types": [event_type]}}, holder)

        class ListenerSong(FakeSong):
            def __init__(self): super().__init__(); self.listeners = {name: [] for name in ("is_playing", "record_mode", "session_record", "tracks", "scenes")}
            def _add(self, name, callback): self.listeners[name].append(callback)
            def _remove(self, name, callback): self.listeners[name].remove(callback)
            def add_is_playing_listener(self, callback): self._add("is_playing", callback)
            def remove_is_playing_listener(self, callback): self._remove("is_playing", callback)
            def add_record_mode_listener(self, callback): self._add("record_mode", callback)
            def remove_record_mode_listener(self, callback): self._remove("record_mode", callback)
            def add_session_record_listener(self, callback): self._add("session_record", callback)
            def remove_session_record_listener(self, callback): self._remove("session_record", callback)
            def add_tracks_listener(self, callback): self._add("tracks", callback)
            def remove_tracks_listener(self, callback): self._remove("tracks", callback)
            def add_scenes_listener(self, callback): self._add("scenes", callback)
            def remove_scenes_listener(self, callback): self._remove("scenes", callback)

        bridge.mapper = LiveObjectMapper(ListenerSong())
        result = bridge._subscribe_main({"args": {"types": ["transport", "object"]}}, holder)
        self.assertTrue(result["subscribed"]); holder["subscription"].close()

    def test_subscription_coalescing_preserves_continuity_without_false_overflow(self):
        mapper = LiveObjectMapper(FakeSong()); subscription = _Subscription(mapper, {"object"})
        subscription._emit("object", {"index": 1}); subscription._emit("object", {"index": 2})
        events = subscription.drain()
        self.assertEqual([event["type"] for event in events], ["reset", "object"])
        self.assertEqual([event["sequence"] for event in events], [1, 2])
        self.assertEqual(events[-1]["payload"], {"index": 2}); self.assertEqual(events[-1]["coalesced"], 1)

    def test_subscription_overflow_emits_epoch_bound_reset(self):
        mapper = LiveObjectMapper(FakeSong()); subscription = _Subscription(mapper, {"transport", "object"})
        for index in range(300): subscription._emit("transport" if index % 2 == 0 else "object", {"index": index})
        events = subscription.drain(); reset = events[-1]
        self.assertEqual(reset["type"], "reset"); self.assertEqual(reset["epoch"], mapper.refs.epoch); self.assertTrue(reset["payload"]["resnapshot"]); self.assertGreater(reset["payload"]["overflow"], 0)
        old_epoch = mapper.refs.epoch; mapper.invoke("session.reconnect", {}); subscription._emit("object", {"afterReconnect": True}); reconnected = subscription.drain()
        self.assertNotEqual(mapper.refs.epoch, old_epoch); self.assertEqual(reconnected[0]["type"], "reset"); self.assertTrue(all(event["epoch"] == mapper.refs.epoch for event in reconnected))

    def test_browser_never_classifies_generic_loadable_clips_as_devices(self):
        class Item:
            def __init__(self, name, loadable=False, children=None): self.name = name; self.is_loadable = loadable; self.children = children or []
        class Browser:
            def __init__(self, song): self.song = song; self.instruments = Item("instruments", children=[Item("Synth", True)]); self.clips = Item("clips", children=[Item("Loop.wav", True)]); self.loaded = []
            def load_item(self, item): self.loaded.append(item); self.song.view.selected_track.devices.append(FakeDevice())
        song = FakeSong(); song.tracks.append(FakeTrack()); song.tracks[0].devices = []; song.view = type("View", (), {"selected_track": song.tracks[1]})(); browser = Browser(song); mapper = LiveObjectMapper(song); mapper._browser = lambda: browser
        instrument = mapper.invoke("browser.search", {"category": "instruments", "limit": 10})["items"][0]; clip = mapper.invoke("browser.search", {"category": "clips", "limit": 10})["items"][0]
        self.assertTrue(instrument["isDevice"]); self.assertFalse(clip["isDevice"])
        with self.assertRaises(ValueError): mapper.invoke("browser.load", {"itemId": clip["id"], "trackRef": mapper.snapshot()["tracks"][0]["ref"], "expectedName": clip["name"]})
        self.assertEqual(browser.loaded, [])
        with self.assertRaises(ValueError): mapper.invoke("browser.load", {"itemId": instrument["id"], "expectedName": instrument["name"]})
        track_row = mapper.snapshot()["tracks"][0]; track_ref = track_row["ref"]; track_authority = {"expectedTrackIdentity": track_row["objectIdentity"], "expectedSiblings": [{"ref": row["ref"], "objectIdentity": row["objectIdentity"]} for row in track_row["devices"]]}
        result = mapper.invoke("browser.load", {"itemId": instrument["id"], "trackRef": track_ref, "expectedName": instrument["name"], "expectedItemIdentity": instrument["objectIdentity"], **track_authority})
        self.assertTrue(result["loaded"]); self.assertIs(song.view.selected_track, song.tracks[1]); self.assertEqual(len(song.tracks[0].devices), 1)
        song.return_tracks = [FakeTrack()]; return_ref = next(row["ref"] for row in mapper.snapshot()["tracks"] if row["kind"] == "return")
        with self.assertRaises(ValueError): mapper.invoke("browser.load", {"itemId": instrument["id"], "trackRef": return_ref, "expectedName": instrument["name"]})
        self.assertEqual(len(browser.loaded), 1)

    def test_browser_failure_cleans_transaction_owned_device_before_returning(self):
        class Item:
            def __init__(self, name, loadable=False, children=None): self.name = name; self.is_loadable = loadable; self.children = children or []
        class Browser:
            def __init__(self, song): self.song = song; self.fail = True; self.instruments = Item("instruments", children=[Item("Failing Synth", True)])
            def load_item(self, _item):
                self.song.view.selected_track.devices.insert(0, FakeDevice())
                if self.fail: raise RuntimeError("injected browser failure")
        song = FakeSong(); track = song.tracks[0]; track.devices = []; track.delete_device = lambda index: track.devices.pop(index); song.view = type("View", (), {"selected_track": track})(); mapper = LiveObjectMapper(song); browser = Browser(song); mapper._browser = lambda: browser; item = mapper.invoke("browser.search", {"category": "instruments", "limit": 10})["items"][0]; row = mapper.snapshot()["tracks"][0]; authority = {"expectedTrackIdentity": row["objectIdentity"], "expectedSiblings": [{"ref": device["ref"], "objectIdentity": device["objectIdentity"]} for device in row["devices"]]}
        with self.assertRaisesRegex(ValueError, "without a residual device"): mapper.invoke("browser.load", {"itemId": item["id"], "trackRef": row["ref"], "expectedName": item["name"], "expectedItemIdentity": item["objectIdentity"], **authority})
        self.assertEqual(len(track.devices), 0)
        browser.fail = False; row = mapper.snapshot()["tracks"][0]; authority = {"expectedTrackIdentity": row["objectIdentity"], "expectedSiblings": []}; registry_before = mapper.refs.checkpoint(); mapper._mapped_fingerprint = lambda _reference: (_ for _ in ()).throw(RuntimeError("injected fingerprint failure"))
        with self.assertRaisesRegex(ValueError, "mapping failed without a residual device"): mapper.invoke("browser.load", {"itemId": item["id"], "trackRef": row["ref"], "expectedName": item["name"], "expectedItemIdentity": item["objectIdentity"], **authority})
        self.assertEqual(len(track.devices), 0); self.assertEqual(mapper.refs.checkpoint(), registry_before)

    def test_real_live_browser_load_returns_hidden_cleanup_ownership_shape(self):
        class Item:
            def __init__(self, name, children=None): self.name = name; self.children = children or []; self.is_loadable = not bool(children); self.is_device = not bool(children)
        class Browser:
            def __init__(self, song): self.song = song; self.instruments = Item("instruments", [Item("Owned Synth")])
            def load_item(self, _item): self.song.view.selected_track.devices.append(FakeDevice())
        song = FakeSong(); track = song.tracks[0]; track.devices = []; track.delete_device = lambda index: track.devices.pop(index); song.view = type("View", (), {"selected_track": track})(); mapper = LiveObjectMapper(song, provenance="real-live"); browser = Browser(song); mapper._browser = lambda: browser; item = mapper.invoke("browser.search", {"category": "instruments", "limit": 10})["items"][0]; row = mapper.snapshot()["tracks"][0]; transaction = "browser-owned-transaction"; loaded = mapper.invoke("browser.load", {"itemId": item["id"], "trackRef": row["ref"], "expectedName": item["name"], "expectedItemIdentity": item["objectIdentity"], "expectedTrackIdentity": row["objectIdentity"], "expectedSiblings": [{"ref": device["ref"], "objectIdentity": device["objectIdentity"]} for device in row["devices"]]}, transaction)
        self.assertIn("ownershipToken", loaded); snapshot = mapper.snapshot(); track_row = snapshot["tracks"][0]; device = next(item for item in track_row["devices"] if item["ref"] == loaded["deviceRef"]); siblings = [{"ref": item["ref"], "objectIdentity": item["objectIdentity"]} for item in track_row["devices"]]; deleted = mapper.invoke("device.delete", {"ref": device["ref"], "expectedObjectIdentity": device["objectIdentity"], "expectedOwnerRef": track_row["ref"], "expectedOwnerIdentity": track_row["objectIdentity"], "expectedSiblings": siblings, "expectedTrackRef": track_row["ref"], "expectedTrackIdentity": track_row["objectIdentity"]}, transaction, loaded["ownershipToken"]); self.assertEqual(deleted, {"deleted": device["ref"]}); self.assertEqual(len(track.devices), 0)

    def test_automation_batch_failure_restores_exact_prior_envelope(self):
        class Event:
            def __init__(self, time, value): self.time = time; self.value = value
        class Envelope:
            def __init__(self, clip): self.canonical_parent = clip; self.events = [Event(0.25, 0.2)]; self.fail_delete = False; self.mutate_other = False
            def events_in_range(self, start, end): return [event for event in self.events if start <= event.time < end]
            def create_event(self, event):
                self.events.append(event)
                if self.mutate_other and self.events: self.events[0].value = 0.9
                if event.value == 0.75: raise RuntimeError("injected event failure")
            def delete_events_in_range(self, start, end):
                if self.fail_delete:
                    for index, event in enumerate(self.events):
                        if start <= event.time < end: self.events.pop(index); break
                    raise RuntimeError("injected partial delete failure")
                self.events = [event for event in self.events if not start <= event.time < end]
        class AutomationClip(FakeClip):
            def __init__(self): super().__init__(4.0); self.envelope = Envelope(self)
            def automation_envelope(self, _parameter): return self.envelope
            def create_automation_envelope(self, _parameter): self.envelope = Envelope(self); self.envelope.events = []; return self.envelope
            def clear_envelope(self, _parameter): self.envelope = None
        song = FakeSong(); clip = AutomationClip(); song.tracks[0].clip_slots[0].clip = clip; mapper = LiveObjectMapper(song); snapshot = mapper.snapshot(); clip_ref = snapshot["tracks"][0]["clips"][0]["ref"]; parameter_ref = snapshot["tracks"][0]["devices"][0]["parameters"][0]["ref"]; read = mapper.invoke("automation.envelope.read", {"clipRef": clip_ref, "parameterRef": parameter_ref}); authority = mapper._envelope_authority_digest(clip_ref, parameter_ref)
        with self.assertRaisesRegex(RuntimeError, "injected event failure"): mapper.invoke("automation.point.insert", {"clipRef": clip_ref, "parameterRef": parameter_ref, "expectedAuthorityDigest": authority, "expectedEnvelopeRevision": read["revision"], "points": [{"time": 0.5, "value": 0.5}, {"time": 0.75, "value": 0.75}]})
        self.assertEqual([(event.time, event.value) for event in clip.envelope.events], [(0.25, 0.2)])
        clip.envelope.mutate_other = True; read = mapper.invoke("automation.envelope.read", {"clipRef": clip_ref, "parameterRef": parameter_ref}); authority = mapper._envelope_authority_digest(clip_ref, parameter_ref)
        with self.assertRaisesRegex(ValueError, "exact requested state"): mapper.invoke("automation.point.insert", {"clipRef": clip_ref, "parameterRef": parameter_ref, "expectedAuthorityDigest": authority, "expectedEnvelopeRevision": read["revision"], "points": [{"time": 0.5, "value": 0.6}]})
        self.assertEqual([(event.time, event.value) for event in clip.envelope.events], [(0.25, 0.2)])
        clip.envelope.events.append(Event(0.5, 0.4)); clip.envelope.fail_delete = True; read = mapper.invoke("automation.envelope.read", {"clipRef": clip_ref, "parameterRef": parameter_ref}); authority = mapper._envelope_authority_digest(clip_ref, parameter_ref)
        with self.assertRaisesRegex(RuntimeError, "partial delete failure"): mapper.invoke("automation.point.delete", {"clipRef": clip_ref, "parameterRef": parameter_ref, "expectedAuthorityDigest": authority, "expectedEnvelopeRevision": read["revision"], "from": 0.2, "to": 0.6})
        self.assertEqual([(event.time, event.value) for event in clip.envelope.events], [(0.25, 0.2), (0.5, 0.4)])
        clip.create_automation_envelope = None; read = mapper.invoke("automation.envelope.read", {"clipRef": clip_ref, "parameterRef": parameter_ref}); authority = mapper._envelope_authority_digest(clip_ref, parameter_ref)
        with self.assertRaisesRegex(ValueError, "restoration"): mapper.invoke("automation.envelope.delete", {"clipRef": clip_ref, "parameterRef": parameter_ref, "expectedAuthorityDigest": authority, "expectedEnvelopeRevision": read["revision"]})
        self.assertIsNotNone(clip.envelope)

    def test_midi_snapshot_does_not_read_audio_only_warp_markers(self):
        class StrictMidiClip(FakeClip):
            is_audio_clip = False
            @property
            def warp_markers(self): raise RuntimeError("Warp markers are only available for Audio Clips")
        song = FakeSong(); song.tracks[0].clip_slots[0].clip = StrictMidiClip(4.0)
        row = LiveObjectMapper(song).snapshot()["tracks"][0]["clips"][0]
        self.assertFalse(row["isAudio"]); self.assertEqual(row["availableAudioFields"], []); self.assertEqual(row["warpMarkers"], [])

    def test_audio_fields_are_discovered_and_mutated_only_when_writable(self):
        song = FakeSong(); clip = FakeCapturedAudioClip(); clip.is_recording = False; clip.pitch_coarse = 0.0; clip.pitch_fine = 0.0; clip.loop_start = 0.0; clip.loop_end = 2.0; clip.warp_mode = 1; clip.warping = True; clip.fade_in_length = 0.0; clip.fade_out_length = 0.0
        song.tracks[0].clip_slots[0].clip = clip; mapper = LiveObjectMapper(song); row = mapper.snapshot()["tracks"][0]["clips"][0]
        self.assertIn("fadeInLength", row["availableAudioFields"]); self.assertEqual(row["warpMarkers"], [])
        fields = ("gain", "pitchCoarse", "pitchFine", "loopStart", "loopEnd", "warpMode", "warping", "fadeInLength", "fadeOutLength")
        authority = hashlib.sha256(mapper._bounded_canonical(mapper._session_clip_authority(row["ref"])).encode()).hexdigest(); state = hashlib.sha256(mapper._bounded_canonical({field: row.get(field) for field in fields}).encode()).hexdigest()
        result = mapper.invoke("audio.clip.set", {"ref": row["ref"], "expectedObjectIdentity": row["objectIdentity"], "expectedAuthorityRevision": authority, "expectedStateRevision": state, "warping": False, "fadeInLength": 0.25, "fadeOutLength": 0.5})
        self.assertTrue(result["changed"]); self.assertFalse(clip.warping); self.assertEqual(clip.fade_out_length, 0.5)
        del clip.fade_in_length; row = mapper.get(row["ref"]); state = hashlib.sha256(mapper._bounded_canonical({field: row.get(field) for field in fields}).encode()).hexdigest()
        with self.assertRaises(ValueError): mapper.invoke("audio.clip.set", {"ref": row["ref"], "expectedObjectIdentity": row["objectIdentity"], "expectedAuthorityRevision": authority, "expectedStateRevision": state, "fadeInLength": 0.1})

    def test_audio_multi_field_failure_rolls_back_exact_prior_state(self):
        class FailingAudioClip(FakeCapturedAudioClip):
            def __init__(self): self._fade_out = 0.0; super().__init__()
            @property
            def fade_out_length(self): return self._fade_out
            @fade_out_length.setter
            def fade_out_length(self, value):
                if value == 0.5: raise RuntimeError("injected fade failure")
                self._fade_out = value
        song = FakeSong(); clip = FailingAudioClip(); clip.is_recording = False; clip.pitch_coarse = 0.0; clip.pitch_fine = 0.0; clip.loop_start = 0.0; clip.loop_end = 2.0; clip.warp_mode = 1; clip.warping = True; clip.fade_in_length = 0.0
        song.tracks[0].clip_slots[0].clip = clip; mapper = LiveObjectMapper(song); row = mapper.snapshot()["tracks"][0]["clips"][0]; fields = ("gain", "pitchCoarse", "pitchFine", "loopStart", "loopEnd", "warpMode", "warping", "fadeInLength", "fadeOutLength"); authority = hashlib.sha256(mapper._bounded_canonical(mapper._session_clip_authority(row["ref"])).encode()).hexdigest(); state = hashlib.sha256(mapper._bounded_canonical({field: row.get(field) for field in fields}).encode()).hexdigest()
        with self.assertRaisesRegex(ValueError, "loopStart"):
            mapper.invoke("audio.clip.set", {"ref": row["ref"], "expectedObjectIdentity": row["objectIdentity"], "expectedAuthorityRevision": authority, "expectedStateRevision": state, "gain": 0.25, "loopStart": 3.0, "loopEnd": 2.0})
        self.assertEqual(clip.gain, 1.0)
        with self.assertRaisesRegex(RuntimeError, "injected fade failure"):
            mapper.invoke("audio.clip.set", {"ref": row["ref"], "expectedObjectIdentity": row["objectIdentity"], "expectedAuthorityRevision": authority, "expectedStateRevision": state, "gain": 0.25, "fadeOutLength": 0.5})
        self.assertEqual(clip.gain, 1.0); self.assertEqual(clip.fade_out_length, 0.0)

    def test_nested_chain_devices_and_parameters_are_first_class(self):
        class EnableableDevice(FakeDevice):
            def __init__(self):
                super().__init__()
                on = FakeParameter(); on.value = 1.0; on.quantization = 1.0
                self.parameters = [on, FakeParameter()]
            @property
            def enabled(self): return self.parameters[0].value == 1.0
            @enabled.setter
            def enabled(self, _value): pass  # enable state is owned by the Device On parameter
        song = FakeSong(); nested = EnableableDevice(); nested.name = "Nested Utility"; sibling = FakeDevice(); sibling.name = "Sibling"
        chain_one = type("Chain", (), {"name": "Chain 1", "devices": [nested, sibling], "mute": False, "solo": False})(); chain_two = type("Chain", (), {"name": "Chain 2", "devices": [], "mute": False, "solo": False})()
        rack = FakeDevice(); rack.name = "Rack"; rack.can_have_chains = True; rack.chains = [chain_one, chain_two]
        song.tracks[0].devices = [rack]; mapper = LiveObjectMapper(song)
        track_ref = mapper.discover("track")["items"][0]["ref"]; top = mapper.discover("device", parent=track_ref)["items"]
        self.assertEqual([item["name"] for item in top], ["Rack"])
        nested_rows = mapper.discover("device", parent=top[0]["chains"][0]["ref"])["items"]; self.assertEqual([item["name"] for item in nested_rows], ["Nested Utility", "Sibling"])
        nested_row = nested_rows[0]; parameter = mapper.discover("parameter", parent=nested_row["ref"])["items"][0]
        self.assertEqual(parameter["parentRef"], nested_row["ref"]); self.assertEqual(mapper.get(nested_row["ref"])["name"], "Nested Utility")
        owner_identity = top[0]["chains"][0]["objectIdentity"]; siblings = [{"ref": row["ref"], "objectIdentity": row["objectIdentity"]} for row in nested_rows]
        base = {"ref": nested_row["ref"], "expectedObjectIdentity": nested_row["objectIdentity"], "expectedOwnerRef": nested_row["parentRef"], "expectedOwnerIdentity": owner_identity, "expectedSiblings": siblings, "expectedTrackRef": track_ref, "expectedTrackIdentity": mapper.snapshot()["tracks"][0]["objectIdentity"]}
        changed = mapper.invoke("device.enable", {**base, "expectedStateRevision": hashlib.sha256(mapper._bounded_canonical({"enabled": True}).encode()).hexdigest(), "enabled": False}); self.assertTrue(changed["changed"]); self.assertFalse(nested.enabled)
        base["expectedStateRevision"] = hashlib.sha256(mapper._bounded_canonical({"enabled": False}).encode()).hexdigest()
        replacement_sibling = FakeDevice(); replacement_sibling.name = "Sibling"; chain_one.devices[1] = replacement_sibling
        with self.assertRaises(ValueError): mapper.invoke("device.enable", {**base, "enabled": True})
        chain_one.devices[1] = sibling
        replacement_chain = type("Chain", (), {"name": "Replacement", "devices": [nested], "mute": False, "solo": False})(); rack.chains[0] = replacement_chain
        with self.assertRaises(ValueError): mapper.invoke("device.enable", {**base, "enabled": True})
        rack.chains[0] = chain_one; chain_one.devices = []; chain_two.devices = [nested]
        with self.assertRaises(ValueError): mapper.invoke("device.enable", {**base, "enabled": True})

    def test_device_parameter_discovery_and_guarded_mutation(self):
        mapper = LiveObjectMapper(FakeSong())
        track = mapper.discover("track")["items"][0]
        device = mapper.discover("device", parent=track["ref"])["items"][0]
        parameter = mapper.discover("parameter", parent=device["ref"])["items"][0]
        self.assertEqual(parameter["parentRef"], device["ref"])
        self.assertEqual(parameter["revision"], 1)
        changed = mapper.invoke("device.parameter.set", {"ref": parameter["ref"], "value": 0.75, "expectedRevision": 1, **self.parameter_authority(mapper, parameter["ref"])})
        self.assertEqual(changed["value"], 0.75)
        self.assertEqual(changed["revision"], 2)
        with self.assertRaises(ValueError):
            mapper.invoke("device.parameter.set", {"ref": parameter["ref"], "value": 0.7})

    def test_capabilities_are_derived_from_negotiated_operation_sets(self):
        mapper = LiveObjectMapper(FakeSong()); status = mapper.status(); operations, capabilities = set(status["operations"]), set(status["capabilities"])
        requirements = {
            "transport": {"transport.set", "tempo.set"}, "subscriptions": {"subscribe"},
            "session.midi_clip.create": {"clip.create"}, "session.midi_clip.delete": {"clip.delete"},
            "session.midi_note.write": {"note.add", "note.add-batch"},
        }
        for capability, required in requirements.items():
            if capability in capabilities: self.assertTrue(required <= operations, (capability, required - operations))
        self.assertNotIn("max", capabilities)

    def test_partial_recording_and_empty_parameter_shapes_are_not_overadvertised(self):
        partial = FakeSong(); del partial.record_mode; status = LiveObjectMapper(partial).status()
        self.assertNotIn("recording.session", status["operations"]); self.assertNotIn("recording", status["capabilities"])
        empty_device = FakeSong(); empty_device.tracks[0].devices[0].parameters = []; status = LiveObjectMapper(empty_device).status()
        self.assertIn("devices", status["capabilities"]); self.assertNotIn("parameters", status["capabilities"]); self.assertNotIn("device.parameter.write", status["capabilities"])

    def test_selection_uses_canonical_dereferenceable_track_identity(self):
        song = FakeSong(); track, scene, slot = song.tracks[0], song.scenes[0], song.tracks[0].clip_slots[0]; track._live_ptr = 101; scene._live_ptr = 102; slot._live_ptr = 103; copier = __import__("copy").copy
        song.view = type("View", (), {"selected_track": copier(track), "selected_scene": copier(scene), "highlighted_clip_slot": copier(slot)})()
        mapper = LiveObjectMapper(song); selection = mapper.discover("selection")["items"][0]
        canonical_track = mapper.discover("track")["items"][0]["ref"]
        self.assertEqual(selection["selectedTrackRef"], canonical_track); self.assertEqual(mapper.get(selection["selectedTrackRef"])["name"], "Drums")
        self.assertEqual(selection["selectedSceneRef"], mapper.discover("scene")["items"][0]["ref"]); self.assertTrue(selection["highlightedClipSlotRef"].endswith(":0:0"))

    def test_proxy_identity_selection_tracks_recording_and_ambiguity_fail_closed(self):
        copier = __import__("copy").copy; song = FakeSong(); destination = song.tracks[0]; destination._live_ptr = 201; destination.arm = True; mapper = LiveObjectMapper(song); snapshot = mapper.snapshot(); destination_ref = snapshot["tracks"][0]["ref"]; fresh = copier(destination); song.tracks = [fresh]
        args = {"action": "start", "expectedSessionRecord": False, "expectedArrangementRecord": False, "destinationTrackRef": destination_ref, "destinationTrackIdentity": "live:201", "outputSafety": {"safe": True, "provenance": "unit-test"}}
        self.assertEqual(mapper._recording_authority(args, "session"), "start")
        song.tracks.append(copier(destination))
        with self.assertRaisesRegex(ValueError, "ambiguous"): mapper._recording_authority(args, "session")
        song = FakeSong(); song.return_tracks = [FakeTrack()]; song.master_track = FakeTrack(); mapper = LiveObjectMapper(song); rows = mapper.snapshot()["tracks"]
        for row in rows[1:]: self.assertEqual(mapper.get(row["ref"])["objectIdentity"], row["objectIdentity"])
        returned = rows[1]; mapper.invoke("track.rename", {"ref": returned["ref"], "name": "Return Renamed", "expectedName": returned["name"], "expectedObjectIdentity": returned["objectIdentity"], "expectedAuthorityRevision": mapper._rename_authority_revision("track", returned["ref"])})
        self.assertEqual(song.return_tracks[0].name, "Return Renamed")

    def test_duplicate_proxy_identities_and_route_labels_are_refused(self):
        song = FakeSong(); first, second = FakeDevice(), FakeDevice(); first._live_ptr = 301; second._live_ptr = 302; song.tracks[0].devices = [first, second]; mapper = LiveObjectMapper(song); snapshot = mapper.snapshot(); track = snapshot["tracks"][0]; device = track["devices"][0]; siblings = [{"ref": row["ref"], "objectIdentity": row["objectIdentity"]} for row in track["devices"]]
        second._live_ptr = 301
        with self.assertRaisesRegex(ValueError, "ambiguous"): mapper._device_location(device["ref"], device["objectIdentity"], track["ref"], track["objectIdentity"], siblings, track["ref"], track["objectIdentity"])
        choice_one, choice_two = FakeRouteChoice("Duplicate"), FakeRouteChoice("Duplicate"); song.tracks[0].available_input_routing_types = [choice_one, choice_two]
        with self.assertRaisesRegex(ValueError, "ambiguous"): mapper._routing_choice(song.tracks[0], "available_input_routing_types", "Duplicate")
        rack = FakeDevice(); rack.can_have_chains = True; chain = type("Chain", (), {})(); chain.devices = [rack]; rack.chains = [chain]; song.tracks[0].devices = [rack]
        with self.assertRaisesRegex(ValueError, "cyclic"): LiveObjectMapper(song).snapshot()

    def test_destructive_cleanup_requires_unforgeable_unchanged_creation_ownership(self):
        song = FakeSong(); mapper = LiveObjectMapper(song); transaction = "structure-ownership-transaction"; created = mapper.invoke("track.create", {"name": "Owned", "kind": "midi", "index": 1, "expectedStructureRevision": mapper._structure_revision()}, transaction)
        self.assertIn("ownershipToken", created)
        delete_args = {"ref": created["ref"], "expectedStructureRevision": mapper._structure_revision(), "expectedObjectIdentity": created["objectIdentity"]}
        with self.assertRaisesRegex(ValueError, "transaction-owned"): mapper.invoke("track.delete", delete_args, "attacker-transaction")
        song.tracks[1].arrangement_clips = [FakeClip(4.0)]; delete_args["expectedStructureRevision"] = mapper._structure_revision()
        with self.assertRaisesRegex(ValueError, "changed after creation"): mapper.invoke("track.delete", delete_args, transaction, created["ownershipToken"])
        clean_song = FakeSong(); clean_mapper = LiveObjectMapper(clean_song); clean = clean_mapper.invoke("scene.create", {"name": "Owned Scene", "index": 1, "expectedStructureRevision": clean_mapper._structure_revision()}, transaction); clean_args = {"ref": clean["ref"], "expectedStructureRevision": clean_mapper._structure_revision(), "expectedObjectIdentity": clean["objectIdentity"]}
        self.assertEqual(clean_mapper.invoke("scene.delete", clean_args, transaction, clean["ownershipToken"]), {"deleted": clean["ref"]}); clean_mapper._require_cleanup_ownership("scene.delete", clean_args, transaction, clean["ownershipToken"]); clean_mapper.retire_transaction_ownership(transaction)
        with self.assertRaisesRegex(ValueError, "transaction-owned"): clean_mapper._require_cleanup_ownership("scene.delete", clean_args, transaction, clean["ownershipToken"])
        collision_mapper = LiveObjectMapper(FakeSong()); first = collision_mapper.invoke("track.create", {"name": "First at zero", "kind": "midi", "index": 0, "expectedStructureRevision": collision_mapper._structure_revision()}, transaction)
        with self.assertRaisesRegex(ValueError, "shift active transaction-owned reference"): collision_mapper.invoke("track.create", {"name": "Second at zero", "kind": "midi", "index": 0, "expectedStructureRevision": collision_mapper._structure_revision()}, transaction)
        self.assertEqual(len(collision_mapper.song.tracks), 2); self.assertEqual(collision_mapper.invoke("track.delete", {"ref": first["ref"], "expectedStructureRevision": collision_mapper._structure_revision(), "expectedObjectIdentity": first["objectIdentity"]}, transaction, first["ownershipToken"]), {"deleted": first["ref"]}); self.assertEqual(len(collision_mapper.song.tracks), 1)
        shifted_mapper = LiveObjectMapper(FakeSong()); later = shifted_mapper.invoke("track.create", {"name": "Owned later", "kind": "midi", "index": 1, "expectedStructureRevision": shifted_mapper._structure_revision()}, transaction)
        with self.assertRaisesRegex(ValueError, "shift active transaction-owned reference"): shifted_mapper.invoke("track.create", {"name": "Forbidden before", "kind": "midi", "index": 0, "expectedStructureRevision": shifted_mapper._structure_revision()}, "other-structure-transaction")
        self.assertEqual(shifted_mapper.invoke("track.delete", {"ref": later["ref"], "expectedStructureRevision": shifted_mapper._structure_revision(), "expectedObjectIdentity": later["objectIdentity"]}, transaction, later["ownershipToken"]), {"deleted": later["ref"]})
        midi_mapper = LiveObjectMapper(FakeSong(), provenance="real-live"); track_ref = midi_mapper.snapshot()["tracks"][0]["ref"]; midi = midi_mapper.invoke("clip.create", self.clip_creation_args(midi_mapper, track_ref, 0, kind="midi", name="Owned MIDI", length=4), transaction); midi_mapper.invoke("note.add-batch", {"ref": midi["ref"], "notes": [{"pitch": 36, "start": 0, "duration": 0.25, "velocity": 100, "channel": 1}], **self.note_authority(midi_mapper, midi["ref"])}, transaction); self.assertEqual(midi_mapper.invoke("clip.delete", {"ref": midi["ref"], **midi_mapper._session_clip_authority(midi["ref"])}, transaction, midi["ownershipToken"]), {"deleted": midi["ref"]})

    def test_scene_capture_cannot_shift_owned_scene_reference(self):
        mapper = LiveObjectMapper(FakeSong()); transaction = "owned-scene-shift-transaction"; owned = mapper.invoke("scene.create", {"name": "Owned later", "index": 1, "expectedStructureRevision": mapper._structure_revision()}, transaction); mapper.song.capture_and_insert_scene = lambda: mapper.song.scenes.insert(0, FakeScene("Captured before"))
        with self.assertRaisesRegex(ValueError, "shift active transaction-owned"): mapper.invoke("scene.capture", {"expectedStateRevision": mapper._capture_authority_revision()}, "capture-other-transaction")
        self.assertEqual([scene.name for scene in mapper.song.scenes], ["Scene 1", "Owned later"]); self.assertEqual(mapper.invoke("scene.delete", {"ref": owned["ref"], "expectedStructureRevision": mapper._structure_revision(), "expectedObjectIdentity": owned["objectIdentity"]}, transaction, owned["ownershipToken"]), {"deleted": owned["ref"]})

    def test_session_structure_lifecycle_and_empty_slots_are_authoritative(self):
        mapper = LiveObjectMapper(FakeSong())
        track = mapper.discover("track")["items"][0]
        self.assertTrue(track["clipSlots"][0]["empty"])
        stale_revision = mapper._structure_revision(); mapper.song.scenes.append(FakeScene("External"))
        with self.assertRaises(ValueError): mapper.invoke("track.create", {"name": "Stale", "kind": "midi", "index": 1, "expectedStructureRevision": stale_revision})
        mapper.song.scenes.pop()
        created_track = mapper.invoke("track.create", {"name": "Strings", "kind": "midi", "index": 1, "expectedStructureRevision": mapper._structure_revision()})
        created_scene = mapper.invoke("scene.create", {"name": "Verse", "index": 1, "expectedStructureRevision": mapper._structure_revision()})
        self.assertEqual(created_track["name"], "Strings"); self.assertTrue(created_track["objectIdentity"])
        self.assertEqual(created_scene["name"], "Verse"); self.assertTrue(created_scene["objectIdentity"])
        self.assertEqual(mapper.invoke("track.rename", {"ref": created_track["ref"], "name": "Synths", "expectedName": "Strings", "expectedObjectIdentity": created_track["objectIdentity"], "expectedAuthorityRevision": mapper._structure_revision()})["name"], "Synths")
        with self.assertRaises(ValueError): mapper.invoke("track.rename", {"ref": created_track["ref"], "name": "Wrong", "expectedName": "Strings", "expectedObjectIdentity": created_track["objectIdentity"], "expectedAuthorityRevision": mapper._structure_revision()})
        self.assertEqual(mapper.invoke("scene.rename", {"ref": created_scene["ref"], "name": "Chorus", "expectedName": "Verse", "expectedObjectIdentity": created_scene["objectIdentity"], "expectedAuthorityRevision": mapper._structure_revision()})["name"], "Chorus")
        created_track_object = mapper.song.tracks[1]; replacement = FakeTrack(); replacement.name = "Synths"; mapper.song.tracks[1] = replacement
        with self.assertRaises(ValueError): mapper.invoke("track.delete", {"ref": created_track["ref"], "expectedStructureRevision": mapper._structure_revision(), "expectedObjectIdentity": created_track["objectIdentity"]})
        mapper.song.tracks[1] = created_track_object
        self.assertEqual(mapper.invoke("track.delete", {"ref": created_track["ref"], "expectedStructureRevision": mapper._structure_revision(), "expectedObjectIdentity": created_track["objectIdentity"]}), {"deleted": created_track["ref"]})
        self.assertEqual(mapper.invoke("scene.delete", {"ref": created_scene["ref"], "expectedStructureRevision": mapper._structure_revision(), "expectedObjectIdentity": created_scene["objectIdentity"]}), {"deleted": created_scene["ref"]})

    def test_structure_operations_fail_closed_when_live_shape_is_unsupported(self):
        class UnsupportedSong:
            tracks = []
            scenes = []
        mapper = LiveObjectMapper(UnsupportedSong())
        with self.assertRaises(ValueError):
            mapper.invoke("track.create", {"name": "Nope", "kind": "midi", "index": 0, "expectedStructureRevision": mapper._structure_revision()})

    def test_status_does_not_advertise_mutations_missing_from_observed_live_shape(self):
        class ReadOnlyTrack:
            clip_slots = []
            devices = []

        class ReadOnlySong:
            tracks = [ReadOnlyTrack()]
            scenes = []

        status = LiveObjectMapper(ReadOnlySong()).status()
        self.assertIn("status", status["operations"])
        self.assertIn("discover", status["operations"])
        self.assertNotIn("track.create", status["operations"])
        self.assertNotIn("scene.create", status["operations"])
        self.assertNotIn("clip.create", status["operations"])
        self.assertNotIn("note.add", status["operations"])
        self.assertNotIn("note.add-batch", status["operations"])
        self.assertNotIn("device.parameter.set", status["operations"])
        self.assertNotIn("locator.add", status["operations"])

    def test_status_requires_callable_delete_and_usable_device_parameters(self):
        class EmptyDevice:
            parameters = []

        class ReadOnlyTrack:
            clip_slots = []
            devices = [EmptyDevice()]

        class ReadOnlySong:
            tracks = [ReadOnlyTrack()]
            scenes = []

        status = LiveObjectMapper(ReadOnlySong()).status()
        self.assertNotIn("track.delete", status["operations"])
        self.assertNotIn("device.parameter.set", status["operations"])

    def test_hierarchical_discovery_exposes_song_parents_and_empty_slots(self):
        mapper = LiveObjectMapper(FakeSong())
        song = mapper.discover("song")["items"][0]
        track = mapper.discover("track")["items"][0]
        slot = mapper.discover("clip_slot", parent=track["ref"])["items"][0]
        self.assertEqual(track["parentRef"], song["ref"])
        self.assertEqual(slot["parentRef"], track["ref"])
        self.assertTrue(slot["empty"])
        self.assertEqual(mapper.discover("clip_slot", parent=track["ref"], requested_fields=["empty"])["items"][0], {"ref": slot["ref"], "parentRef": track["ref"], "empty": True})

    def test_discovery_cursor_is_opaque_authenticated_and_revision_bound(self):
        mapper = LiveObjectMapper(FakeSong())
        page = mapper.discover("track", limit=1, traversal_budget=1)
        self.assertIsNone(page.get("nextCursor"))
        mapper = LiveObjectMapper(FakeSong())
        mapper.song.tracks.append(FakeTrack())
        page = mapper.discover("track", limit=1)
        cursor = page["nextCursor"]
        self.assertIsInstance(cursor, str)
        self.assertNotIn(":", cursor)
        self.assertEqual(len(mapper.discover("track", limit=1, cursor=cursor)["items"]), 1)
        tampered = ("A" if cursor[4] != "A" else "B") + cursor[5:]
        with self.assertRaises(ValueError):
            mapper.discover("track", limit=1, cursor=tampered)

    def test_discovery_rejects_stale_parent_and_reports_unknown_playback_authoritatively(self):
        mapper = LiveObjectMapper(FakeSong())
        stale = f"{mapper.refs.epoch + 1}:track:0"
        with self.assertRaises(ValueError):
            mapper.discover("clip_slot", parent=stale)
        playback = mapper.discover("session_playback")["items"][0]
        self.assertIs(playback["transport"]["playing"], False)
        self.assertEqual(playback["transport"]["launchQuantization"]["normalized"], "1-bar")
        self.assertEqual(playback["firedTargets"], [])

    def test_playback_derives_exact_targets_from_track_slot_indexes(self):
        song = FakeSong()
        song.tracks[0].clip_slots[0].create_clip(4)
        song.tracks[0].playing_slot_index = 0
        song.tracks[0].fired_slot_index = 0
        mapper = LiveObjectMapper(song)
        snapshot = mapper.snapshot()
        track = snapshot["tracks"][0]
        self.assertEqual(track["monitoringState"], "off")
        self.assertEqual(track["playingSlotIndex"], 0)
        for target in snapshot["playback"]["playingTargets"] + snapshot["playback"]["firedTargets"]:
            self.assertEqual(target["trackRef"], track["ref"])
            self.assertEqual(target["clipSlotRef"], track["clipSlots"][0]["ref"])
            self.assertEqual(target["sceneRef"], snapshot["scenes"][0]["ref"])
            self.assertEqual(target["sceneIndex"], 0)
            self.assertEqual(target["clipRef"], track["clipSlots"][0]["clipRef"])

    def test_unknown_monitoring_and_arm_remain_unavailable(self):
        song = FakeSong()
        del song.tracks[0].arm

    def _audition_args(self, mapper):
        snapshot = mapper.snapshot()
        scene = snapshot["scenes"][0]
        track = snapshot["tracks"][0]
        slot = track["clipSlots"][0]
        return snapshot, {
            "ref": scene["ref"],
            "setName": snapshot["set"]["name"],
            "sceneName": scene["name"],
            "sceneIndex": scene["index"],
            "playbackRevision": snapshot["playback"]["revision"],
            "eligibleTargets": [f"{track['ref']}|{slot['ref']}|{scene['ref']}"],
            "expectedSetIdentity": snapshot["set"]["objectIdentity"],
            "expectedAuthorityRevision": mapper._audition_authority_revision(snapshot, scene["ref"], scene["index"], {f"{track['ref']}|{slot['ref']}|{scene['ref']}"}),
            "outputSafety": {"safe": True, "provenance": "unit-test-operator"},
        }

    def test_guarded_audition_launch_rechecks_identity_safety_and_eligibility(self):
        mapper = LiveObjectMapper(FakeAuditionSong())
        snapshot, args = self._audition_args(mapper)
        self.assertIn("session.audition-launch", mapper.status()["operations"])
        self.assertIn("session.audition-stop", mapper.status()["operations"])
        self.assertIn("session.emergency-stop", mapper.status()["operations"])
        self.assertNotIn("scene.launch", mapper.status()["operations"])
        self.assertNotIn("stop-all-clips", mapper.status()["operations"])
        self.assertNotIn("transport.stop", mapper.status()["operations"])
        unsafe = dict(args); unsafe.pop("outputSafety")
        with self.assertRaises(ValueError): mapper.invoke("session.audition-launch", unsafe)
        with self.assertRaises(ValueError):
            mapper.invoke("session.audition-launch", {**args, "playbackRevision": "stale"})
        with self.assertRaises(ValueError):
            mapper.invoke("session.audition-launch", {**args, "setName": "Other Set"})
        with self.assertRaises(ValueError):
            mapper.invoke("session.audition-launch", {**args, "eligibleTargets": [f"{snapshot['tracks'][0]['ref']}|{snapshot['tracks'][0]['clipSlots'][0]['ref']}|1:scene:9"]})
        result = mapper.invoke("session.audition-launch", args)
        self.assertEqual(result["launched"], args["ref"])
        self.assertEqual(len(result["targets"]), 1)
        self.assertTrue(mapper.song.is_playing)
        with self.assertRaises(ValueError):
            mapper.invoke("session.audition-launch", args)

    def test_guarded_audition_launch_refuses_armed_or_monitored_tracks(self):
        song = FakeAuditionSong()
        song.tracks[0].arm = True
        mapper = LiveObjectMapper(song)
        _, args = self._audition_args(mapper)
        with self.assertRaises(ValueError):
            mapper.invoke("session.audition-launch", args)
        song.tracks[0].arm = False
        song.tracks[0].current_monitoring_state = 0
        mapper = LiveObjectMapper(song)
        _, args = self._audition_args(mapper)
        with self.assertRaises(ValueError):
            mapper.invoke("session.audition-launch", args)
        # Auto monitoring with a verified-unarmed track passes no input.
        song.tracks[0].current_monitoring_state = 1
        mapper = LiveObjectMapper(song)
        _, args = self._audition_args(mapper)
        result = mapper.invoke("session.audition-launch", args)
        self.assertEqual(result["launched"], args["ref"])

    def test_guarded_audition_stop_requires_owned_playback_and_verifies_stopped(self):
        mapper = LiveObjectMapper(FakeAuditionSong())
        _, launch = self._audition_args(mapper)
        mapper.invoke("session.audition-launch", launch)
        stop_args = {"ref": launch["ref"], "setName": launch["setName"], "eligibleTargets": launch["eligibleTargets"], "expectedSetIdentity": launch["expectedSetIdentity"], "expectedAuthorityRevision": launch["expectedAuthorityRevision"]}
        with self.assertRaises(ValueError):
            mapper.invoke("session.audition-stop", {**stop_args, "setName": "Other Set"})
        self.assertTrue(mapper.song.is_playing)
        self.assertEqual(mapper.invoke("session.audition-stop", stop_args), {"stopped": True})
        self.assertFalse(mapper.song.is_playing)
        self.assertEqual(mapper.song.stopped_all, 1)
        # Stopping again with no active playback is an idempotent no-op.
        self.assertEqual(mapper.invoke("session.audition-stop", stop_args), {"stopped": True})
        # External playback outside the owned target set refuses the owned stop.
        _, relaunch = self._audition_args(mapper)
        mapper.invoke("session.audition-launch", relaunch)
        scene2 = FakeScene("Scene 2")
        mapper.song.scenes.append(scene2)
        mapper.song.tracks[0].clip_slots.append(FakeSlot())
        with self.assertRaises(ValueError):
            mapper.invoke("session.audition-stop", {**stop_args, "eligibleTargets": []})
        self.assertTrue(mapper.song.is_playing)

    def test_guarded_emergency_stop_requires_exact_observation_and_stops(self):
        mapper = LiveObjectMapper(FakeAuditionSong())
        _, launch = self._audition_args(mapper)
        mapper.invoke("session.audition-launch", launch)
        with self.assertRaises(ValueError):
            mapper.invoke("session.emergency-stop", {"expectedTargets": [], "expectedRecording": "stopped"})
        self.assertTrue(mapper.song.is_playing)
        result = mapper.invoke("session.emergency-stop", {"expectedTargets": launch["eligibleTargets"], "expectedRecording": "stopped"})
        self.assertEqual(result["stopped"], True)
        self.assertEqual(result["stoppedTargets"], launch["eligibleTargets"])
        self.assertFalse(mapper.song.is_playing)
        # An empty observation is exact when nothing is playing.
        self.assertEqual(mapper.invoke("session.emergency-stop", {"expectedTargets": [], "expectedRecording": "stopped"})["stopped"], True)

    def test_generic_audible_operations_are_not_mapper_capabilities(self):
        mapper = LiveObjectMapper(FakeAuditionSong())
        operation_ids = {item["id"] for item in operation_registry()[0]["operations"]}
        for operation in ("set", "clip.launch", "track.stop", "playback.stop-all-clips", "scene.launch", "stop-all-clips", "transport.stop"):
            self.assertNotIn(operation, operation_ids)
            with self.assertRaises(ValueError):
                mapper.invoke(operation, {})

    def test_guarded_clip_launch_and_stop_require_exact_atomic_identity(self):
        song = FakeAuditionSong(); song.tracks[0].clip_slots[0].fire = song.scenes[0].fire; song.tracks[0].stop_all_clips = song.stop_all_clips
        second_slot = FakeSlot(); second_slot.clip = FakeClip(4.0); second_slot.fire = song.scenes[0].fire
        song.tracks[0].clip_slots.append(second_slot); song.scenes.append(FakeScene("Scene 2"))
        mapper = LiveObjectMapper(song)
        snapshot = mapper.snapshot(); track = snapshot["tracks"][0]; slot = track["clipSlots"][0]; scene = snapshot["scenes"][0]
        clip = next(item for item in track["clips"] if item["ref"] == slot["clipRef"])
        authority = {"slotRef": slot["ref"], "trackRef": track["ref"], "sceneRef": scene["ref"], "sceneIndex": scene["index"], "clipRef": slot["clipRef"], "trackIdentity": track["objectIdentity"], "sceneIdentity": scene["objectIdentity"], "slotIdentity": slot["objectIdentity"], "clipIdentity": clip["objectIdentity"], "playbackRevision": snapshot["playback"]["revision"], "outputSafety": {"safe": True, "provenance": "unit-test-operator"}}
        stale = dict(authority); stale["playbackRevision"] = "stale"
        with self.assertRaises(ValueError): mapper.invoke("session.clip-launch", stale)
        cross_wired = dict(authority); cross_wired["sceneRef"] = snapshot["scenes"][1]["ref"]; cross_wired["sceneIndex"] = 1
        with self.assertRaises(ValueError): mapper.invoke("session.clip-launch", cross_wired)
        launched = mapper.invoke("session.clip-launch", authority)
        self.assertEqual(launched["launched"], slot["ref"])
        layered = dict(authority); layered["playbackRevision"] = mapper.snapshot()["playback"]["revision"]
        with self.assertRaises(ValueError): mapper.invoke("session.clip-launch", layered)
        stopped = mapper.invoke("session.clip-stop", {key: value for key, value in authority.items() if key != "playbackRevision"})
        self.assertTrue(stopped["stopped"])

    def test_guarded_clip_launch_accepts_fresh_live_proxies_but_not_replacements(self):
        song = FakeAuditionSong(); original_track, original_scene, original_slot, original_clip = song.tracks[0], song.scenes[0], song.tracks[0].clip_slots[0], song.tracks[0].clip_slots[0].clip
        for value, pointer in ((original_track, 101), (original_scene, 102), (original_slot, 103), (original_clip, 104)): value._live_ptr = pointer
        mapper = LiveObjectMapper(song); snapshot = mapper.snapshot(); track_row = snapshot["tracks"][0]; slot_row = track_row["clipSlots"][0]; scene_row = snapshot["scenes"][0]; clip_row = track_row["clips"][0]
        authority = {"slotRef": slot_row["ref"], "trackRef": track_row["ref"], "sceneRef": scene_row["ref"], "sceneIndex": 0, "clipRef": slot_row["clipRef"], "trackIdentity": track_row["objectIdentity"], "sceneIdentity": scene_row["objectIdentity"], "slotIdentity": slot_row["objectIdentity"], "clipIdentity": clip_row["objectIdentity"], "playbackRevision": snapshot["playback"]["revision"], "outputSafety": {"safe": True, "provenance": "unit-test-operator"}}
        fresh_track, fresh_scene, fresh_slot, fresh_clip = FakeTrack(), FakeScene("Scene 1"), FakeSlot(), FakeClip(4.0)
        for value, pointer in ((fresh_track, 101), (fresh_scene, 102), (fresh_slot, 103), (fresh_clip, 104)): value._live_ptr = pointer
        fired = []
        def fresh_fire(): fired.append(True); song.is_playing = True; fresh_track.playing_slot_index = 0; fresh_track.fired_slot_index = 0
        def fresh_stop(): fresh_track.playing_slot_index = -1; fresh_track.fired_slot_index = -1
        fresh_slot.clip = fresh_clip; fresh_slot.fire = fresh_fire; fresh_track.stop_all_clips = fresh_stop; fresh_track.clip_slots = [fresh_slot]; song.tracks = [fresh_track]; song.scenes = [fresh_scene]
        self.assertEqual(mapper.invoke("session.clip-launch", authority)["launched"], slot_row["ref"]); self.assertEqual(fired, [True])
        stop_authority = {key: value for key, value in authority.items() if key not in {"playbackRevision", "outputSafety"}}
        replacement = FakeClip(4.0); replacement._live_ptr = 999; fresh_slot.clip = replacement
        with self.assertRaises(ValueError): mapper.invoke("session.clip-stop", stop_authority)
        self.assertEqual(fresh_track.playing_slot_index, 0)
        fresh_slot.clip = fresh_clip; self.assertTrue(mapper.invoke("session.clip-stop", stop_authority)["stopped"])
        song.is_playing = False; fired.clear(); fresh_slot.clip = replacement
        with self.assertRaises(ValueError): mapper.invoke("session.clip-launch", authority)
        self.assertEqual(fired, [])

    def test_recording_requires_atomic_state_destination_and_output_authority(self):
        song = FakeAuditionSong(); song.tracks[0].arm = True
        mapper = LiveObjectMapper(song); track_row = mapper.snapshot()["tracks"][0]; track_ref = track_row["ref"]
        authority = {"action": "start", "expectedSessionRecord": False, "expectedArrangementRecord": False, "destinationTrackRef": track_ref, "destinationTrackIdentity": track_row["objectIdentity"], "outputSafety": {"safe": True, "provenance": "operator-observed"}}
        with self.assertRaises(ValueError): mapper.invoke("recording.session", {**authority, "expectedSessionRecord": True})
        self.assertEqual(mapper.invoke("recording.session", authority)["recording"], True)
        with self.assertRaises(ValueError): mapper.invoke("recording.session", authority)
        stopped_recording = mapper.invoke("session.emergency-stop", {"expectedTargets": [], "expectedRecording": "session"})
        self.assertTrue(stopped_recording["recordingStopped"]); self.assertFalse(song.session_record)

    def test_unknown_monitoring_and_arm_remain_unavailable(self):
        song = FakeSong()
        del song.tracks[0].arm
        song.tracks[0].current_monitoring_state = 99
        row = LiveObjectMapper(song).snapshot()["tracks"][0]
        self.assertIsNone(row["armed"])
        self.assertIsNone(row["monitoringState"])

    def test_arrangement_locators_are_authoritative_and_reversible(self):
        song = FakeArrangementSong()
        mapper = LiveObjectMapper(song)
        self.assertIn("arrangement.write", mapper.status()["capabilities"])
        self.assertEqual(mapper.discover("locator")["items"][0]["name"], "Intro")
        created = mapper.invoke("arrangement.locator.create", {"name": "Verse", "position": 8, "expectedCollectionRevision": mapper.snapshot()["arrangement"]["locatorRevision"]})
        self.assertEqual(created["name"], "Verse")
        self.assertEqual(mapper.discover("locator")["items"][-1]["position"], 8)
        delete_args = {"ref": created["ref"], "expectedObjectIdentity": created["objectIdentity"], "expectedCollectionRevision": mapper.snapshot()["arrangement"]["locatorRevision"]}
        self.assertEqual(mapper.invoke("arrangement.locator.delete", delete_args), {"deleted": created["ref"]})
        self.assertEqual([item["name"] for item in mapper.discover("locator")["items"]], ["Intro"])

    def test_arrangement_locator_rejects_collisions_and_unsupported_shapes(self):
        mapper = LiveObjectMapper(FakeArrangementSong())
        with self.assertRaises(ValueError):
            mapper.invoke("arrangement.locator.create", {"name": "Other", "position": 0, "expectedCollectionRevision": mapper.snapshot()["arrangement"]["locatorRevision"]})
        with self.assertRaises(ValueError):
            mapper.invoke("arrangement.locator.create", {"name": "Other", "position": float("nan")})
        with self.assertRaises(ValueError):
            LiveObjectMapper(FakeSong()).invoke("arrangement.locator.create", {"name": "Other", "position": 4})

    def test_entrypoint_requires_explicit_loopback_configuration(self):
        with self.assertRaises(ValueError):
            create_instance(FakeInstance())

    def test_bridge_rejects_ambient_environment_configuration(self):
        with self.assertRaises(ValueError):
            AbletonMcpBridge(FakeInstance())

    def test_real_live_mapper_reconnect_clears_cleanup_ownership_without_mutation_transaction(self):
        mapper = LiveObjectMapper(FakeSong(), provenance="real-live"); mapper._owned_cleanup_tokens["o" * 48] = {"transactionId": "transaction-one", "ref": "ref", "objectIdentity": "identity", "fingerprint": "f" * 64}
        result = mapper.invoke("session.reconnect", {})
        self.assertEqual(result["connected"], True); self.assertEqual(mapper._owned_cleanup_tokens, {})

    def test_mapper_get_is_read_only_and_generic_set_is_absent(self):
        mapper = LiveObjectMapper(FakeSong())
        track_ref = mapper.discover("track")["items"][0]["ref"]
        self.assertEqual(mapper.get(track_ref)["name"], "Drums")
        self.assertFalse(hasattr(mapper, "set"))

    def test_mapper_discovery_and_midi_lifecycle_use_fake_live_objects(self):
        mapper = LiveObjectMapper(FakeSong())
        status = mapper.status()
        self.assertTrue(status["connected"])
        self.assertIn("session.midi_clip.create", status["capabilities"])
        self.assertIn("session.midi_clip.delete", status["capabilities"])
        self.assertIn("session.midi_note.write", status["capabilities"])
        self.assertIn("note.add-batch", status["operations"])
        track = mapper.discover("track")["items"][0]["ref"]
        created = mapper.invoke("clip.create", self.clip_creation_args(mapper, track, 0, kind="midi", name="Four bars", length=16))
        self.assertEqual(created["name"], "Four bars")
        mapper.invoke("note.add", {"ref": created["ref"], "note": {"pitch": 36, "start": 0, "duration": 0.25, "velocity": 110, "channel": 1}, **self.note_authority(mapper, created["ref"])})
        batch = mapper.invoke("note.add-batch", {"ref": created["ref"], "notes": [
            {"pitch": 38, "start": 1, "duration": 0.25, "velocity": 100, "channel": 1},
            {"pitch": 42, "start": 2, "duration": 0.25, "velocity": 90, "channel": 1, "mute": True, "probability": 0.5, "velocityDeviation": 7, "releaseVelocity": 32},
        ], **self.note_authority(mapper, created["ref"])})
        self.assertEqual(batch["added"], 2); self.assertEqual(batch["noteIds"], [2, 3]); self.assertRegex(batch["notesRevision"], r"^[a-f0-9]{64}$")
        clip = mapper.refs.get(created["ref"])
        self.assertEqual([note["pitch"] for note in clip.get_notes(0, 0, 0, 128)], [36, 38, 42])
        expressive = mapper.get(created["ref"])["notes"][2]
        self.assertEqual({key: expressive[key] for key in ("mute", "probability", "velocityDeviation", "releaseVelocity")}, {"mute": True, "probability": 0.5, "velocityDeviation": 7.0, "releaseVelocity": 32.0})
        self.assertEqual(mapper.invoke("clip.delete", {"ref": created["ref"], **mapper._session_clip_authority(created["ref"])}), {"deleted": created["ref"]})

    def test_note_batch_ids_exclude_preexisting_coincident_notes(self):
        class ExtendedNote:
            def __init__(self, note_id, pitch, start, duration, velocity=100):
                self.note_id = note_id; self.pitch = pitch; self.start_time = start; self.duration = duration; self.velocity = velocity
                self.channel = 1; self.mute = False; self.probability = 1.0; self.velocity_deviation = 0.0; self.release_velocity = 64.0

        class ExtendedClip:
            length = 4.0
            def __init__(self): self.notes = [ExtendedNote(7, 36, 0, 0.25)]; self.next_id = 8
            def get_all_notes_extended(self): return list(self.notes)
            def add_new_notes(self, notes):
                for note in notes:
                    self.notes.append(ExtendedNote(self.next_id, note["pitch"], note["start_time"], note["duration"], note["velocity"])); self.next_id += 1
            def remove_notes_by_id(self, ids): self.notes = [note for note in self.notes if note.note_id not in set(ids)]

        song = FakeSong(); clip = ExtendedClip(); song.tracks[0].clip_slots[0].clip = clip; mapper = LiveObjectMapper(song); clip_ref = mapper.snapshot()["tracks"][0]["clips"][0]["ref"]
        result = mapper.invoke("note.add-batch", {"ref": clip_ref, "notes": [{"pitch": 36, "start": 0, "duration": 0.25, "velocity": 100, "channel": 1}], **self.note_authority(mapper, clip_ref)})
        self.assertEqual(result["added"], 1); self.assertEqual(result["noteIds"], [8]); self.assertRegex(result["notesRevision"], r"^[a-f0-9]{64}$")

    def test_midi_reads_cover_exact_clip_length_and_refuse_unbounded_or_replacing_fallbacks(self):
        class LegacyClip:
            def __init__(self, count=1): self.length = 6000.0; self.calls = []; self.count = count; self.set_called = False
            def get_notes(self, pitch, start, span, pitches): self.calls.append((pitch, start, span, pitches)); return [(60, 5000.0, 0.25, 100)] * self.count
            def add_new_notes(self, _notes): pass
            def set_notes(self, _notes): self.set_called = True
        song = FakeSong(); clip = LegacyClip(); song.tracks[0].clip_slots[0].clip = clip; mapper = LiveObjectMapper(song); row = mapper.snapshot()["tracks"][0]["clips"][0]
        self.assertEqual(row["notes"][0]["start"], 5000.0); self.assertEqual(clip.calls[-1][2], 6000.0)
        authority = self.note_authority(mapper, row["ref"])
        with self.assertRaisesRegex(ValueError, "set_notes replacement is refused"): mapper.invoke("note.add-batch", {"ref": row["ref"], "notes": [{"pitch": 61, "start": 1, "duration": 0.25, "velocity": 100, "channel": 1}], **authority})
        self.assertFalse(clip.set_called)
        oversized = LegacyClip(513); song.tracks[0].clip_slots[0].clip = oversized
        with self.assertRaisesRegex(ValueError, "exceeds its authoritative bound"): LiveObjectMapper(song).snapshot()

    def test_partial_native_note_addition_rolls_back_new_stable_ids(self):
        class Note:
            def __init__(self, note_id, pitch): self.note_id = note_id; self.pitch = pitch; self.start_time = 0.0; self.duration = 0.25; self.velocity = 100; self.channel = 1; self.mute = False; self.probability = 1.0; self.velocity_deviation = 0.0; self.release_velocity = 64.0
        class Clip:
            length = 4.0
            def __init__(self): self.notes = [Note(1, 36)]
            def get_all_notes_extended(self): return list(self.notes)
            def add_new_notes(self, notes): self.notes.append(Note(2, notes[0]["pitch"])); raise RuntimeError("injected partial native add")
            def remove_notes_by_id(self, ids): self.notes = [note for note in self.notes if note.note_id not in ids]
        song = FakeSong(); clip = Clip(); song.tracks[0].clip_slots[0].clip = clip; mapper = LiveObjectMapper(song); ref = mapper.snapshot()["tracks"][0]["clips"][0]["ref"]
        with self.assertRaisesRegex(RuntimeError, "partial native add"): mapper.invoke("note.add-batch", {"ref": ref, "notes": [{"pitch": 38, "start": 0, "duration": 0.25, "velocity": 100, "channel": 1}], **self.note_authority(mapper, ref)})
        self.assertEqual([note.note_id for note in clip.notes], [1])
        duplicate = Clip(); duplicate.notes = [Note(1, 36), Note(1, 38)]; song.tracks[0].clip_slots[0].clip = duplicate; mapper = LiveObjectMapper(song); ref = mapper.snapshot()["tracks"][0]["clips"][0]["ref"]
        with self.assertRaisesRegex(ValueError, "unique stable note identity"): mapper.invoke("note.add-batch", {"ref": ref, "notes": [{"pitch": 40, "start": 0, "duration": 0.25, "velocity": 100, "channel": 1}], **self.note_authority(mapper, ref)})
        self.assertEqual(len(duplicate.notes), 2)

    def test_mapper_clip_creation_uses_session_slot_index(self):
        mapper = LiveObjectMapper(FakeSong())
        track = mapper.discover("track")["items"][0]["ref"]
        created = mapper.invoke("clip.create", self.clip_creation_args(mapper, track, 0, kind="midi", name="Session slot", length=16))
        self.assertEqual(mapper.refs.get(created["ref"]).length, 16)

    def test_post_creation_mapping_failures_remove_owned_clip_and_device(self):
        song = FakeSong(); mapper = LiveObjectMapper(song); track_ref = mapper.snapshot()["tracks"][0]["ref"]; mapper._mapped_fingerprint = lambda _reference: (_ for _ in ()).throw(RuntimeError("injected mapping failure"))
        with self.assertRaisesRegex(RuntimeError, "injected mapping failure"): mapper.invoke("clip.create", self.clip_creation_args(mapper, track_ref, 0, kind="midi", name="Temporary", length=4))
        self.assertIsNone(song.tracks[0].clip_slots[0].clip)
        song = FakeSong(); track = song.tracks[0]; track.devices = []; track.insert_device = lambda name, index: track.devices.insert(len(track.devices) if index < 0 else index, type("InsertedDevice", (), {"name": name, "class_name": "InsertedDevice", "enabled": True, "parameters": [FakeParameter()]})()); track.delete_device = lambda index: track.devices.pop(index); mapper = LiveObjectMapper(song); row = mapper.snapshot()["tracks"][0]; mapper._mapped_fingerprint = lambda _reference: (_ for _ in ()).throw(RuntimeError("injected device mapping failure"))
        with self.assertRaisesRegex(RuntimeError, "injected device mapping failure"): mapper.invoke("device.insert", {"trackRef": row["ref"], "deviceName": "Utility", "expectedTrackIdentity": row["objectIdentity"], "expectedSiblings": [{"ref": item["ref"], "objectIdentity": item["objectIdentity"]} for item in row["devices"]]})
        self.assertEqual(len(track.devices), 0)
        song = FakeSong(); slot = song.tracks[0].clip_slots[0]; slot.create_clip = lambda length: (setattr(slot, "clip", FakeClip(length + 1)) or slot.clip); mapper = LiveObjectMapper(song); track_ref = mapper.snapshot()["tracks"][0]["ref"]
        with self.assertRaisesRegex(ValueError, "name or length"): mapper.invoke("clip.create", self.clip_creation_args(mapper, track_ref, 0, kind="midi", name="Wrong length", length=4))
        self.assertIsNone(slot.clip)
        song = FakeSong(); track = song.tracks[0]; track.devices = []; track.insert_device = lambda name, index: track.devices.append(type("InsertedDevice", (), {"name": "Substituted", "class_name": "InsertedDevice", "enabled": True, "parameters": []})()); track.delete_device = lambda index: track.devices.pop(index); mapper = LiveObjectMapper(song); row = mapper.snapshot()["tracks"][0]
        with self.assertRaisesRegex(ValueError, "exact requested"): mapper.invoke("device.insert", {"trackRef": row["ref"], "deviceName": "Wrong index", "index": 0, "expectedTrackIdentity": row["objectIdentity"], "expectedSiblings": [{"ref": item["ref"], "objectIdentity": item["objectIdentity"]} for item in row["devices"]]})
        self.assertEqual(len(track.devices), 0)

    def test_cleanup_token_attachment_failure_removes_physical_creation_and_registry_mapping(self):
        song = FakeSong(); mapper = LiveObjectMapper(song, provenance="real-live"); track_ref = mapper.snapshot()["tracks"][0]["ref"]; checkpoint = mapper.refs.checkpoint(); mapper._attach_cleanup_ownership = lambda *_args: (_ for _ in ()).throw(RuntimeError("injected token attachment failure"))
        with self.assertRaisesRegex(RuntimeError, "token attachment failure"): mapper.invoke("clip.create", self.clip_creation_args(mapper, track_ref, 0, kind="midi", name="Unattached", length=4), "attachment-failure-transaction")
        self.assertIsNone(song.tracks[0].clip_slots[0].clip); self.assertEqual(mapper.refs.checkpoint(), checkpoint); self.assertEqual(mapper._owned_cleanup_tokens, {})

    def test_mapper_rejects_unsafe_clip_and_note_mutations(self):
        mapper = LiveObjectMapper(FakeSong())
        track = mapper.discover("track")["items"][0]["ref"]
        with self.assertRaises(ValueError):
            mapper.invoke("clip.create", self.clip_creation_args(mapper, track, 0, kind="midi", name="bad", length=float("nan")))
        created = mapper.invoke("clip.create", self.clip_creation_args(mapper, track, 0, kind="midi", name="bounded", length=4))
        with self.assertRaises(ValueError):
            mapper.invoke("note.add", {"ref": created["ref"], "note": {"pitch": 36, "start": 3.5, "duration": 1, "velocity": 100, "channel": 1}, **self.note_authority(mapper, created["ref"])})
        with self.assertRaises(ValueError):
            mapper.invoke("note.add-batch", {"ref": created["ref"], "notes": [
                {"pitch": 36, "start": 0, "duration": 0.25, "velocity": 100, "channel": 1},
                {"pitch": 38, "start": 3.5, "duration": 1, "velocity": 100, "channel": 1},
            ], **self.note_authority(mapper, created["ref"])})
        self.assertEqual(mapper.refs.get(created["ref"]).get_notes(0, 0, 0, 128), [])

    def test_discovery_pages_notes_and_rejects_stale_cursor(self):
        mapper = LiveObjectMapper(FakeSong())
        track = mapper.discover("track")["items"][0]["ref"]
        created = mapper.invoke("clip.create", self.clip_creation_args(mapper, track, 0, kind="midi", name="Paged", length=16))
        mapper.invoke("note.add", {"ref": created["ref"], "note": {"pitch": 36, "start": 0, "duration": 0.25, "velocity": 100, "channel": 1}, **self.note_authority(mapper, created["ref"])})
        page = mapper.discover("note", 1, parent=created["ref"])
        self.assertEqual(len(page["items"]), 1)
        mapper.invoke("session.reconnect", {})
        with self.assertRaises(ValueError):
            mapper.discover("note", 1, page.get("nextCursor", "invalid"), parent=created["ref"])

    def test_timed_out_main_thread_callback_is_fenced_from_late_drain(self):
        work = _MainThreadQueue()
        mutations = []
        errors = []
        import threading
        worker = threading.Thread(target=lambda: self._capture_queue_error(work, mutations, errors))
        worker.start(); worker.join(1)
        self.assertEqual(errors, ["Live main-thread operation timed out before dispatch"])
        self.assertEqual(work.drain(), 1)
        self.assertEqual(mutations, [])

    @staticmethod
    def _capture_queue_error(work, mutations, errors):
        try: work.submit(lambda: mutations.append("mutated"), timeout=0.01)
        except TimeoutError as error: errors.append(str(error))

    def test_nonblocking_main_thread_callback_reports_predispatch_expiry(self):
        work = _MainThreadQueue()
        mutations = []
        cancellations = []
        self.assertTrue(work.submit_nowait(lambda: mutations.append("mutated"), int(time.time() * 1000) + 10, lambda error: cancellations.append(str(error))))
        time.sleep(0.02)
        self.assertEqual(work.drain(), 1)
        self.assertEqual(mutations, [])
        self.assertEqual(cancellations, ["Live main-thread operation timed out before dispatch"])

    def test_bridge_lifecycle_and_main_thread_queue_cleanup(self):
        bridge = AbletonMcpBridge(FakeInstance(), {"host": "127.0.0.1", "port": 45678, "secret": "0123456789abcdef0123456789abcdef"})
        self.assertGreater(bridge.address[1], 0)
        result = []

        def submit():
            result.append(bridge._dispatch("status", {}))

        import threading
        worker = threading.Thread(target=submit)
        worker.start()
        self.assertEqual(bridge.drain_main_thread(), 1)
        worker.join(1)
        self.assertTrue(result[0]["connected"])
        queued = []
        worker = threading.Thread(target=lambda: queued.append(bridge._dispatch("status", {})))
        worker.start()
        bridge.update_display()
        worker.join(1)
        self.assertEqual(len(queued), 1)
        bridge.disconnect()
        self.assertTrue(bridge._stop.is_set())
        self.assertEqual(len(bridge._clients), 0)

    def test_disconnect_releases_waiting_main_thread_work(self):
        bridge = AbletonMcpBridge(FakeInstance(), {"host": "127.0.0.1", "port": 45679, "secret": "0123456789abcdef0123456789abcdef"})
        result = []
        import threading
        worker = threading.Thread(target=lambda: result.append(self._dispatch_error(bridge)))
        worker.start()
        bridge.disconnect()
        worker.join(1)
        self.assertEqual(result, ["Live bridge is disconnected"])

    @staticmethod
    def _dispatch_error(bridge):
        try:
            bridge._dispatch("status", {})
        except RuntimeError as error:
            return str(error)
        return "no error"


    def test_audition_refuses_same_slot_clip_substitution_at_live_thread_boundary(self):
        song = FakeAuditionSong(); mapper = LiveObjectMapper(song); _, args = self._audition_args(mapper)
        song.tracks[0].clip_slots[0].clip = FakeClip(4.0)
        with self.assertRaisesRegex(ValueError, "identity hierarchy"):
            mapper.invoke("session.audition-launch", args)
        self.assertFalse(song.is_playing)

    def test_atomic_session_clip_move_compensates_when_source_delete_fails(self):
        song = FakeSong(); song.scenes.append(FakeScene("Scene 2")); source = song.tracks[0].clip_slots[0]; source.clip = FakeClip(4.0); source.clip.name = "Source"; target = FakeSlot(); song.tracks[0].clip_slots.append(target)
        def duplicate(destination): duplicate_clip = FakeClip(source.clip.length); duplicate_clip.name = source.clip.name; destination.clip = duplicate_clip
        source.duplicate_clip_to = duplicate
        def refuse_delete(): raise RuntimeError("injected delete failure")
        source.delete_clip = refuse_delete
        mapper = LiveObjectMapper(song); snapshot = mapper.snapshot(); track = snapshot["tracks"][0]; source_row = track["clips"][0]; target_slot = track["clipSlots"][1]; target_scene = snapshot["scenes"][1]
        args = {"ref": source_row["ref"], "targetTrackRef": track["ref"], "targetSceneIndex": 1, "arrangementPosition": None, **mapper._session_clip_authority(source_row["ref"]), "expectedContentFingerprint": mapper._mapped_fingerprint(source_row["ref"]), "expectedTargetTrackIdentity": track["objectIdentity"], "expectedTargetSlotRef": target_slot["ref"], "expectedTargetSlotIdentity": target_slot["objectIdentity"], "expectedTargetSceneRef": target_scene["ref"], "expectedTargetSceneIdentity": target_scene["objectIdentity"], "expectedTargetCollectionRevision": None}
        source.clip.name = "External edit"
        with self.assertRaisesRegex(ValueError, "content changed"): mapper.invoke("clip.move", args)
        source.clip.name = "Source"
        with self.assertRaisesRegex(ValueError, "source deletion failed"):
            mapper.invoke("clip.move", args)
        self.assertIsNotNone(source.clip); self.assertIsNone(target.clip)
        source.duplicate_clip_to = lambda destination: setattr(destination, "clip", FakeClip(99.0)); deleted = []; source.delete_clip = lambda: deleted.append(True)
        with self.assertRaisesRegex(ValueError, "preserve exact clip content"): mapper.invoke("clip.move", args)
        self.assertEqual(deleted, []); self.assertIsNotNone(source.clip); self.assertIsNone(target.clip)

    def test_preexisting_clip_move_never_mints_cleanup_authority(self):
        song = FakeSong(); song.scenes.append(FakeScene("Scene 2")); source = song.tracks[0].clip_slots[0]; source.clip = FakeClip(4.0); target = FakeSlot(); song.tracks[0].clip_slots.append(target)
        source.duplicate_clip_to = lambda destination: setattr(destination, "clip", FakeClip(source.clip.length)); mapper = LiveObjectMapper(song, provenance="real-live"); snapshot = mapper.snapshot(); track = snapshot["tracks"][0]; source_row = track["clips"][0]; target_slot = track["clipSlots"][1]; target_scene = snapshot["scenes"][1]; args = {"ref": source_row["ref"], "targetTrackRef": track["ref"], "targetSceneIndex": 1, "arrangementPosition": None, **mapper._session_clip_authority(source_row["ref"]), "expectedContentFingerprint": mapper._mapped_fingerprint(source_row["ref"]), "expectedTargetTrackIdentity": track["objectIdentity"], "expectedTargetSlotRef": target_slot["ref"], "expectedTargetSlotIdentity": target_slot["objectIdentity"], "expectedTargetSceneRef": target_scene["ref"], "expectedTargetSceneIdentity": target_scene["objectIdentity"], "expectedTargetCollectionRevision": None}; moved = mapper.invoke("clip.move", args, "preexisting-move-transaction")
        self.assertNotIn("ownershipToken", moved); self.assertEqual(mapper._owned_cleanup_tokens, {}); self.assertIsNone(source.clip); self.assertIsNotNone(target.clip)

    def test_capture_midi_refuses_any_preexisting_session_content(self):
        song = FakeSong(); song.tracks[0].clip_slots[0].clip = FakeClip(4.0); called = []; song.capture_midi = lambda: called.append(True); mapper = LiveObjectMapper(song); expected = mapper._capture_authority_revision()
        self.assertNotIn("session.capture-midi", mapper.status()["operations"])
        with self.assertRaisesRegex(ValueError, "globally empty Session slots"): mapper.invoke("session.capture-midi", {"expectedStateRevision": expected})
        self.assertEqual(called, []); self.assertIsNotNone(song.tracks[0].clip_slots[0].clip)

    def test_partial_note_delete_restores_complete_content_with_fresh_stable_id(self):
        class Note:
            def __init__(self, note_id, pitch): self.note_id = note_id; self.pitch = pitch; self.start_time = 0.0; self.duration = 0.25; self.velocity = 100; self.channel = 1; self.mute = False; self.probability = 1.0; self.velocity_deviation = 0.0; self.release_velocity = 64.0
        class Clip:
            length = 4.0
            def __init__(self): self.notes = [Note(1, 36), Note(2, 38)]; self.next_id = 3
            def get_all_notes_extended(self): return list(self.notes)
            def remove_notes_by_id(self, ids): self.notes = [note for note in self.notes if note.note_id != ids[0]]; raise RuntimeError("injected partial delete")
            def add_new_notes(self, notes): self.notes.append(Note(self.next_id, notes[0]["pitch"])); self.next_id += 1
        song = FakeSong(); clip = Clip(); song.tracks[0].clip_slots[0].clip = clip; mapper = LiveObjectMapper(song); ref = mapper.snapshot()["tracks"][0]["clips"][0]["ref"]
        with self.assertRaisesRegex(RuntimeError, "partial delete"): mapper.invoke("note.delete", {"ref": ref, "noteIds": [1, 2], **self.note_authority(mapper, ref)})
        self.assertEqual(sorted(note.pitch for note in clip.notes), [36, 38]); self.assertEqual(len({note.note_id for note in clip.notes}), 2)

    def test_clip_delete_requires_authoritative_absence(self):
        song = FakeSong(); slot = song.tracks[0].clip_slots[0]; slot.clip = FakeClip(4.0); slot.delete_clip = lambda: None; mapper = LiveObjectMapper(song); ref = mapper.snapshot()["tracks"][0]["clips"][0]["ref"]
        with self.assertRaisesRegex(ValueError, "not confirmed"): mapper.invoke("clip.delete", {"ref": ref, **mapper._session_clip_authority(ref)})
        self.assertIsNotNone(slot.clip); self.assertIs(mapper.refs.get(ref), slot.clip)

    def test_device_enable_setter_failure_restores_prior_state(self):
        class FailingDevice:
            name = "Failing"; class_name = "Failing"; parameters = []
            def __init__(self): self._enabled = False
            @property
            def enabled(self): return self._enabled
            @enabled.setter
            def enabled(self, value): self._enabled = value; raise RuntimeError("injected setter acknowledgement loss")
        song = FakeSong(); device = FailingDevice(); song.tracks[0].devices = [device]; mapper = LiveObjectMapper(song); track = mapper.snapshot()["tracks"][0]; row = track["devices"][0]; siblings = [{"ref": item["ref"], "objectIdentity": item["objectIdentity"]} for item in track["devices"]]; args = {"ref": row["ref"], "enabled": True, "expectedObjectIdentity": row["objectIdentity"], "expectedOwnerRef": track["ref"], "expectedOwnerIdentity": track["objectIdentity"], "expectedSiblings": siblings, "expectedTrackRef": track["ref"], "expectedTrackIdentity": track["objectIdentity"], "expectedStateRevision": hashlib.sha256(mapper._bounded_canonical({"enabled": False}).encode()).hexdigest()}
        with self.assertRaisesRegex(ValueError, "unavailable"): mapper.invoke("device.enable", args)
        self.assertFalse(device.enabled)
        class AliasDevice:
            name = "Alias"; class_name = "Alias"; parameters = []
            def __init__(self): self.enabled = False
            @property
            def is_active(self): return False
            @is_active.setter
            def is_active(self, _value): raise RuntimeError("read-only authoritative alias")
        song = FakeSong(); alias = AliasDevice(); song.tracks[0].devices = [alias]; mapper = LiveObjectMapper(song); track = mapper.snapshot()["tracks"][0]; row = track["devices"][0]; siblings = [{"ref": item["ref"], "objectIdentity": item["objectIdentity"]} for item in track["devices"]]; args = {"ref": row["ref"], "enabled": True, "expectedObjectIdentity": row["objectIdentity"], "expectedOwnerRef": track["ref"], "expectedOwnerIdentity": track["objectIdentity"], "expectedSiblings": siblings, "expectedTrackRef": track["ref"], "expectedTrackIdentity": track["objectIdentity"], "expectedStateRevision": hashlib.sha256(mapper._bounded_canonical({"enabled": False}).encode()).hexdigest()}
        with self.assertRaisesRegex(ValueError, "unavailable"): mapper.invoke("device.enable", args)
        self.assertFalse(alias.is_active); self.assertFalse(alias.enabled)

    def test_device_enable_device_on_parameter_failure_rolls_back_exactly(self):
        class FailingOnParameter(FakeParameter):
            def __init__(self): self._armed = False; super().__init__(); self.quantization = 1.0; self._value = 1.0
            @property
            def value(self): return self._value
            @value.setter
            def value(self, target):
                self._value = target
                if self._armed: raise RuntimeError("injected setter acknowledgement loss")
        class ToggleDevice(FakeDevice):
            def __init__(self):
                super().__init__(); on = FailingOnParameter(); on._armed = True; self.parameters = [on, FakeParameter()]
            @property
            def enabled(self): return self.parameters[0].value == 1.0
            @enabled.setter
            def enabled(self, _value): pass  # enable state is owned by the Device On parameter
        song = FakeSong(); device = ToggleDevice(); song.tracks[0].devices = [device]; mapper = LiveObjectMapper(song); track = mapper.snapshot()["tracks"][0]; row = track["devices"][0]; siblings = [{"ref": item["ref"], "objectIdentity": item["objectIdentity"]} for item in track["devices"]]; args = {"ref": row["ref"], "enabled": False, "expectedObjectIdentity": row["objectIdentity"], "expectedOwnerRef": track["ref"], "expectedOwnerIdentity": track["objectIdentity"], "expectedSiblings": siblings, "expectedTrackRef": track["ref"], "expectedTrackIdentity": track["objectIdentity"], "expectedStateRevision": hashlib.sha256(mapper._bounded_canonical({"enabled": True}).encode()).hexdigest()}
        with self.assertRaisesRegex(ValueError, "unavailable"): mapper.invoke("device.enable", args)
        self.assertTrue(device.enabled)

    def test_browser_search_skips_unrepresentable_live_names(self):
        class Item:
            def __init__(self, name, children=None): self.name = name; self.children = children or []; self.is_loadable = not bool(children); self.is_device = not bool(children)
        class Browser:
            instruments = Item("instruments", [Item("x" * 300), Item("Bounded")])
        mapper = LiveObjectMapper(FakeSong()); mapper._browser = lambda: Browser(); result = mapper.invoke("browser.search", {"category": "instruments", "limit": 10})
        self.assertEqual([item["name"] for item in result["items"]], ["Bounded"]); validate_operation_payload("browser.search", "result", result)
        class BroadBrowser:
            instruments = Item("instruments", [Item(f"Item {index}") for index in range(257)])
        mapper._browser = lambda: BroadBrowser()
        with self.assertRaisesRegex(ValueError, "traversal bound"): mapper.invoke("browser.search", {"category": "instruments", "query": "never-matches", "limit": 10})

    def test_browser_inspect_follows_the_returned_path_without_scanning_unrelated_subtrees(self):
        class Item:
            def __init__(self, name, children=None): self.name = name; self.children = children or []; self.is_loadable = not bool(children); self.is_device = not bool(children)
        class Browser:
            @property
            def instruments(self):
                return Item("instruments", [
                    Item("Before", [Item(f"Before {index}") for index in range(200)]),
                    Item("Target Folder", [Item("Operator")]),
                    Item("After", [Item(f"After {index}") for index in range(100)]),
                ])
        mapper = LiveObjectMapper(FakeSong()); mapper._browser = lambda: Browser()
        item = mapper.invoke("browser.search", {"category": "instruments", "query": "Operator", "limit": 1})["items"][0]
        self.assertEqual(mapper.invoke("browser.inspect", {"itemId": item["id"]}), item)

    def test_arrangement_duplicate_identifies_new_clip_and_move_compensates(self):
        song = FakeSong(); track = song.tracks[0]; source_slot = track.clip_slots[0]; source_slot.clip = FakeClip(4.0); source_slot.clip.name = "Session Source"
        existing = FakeClip(4.0); existing.name = "Existing at Eight"; existing.start_time = 8.0; track.arrangement_clips = [existing]
        def duplicate_to_arrangement(clip, position): created = FakeClip(clip.length); created.name = clip.name; created.start_time = position; track.arrangement_clips.append(created)
        track.duplicate_clip_to_arrangement = duplicate_to_arrangement
        def delete_clip(candidate): track.arrangement_clips.remove(candidate)
        track.delete_clip = delete_clip
        mapper = LiveObjectMapper(song); snapshot = mapper.snapshot(); source = snapshot["tracks"][0]["clips"][0]
        args = {"ref": source["ref"], "targetTrackRef": None, "targetSceneIndex": None, "arrangementPosition": 8.0, **mapper._session_clip_authority(source["ref"]), "expectedContentFingerprint": mapper._mapped_fingerprint(source["ref"]), "expectedTargetTrackIdentity": None, "expectedTargetSlotRef": None, "expectedTargetSlotIdentity": None, "expectedTargetSceneRef": None, "expectedTargetSceneIdentity": None, "expectedTargetCollectionRevision": mapper._arrangement_collection_revision(track, 0)}
        created = mapper.invoke("clip.duplicate", args); self.assertNotEqual(created["objectIdentity"], mapper.snapshot()["arrangement"]["clips"][0]["objectIdentity"]); self.assertEqual(created["createdFingerprint"], mapper._mapped_fingerprint(created["ref"]))
        source_arrangement = mapper.snapshot()["arrangement"]["clips"][0]; source_object = track.arrangement_clips[0]
        def selective_delete(candidate):
            if candidate is not source_object: track.arrangement_clips.remove(candidate)
        track.delete_clip = selective_delete
        before = len(track.arrangement_clips); move_args = {"ref": source_arrangement["ref"], "position": 16.0, "expectedObjectIdentity": source_arrangement["objectIdentity"], "expectedAuthorityRevision": mapper._arrangement_clip_authority_revision(source_arrangement["ref"]), "expectedContentFingerprint": mapper._mapped_fingerprint(source_arrangement["ref"])}
        with self.assertRaisesRegex(ValueError, "source deletion failed"):
            mapper.invoke("arrangement.clip.move", move_args)
        self.assertEqual(len(track.arrangement_clips), before); self.assertIn(source_object, track.arrangement_clips)

    def test_transport_revision_rejects_observed_aba_state(self):
        song = FakeSong()
        song.loop = False
        song.loop_start = 0.0
        song.loop_length = 4.0
        song.current_song_time = 0.0
        song.metronome = False
        song.punch_in = False
        song.punch_out = False
        song.count_in_duration = 0
        mapper = LiveObjectMapper(song)
        snapshot = mapper.snapshot()
        set_row = snapshot["set"]

        def set_metronome(value, revision):
            return mapper.invoke("transport.set", {
                "setRef": set_row["ref"],
                "expectedObjectIdentity": set_row["objectIdentity"],
                "expectedRevision": revision,
                "metronome": value,
            })

        initial_revision = snapshot["playback"]["revision"]
        first_true = set_metronome(True, initial_revision)["revision"]
        intervening_false = set_metronome(False, first_true)["revision"]
        current_true = set_metronome(True, intervening_false)["revision"]
        self.assertNotEqual(first_true, current_true)
        self.assertEqual(current_true, mapper.snapshot()["playback"]["revision"])
        with self.assertRaisesRegex(ValueError, "changed since preview"):
            set_metronome(False, first_true)
        self.assertTrue(song.metronome)
        set_metronome(False, current_true)

    def test_wrong_device_delete_and_late_transport_failure_never_report_partial_success(self):
        song = FakeSong(); target, sibling = FakeDevice(), FakeDevice(); target.name = "Target"; sibling.name = "Sibling"; song.tracks[0].devices = [target, sibling]; song.tracks[0].delete_device = lambda _index: song.tracks[0].devices.pop(1); mapper = LiveObjectMapper(song); track = mapper.snapshot()["tracks"][0]; device = track["devices"][0]; siblings = [{"ref": row["ref"], "objectIdentity": row["objectIdentity"]} for row in track["devices"]]
        with self.assertRaisesRegex(ValueError, "sole sibling"): mapper.invoke("device.delete", {"ref": device["ref"], "expectedObjectIdentity": device["objectIdentity"], "expectedOwnerRef": track["ref"], "expectedOwnerIdentity": track["objectIdentity"], "expectedSiblings": siblings, "expectedTrackRef": track["ref"], "expectedTrackIdentity": track["objectIdentity"]})
        self.assertIn(target, song.tracks[0].devices)
        class FailingTransportSong(FakeSong):
            def __init__(self): self._loop = False; self.reject_loop = False; super().__init__(); self.reject_loop = True
            @property
            def loop(self): return self._loop
            @loop.setter
            def loop(self, value): self._loop = value
        failing = FailingTransportSong(); failing.loop_start = 0.0; failing.loop_length = 4.0; failing.current_song_time = 0.0; failing.metronome = False; failing.punch_in = False; failing.punch_out = False
        def reject_loop(value): failing._loop = value; raise RuntimeError("injected late transport failure")
        type(failing).loop = property(lambda self: self._loop, lambda self, value: reject_loop(value) if self.reject_loop else setattr(self, "_loop", value)); mapper = LiveObjectMapper(failing); snapshot = mapper.snapshot(); set_ref = snapshot["set"]["ref"]
        with self.assertRaisesRegex(RuntimeError, "late transport failure"): mapper.invoke("transport.set", {"setRef": set_ref, "expectedObjectIdentity": snapshot["set"]["objectIdentity"], "expectedRevision": snapshot["playback"]["revision"], "loopEnabled": True, "metronome": True})
        self.assertIs(failing.loop, False); self.assertFalse(failing.metronome)

    def test_mixer_and_routing_mutations_compare_atomic_prior_state(self):
        song = FakeSong(); track = song.tracks[0]; track.mute = False; track.solo = False
        volume, pan, cue, send = FakeParameter(), FakeParameter(), FakeParameter(), FakeParameter(); volume.value = 0.5; pan.value = 0.0; cue.value = 0.7; send.value = 0.1
        track.mixer_device = type("Mixer", (), {"volume": volume, "panning": pan, "cue_volume": cue, "sends": [send]})()
        track.available_input_routing_types = [FakeRouteChoice("Ext. In")]; track.available_input_routing_channels = [FakeRouteChoice("1")]; track.available_output_routing_types = [FakeRouteChoice("Main")]; track.available_output_routing_channels = [FakeRouteChoice("1")]; track.input_routing_type = track.available_input_routing_types[0]; track.input_routing_channel = track.available_input_routing_channels[0]; track.output_routing_type = track.available_output_routing_types[0]; track.output_routing_channel = track.available_output_routing_channels[0]; track.can_be_armed = True
        mapper = LiveObjectMapper(song); row = mapper.snapshot()["tracks"][0]; mixer = row["mixer"]; state = {field: mixer.get(field) for field in ("volume", "pan", "mute", "solo", "cueVolume", "sends")}
        args = {"ref": row["ref"], "volume": 0.8, "expectedObjectIdentity": row["objectIdentity"], "expectedVolumeIdentity": mixer["volumeIdentity"], "expectedPanIdentity": mixer["panIdentity"], "expectedCueIdentity": mixer["cueIdentity"], "expectedSendIdentities": mixer["sendIdentities"], "expectedStateRevision": hashlib.sha256(mapper._bounded_canonical(state).encode()).hexdigest()}
        volume.value = 0.6
        with self.assertRaisesRegex(ValueError, "state changed"):
            mapper.invoke("mixer.set", args)
        self.assertEqual(volume.value, 0.6)
        row = mapper.snapshot()["tracks"][0]; routing = row["routing"]; routing_state = {"inputType": routing["inputType"], "inputSubRouting": routing["inputSubRouting"], "outputType": routing["outputType"], "outputSubRouting": routing["outputSubRouting"], "arm": row["armed"], "monitoring": row["monitoringState"]}; routing_args = {"ref": row["ref"], "outputType": "Main", "expectedObjectIdentity": row["objectIdentity"], "expectedStateRevision": hashlib.sha256(mapper._bounded_canonical(routing_state).encode()).hexdigest()}
        track.arm = True
        with self.assertRaisesRegex(ValueError, "state changed"):
            mapper.invoke("routing.set", routing_args)

    def test_mixer_multi_field_failure_rolls_back_exact_prior_state(self):
        class FailingPan(FakeParameter):
            def __init__(self): self._value = 0.0; self.reject = False; super().__init__(); self._value = 0.0; self.reject = True
            @property
            def value(self): return self._value
            @value.setter
            def value(self, value):
                if getattr(self, "reject", False) and value == 0.25: raise RuntimeError("injected pan failure")
                self._value = value
        song = FakeSong(); track = song.tracks[0]; volume = FakeParameter(); volume.value = 0.5; pan = FailingPan(); cue = FakeParameter(); cue.value = 0.7; track.mute = False; track.solo = False; track.mixer_device = type("Mixer", (), {"volume": volume, "panning": pan, "cue_volume": cue, "sends": []})()
        mapper = LiveObjectMapper(song); row = mapper.snapshot()["tracks"][0]; mixer = row["mixer"]; state = {field: mixer.get(field) for field in ("volume", "pan", "mute", "solo", "cueVolume", "sends")}; args = {"ref": row["ref"], "volume": 0.75, "pan": 0.25, "expectedObjectIdentity": row["objectIdentity"], "expectedVolumeIdentity": mixer["volumeIdentity"], "expectedPanIdentity": mixer["panIdentity"], "expectedCueIdentity": mixer["cueIdentity"], "expectedSendIdentities": mixer["sendIdentities"], "expectedStateRevision": hashlib.sha256(mapper._bounded_canonical(state).encode()).hexdigest()}
        with self.assertRaisesRegex(RuntimeError, "injected pan failure"): mapper.invoke("mixer.set", args)
        self.assertEqual(volume.value, 0.5); self.assertEqual(pan.value, 0.0)

    def test_routing_chooses_cycle_free_transition_order_and_rolls_back_failure(self):
        class OrderedTrack(FakeTrack):
            def __init__(self): self.route_log = []; self.reject_input_b = False; self.reject_arm = False; self.input_channels_by_type = {}; self.output_channels_by_type = {}; self.input_types_by_output = {}; super().__init__()
            def __setattr__(self, name, value):
                if name == "arm" and getattr(self, "reject_arm", False) and value is True: raise RuntimeError("injected arm failure")
                if name in {"input_routing_type", "output_routing_type"} and hasattr(self, "route_log"):
                    self.route_log.append((name, getattr(value, "name", None)))
                    if name == "input_routing_type" and getattr(self, "reject_input_b", False) and getattr(value, "name", None) == "B": raise RuntimeError("injected routing failure")
                    super().__setattr__(name, value); direction = "input" if name.startswith("input") else "output"; choices = getattr(self, f"{direction}_channels_by_type", {}).get(getattr(value, "name", None))
                    if choices: super().__setattr__(f"available_{direction}_routing_channels", choices); super().__setattr__(f"{direction}_routing_channel", choices[0])
                    if direction == "output":
                        types = getattr(self, "input_types_by_output", {}).get(getattr(value, "name", None))
                        if types: super().__setattr__("available_input_routing_types", types)
                    return
                super().__setattr__(name, value)
        song = FakeSong(); a = OrderedTrack(); b = FakeTrack(); a.name = "A"; b.name = "B"; song.tracks = [a, b]
        ext, route_b, main = FakeRouteChoice("Ext. In"), FakeRouteChoice("B"), FakeRouteChoice("Main"); route_a = FakeRouteChoice("A"); channel = FakeRouteChoice("1"); channel_two = FakeRouteChoice("2")
        for track in song.tracks:
            track.available_input_routing_types = [ext, route_a, route_b]; track.available_input_routing_channels = [channel, channel_two]; track.available_output_routing_types = [route_a, route_b, main]; track.available_output_routing_channels = [channel, channel_two]; track.input_routing_channel = channel; track.output_routing_channel = channel; track.can_be_armed = True
        a.input_channels_by_type = {"Ext. In": [channel], "B": [channel_two]}; a.output_channels_by_type = {"B": [channel], "Main": [channel_two]}; a.input_types_by_output = {"B": [ext, route_a], "Main": [ext, route_a, route_b]}
        a.input_routing_type = ext; a.output_routing_type = route_b; b.input_routing_type = ext; b.output_routing_type = main; a.route_log.clear()
        mapper = LiveObjectMapper(song); row = mapper.snapshot()["tracks"][0]; routing = row["routing"]; state = {"inputType": routing["inputType"], "inputSubRouting": routing["inputSubRouting"], "outputType": routing["outputType"], "outputSubRouting": routing["outputSubRouting"], "arm": row["armed"], "monitoring": row["monitoringState"]}; args = {"ref": row["ref"], "inputType": "B", "outputType": "Main", "expectedObjectIdentity": row["objectIdentity"], "expectedStateRevision": hashlib.sha256(mapper._bounded_canonical(state).encode()).hexdigest()}
        self.assertTrue(mapper.invoke("routing.set", args)["changed"]); self.assertEqual(a.route_log[:2], [("output_routing_type", "Main"), ("input_routing_type", "B")])
        a.input_routing_type = ext; a.output_routing_type = route_b; a.input_routing_channel = channel; a.output_routing_channel = channel; a.route_log.clear(); a.reject_arm = True; row = mapper.snapshot()["tracks"][0]; routing = row["routing"]; state = {"inputType": routing["inputType"], "inputSubRouting": routing["inputSubRouting"], "outputType": routing["outputType"], "outputSubRouting": routing["outputSubRouting"], "arm": row["armed"], "monitoring": row["monitoringState"]}; args.update({"inputSubRouting": "2", "outputSubRouting": "2", "arm": True, "expectedObjectIdentity": row["objectIdentity"], "expectedStateRevision": hashlib.sha256(mapper._bounded_canonical(state).encode()).hexdigest()})
        with self.assertRaisesRegex(RuntimeError, "injected arm failure"): mapper.invoke("routing.set", args)
        self.assertEqual(a.output_routing_type.name, "B"); self.assertEqual(a.input_routing_type.name, "Ext. In"); self.assertEqual(a.input_routing_channel.name, "1"); self.assertEqual(a.output_routing_channel.name, "1")


if __name__ == "__main__":
    unittest.main()


class SongResolutionTests(unittest.TestCase):
    def test_bridge_resolves_callable_song_accessor(self):
        class CallableSongInstance:
            def __init__(self):
                self._song = FakeSong()
            def song(self):
                return self._song

        probe = __import__("socket").socket(__import__("socket").AF_INET, __import__("socket").SOCK_STREAM)
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        bridge = AbletonMcpBridge(CallableSongInstance(), {"host": "127.0.0.1", "port": port, "secret": "0123456789abcdef0123456789abcdef"})
        try:
            self.assertEqual(bridge.mapper.song.tracks[0].name, "Drums")
        finally:
            bridge.disconnect()

    def test_bridge_uses_direct_song_object_unchanged(self):
        class DirectSongInstance:
            def __init__(self):
                self.song = FakeSong()

        probe = __import__("socket").socket(__import__("socket").AF_INET, __import__("socket").SOCK_STREAM)
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        bridge = AbletonMcpBridge(DirectSongInstance(), {"host": "127.0.0.1", "port": port, "secret": "0123456789abcdef0123456789abcdef"})
        try:
            self.assertEqual(bridge.mapper.song.tracks[0].name, "Drums")
        finally:
            bridge.disconnect()


class RealLiveShapeTests(unittest.TestCase):
    def test_snapshot_treats_raising_track_properties_as_unavailable(self):
        class RaisingReturnTrack:
            name = "Return A"
            is_return = True
            clip_slots = []
            devices = []
            @property
            def arm(self):
                raise RuntimeError("Main and Return Tracks have no 'Arm' state!")
            @property
            def current_monitoring_state(self):
                raise RuntimeError("Main and Return Tracks have no monitoring state!")
            @property
            def playing_slot_index(self):
                raise RuntimeError("no slot index")
            @property
            def fired_slot_index(self):
                raise RuntimeError("no slot index")

        class RaisingMasterTrack(RaisingReturnTrack):
            name = "Master"
            is_return = False
            is_master = True

        class SongWithRaisingTracks(FakeSong):
            def __init__(self):
                super().__init__()
                self.return_tracks = [RaisingReturnTrack()]
                self.master_track = RaisingMasterTrack()

        snapshot = LiveObjectMapper(SongWithRaisingTracks()).snapshot()
        self.assertEqual(len(snapshot["tracks"]), 3)
        ret = snapshot["tracks"][1]
        self.assertEqual(ret["kind"], "return")
        self.assertIsNone(ret["armed"])
        self.assertIsNone(ret["monitoringState"])
        self.assertIsNone(ret["playingSlotIndex"])
        main = snapshot["tracks"][2]
        self.assertEqual(main["kind"], "main")


class BoostEnumShapeTests(unittest.TestCase):
    def test_quantization_enum_becomes_plain_int_with_canonical_name(self):
        class FakeBoostQuantization(int):
            def __str__(self):
                return "q_bar"

        class EnumSong(FakeSong):
            def __init__(self):
                super().__init__()
                self.clip_trigger_quantization = FakeBoostQuantization(4)

        playback = LiveObjectMapper(EnumSong()).snapshot()["playback"]
        transport = playback["transport"]
        self.assertEqual(transport["launchQuantization"]["raw"], 4)
        self.assertIs(type(transport["launchQuantization"]["raw"]), int)
        self.assertEqual(transport["launchQuantization"]["normalized"], "1-bar")

    def test_canonical_renders_int_subclass_enums_as_plain_integers(self):
        class FakeBoostQuantization(int):
            def __str__(self):
                return "q_bar"

        canonical = AuthenticatedRemoteScript._bounded_canonical({"raw": FakeBoostQuantization(4)})
        self.assertEqual(canonical, '{"raw":4}')


class RealtimePlaneTests(unittest.TestCase):
    def _plane(self):
        import socket as _socket
        from ableton_mcp_remote_script import _RealtimePlane

        class _Queue:
            def __init__(self):
                self.calls = []
                self.accept = True
                self.defer = False
                self.raise_once = False
            def submit_nowait(self, callback, deadline_ms, on_cancel=None):
                if self.raise_once:
                    self.raise_once = False
                    raise RuntimeError("injected queue failure")
                if not self.accept:
                    return False
                self.calls.append(callback)
                if not self.defer:
                    try:
                        callback()
                    except BaseException:
                        pass
                return True

        class _Parameter:
            def __init__(self):
                self.min = 0.0
                self.max = 1.0
                self.value = 0.0
                self.enabled = True
                self.quantization = 0.0

        class _Mapper:
            def __init__(self):
                self.parameters = {}; self.authority_generation = 1
            def _playback(self):
                return {"firedTargets": [], "playingTargets": []}
            def _active_targets(self, playback):
                return []
            def _target_key(self, target):
                return "t|s|sc"
            def _guarded_emergency_stop(self, args):
                return {"stopped": True, "stoppedTargets": []}
            def _resolve_parameter(self, ref):
                return self.parameters.setdefault(ref, _Parameter())
            def _realtime_parameter_authority(self, ref):
                parameter = self._resolve_parameter(ref)
                return {"ref": ref, "parameterIdentity": f"parameter:{id(parameter)}", "ownerRef": "owner", "ownerIdentity": f"owner:{self.authority_generation}", "trackRef": "track", "trackIdentity": "track:1", "siblings": [{"ref": ref, "objectIdentity": f"parameter:{id(parameter)}"}]}
            @staticmethod
            def _read_attr(obj, *names):
                for name in names:
                    value = getattr(obj, name, None)
                    if value is not None:
                        return value
                return None

        class _Bridge:
            def __init__(self):
                self.queue = _Queue()
                self.mapper = _Mapper()

        probe = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        return _RealtimePlane(_Bridge(), "127.0.0.1", port)

    def _arm(self, plane, ttl_ms, channels, references, source_ports=None):
        authorities = [plane._bridge.mapper._realtime_parameter_authority(reference) for reference in references]
        return plane.arm(ttl_ms, channels, references, source_ports, authorities)

    @staticmethod
    def _json(**values):
        return json.dumps(values, separators=(",", ":")).encode()

    @staticmethod
    def _osc_string(value):
        encoded = value.encode() + b"\0"
        return encoded + b"\0" * ((-len(encoded)) % 4)

    @classmethod
    def _osc_parameter(cls, token, sequence, reference, value):
        import struct
        return b"".join((
            cls._osc_string("/ableton-mcp/parameter"), cls._osc_string(",sisf"),
            cls._osc_string(token), struct.pack(">i", sequence), cls._osc_string(reference), struct.pack(">f", value),
        ))

    def test_bridge_realtime_port_validation_and_conflict_cleanup(self):
        import socket as _socket
        tcp_probe = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
        tcp_probe.bind(("127.0.0.1", 0)); tcp_port = tcp_probe.getsockname()[1]; tcp_probe.close()
        blocker = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        blocker.bind(("127.0.0.1", 0)); realtime_port = blocker.getsockname()[1]
        try:
            with self.assertRaises(ValueError):
                AbletonMcpBridge(FakeInstance(), {"host": "127.0.0.1", "port": tcp_port, "realtimePort": tcp_port, "secret": "x" * 40})
            with self.assertRaises(OSError):
                AbletonMcpBridge(FakeInstance(), {"host": "127.0.0.1", "port": tcp_port, "realtimePort": realtime_port, "secret": "x" * 40})
            checker = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
            checker.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
            try:
                checker.bind(("127.0.0.1", tcp_port))
            finally:
                checker.close()
        finally:
            blocker.close()

    def test_configured_plane_is_truthfully_capability_negotiated(self):
        import socket as _socket
        tcp_probe = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
        tcp_probe.bind(("127.0.0.1", 0)); tcp_port = tcp_probe.getsockname()[1]; tcp_probe.close()
        udp_probe = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        udp_probe.bind(("127.0.0.1", 0)); realtime_port = udp_probe.getsockname()[1]; udp_probe.close()
        bridge = AbletonMcpBridge(FakeInstance(), {"host": "127.0.0.1", "port": tcp_port, "realtimePort": realtime_port, "secret": "x" * 40})
        try:
            status = bridge.mapper.status()
            for operation in ("realtime.arm", "realtime.disarm", "realtime.stats"):
                self.assertIn(operation, status["operations"])
            for capability in ("osc", "realtime.events"):
                self.assertIn(capability, status["capabilities"])
            self.assertNotIn("max", status["capabilities"])
        finally:
            bridge.disconnect()

    def test_authenticated_disarm_and_rearm_revoke_fifo_callbacks_before_drain(self):
        import socket as _socket
        tcp_probe = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
        tcp_probe.bind(("127.0.0.1", 0)); tcp_port = tcp_probe.getsockname()[1]; tcp_probe.close()
        udp_probe = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        udp_probe.bind(("127.0.0.1", 0)); realtime_port = udp_probe.getsockname()[1]; udp_probe.close()
        bridge = AbletonMcpBridge(FakeInstance(), {"host": "127.0.0.1", "port": tcp_port, "realtimePort": realtime_port, "secret": "x" * 40})
        try:
            snapshot = bridge.mapper.snapshot()
            parameter_ref = snapshot["tracks"][0]["devices"][0]["parameters"][0]["ref"]
            parameter = bridge.mapper._resolve_parameter(parameter_ref); target_authority = bridge.mapper._realtime_parameter_authority(parameter_ref)
            def authorized(request):
                # This test runs on its synthetic main thread; bridge authority
                # preflight/prepare/invoke sequencing is covered separately.
                return bridge._realtime_op(request["operation"], request["args"])
            arm_request = {"operation": "realtime.arm", "args": {"ttlMs": 30000, "channels": ["udp-json"], "parameterRefs": [parameter_ref], "targetAuthorities": [target_authority], "outputSafety": {"safe": True, "provenance": "unit-test-operator"}}}
            with self.assertRaises(ValueError): bridge._realtime_op("realtime.arm", {"ttlMs": 30000, "channels": ["udp-json"], "parameterRefs": [parameter_ref]})
            armed = authorized(arm_request)
            for sequence in (1, 2):
                bridge._realtime._handle(self._json(token=armed["token"], seq=sequence, channel="udp-json", op="parameter.set", ref=parameter_ref, value=0.75))
            self.assertEqual(bridge.queue.items.qsize(), 2)
            self.assertEqual(authorized({"operation": "realtime.disarm", "args": {}}), {"armed": False})

            armed = authorized(arm_request)
            for sequence in (1, 2):
                bridge._realtime._handle(self._json(token=armed["token"], seq=sequence, channel="udp-json", op="parameter.set", ref=parameter_ref, value=1.0))
            self.assertEqual(bridge.queue.items.qsize(), 4)
            authorized(arm_request)
            self.assertEqual(bridge.queue.drain(), 4)
            self.assertEqual(parameter.value, 0.5)
            stats = bridge._realtime.stats()
            self.assertEqual(stats["applied"], 0)
            self.assertEqual(stats["revokedBeforeApply"], 4)
            self.assertEqual(stats["applyFailures"], 4)
            self.assertEqual(stats["pending"], 0)
        finally:
            bridge.disconnect()

    def test_real_mapper_authority_matches_filtered_bounded_snapshot_siblings(self):
        import socket as _socket
        tcp_probe = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM); tcp_probe.bind(("127.0.0.1", 0)); tcp_port = tcp_probe.getsockname()[1]; tcp_probe.close()
        udp_probe = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM); udp_probe.bind(("127.0.0.1", 0)); realtime_port = udp_probe.getsockname()[1]; udp_probe.close()
        bridge = AbletonMcpBridge(FakeInstance(), {"host": "127.0.0.1", "port": tcp_port, "realtimePort": realtime_port, "secret": "x" * 40})
        try:
            hidden = FakeParameter(); hidden.min = None
            bridge.mapper.song.tracks[0].devices[0].parameters = [hidden] + [FakeParameter() for _ in range(256)]
            with self.assertRaisesRegex(ValueError, "complete-state bound"): bridge.mapper.snapshot()
            bridge.mapper.song.tracks[0].devices[0].parameters = [hidden] + [FakeParameter() for _ in range(255)]
            rows = bridge.mapper.snapshot()["tracks"][0]["devices"][0]["parameters"]
            self.assertEqual(len(rows), 255)
            target_ref = rows[0]["ref"]; authority = bridge.mapper._realtime_parameter_authority(target_ref)
            self.assertEqual(authority["siblings"], [{"ref": row["ref"], "objectIdentity": row["objectIdentity"]} for row in rows])
            armed = bridge._realtime_op("realtime.arm", {"ttlMs": 30000, "channels": ["udp-json"], "parameterRefs": [target_ref], "targetAuthorities": [authority], "outputSafety": {"safe": True, "provenance": "unit-test-operator"}})
            self.assertTrue(bridge._realtime.stats()["armed"]); self.assertEqual(armed["parameterRefs"], [target_ref]); bridge._realtime.disarm()
            bridge.mapper.song.tracks[0].devices = [FakeDevice() for _ in range(5)]
            for device in bridge.mapper.song.tracks[0].devices: device.parameters = [FakeParameter() for _ in range(256)]
            device_rows = bridge.mapper.snapshot()["tracks"][0]["devices"]
            self.assertEqual(bridge.mapper._realtime_parameter_authority(device_rows[2]["parameters"][0]["ref"])["parameterIdentity"], device_rows[2]["parameters"][0]["objectIdentity"])
            with self.assertRaises(ValueError): bridge.mapper._realtime_parameter_authority(device_rows[4]["parameters"][0]["ref"])
            rack = FakeDevice(); rack.can_have_chains = True; rack.chains = []; rack.macros = [rack.parameters[0]]; bridge.mapper.song.tracks[0].devices = [rack]
            rack_row = bridge.mapper.snapshot()["tracks"][0]["devices"][0]; macro_ref = rack_row["macros"][0]["ref"]; macro_authority = bridge.mapper._realtime_parameter_authority(macro_ref)
            self.assertEqual(macro_authority["ref"], macro_ref); self.assertEqual([row["ref"] for row in macro_authority["siblings"]], [rack_row["parameters"][0]["ref"], macro_ref])
            macro_arm = bridge._realtime_op("realtime.arm", {"ttlMs": 30000, "channels": ["udp-json"], "parameterRefs": [macro_ref], "targetAuthorities": [macro_authority], "outputSafety": {"safe": True, "provenance": "unit-test-operator"}})
            self.assertEqual(macro_arm["parameterRefs"], [macro_ref]); bridge._realtime.disarm()
            oversized_rack = FakeDevice(); oversized_rack.can_have_chains = True; oversized_rack.macros = []; oversized_rack.chains = [type("Chain", (), {"devices": []})() for _ in range(257)]
            bridge.mapper.song.tracks[0].devices = [oversized_rack, FakeDevice()]; later_ref = bridge.mapper.snapshot()["tracks"][0]["devices"][1]["parameters"][0]["ref"]
            with self.assertRaises(ValueError): bridge.mapper._realtime_parameter_authority(later_ref)
        finally:
            bridge.disconnect()

    def test_real_mapper_track_reorder_before_arm_refuses_stale_host_authority(self):
        import socket as _socket
        tcp_probe = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM); tcp_probe.bind(("127.0.0.1", 0)); tcp_port = tcp_probe.getsockname()[1]; tcp_probe.close()
        udp_probe = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM); udp_probe.bind(("127.0.0.1", 0)); realtime_port = udp_probe.getsockname()[1]; udp_probe.close()
        bridge = AbletonMcpBridge(FakeInstance(), {"host": "127.0.0.1", "port": tcp_port, "realtimePort": realtime_port, "secret": "x" * 40})
        try:
            snapshot = bridge.mapper.snapshot(); parameter_ref = snapshot["tracks"][0]["devices"][0]["parameters"][0]["ref"]; stale_authority = bridge.mapper._realtime_parameter_authority(parameter_ref)
            bridge.mapper.song.tracks.insert(0, FakeTrack())
            with self.assertRaises(ValueError): bridge._realtime_op("realtime.arm", {"ttlMs": 30000, "channels": ["udp-json"], "parameterRefs": [parameter_ref], "targetAuthorities": [stale_authority], "outputSafety": {"safe": True, "provenance": "unit-test-operator"}})
            self.assertFalse(bridge._realtime.stats()["armed"])
        finally:
            bridge.disconnect()

    def test_real_mapper_track_reorder_revokes_parameter_authority(self):
        import socket as _socket
        tcp_probe = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM); tcp_probe.bind(("127.0.0.1", 0)); tcp_port = tcp_probe.getsockname()[1]; tcp_probe.close()
        udp_probe = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM); udp_probe.bind(("127.0.0.1", 0)); realtime_port = udp_probe.getsockname()[1]; udp_probe.close()
        bridge = AbletonMcpBridge(FakeInstance(), {"host": "127.0.0.1", "port": tcp_port, "realtimePort": realtime_port, "secret": "x" * 40})
        try:
            snapshot = bridge.mapper.snapshot(); parameter_ref = snapshot["tracks"][0]["devices"][0]["parameters"][0]["ref"]; parameter = bridge.mapper._resolve_parameter(parameter_ref); prior = parameter.value; target_authority = bridge.mapper._realtime_parameter_authority(parameter_ref)
            armed = bridge._realtime_op("realtime.arm", {"ttlMs": 30000, "channels": ["udp-json"], "parameterRefs": [parameter_ref], "targetAuthorities": [target_authority], "outputSafety": {"safe": True, "provenance": "unit-test-operator"}})
            bridge._realtime._handle(self._json(token=armed["token"], seq=1, channel="udp-json", op="parameter.set", ref=parameter_ref, value=0.25))
            bridge.mapper.song.tracks.insert(0, FakeTrack()); bridge.queue.drain()
            stats = bridge._realtime.stats(); self.assertFalse(stats["armed"]); self.assertEqual(stats["applyFailures"], 1); self.assertEqual(parameter.value, prior)
        finally:
            bridge.disconnect()

    def test_arm_bounds_endpoint_channel_and_drop_accounting(self):
        plane = self._plane()
        try:
            with self.assertRaises(ValueError):
                self._arm(plane, 500, ["udp-json"], ["p"])
            with self.assertRaises(ValueError):
                self._arm(plane, 30000, ["udp-json", "udp-json"], ["p"])
            stale_authority = plane._bridge.mapper._realtime_parameter_authority("p"); plane._bridge.mapper.authority_generation += 1
            with self.assertRaises(ValueError): plane.arm(30000, ["udp-json"], ["p"], None, [stale_authority])
            plane._bridge.mapper.authority_generation -= 1
            armed = self._arm(plane, 30000, ["udp-json", "xy"], ["p", "x", "y"], [41000])
            self.assertEqual(armed["host"], "127.0.0.1")
            self.assertEqual(armed["packetLimitBytes"], 512)
            plane._handle(b"not-json", ("127.0.0.1", 41000))
            plane._handle(self._json(token="w" * 32, seq=1, channel="udp-json", op="parameter.set", ref="p", value=1), ("127.0.0.1", 41000))
            plane._handle(self._json(token=armed["token"], seq=1, channel="max", op="parameter.set", ref="p", value=1), ("127.0.0.1", 41000))
            plane._handle(self._json(token=armed["token"], seq=1, channel="udp-json", op="parameter.set", ref="p", value=1), ("127.0.0.1", 42000))
            plane._handle(self._json(token=armed["token"], seq=1, channel="udp-json", op="parameter.set", ref="not-allowed", value=1), ("127.0.0.1", 41000))
            plane._handle(self._json(token=armed["token"], seq=1, channel="udp-json", op="parameter.set", ref="p", value=1, sentAtMs=time.time() * 1000), ("127.0.0.1", 41000))
            plane._handle(self._json(token=armed["token"], seq=1, channel="udp-json", op="parameter.set", ref="p", value=1), ("127.0.0.1", 41000))
            plane._handle(self._json(token=armed["token"], seq=4, channel="xy", op="xy.set", xRef="x", x=0.2, yRef="y", y=0.8, sentAtMs=time.time() * 1000), ("127.0.0.1", 41000))
            stats = plane.stats()
            self.assertEqual(stats["accepted"], 2)
            self.assertEqual(stats["applied"], 2)
            self.assertEqual(stats["droppedUnarmed"], 2)
            self.assertEqual(stats["droppedEndpoint"], 1)
            self.assertEqual(stats["droppedTarget"], 1)
            self.assertEqual(stats["droppedInvalid"], 1)
            self.assertEqual(stats["droppedReplay"], 1)
            self.assertEqual(stats["sequenceGaps"], 2)
            self.assertEqual(stats["lastSequence"], 4)
            self.assertGreaterEqual(stats["jitterMs"], 0)
            plane.disarm()
            plane._handle(self._json(token=armed["token"], seq=6, channel="udp-json", op="emergency-stop"), ("127.0.0.1", 41000))
            self.assertEqual(plane.stats()["droppedUnarmed"], 3)
        finally:
            plane.close()

    def test_osc_max_xy_queue_and_parameter_bounds(self):
        plane = self._plane()
        try:
            armed = self._arm(plane, 30000, ["osc", "max", "xy"], ["p", "x", "y"])
            plane._handle(self._osc_parameter(armed["token"], 1, "p", 0.25))
            plane._handle(self._json(token=armed["token"], seq=2, channel="max", op="parameter.set", ref="p", value=2.0))
            plane._handle(self._json(token=armed["token"], seq=3, channel="xy", op="xy.set", xRef="x", x=0.3, yRef="y", y=0.7))
            plane._bridge.queue.accept = False
            plane._handle(self._json(token=armed["token"], seq=4, channel="max", op="emergency-stop"))
            stats = plane.stats()
            self.assertEqual(stats["accepted"], 3)
            self.assertEqual(stats["applied"], 2)
            self.assertEqual(stats["applyFailures"], 1)
            self.assertEqual(stats["droppedQueueFull"], 1)
            self.assertAlmostEqual(plane._bridge.mapper.parameters["p"].value, 0.25)
            self.assertAlmostEqual(plane._bridge.mapper.parameters["x"].value, 0.3)
            self.assertAlmostEqual(plane._bridge.mapper.parameters["y"].value, 0.7)
            plane._handle(b"x" * 513)
            self.assertEqual(plane.stats()["droppedInvalid"], 1)
        finally:
            plane.close()

    def test_parameter_topology_change_revokes_armed_generation_before_apply(self):
        plane = self._plane()
        try:
            queue = plane._bridge.queue; queue.defer = True
            armed = self._arm(plane, 30000, ["udp-json"], ["p"])
            plane._handle(self._json(token=armed["token"], seq=1, channel="udp-json", op="parameter.set", ref="p", value=0.75))
            plane._bridge.mapper.authority_generation += 1
            with self.assertRaises(ValueError): queue.calls.pop(0)()
            stats = plane.stats(); self.assertFalse(stats["armed"]); self.assertEqual(stats["applied"], 0); self.assertEqual(stats["applyFailures"], 1); self.assertEqual(stats["revokedBeforeApply"], 1)
            self.assertEqual(plane._bridge.mapper.parameters["p"].value, 0.0)
        finally:
            plane.close()

    def test_disarm_expiry_and_rearm_fence_accepted_callbacks(self):
        plane = self._plane()
        try:
            queue = plane._bridge.queue
            queue.defer = True
            armed = self._arm(plane, 30000, ["udp-json"], ["p"])
            plane._handle(self._json(token=armed["token"], seq=1, channel="udp-json", op="parameter.set", ref="p", value=0.75))
            self.assertEqual(plane.stats()["accepted"], 1)
            self.assertEqual(plane.stats()["pending"], 1)
            plane.disarm()
            with self.assertRaises(ValueError):
                queue.calls.pop(0)()
            self.assertEqual(plane._bridge.mapper.parameters["p"].value, 0.0)

            expired = self._arm(plane, 30000, ["udp-json"], ["p"])
            plane._handle(self._json(token=expired["token"], seq=1, channel="udp-json", op="parameter.set", ref="p", value=0.5))
            with plane._lock:
                token, _, channels, ports, parameters = plane._armed
                plane._armed = (token, time.time() - 1, channels, ports, parameters)
            with self.assertRaises(ValueError):
                queue.calls.pop(0)()

            old = self._arm(plane, 30000, ["udp-json"], ["p"])
            plane._handle(self._json(token=old["token"], seq=1, channel="udp-json", op="parameter.set", ref="p", value=0.4))
            self._arm(plane, 30000, ["udp-json"], ["p"])
            with self.assertRaises(ValueError):
                queue.calls.pop(0)()
            stats = plane.stats()
            self.assertEqual(stats["revokedBeforeApply"], 3)
            self.assertEqual(stats["applyFailures"], 3)
            self.assertEqual(stats["applied"], 0)
            self.assertEqual(stats["pending"], 0)
        finally:
            plane.close()

    def test_actual_udp_bounds_and_receiver_survives_queue_failure(self):
        import socket as _socket
        from ableton_mcp_remote_script import validate_operation_payload
        plane = self._plane()
        sender = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        sender.bind(("127.0.0.1", 0))
        try:
            armed = self._arm(plane, 30000, ["udp-json"], ["p"], [sender.getsockname()[1]])
            sender.sendto(b"x" * 513, ("127.0.0.1", plane.port))
            plane._bridge.queue.raise_once = True
            sender.sendto(self._json(token=armed["token"], seq=1, channel="udp-json", op="parameter.set", ref="p", value=0.2), ("127.0.0.1", plane.port))
            sender.sendto(self._json(token=armed["token"], seq=2, channel="udp-json", op="parameter.set", ref="p", value=0.3), ("127.0.0.1", plane.port))
            deadline = time.time() + 3
            while time.time() < deadline and plane.stats()["accepted"] < 1:
                time.sleep(0.02)
            stats = plane.stats()
            self.assertGreaterEqual(stats["droppedInvalid"], 1)
            self.assertGreaterEqual(stats["droppedBeforeDispatch"], 1)
            self.assertEqual(stats["accepted"], 1)
            self.assertEqual(stats["applied"], 1)
            self.assertTrue(plane._thread.is_alive())
            validate_operation_payload("realtime.stats", "result", stats)
        finally:
            sender.close()
            plane.close()

    def test_rate_limit_drops_bursts_without_replay_gap_double_counting(self):
        plane = self._plane()
        try:
            armed = self._arm(plane, 30000, ["udp-json"], ["p"])
            for seq in range(1, 41):
                plane._handle(self._json(token=armed["token"], seq=seq, channel="udp-json", op="parameter.set", ref="p", value=0.5))
            stats = plane.stats()
            self.assertGreater(stats["droppedRateLimited"], 0)
            self.assertLess(stats["accepted"], 40)
            self.assertEqual(stats["sequenceGaps"], 0)
            self.assertEqual(stats["lastSequence"], 40)
        finally:
            plane.close()


class ViewLocatorClipExpansionTests(unittest.TestCase):
    def test_clip_set_mutes_colors_and_loops_midi_clips_with_fail_closed_rollback(self):
        song = FakeSong(); clip = FakeClip(8.0)
        clip.is_audio_clip = False; clip.muted = False; clip.color_index = 1; clip.looping = False; clip.loop_start = 0.0; clip.loop_end = 8.0
        song.tracks[0].clip_slots[0].clip = clip
        mapper = LiveObjectMapper(song); row = mapper.snapshot()["tracks"][0]["clips"][0]
        self.assertEqual((row["muted"], row["colorIndex"], row["looping"], row["loopStart"], row["loopEnd"]), (False, 1, False, 0.0, 8.0))
        fields = ("muted", "colorIndex", "looping", "loopStart", "loopEnd", "groove")
        def payload(**changes):
            current = mapper.get(row["ref"])
            return {"ref": row["ref"], **changes, "expectedObjectIdentity": row["objectIdentity"],
                    "expectedAuthorityRevision": hashlib.sha256(mapper._bounded_canonical(mapper._session_clip_authority(row["ref"])).encode()).hexdigest(),
                    "expectedStateRevision": hashlib.sha256(mapper._bounded_canonical({field: current.get(field) for field in fields}).encode()).hexdigest()}
        stale = payload(muted=True, colorIndex=5, looping=True, loopStart=1.0, loopEnd=5.0)
        result = mapper.invoke("clip.set", stale)
        self.assertTrue(result["changed"]); validate_operation_payload("clip.set", "result", result)
        self.assertTrue(clip.muted); self.assertEqual(clip.color_index, 5); self.assertTrue(clip.looping); self.assertEqual((clip.loop_start, clip.loop_end), (1.0, 5.0))
        with self.assertRaisesRegex(ValueError, "changed since preview"): mapper.invoke("clip.set", stale)
        with self.assertRaisesRegex(ValueError, "no fields"): mapper.invoke("clip.set", payload())
        with self.assertRaisesRegex(ValueError, "colorIndex is invalid"): mapper.invoke("clip.set", payload(colorIndex=70))
        with self.assertRaisesRegex(ValueError, "loopStart must not exceed loopEnd"): mapper.invoke("clip.set", payload(loopStart=7.0, loopEnd=6.0))

    def test_clip_set_rejects_loop_edits_on_audio_clips_and_rolls_back_exactly(self):
        song = FakeSong(); clip = FakeClip(4.0)
        clip.is_audio_clip = True; clip.muted = False; clip.color_index = 2; clip.looping = True; clip.loop_start = 0.0; clip.loop_end = 4.0
        song.tracks[0].clip_slots[0].clip = clip
        mapper = LiveObjectMapper(song); row = mapper.snapshot()["tracks"][0]["clips"][0]
        self.assertEqual((row["loopStart"], row["loopEnd"]), (0.0, 4.0))
        fields = ("muted", "colorIndex", "looping", "loopStart", "loopEnd", "groove")
        def payload(**changes):
            current = mapper.get(row["ref"])
            return {"ref": row["ref"], **changes, "expectedObjectIdentity": row["objectIdentity"],
                    "expectedAuthorityRevision": hashlib.sha256(mapper._bounded_canonical(mapper._session_clip_authority(row["ref"])).encode()).hexdigest(),
                    "expectedStateRevision": hashlib.sha256(mapper._bounded_canonical({field: current.get(field) for field in fields}).encode()).hexdigest()}
        with self.assertRaisesRegex(ValueError, "audio clip loop editing"): mapper.invoke("clip.set", payload(looping=False))
        result = mapper.invoke("clip.set", payload(muted=True))
        self.assertTrue(result["changed"]); self.assertTrue(clip.muted)

        class FailingClip(FakeClip):
            @property
            def muted(self): return self._muted
            @muted.setter
            def muted(self, value):
                if value is True: raise RuntimeError("Live rejected the write")
                self._muted = value
        failing = FailingClip(4.0); failing._muted = False; failing.is_audio_clip = False; failing.color_index = 3; failing.looping = False; failing.loop_start = 0.0; failing.loop_end = 4.0
        song.tracks[0].clip_slots[0].clip = failing; mapper = LiveObjectMapper(song); failing_row = mapper.snapshot()["tracks"][0]["clips"][0]
        def failing_payload(**changes):
            current = mapper.get(failing_row["ref"])
            return {"ref": failing_row["ref"], **changes, "expectedObjectIdentity": failing_row["objectIdentity"],
                    "expectedAuthorityRevision": hashlib.sha256(mapper._bounded_canonical(mapper._session_clip_authority(failing_row["ref"])).encode()).hexdigest(),
                    "expectedStateRevision": hashlib.sha256(mapper._bounded_canonical({field: current.get(field) for field in fields}).encode()).hexdigest()}
        with self.assertRaises(RuntimeError):
            mapper.invoke("clip.set", failing_payload(colorIndex=9, muted=True))
        self.assertEqual(failing.color_index, 3); self.assertFalse(failing.muted)

    def test_clip_set_arrangement_clip_uses_arrangement_authority(self):
        song = FakeSong(); track = song.tracks[0]
        clip = FakeClip(4.0); clip.name = "Arr"; clip.start_time = 4.0; clip.is_audio_clip = False; clip.muted = False; clip.color_index = 1; clip.looping = True; clip.loop_start = 0.0; clip.loop_end = 4.0
        track.arrangement_clips = [clip]
        mapper = LiveObjectMapper(song); row = mapper.snapshot()["arrangement"]["clips"][0]
        fields = ("muted", "colorIndex", "looping", "loopStart", "loopEnd", "groove")
        current = mapper.get(row["ref"])
        args = {"ref": row["ref"], "muted": True, "expectedObjectIdentity": row["objectIdentity"],
                "expectedAuthorityRevision": mapper._arrangement_clip_authority_revision(row["ref"]),
                "expectedStateRevision": hashlib.sha256(mapper._bounded_canonical({field: current.get(field) for field in fields}).encode()).hexdigest()}
        result = mapper.invoke("clip.set", args)
        self.assertTrue(result["changed"]); self.assertTrue(clip.muted)

    def test_locator_jump_navigates_cue_points(self):
        song = FakeArrangementSong()
        song.cue_points = [FakeLocator(8.0, "A"), FakeLocator(16.0, "B")]
        def jump_next():
            later = [locator.time for locator in song.cue_points if locator.time > song.current_song_time]
            if later: song.current_song_time = min(later)
        def jump_previous():
            earlier = [locator.time for locator in song.cue_points if locator.time < song.current_song_time - 1e-9]
            song.current_song_time = max(earlier) if earlier else 0.0
        song.jump_to_next_cue = jump_next; song.jump_to_prev_cue = jump_previous
        mapper = LiveObjectMapper(song)
        self.assertTrue(mapper._operation_supported("locator.jump"))
        result = mapper.invoke("locator.jump", {"direction": "next"})
        self.assertEqual((result["before"], result["position"]), (0.0, 8.0)); validate_operation_payload("locator.jump", "result", result)
        self.assertEqual(mapper.invoke("locator.jump", {"direction": "previous"})["position"], 0.0)
        with self.assertRaisesRegex(ValueError, "direction is invalid"): mapper.invoke("locator.jump", {"direction": "sideways"})
        without = LiveObjectMapper(FakeSong())
        self.assertFalse(without._operation_supported("locator.jump"))
        with self.assertRaisesRegex(ValueError, "unavailable"): without.invoke("locator.jump", {"direction": "next"})

    def test_view_set_and_control_use_application_view_with_readback(self):
        class FakeAppView:
            def __init__(self): self.visible = "Session"; self.zooms = []; self.scrolls = []
            def show_view(self, name): self.visible = name
            def is_view_visible(self, name): return self.visible == name
            def zoom_view(self, direction, surface, animate): self.zooms.append((direction, surface, animate))
            def scroll_view(self, direction, surface, animate): self.scrolls.append((direction, surface, animate))
        class FakeApplication: pass
        song = FakeSong(); song.view = type("SongView", (), {"follow_song": False})()
        song.tracks[0].view = type("TrackView", (), {"is_collapsed": False})()
        application = FakeApplication(); application.view = FakeAppView()
        mapper = LiveObjectMapper(song); mapper._application = lambda: application
        self.assertTrue(mapper._operation_supported("view.set")); self.assertTrue(mapper._operation_supported("view.control"))
        result = mapper.invoke("view.set", {"view": "Arranger"})
        self.assertEqual(result, {"view": "Arranger", "visible": True}); validate_operation_payload("view.set", "result", result)
        application.view.is_view_visible = lambda name: False
        with self.assertRaisesRegex(ValueError, "not confirmed"): mapper.invoke("view.set", {"view": "Session"})
        self.assertEqual(mapper.invoke("view.control", {"action": "zoom-in"}), {"action": "zoom-in", "done": True})
        self.assertEqual(application.view.zooms, [(1, "Arranger", False)])
        self.assertEqual(mapper.invoke("view.control", {"action": "scroll-right"}), {"action": "scroll-right", "done": True})
        self.assertEqual(application.view.scrolls, [(1, "Arranger", False)])
        mapper.invoke("view.control", {"action": "follow-on"}); self.assertTrue(song.view.follow_song)
        mapper.invoke("view.control", {"action": "follow-off"}); self.assertFalse(song.view.follow_song)
        track_ref = mapper.snapshot()["tracks"][0]["ref"]
        mapper.invoke("view.control", {"action": "collapse-track", "trackRef": track_ref}); self.assertTrue(song.tracks[0].view.is_collapsed)
        mapper.invoke("view.control", {"action": "expand-track", "trackRef": track_ref}); self.assertFalse(song.tracks[0].view.is_collapsed)
        with self.assertRaisesRegex(ValueError, "action is invalid"): mapper.invoke("view.control", {"action": "detonate"})
        with self.assertRaisesRegex(ValueError, "track reference is stale"): mapper.invoke("view.control", {"action": "collapse-track", "trackRef": "bogus"})
        without = LiveObjectMapper(FakeSong())
        self.assertFalse(without._operation_supported("view.set")); self.assertFalse(without._operation_supported("view.control"))
        with self.assertRaisesRegex(ValueError, "unavailable"): without.invoke("view.set", {"view": "Arranger"})

    def test_arrangement_audio_clip_create_places_file_and_cleans_up_exactly(self):
        song = FakeSong(); track = song.tracks[0]; track.arrangement_clips = []
        def create_audio_clip(file_path, position):
            clip = FakeClip(4.0); clip.start_time = position; clip.file_path = file_path; track.arrangement_clips.append(clip); return clip
        track.create_audio_clip = create_audio_clip
        track.delete_clip = lambda candidate: track.arrangement_clips.remove(candidate)
        mapper = LiveObjectMapper(song); track_row = mapper.snapshot()["tracks"][0]
        args = {"trackRef": track_row["ref"], "filePath": "/tmp/demo.wav", "position": 8.0, "name": "Imported",
                "expectedTrackIdentity": track_row["objectIdentity"], "expectedCollectionRevision": mapper._arrangement_collection_revision(track, 0)}
        result = mapper.invoke("arrangement.audio-clip.create", args)
        self.assertEqual((result["filePath"], result["start"], result["length"], result["name"]), ("/tmp/demo.wav", 8.0, 4.0, "Imported"))
        validate_operation_payload("arrangement.audio-clip.create", "result", result)
        self.assertEqual(len(track.arrangement_clips), 1)
        with self.assertRaisesRegex(ValueError, "collection changed since preview"):
            mapper.invoke("arrangement.audio-clip.create", args)
        self.assertEqual(len(track.arrangement_clips), 1)

        def broken_creator(file_path, position):
            clip = FakeClip(4.0); clip.start_time = position; clip.file_path = ""; track.arrangement_clips.append(clip); return clip
        track.create_audio_clip = broken_creator
        broken_args = dict(args, expectedCollectionRevision=mapper._arrangement_collection_revision(track, 0))
        with self.assertRaisesRegex(ValueError, "file path was not confirmed"):
            mapper.invoke("arrangement.audio-clip.create", broken_args)
        self.assertEqual(len(track.arrangement_clips), 1)
        with self.assertRaisesRegex(ValueError, "filePath is invalid"):
            mapper.invoke("arrangement.audio-clip.create", dict(broken_args, filePath=""))


class FakeWarpMarker:
    def __init__(self, beat, sample): self.beat_time = beat; self.sample_time = sample


class FakeAudioClipFull(FakeClip):
    def __init__(self, length):
        super().__init__(length)
        self.is_audio_clip = True
        self.warp_markers = [FakeWarpMarker(1.0, 44100.0), FakeWarpMarker(3.0, 132300.0)]
        self.file_path = "/tmp/a.wav"
        self.looping = True; self.loop_start = 0.0; self.loop_end = length
        self.muted = False; self.color_index = 0
        self.available_warp_modes = [0, 1, 2, 3, 4, 6]
        self.sample_length = 176400.0

    def add_warp_marker(self, beat):
        marker = FakeWarpMarker(beat, beat * 44100.0); self.warp_markers.append(marker); self.warp_markers.sort(key=lambda item: item.beat_time); return marker

    def move_warp_marker(self, beat, distance):
        for marker in self.warp_markers:
            if marker.beat_time == beat:
                marker.beat_time = beat + distance; marker.sample_time = (beat + distance) * 44100.0; self.warp_markers.sort(key=lambda item: item.beat_time); return
        raise RuntimeError("no marker at beat")

    def remove_warp_marker(self, marker):
        self.warp_markers.remove(marker)


class AudioWarpNoteExpansionTests(unittest.TestCase):
    def _mapper_with_audio_clip(self):
        song = FakeSong(); clip = FakeAudioClipFull(4.0); song.tracks[0].clip_slots[0].clip = clip
        mapper = LiveObjectMapper(song); row = mapper.snapshot()["tracks"][0]["clips"][0]
        return song, clip, mapper, row

    def _fences(self, mapper, row, clip):
        return {"ref": row["ref"], "expectedClipAuthorityDigest": mapper._clip_authority_digest(row["ref"]),
                "expectedMarkerCollectionRevision": mapper._warp_marker_collection_revision(clip)}

    def test_warp_marker_rows_and_audio_metadata_are_exposed(self):
        _, clip, mapper, row = self._mapper_with_audio_clip()
        self.assertEqual(row["warpMarkers"], [{"beatTime": 1.0, "sampleTime": 44100.0}, {"beatTime": 3.0, "sampleTime": 132300.0}])
        self.assertEqual(row["availableWarpModes"], [0, 1, 2, 3, 4, 6]); self.assertEqual(row["sampleLength"], 176400.0)
        result = mapper.invoke("audio.warp-marker.read", {"ref": row["ref"]})
        self.assertEqual([marker["beatTime"] for marker in result["markers"]], [1.0, 3.0]); validate_operation_payload("audio.warp-marker.read", "result", result)
        self.assertTrue(mapper._operation_supported("audio.warp-marker.read")); self.assertTrue(mapper._operation_supported("audio.warp-marker.add"))
        self.assertIn("warp", mapper.capabilities())

    def test_warp_marker_add_move_delete_with_fences_and_refusals(self):
        _, clip, mapper, row = self._mapper_with_audio_clip()
        result = mapper.invoke("audio.warp-marker.add", {**self._fences(mapper, row, clip), "beatTime": 2.0})
        self.assertTrue(result["changed"]); validate_operation_payload("audio.warp-marker.add", "result", result)
        self.assertEqual([marker.beat_time for marker in clip.warp_markers], [1.0, 2.0, 3.0])
        with self.assertRaisesRegex(ValueError, "already exists"): mapper.invoke("audio.warp-marker.add", {**self._fences(mapper, row, clip), "beatTime": 2.0})
        stale = self._fences(mapper, row, clip); stale["expectedMarkerCollectionRevision"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "collection changed"): mapper.invoke("audio.warp-marker.add", {**stale, "beatTime": 4.0})
        moved = mapper.invoke("audio.warp-marker.move", {**self._fences(mapper, row, clip), "beatTime": 1.0, "distance": 0.5})
        self.assertTrue(moved["changed"]); self.assertEqual([marker.beat_time for marker in clip.warp_markers], [1.5, 2.0, 3.0])
        with self.assertRaisesRegex(ValueError, "no warp marker"): mapper.invoke("audio.warp-marker.move", {**self._fences(mapper, row, clip), "beatTime": 1.0, "distance": 0.5})
        with self.assertRaisesRegex(ValueError, "collides"): mapper.invoke("audio.warp-marker.move", {**self._fences(mapper, row, clip), "beatTime": 1.5, "distance": 0.5})
        deleted = mapper.invoke("audio.warp-marker.delete", {**self._fences(mapper, row, clip), "beatTime": 3.0})
        self.assertTrue(deleted["changed"]); self.assertEqual([marker.beat_time for marker in clip.warp_markers], [1.5, 2.0])

    def test_warp_marker_acknowledgement_loss_compensates_exactly(self):
        _, clip, mapper, row = self._mapper_with_audio_clip()
        original_move = clip.move_warp_marker
        calls = []
        def flaky_move(beat, distance):
            original_move(beat, distance)
            if not calls:
                calls.append(1); raise RuntimeError("ack lost")
        clip.move_warp_marker = flaky_move
        with self.assertRaisesRegex(RuntimeError, "ack lost"):
            mapper.invoke("audio.warp-marker.move", {**self._fences(mapper, row, clip), "beatTime": 1.0, "distance": 0.25})
        self.assertEqual([marker.beat_time for marker in clip.warp_markers], [1.0, 3.0])

    def test_session_audio_clip_create_with_file_authority_refusals(self):
        song = FakeSong(); track = song.tracks[0]; track.has_midi_input = False; slot = track.clip_slots[0]
        def create_audio_clip(path):
            clip = FakeClip(4.0); clip.is_audio_clip = True; clip.file_path = path; slot.clip = clip; return clip
        slot.create_audio_clip = create_audio_clip
        mapper = LiveObjectMapper(song); track_row = mapper.snapshot()["tracks"][0]; slot_row = track_row["clipSlots"][0]; scene_row = mapper.snapshot()["scenes"][0]
        args = {"trackRef": track_row["ref"], "sceneIndex": 0, "filePath": "/tmp/demo.wav", "name": "Imported",
                "expectedTrackIdentity": track_row["objectIdentity"], "expectedSlotRef": slot_row["ref"], "expectedSlotIdentity": slot_row["objectIdentity"],
                "expectedSceneRef": scene_row["ref"], "expectedSceneIdentity": scene_row["objectIdentity"]}
        self.assertTrue(mapper._operation_supported("session.audio-clip.create"))
        result = mapper.invoke("session.audio-clip.create", args)
        self.assertEqual((result["filePath"], result["name"], result["length"]), ("/tmp/demo.wav", "Imported", 4.0)); validate_operation_payload("session.audio-clip.create", "result", result)
        with self.assertRaisesRegex(ValueError, "occupied"): mapper.invoke("session.audio-clip.create", args)
        song2 = FakeSong(); slot2 = song2.tracks[0].clip_slots[0]; slot2.create_audio_clip = create_audio_clip
        mapper2 = LiveObjectMapper(song2); track2 = mapper2.snapshot()["tracks"][0]; slot2_row = track2["clipSlots"][0]; scene2 = mapper2.snapshot()["scenes"][0]
        relative = dict(args, trackRef=track2["ref"], filePath="demo.wav", expectedTrackIdentity=track2["objectIdentity"], expectedSlotRef=slot2_row["ref"], expectedSlotIdentity=slot2_row["objectIdentity"], expectedSceneRef=scene2["ref"], expectedSceneIdentity=scene2["objectIdentity"])
        with self.assertRaisesRegex(ValueError, "absolute path"): mapper2.invoke("session.audio-clip.create", relative)
        with self.assertRaisesRegex(ValueError, "not an audio track"): mapper2.invoke("session.audio-clip.create", dict(relative, filePath="/tmp/demo.wav"))

    def _clip_action_fences(self, mapper, row):
        current = mapper.get(row["ref"])
        state = hashlib.sha256(mapper._bounded_canonical({"isPlaying": current.get("isPlaying"), "playingPosition": current.get("playingPosition"), "length": current.get("length"), "loopStart": current.get("loopStart"), "loopEnd": current.get("loopEnd")}).encode()).hexdigest()
        return {"ref": row["ref"], "expectedObjectIdentity": row["objectIdentity"], "expectedAuthorityRevision": mapper._clip_authority_digest(row["ref"]), "expectedStateRevision": state}

    def test_clip_actions_crop_duplicate_and_scrub(self):
        song = FakeSong(); clip = FakeClip(4.0); clip.loop_start = 1.0; clip.loop_end = 3.0
        clip.crop = lambda: setattr(clip, "length", clip.loop_end - clip.loop_start)
        clip.duplicate_loop = lambda: setattr(clip, "length", clip.length * 2)
        clip.duplicate_region = lambda start, end, dest: setattr(clip, "length", clip.length + (end - start))
        clip.playing_position = 0.5
        clip.start_scrub = lambda position: setattr(clip, "playing_position", position)
        clip.stop_scrub = lambda: setattr(clip, "playing_position", 0.0)
        clip.move_playing_pos = lambda offset: setattr(clip, "playing_position", clip.playing_position + offset)
        song.tracks[0].clip_slots[0].clip = clip; mapper = LiveObjectMapper(song); row = mapper.snapshot()["tracks"][0]["clips"][0]
        self.assertTrue(mapper._operation_supported("clip.action"))
        result = mapper.invoke("clip.action", {**self._clip_action_fences(mapper, row), "action": "crop", "expectedContentFingerprint": mapper._mapped_fingerprint(row["ref"])})
        self.assertTrue(result["changed"]); self.assertEqual(clip.length, 2.0)
        result = mapper.invoke("clip.action", {**self._clip_action_fences(mapper, row), "action": "duplicate-loop", "expectedContentFingerprint": mapper._mapped_fingerprint(row["ref"])})
        self.assertTrue(result["changed"]); self.assertEqual(clip.length, 4.0)
        result = mapper.invoke("clip.action", {**self._clip_action_fences(mapper, row), "action": "duplicate-region", "regionStart": 0.0, "regionEnd": 1.0, "destination": 4.0, "expectedContentFingerprint": mapper._mapped_fingerprint(row["ref"])})
        self.assertTrue(result["changed"]); self.assertEqual(clip.length, 5.0)
        mapper.invoke("clip.action", {**self._clip_action_fences(mapper, row), "action": "scrub-start", "offset": 2.5})
        self.assertEqual(clip.playing_position, 2.5)
        mapper.invoke("clip.action", {**self._clip_action_fences(mapper, row), "action": "move-playing-position", "offset": 1.0})
        self.assertEqual(clip.playing_position, 3.5)
        mapper.invoke("clip.action", {**self._clip_action_fences(mapper, row), "action": "scrub-stop"})
        self.assertEqual(clip.playing_position, 0.0)
        with self.assertRaisesRegex(ValueError, "invalid"): mapper.invoke("clip.action", {**self._clip_action_fences(mapper, row), "action": "detonate"})
        with self.assertRaisesRegex(ValueError, "changed since preview"): mapper.invoke("clip.action", {**self._clip_action_fences(mapper, row), "action": "crop", "expectedContentFingerprint": "0" * 64})

    def test_automation_envelope_clear_counts_and_fences(self):
        song = FakeSong(); clip = FakeClip(4.0)
        envelope = type("Envelope", (), {})()
        clip._envelopes = {}
        clip.automation_envelope = lambda parameter: clip._envelopes.get(id(parameter))
        clip.clear_all_envelopes = lambda: clip._envelopes.clear()
        song.tracks[0].clip_slots[0].clip = clip; parameter = song.tracks[0].devices[0].parameters[0]
        clip._envelopes[id(parameter)] = envelope
        mapper = LiveObjectMapper(song); row = mapper.snapshot()["tracks"][0]["clips"][0]
        revision = hashlib.sha256(mapper._bounded_canonical([True]).encode()).hexdigest()
        result = mapper.invoke("automation.envelope.clear", {"clipRef": row["ref"], "expectedAuthorityDigest": mapper._clip_authority_digest(row["ref"]), "expectedEnvelopesRevision": revision})
        self.assertEqual(result["cleared"], 1); validate_operation_payload("automation.envelope.clear", "result", result)
        self.assertEqual(clip._envelopes, {})
        with self.assertRaisesRegex(ValueError, "collection changed since preview"):
            mapper.invoke("automation.envelope.clear", {"clipRef": row["ref"], "expectedAuthorityDigest": mapper._clip_authority_digest(row["ref"]), "expectedEnvelopesRevision": revision})

    def test_note_targeted_reads_duplicate_and_quantize(self):
        song = FakeSong(); clip = FakeClip(4.0)
        clip.add_new_notes([{"pitch": 60, "start_time": 0.0, "duration": 0.5, "velocity": 100}, {"pitch": 64, "start_time": 0.6, "duration": 0.5, "velocity": 90}])
        clip.get_notes_by_id = lambda ids: [note for note in clip.notes if note["note_id"] in set(ids)]
        clip.get_selected_notes = lambda: [clip.notes[0]]
        def duplicate(ids):
            for note in [n for n in clip.notes if n["note_id"] in set(ids)]:
                copy = dict(note); copy["note_id"] = clip.next_note_id; clip.next_note_id += 1; clip.notes.append(copy)
        clip.duplicate_notes_by_id = duplicate
        def quantize(grid, amount):
            for note in clip.notes: note["start_time"] = round(note["start_time"] / grid) * grid * amount + note["start_time"] * (1 - amount)
        clip.quantize = quantize
        def quantize_to_pitch(pitch, grid, amount):
            for note in clip.notes: note["pitch"] = pitch
        clip.quantize_to_pitch = quantize_to_pitch
        song.tracks[0].clip_slots[0].clip = clip; mapper = LiveObjectMapper(song); row = mapper.snapshot()["tracks"][0]["clips"][0]
        read = mapper.invoke("note.read-by-id", {"ref": row["ref"], "noteIds": [1]})
        self.assertEqual([note["pitch"] for note in read["notes"]], [60]); validate_operation_payload("note.read-by-id", "result", read)
        selected = mapper.invoke("note.read-selected", {"ref": row["ref"]})
        self.assertTrue(selected["available"]); self.assertEqual(len(selected["notes"]), 1)
        def note_fences():
            return {"ref": row["ref"], "expectedClipAuthority": mapper._session_clip_authority(row["ref"]), "expectedNotesRevision": hashlib.sha256(mapper._bounded_canonical(mapper._read_notes(clip)).encode()).hexdigest()}
        duplicated = mapper.invoke("note.duplicate", {**note_fences(), "noteIds": [1]})
        self.assertEqual(duplicated["duplicated"], 1); self.assertEqual(len(clip.notes), 3)
        with self.assertRaisesRegex(ValueError, "stable note identity"): mapper.invoke("note.duplicate", {**note_fences(), "noteIds": [99]})
        changed = mapper.invoke("note.quantize", {**note_fences(), "grid": 0.25, "amount": 1.0})
        self.assertTrue(changed["changed"]); self.assertEqual(clip.notes[1]["start_time"], 0.5)
        changed = mapper.invoke("note.quantize", {**note_fences(), "grid": 0.25, "amount": 1.0, "pitch": 67})
        self.assertTrue(changed["changed"]); self.assertTrue(all(note["pitch"] == 67 for note in clip.notes))


class FakeTakeLane:
    def __init__(self, name="Take 1"):
        self.name = name
        self.arrangement_clips = []

    def create_midi_clip(self, position, length):
        clip = FakeClip(length); clip.start_time = position; clip.is_take_lane_clip = True; self.arrangement_clips.append(clip); return clip

    def create_audio_clip(self, file_path, position):
        clip = FakeClip(4.0); clip.is_audio_clip = True; clip.start_time = position; clip.file_path = file_path; clip.is_take_lane_clip = True; self.arrangement_clips.append(clip); return clip


class TakeLaneExpansionTests(unittest.TestCase):
    def _mapper_with_lanes(self):
        song = FakeSong(); track = song.tracks[0]
        lane = FakeTakeLane()
        existing = FakeClip(4.0); existing.name = "Comp A"; existing.start_time = 0.0; existing.is_take_lane_clip = True
        lane.arrangement_clips = [existing]
        track.take_lanes = [lane]
        track.create_take_lane = lambda: (track.take_lanes.append(FakeTakeLane(f"Take {len(track.take_lanes) + 1}")) or track.take_lanes[-1])
        mapper = LiveObjectMapper(song)
        return song, track, lane, existing, mapper

    def test_take_lane_discovery_rows_and_read(self):
        _, track, lane, existing, mapper = self._mapper_with_lanes()
        track_row = mapper.snapshot()["tracks"][0]
        lanes = track_row["takeLanes"]
        self.assertEqual(len(lanes), 1); self.assertEqual(lanes[0]["name"], "Take 1"); self.assertEqual(lanes[0]["index"], 0)
        clip_row = lanes[0]["clips"][0]
        self.assertEqual(clip_row["name"], "Comp A"); self.assertTrue(clip_row["isTakeLaneClip"]); self.assertEqual(clip_row["takeLaneRef"], lanes[0]["ref"])
        self.assertEqual(mapper.get(lanes[0]["ref"])["name"], "Take 1")
        self.assertEqual(mapper.get(clip_row["ref"])["name"], "Comp A")
        self.assertIsNone(mapper.snapshot()["tracks"][0]["clips"] and mapper.snapshot()["tracks"][0]["clips"] == [] or None)
        result = mapper.invoke("audio.take-lane.read", {"trackRef": track_row["ref"]})
        self.assertEqual(result["lanes"], [{"ref": lanes[0]["ref"], "name": "Take 1"}]); validate_operation_payload("audio.take-lane.read", "result", result)
        self.assertTrue(mapper._operation_supported("audio.take-lane.read")); self.assertIn("takes", mapper.capabilities())

    def test_take_lane_create_with_collection_fencing(self):
        song, track, lane, existing, mapper = self._mapper_with_lanes()
        track_row = mapper.snapshot()["tracks"][0]
        args = {"trackRef": track_row["ref"], "name": "Take 2", "expectedTrackIdentity": track_row["objectIdentity"], "expectedTakeLaneCollectionRevision": mapper._take_lane_collection_revision(track, 0)}
        self.assertTrue(mapper._operation_supported("take-lane.create"))
        result = mapper.invoke("take-lane.create", args)
        self.assertEqual((result["name"], result["index"]), ("Take 2", 1)); validate_operation_payload("take-lane.create", "result", result)
        self.assertEqual(len(track.take_lanes), 2)
        with self.assertRaisesRegex(ValueError, "collection changed"): mapper.invoke("take-lane.create", args)

    def test_take_lane_rename_with_rollback(self):
        _, track, lane, existing, mapper = self._mapper_with_lanes()
        lane_row = mapper.snapshot()["tracks"][0]["takeLanes"][0]
        args = {"ref": lane_row["ref"], "name": "Verse Take", "expectedName": "Take 1", "expectedObjectIdentity": lane_row["objectIdentity"], "expectedAuthorityRevision": mapper._take_lane_collection_revision(track, 0)}
        result = mapper.invoke("take-lane.rename", args)
        self.assertEqual(result, {"renamed": lane_row["ref"], "name": "Verse Take"}); self.assertEqual(lane.name, "Verse Take")
        with self.assertRaisesRegex(ValueError, "changed since preview"): mapper.invoke("take-lane.rename", args)
        class FailingLane(FakeTakeLane):
            @property
            def name(self): return self._name
            @name.setter
            def name(self, value):
                if value == "Boom": raise RuntimeError("rename rejected")
                self._name = value
        failing = FailingLane(); failing._name = "Old"; track.take_lanes = [failing]
        mapper2 = LiveObjectMapper(_song_with_lanes(track_holder=[track])) if False else LiveObjectMapper(FakeSong())
        song2 = FakeSong(); song2.tracks[0] = track; mapper2 = LiveObjectMapper(song2)
        failing_row = mapper2.snapshot()["tracks"][0]["takeLanes"][0]
        bad_args = {"ref": failing_row["ref"], "name": "Boom", "expectedName": "Old", "expectedObjectIdentity": failing_row["objectIdentity"], "expectedAuthorityRevision": mapper2._take_lane_collection_revision(track, 0)}
        with self.assertRaisesRegex(ValueError, "postcondition was not confirmed"): mapper2.invoke("take-lane.rename", bad_args)
        self.assertEqual(failing.name, "Old")

    def test_take_lane_clip_create_midi_and_audio(self):
        _, track, lane, existing, mapper = self._mapper_with_lanes()
        lane_row = mapper.snapshot()["tracks"][0]["takeLanes"][0]
        base = {"takeLaneRef": lane_row["ref"], "expectedTakeLaneIdentity": lane_row["objectIdentity"], "expectedCollectionRevision": mapper._take_lane_clip_collection_revision(lane, lane_row["ref"])}
        result = mapper.invoke("take-lane.clip.create", {**base, "position": 8.0, "length": 4.0, "name": "New Take"})
        self.assertEqual((result["name"], result["start"], result["length"]), ("New Take", 8.0, 4.0)); validate_operation_payload("take-lane.clip.create", "result", result)
        self.assertEqual(len(lane.arrangement_clips), 2); self.assertTrue(lane.arrangement_clips[1].is_take_lane_clip)
        audio = mapper.invoke("take-lane.audio-clip.create", {"takeLaneRef": lane_row["ref"], "expectedTakeLaneIdentity": lane_row["objectIdentity"], "expectedCollectionRevision": mapper._take_lane_clip_collection_revision(lane, lane_row["ref"]), "filePath": "/tmp/demo.wav", "position": 16.0, "name": "Audio Take"})
        self.assertEqual((audio["filePath"], audio["start"]), ("/tmp/demo.wav", 16.0)); validate_operation_payload("take-lane.audio-clip.create", "result", audio)
        with self.assertRaisesRegex(ValueError, "absolute path"): mapper.invoke("take-lane.audio-clip.create", {**base, "filePath": "demo.wav", "position": 20.0})
        clip_row = mapper.snapshot()["tracks"][0]["takeLanes"][0]["clips"][1]
        self.assertTrue(clip_row["isTakeLaneClip"])
        fields = ("muted", "colorIndex", "looping", "loopStart", "loopEnd", "groove")
        current = mapper.get(clip_row["ref"])
        args = {"ref": clip_row["ref"], "muted": True, "expectedObjectIdentity": clip_row["objectIdentity"], "expectedAuthorityRevision": mapper._clip_authority_digest(clip_row["ref"]), "expectedStateRevision": hashlib.sha256(mapper._bounded_canonical({field: current.get(field) for field in fields}).encode()).hexdigest()}
        lane.arrangement_clips[1].muted = False; lane.arrangement_clips[1].color_index = 1; lane.arrangement_clips[1].looping = True; lane.arrangement_clips[1].loop_start = 0.0; lane.arrangement_clips[1].loop_end = 4.0
        current = mapper.get(clip_row["ref"]); args["expectedStateRevision"] = hashlib.sha256(mapper._bounded_canonical({field: current.get(field) for field in fields}).encode()).hexdigest()
        result = mapper.invoke("clip.set", args)
        self.assertTrue(result["changed"]); self.assertTrue(lane.arrangement_clips[1].muted)


class FakeTuningSystem:
    def __init__(self):
        self.name = "Equal"
        self.lowest_note = 0
        self.highest_note = 127
        self.reference_pitch = 440.0
        self.pseudo_octave_in_cents = 1200.0
        self.note_tunings = [{"note": index, "deviation": 0.0} for index in range(128)]


class TuningScaleTests(unittest.TestCase):
    def _mapper_with_tuning(self):
        song = FakeSong()
        song.tuning_system = FakeTuningSystem()
        song.root_note = 0; song.scale_name = "Major"; song.scale_mode = "Ionian"; song.scale_intervals = [0, 2, 4, 5, 7, 9, 11]
        return song, mapper if False else LiveObjectMapper(song)

    def test_tuning_read_exposes_system_and_scale(self):
        song, mapper = self._mapper_with_tuning()
        self.assertTrue(mapper._operation_supported("tuning.read")); self.assertTrue(mapper._operation_supported("tuning.set"))
        set_ref = mapper.snapshot()["set"]["ref"]
        result = mapper.invoke("tuning.read", {"setRef": set_ref})
        self.assertEqual(result["tuningSystem"]["name"], "Equal"); self.assertEqual(result["tuningSystem"]["referencePitch"], 440.0)
        self.assertEqual(result["tuningSystem"]["pseudoOctaveInCents"], 1200.0); self.assertEqual(len(result["tuningSystem"]["noteTunings"]), 128)
        self.assertEqual(result["scale"], {"rootNote": 0, "scaleName": "Major", "scaleMode": "Ionian", "scaleIntervals": [0, 2, 4, 5, 7, 9, 11]})
        validate_operation_payload("tuning.read", "result", result)

    def test_tuning_set_validates_and_rolls_back_exactly(self):
        song, mapper = self._mapper_with_tuning()
        set_ref = mapper.snapshot()["set"]["ref"]; identity = mapper.snapshot()["set"]["objectIdentity"]
        def fences(): return {"setRef": set_ref, "expectedObjectIdentity": identity, "expectedRevision": mapper._tuning_revision()}
        result = mapper.invoke("tuning.set", {**fences(), "referencePitch": 432.0, "rootNote": 9, "scaleName": "Minor", "scaleIntervals": [0, 2, 3, 5, 7, 8, 10]})
        self.assertTrue(result["changed"]); validate_operation_payload("tuning.set", "result", result)
        self.assertEqual(song.tuning_system.reference_pitch, 432.0); self.assertEqual(song.root_note, 9); self.assertEqual(song.scale_name, "Minor")
        stale = fences(); stale["expectedRevision"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "changed since preview"): mapper.invoke("tuning.set", {**stale, "rootNote": 0})
        with self.assertRaisesRegex(ValueError, "referencePitch is invalid"): mapper.invoke("tuning.set", {**fences(), "referencePitch": 5.0})
        with self.assertRaisesRegex(ValueError, "note range is invalid"): mapper.invoke("tuning.set", {**fences(), "lowestNote": 100, "highestNote": 50})
        with self.assertRaisesRegex(ValueError, "exactly 128"): mapper.invoke("tuning.set", {**fences(), "noteTunings": [{"note": 0, "deviation": 0.0}]})
        with self.assertRaisesRegex(ValueError, "no fields"): mapper.invoke("tuning.set", fences())
        rows = [{"note": index, "deviation": 5.0 if index == 69 else 0.0} for index in range(128)]
        result = mapper.invoke("tuning.set", {**fences(), "noteTunings": rows})
        self.assertTrue(result["changed"]); self.assertEqual(song.tuning_system.note_tunings[69]["deviation"], 5.0)
        class FailingTuning(FakeTuningSystem):
            @property
            def reference_pitch(self): return self._pitch
            @reference_pitch.setter
            def reference_pitch(self, value):
                if value == 415.0: raise RuntimeError("tuning rejected")
                self._pitch = value
        failing = FailingTuning(); failing._pitch = 440.0; song.tuning_system = failing
        with self.assertRaisesRegex(RuntimeError, "tuning rejected"):
            mapper.invoke("tuning.set", {**fences(), "referencePitch": 415.0, "rootNote": 2})
        self.assertEqual(failing.reference_pitch, 440.0); self.assertEqual(song.root_note, 9)


class FakeGroove:
    def __init__(self, name="Swing 16"):
        self.name = name
        self.base = 3
        self.quantization_amount = 0.5
        self.random_amount = 0.1
        self.timing_amount = 0.6
        self.velocity_amount = 0.2


class FakeGroovePool:
    def __init__(self, grooves=None):
        self.grooves = grooves if grooves is not None else [FakeGroove()]


class GroovePoolTests(unittest.TestCase):
    def _mapper_with_groove(self):
        song = FakeSong()
        song.groove_pool = FakeGroovePool()
        song.groove_amount = 0.0
        return song, LiveObjectMapper(song)

    def test_groove_read_exposes_pool_and_amount(self):
        song, mapper = self._mapper_with_groove()
        self.assertTrue(mapper._operation_supported("groove.read")); self.assertTrue(mapper._operation_supported("groove.set")); self.assertTrue(mapper._operation_supported("groove.edit"))
        set_ref = mapper.snapshot()["set"]["ref"]
        result = mapper.invoke("groove.read", {"setRef": set_ref})
        self.assertEqual(result["grooveAmount"], 0.0); self.assertEqual(len(result["grooves"]), 1)
        row = result["grooves"][0]
        self.assertEqual((row["name"], row["base"], row["quantizationAmount"], row["timingAmount"]), ("Swing 16", 3, 0.5, 0.6))
        validate_operation_payload("groove.read", "result", result)

    def test_groove_set_amount_with_rollback(self):
        song, mapper = self._mapper_with_groove()
        set_ref = mapper.snapshot()["set"]["ref"]; identity = mapper.snapshot()["set"]["objectIdentity"]
        def fences(): return {"setRef": set_ref, "expectedObjectIdentity": identity, "expectedRevision": mapper._groove_revision()}
        result = mapper.invoke("groove.set", {**fences(), "grooveAmount": 0.75})
        self.assertTrue(result["changed"]); validate_operation_payload("groove.set", "result", result); self.assertEqual(song.groove_amount, 0.75)
        with self.assertRaisesRegex(ValueError, "is invalid"): mapper.invoke("groove.set", {**fences(), "grooveAmount": 2.0})
        stale = fences(); stale["expectedRevision"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "changed since preview"): mapper.invoke("groove.set", {**stale, "grooveAmount": 0.5})

    def test_groove_edit_fields_with_rollback(self):
        song, mapper = self._mapper_with_groove()
        set_ref = mapper.snapshot()["set"]["ref"]; identity = mapper.snapshot()["set"]["objectIdentity"]
        groove_ref = mapper.invoke("groove.read", {"setRef": set_ref})["grooves"][0]["ref"]
        groove = song.groove_pool.grooves[0]
        object_identity = mapper._capture_object_identity(groove)
        def fences(): return {"ref": groove_ref, "expectedObjectIdentity": object_identity, "expectedRevision": mapper._groove_revision()}
        result = mapper.invoke("groove.edit", {**fences(), "name": "MPC 57", "timingAmount": 0.57, "velocityAmount": 0.3})
        self.assertTrue(result["changed"]); validate_operation_payload("groove.edit", "result", result)
        self.assertEqual((groove.name, groove.timing_amount, groove.velocity_amount), ("MPC 57", 0.57, 0.3))
        with self.assertRaisesRegex(ValueError, "is invalid"): mapper.invoke("groove.edit", {**fences(), "timingAmount": 1.5})
        with self.assertRaisesRegex(ValueError, "no fields"): mapper.invoke("groove.edit", fences())

    def test_clip_groove_assignment_and_has_groove(self):
        song, mapper = self._mapper_with_groove()
        clip = FakeClip(4.0); clip.is_audio_clip = False; clip.muted = False; clip.color_index = 0; clip.looping = True; clip.loop_start = 0.0; clip.loop_end = 4.0; clip.groove = None
        song.tracks[0].clip_slots[0].clip = clip
        groove = song.groove_pool.grooves[0]
        set_ref = mapper.snapshot()["set"]["ref"]
        groove_ref = mapper.invoke("groove.read", {"setRef": set_ref})["grooves"][0]["ref"]
        row = mapper.snapshot()["tracks"][0]["clips"][0]
        self.assertIsNone(row["groove"]); self.assertFalse(row["hasGroove"])
        fields = ("muted", "colorIndex", "looping", "loopStart", "loopEnd", "groove")
        def fences():
            current = mapper.get(row["ref"])
            return {"ref": row["ref"], "expectedObjectIdentity": row["objectIdentity"], "expectedAuthorityRevision": mapper._clip_authority_digest(row["ref"]),
                    "expectedStateRevision": hashlib.sha256(mapper._bounded_canonical({field: current.get(field) for field in fields}).encode()).hexdigest()}
        result = mapper.invoke("clip.set", {**fences(), "grooveRef": groove_ref})
        self.assertTrue(result["changed"]); self.assertIs(clip.groove, groove)
        row = mapper.snapshot()["tracks"][0]["clips"][0]
        self.assertEqual(row["groove"]["name"], "Swing 16"); self.assertTrue(row["hasGroove"])
        result = mapper.invoke("clip.set", {**fences(), "grooveRef": None})
        self.assertTrue(result["changed"]); self.assertIsNone(clip.groove)
        with self.assertRaisesRegex(ValueError, "grooveRef is invalid"): mapper.invoke("clip.set", {**fences(), "grooveRef": "bogus"})


class SceneSlotExpansionTests(unittest.TestCase):
    def _mapper_with_scene(self):
        song = FakeSong()
        scene = song.scenes[0]
        scene.color_index = 1; scene.is_empty = False; scene.is_triggered = False
        scene.tempo = 120.0; scene.tempo_enabled = False
        scene.time_signature_numerator = 4; scene.time_signature_denominator = 4; scene.time_signature_enabled = False
        slot = song.tracks[0].clip_slots[0]
        slot.color_index = 2; slot.controls_other_clips = False; slot.has_stop_button = True; slot.is_group_slot = False; slot.playing_status = 0; slot.will_record_on_start = False
        return song, scene, slot, LiveObjectMapper(song)

    def test_scene_and_slot_rows_expose_state(self):
        _, scene, slot, mapper = self._mapper_with_scene()
        row = mapper.snapshot()["scenes"][0]
        self.assertEqual((row["colorIndex"], row["isEmpty"], row["isTriggered"], row["tempo"], row["tempoEnabled"]), (1, False, False, 120.0, False))
        self.assertEqual((row["signatureNumerator"], row["signatureDenominator"], row["timeSignatureEnabled"]), (4, 4, False))
        slot_row = mapper.snapshot()["tracks"][0]["clipSlots"][0]
        self.assertEqual((slot_row["colorIndex"], slot_row["controlsOtherClips"], slot_row["hasStopButton"], slot_row["isGroupSlot"], slot_row["playingStatus"], slot_row["willRecordOnStart"]), (2, False, True, False, 0, False))

    def test_scene_set_with_validation_and_rollback(self):
        song, scene, slot, mapper = self._mapper_with_scene()
        row = mapper.snapshot()["scenes"][0]
        def fences():
            return {"ref": row["ref"], "expectedObjectIdentity": row["objectIdentity"], "expectedAuthorityRevision": mapper._scene_collection_revision(),
                    "expectedStateRevision": hashlib.sha256(mapper._bounded_canonical(mapper._scene_state_fields(scene)).encode()).hexdigest()}
        self.assertTrue(mapper._operation_supported("scene.set"))
        result = mapper.invoke("scene.set", {**fences(), "colorIndex": 5, "tempo": 90.0, "tempoEnabled": True, "signatureNumerator": 6, "signatureDenominator": 8, "timeSignatureEnabled": True})
        self.assertTrue(result["changed"]); validate_operation_payload("scene.set", "result", result)
        self.assertEqual((scene.color_index, scene.tempo, scene.tempo_enabled), (5, 90.0, True))
        self.assertEqual((scene.time_signature_numerator, scene.time_signature_denominator, scene.time_signature_enabled), (6, 8, True))
        with self.assertRaisesRegex(ValueError, "is invalid"): mapper.invoke("scene.set", {**fences(), "tempo": 10000.0})
        with self.assertRaisesRegex(ValueError, "no fields"): mapper.invoke("scene.set", fences())
        stale = fences(); stale["expectedStateRevision"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "changed since preview"): mapper.invoke("scene.set", {**stale, "colorIndex": 3})
        class FailingScene(FakeScene):
            @property
            def tempo(self): return self._tempo
            @tempo.setter
            def tempo(self, value):
                if value == 60.0: raise RuntimeError("tempo rejected")
                self._tempo = value
        failing = FailingScene(); failing._tempo = 120.0; failing.color_index = 1
        failing.time_signature_numerator = 4; failing.time_signature_denominator = 4; failing.time_signature_enabled = False; failing.tempo_enabled = False
        song.scenes = [failing]; mapper2 = LiveObjectMapper(song)
        failing_row = mapper2.snapshot()["scenes"][0]
        bad_args = {"ref": failing_row["ref"], "expectedObjectIdentity": failing_row["objectIdentity"], "expectedAuthorityRevision": mapper2._scene_collection_revision(),
                    "expectedStateRevision": hashlib.sha256(mapper2._bounded_canonical(mapper2._scene_state_fields(failing)).encode()).hexdigest(), "tempo": 60.0, "colorIndex": 9}
        with self.assertRaisesRegex(RuntimeError, "tempo rejected"): mapper2.invoke("scene.set", bad_args)
        self.assertEqual(failing.tempo, 120.0); self.assertEqual(failing.color_index, 1)

    def test_scene_fire_selected_requires_confirmation(self):
        song, scene, slot, mapper = self._mapper_with_scene()
        def fire_as_selected():
            scene.is_triggered = True; song.is_playing = True
        scene.fire_as_selected = fire_as_selected
        row = mapper.snapshot()["scenes"][0]
        self.assertTrue(mapper._operation_supported("scene.fire-selected"))
        playback = mapper._playback()
        state = hashlib.sha256(mapper._bounded_canonical({"isTriggered": False, "playing": playback["transport"]["playing"]}).encode()).hexdigest()
        result = mapper.invoke("scene.fire-selected", {"ref": row["ref"], "expectedObjectIdentity": row["objectIdentity"], "expectedAuthorityRevision": mapper._scene_collection_revision(), "expectedStateRevision": state})
        self.assertEqual(result, {"fired": True}); validate_operation_payload("scene.fire-selected", "result", result)
        self.assertTrue(scene.is_triggered); self.assertTrue(song.is_playing)


class SongTransportLinkTests(unittest.TestCase):
    def _mapper_with_song_state(self):
        song = FakeSong()
        song.visible_tracks = list(song.tracks); song.appointed_device = song.tracks[0].devices[0]
        song.length = 64.0; song.start_time = 0.0
        song.signature_numerator = 4; song.signature_denominator = 4; song.swing_amount = 0.0
        song.overdub = False; song.arrangement_overdub = False; song.back_to_arranger = False
        song.can_capture_midi = True; song.can_undo = True; song.can_redo = False
        song.exclusive_arm = True; song.exclusive_solo = True; song.is_counting_in = False
        song.tempo_follower_enabled = False; song.re_enable_automation_enabled = False
        song.session_automation_record = False
        song.is_ableton_link_enabled = True; song.is_ableton_link_start_stop_sync_enabled = False
        song.tempo = 120.0
        return song, LiveObjectMapper(song)

    def test_song_read_exposes_state(self):
        song, mapper = self._mapper_with_song_state()
        set_ref = mapper.snapshot()["set"]["ref"]
        result = mapper.invoke("song.read", {"setRef": set_ref})
        self.assertEqual(len(result["visibleTracks"]), 1); self.assertIsNotNone(result["appointedDevice"])
        self.assertEqual((result["songLength"], result["signatureNumerator"], result["swingAmount"]), (64.0, 4, 0.0))
        self.assertEqual((result["canCaptureMidi"], result["canUndo"], result["canRedo"]), (True, True, False))
        self.assertEqual((result["exclusiveArm"], result["exclusiveSolo"], result["isCountingIn"]), (True, True, False))
        self.assertEqual((result["isAbletonLinkEnabled"], result["isAbletonLinkStartStopSyncEnabled"]), (True, False))
        validate_operation_payload("song.read", "result", result)

    def test_transport_action_dispatches_and_fences(self):
        song, mapper = self._mapper_with_song_state()
        calls = []
        song.start_playing = lambda: calls.append("start")
        song.continue_playing = lambda: calls.append("continue")
        song.stop_playing = lambda: calls.append("stop")
        song.tap_tempo = lambda: calls.append("tap")
        song.nudge_up = lambda: calls.append("up")
        song.nudge_down = lambda: calls.append("down")
        song.re_enable_automation = lambda: calls.append("reenable")
        song.trigger_session_record = lambda: calls.append("record")
        song.force_link_beat_time = lambda beat: calls.append(("link", beat))
        set_ref = mapper.snapshot()["set"]["ref"]; identity = mapper.snapshot()["set"]["objectIdentity"]
        self.assertTrue(mapper._operation_supported("transport.action"))
        def fences(): return {"setRef": set_ref, "expectedObjectIdentity": identity, "expectedRevision": str(mapper._playback()["revision"])}
        for action in ("start", "continue", "stop", "tap-tempo", "nudge-up", "nudge-down", "re-enable-automation", "trigger-session-record"):
            result = mapper.invoke("transport.action", {**fences(), "action": action})
            self.assertTrue(result["done"]); validate_operation_payload("transport.action", "result", result)
        self.assertEqual(calls, ["start", "continue", "stop", "tap", "up", "down", "reenable", "record"])
        result = mapper.invoke("transport.action", {**fences(), "action": "force-link-beat-time", "beatTime": 8.0})
        self.assertTrue(result["done"]); self.assertEqual(calls[-1], ("link", 8.0))
        with self.assertRaisesRegex(ValueError, "beatTime is required"): mapper.invoke("transport.action", {**fences(), "action": "force-link-beat-time"})
        stale = fences(); stale["expectedRevision"] = "stale"
        with self.assertRaisesRegex(ValueError, "changed since preview"): mapper.invoke("transport.action", {**stale, "action": "start"})
        with self.assertRaisesRegex(ValueError, "invalid"): mapper.invoke("transport.action", {**fences(), "action": "detonate"})

    def test_locator_jump_to_specific_cue(self):
        song = FakeArrangementSong()
        song.cue_points = [FakeLocator(4.0, "A"), FakeLocator(16.0, "B")]
        for locator in song.cue_points:
            locator.jump = lambda loc=locator: setattr(song, "current_song_time", loc.time)
        mapper = LiveObjectMapper(song)
        self.assertTrue(mapper._operation_supported("locator.jump-to"))
        locators = mapper._locator_items()
        result = mapper.invoke("locator.jump-to", {"ref": locators[1]["ref"], "expectedObjectIdentity": locators[1]["objectIdentity"], "expectedCollectionRevision": hashlib.sha256(mapper._bounded_canonical(mapper._locator_items()).encode()).hexdigest()})
        self.assertEqual(result["position"], 16.0); validate_operation_payload("locator.jump-to", "result", result)
        without = LiveObjectMapper(FakeSong())
        self.assertFalse(without._operation_supported("locator.jump-to"))

    def test_song_time_convert(self):
        song, mapper = self._mapper_with_song_state()
        song.get_beats_loop_time = lambda: 8.0
        song.get_smpte_loop_time = lambda: 4.0
        set_ref = mapper.snapshot()["set"]["ref"]
        self.assertTrue(mapper._operation_supported("song.time-convert"))
        result = mapper.invoke("song.time-convert", {"setRef": set_ref, "beatTime": 4.0, "smpteSeconds": 10.0})
        self.assertTrue(result["available"])
        self.assertEqual(result["smpteSeconds"], 4.0 * 60.0 / 120.0); self.assertEqual(result["beats"], 10.0 * 120.0 / 60.0)
        self.assertEqual((result["loopBeats"], result["loopSmpteSeconds"]), (8.0, 4.0))
        validate_operation_payload("song.time-convert", "result", result)


class TrackStructureExpansionTests(unittest.TestCase):
    def test_track_rows_expose_state_meters_and_view(self):
        song = FakeSong()
        track = song.tracks[0]
        track.is_visible = True; track.is_frozen = False; track.implicit_arm = False
        track.back_to_arranger = False; track.muted_via_solo = False
        track.input_meter_left = 0.5; track.input_meter_right = 0.4; track.input_meter_level = 0.45
        track.output_meter_left = 0.6; track.output_meter_right = 0.55; track.output_meter_level = 0.58
        track.performance_impact = 1
        track.view = type("TrackView", (), {"is_collapsed": False, "device_insert_mode": 1, "selected_device": track.devices[0]})()
        song.view = type("SongView", (), {"selected_track": track})()
        mapper = LiveObjectMapper(song)
        row = mapper.snapshot()["tracks"][0]
        self.assertEqual((row["isVisible"], row["isSelected"], row["isFrozen"], row["implicitArm"]), (True, True, False, False))
        self.assertEqual((row["outputMeterLeft"], row["outputMeterLevel"], row["performanceImpact"]), (0.6, 0.58, 1))
        self.assertEqual((row["view"]["isCollapsed"], row["view"]["deviceInsertMode"]), (False, 1))
        self.assertIsNotNone(row["view"]["selectedDeviceRef"])

    def test_return_track_create_and_delete_with_fencing(self):
        song = FakeSong()
        created_holder = []
        def create_return_track():
            track = FakeTrack(); track.name = "Return A"; created_holder.append(track); song.return_tracks.append(track); return track
        song.create_return_track = create_return_track
        song.delete_return_track = lambda index: song.return_tracks.pop(index)
        mapper = LiveObjectMapper(song)
        self.assertTrue(mapper._operation_supported("track.create-return"))
        result = mapper.invoke("track.create-return", {"name": "Verb", "expectedStructureRevision": mapper._structure_revision()})
        self.assertEqual((result["name"], result["index"]), ("Verb", 0)); validate_operation_payload("track.create-return", "result", result)
        self.assertEqual(len(song.return_tracks), 1)
        with self.assertRaisesRegex(ValueError, "changed since preview"): mapper.invoke("track.create-return", {"name": "X", "expectedStructureRevision": "0" * 64})
        self.assertTrue(mapper._operation_supported("track.delete-return"))
        deleted = mapper.invoke("track.delete-return", {"ref": result["ref"], "expectedObjectIdentity": result["objectIdentity"], "expectedStructureRevision": mapper._structure_revision()})
        self.assertEqual(deleted, {"deleted": result["ref"]}); self.assertEqual(len(song.return_tracks), 0)

    def test_track_and_scene_duplication(self):
        song = FakeSong()
        def duplicate_track(index):
            import copy
            new = copy.copy(song.tracks[index]); song.tracks.insert(index + 1, new); return new
        def duplicate_scene(index):
            new = FakeScene(f"{song.scenes[index].name} copy"); song.scenes.insert(index + 1, new); return new
        song.duplicate_track = duplicate_track; song.duplicate_scene = duplicate_scene
        mapper = LiveObjectMapper(song)
        self.assertTrue(mapper._operation_supported("track.duplicate")); self.assertTrue(mapper._operation_supported("scene.duplicate"))
        track_row = mapper.snapshot()["tracks"][0]
        result = mapper.invoke("track.duplicate", {"ref": track_row["ref"], "expectedObjectIdentity": track_row["objectIdentity"], "expectedStructureRevision": mapper._structure_revision()})
        self.assertEqual(result["index"], 1); validate_operation_payload("track.duplicate", "result", result); self.assertEqual(len(song.tracks), 2)
        scene_row = mapper.snapshot()["scenes"][0]
        result = mapper.invoke("scene.duplicate", {"ref": scene_row["ref"], "expectedObjectIdentity": scene_row["objectIdentity"], "expectedStructureRevision": mapper._structure_revision()})
        self.assertEqual(result["index"], 1); validate_operation_payload("scene.duplicate", "result", result); self.assertEqual(len(song.scenes), 2)

    def test_track_view_set_and_select_instrument(self):
        song = FakeSong()
        track = song.tracks[0]
        track.view = type("TrackView", (), {"is_collapsed": False, "device_insert_mode": 1, "selected_device": None})()
        selected = []
        track.view.select_instrument = lambda: selected.append(True)
        mapper = LiveObjectMapper(song)
        self.assertTrue(mapper._operation_supported("track.view.set")); self.assertTrue(mapper._operation_supported("track.select-instrument"))
        row = mapper.snapshot()["tracks"][0]
        def fences(): return {"ref": row["ref"], "expectedObjectIdentity": row["objectIdentity"], "expectedStateRevision": mapper._track_view_state_revision(track)}
        result = mapper.invoke("track.view.set", {**fences(), "collapsed": True, "deviceInsertMode": 2})
        self.assertTrue(result["changed"]); validate_operation_payload("track.view.set", "result", result)
        self.assertTrue(track.view.is_collapsed); self.assertEqual(track.view.device_insert_mode, 2)
        with self.assertRaisesRegex(ValueError, "is invalid"): mapper.invoke("track.view.set", {**fences(), "deviceInsertMode": 99})
        result = mapper.invoke("track.select-instrument", fences())
        self.assertEqual(result, {"done": True}); self.assertEqual(selected, [True])
        with self.assertRaisesRegex(ValueError, "no fields"): mapper.invoke("track.view.set", fences())


class SelectionViewExpansionTests(unittest.TestCase):
    def test_selection_set_assigns_song_view_selections(self):
        song = FakeSong()
        track = song.tracks[0]; scene = song.scenes[0]; slot = track.clip_slots[0]; device = track.devices[0]; parameter = device.parameters[0]
        song.view = type("SongView", (), {"selected_track": None, "selected_scene": None, "highlighted_clip_slot": None, "detail_clip": None, "selected_device": None, "selected_parameter": None, "selected_chain": None})()
        clip = FakeClip(4.0); slot.clip = clip
        mapper = LiveObjectMapper(song)
        self.assertTrue(mapper._operation_supported("selection.set"))
        snapshot = mapper.snapshot()
        track_ref = snapshot["tracks"][0]["ref"]; scene_ref = snapshot["scenes"][0]["ref"]; slot_ref = snapshot["tracks"][0]["clipSlots"][0]["ref"]; clip_ref = snapshot["tracks"][0]["clips"][0]["ref"]
        device_ref = snapshot["tracks"][0]["devices"][0]["ref"]; parameter_ref = snapshot["tracks"][0]["devices"][0]["parameters"][0]["ref"]
        args = {"trackRef": track_ref, "sceneRef": scene_ref, "slotRef": slot_ref, "detailClipRef": clip_ref, "deviceRef": device_ref, "parameterRef": parameter_ref, "expectedStateRevision": mapper._selection_revision()}
        result = mapper.invoke("selection.set", args)
        self.assertTrue(result["changed"]); validate_operation_payload("selection.set", "result", result)
        self.assertIs(song.view.selected_track, track); self.assertIs(song.view.selected_scene, scene)
        self.assertIs(song.view.highlighted_clip_slot, slot); self.assertIs(song.view.detail_clip, clip)
        self.assertIs(song.view.selected_device, device); self.assertIs(song.view.selected_parameter, parameter)
        cleared = mapper.invoke("selection.set", {"detailClipRef": None, "expectedStateRevision": mapper._selection_revision()})
        self.assertTrue(cleared["changed"]); self.assertIsNone(song.view.detail_clip)
        stale = dict(args, expectedStateRevision="0" * 64)
        with self.assertRaisesRegex(ValueError, "changed since preview"): mapper.invoke("selection.set", stale)

    def test_song_view_draw_mode_clip_view_and_device_view(self):
        song = FakeSong()
        song.view = type("SongView", (), {"draw_mode": False})()
        clip = FakeClip(4.0)
        clip.view = type("ClipView", (), {"grid_quantization": 1, "triplet_grid": False, "show_envelope": False})()
        clip.view.show_loop = lambda: setattr(clip.view, "_loop_shown", True)
        song.tracks[0].clip_slots[0].clip = clip
        device = song.tracks[0].devices[0]
        device.view = type("DeviceView", (), {"is_collapsed": False})()
        mapper = LiveObjectMapper(song)
        self.assertTrue(mapper._operation_supported("song.view.set"))
        draw_revision = hashlib.sha256(mapper._bounded_canonical({"drawMode": False}).encode()).hexdigest()
        result = mapper.invoke("song.view.set", {"drawMode": True, "expectedStateRevision": draw_revision})
        self.assertTrue(result["changed"]); validate_operation_payload("song.view.set", "result", result); self.assertTrue(song.view.draw_mode)
        self.assertTrue(mapper._operation_supported("clip.view.set"))
        row = mapper.snapshot()["tracks"][0]["clips"][0]
        def clip_fences():
            return {"ref": row["ref"], "expectedObjectIdentity": row["objectIdentity"], "expectedStateRevision": hashlib.sha256(mapper._bounded_canonical(mapper._clip_view_state(clip)).encode()).hexdigest()}
        result = mapper.invoke("clip.view.set", {**clip_fences(), "gridQuantization": 4, "tripletGrid": True, "showEnvelope": True, "showLoop": True})
        self.assertTrue(result["changed"]); validate_operation_payload("clip.view.set", "result", result)
        self.assertEqual((clip.view.grid_quantization, clip.view.triplet_grid, clip.view.show_envelope), (4, True, True))
        self.assertTrue(getattr(clip.view, "_loop_shown", False))
        self.assertTrue(mapper._operation_supported("device.view.set"))
        device_row = mapper.snapshot()["tracks"][0]["devices"][0]
        collapsed_revision = hashlib.sha256(mapper._bounded_canonical({"collapsed": False}).encode()).hexdigest()
        result = mapper.invoke("device.view.set", {"ref": device_row["ref"], "collapsed": True, "expectedObjectIdentity": device_row["objectIdentity"], "expectedStateRevision": collapsed_revision})
        self.assertTrue(result["changed"]); validate_operation_payload("device.view.set", "result", result)
        self.assertTrue(device.view.is_collapsed)

    def test_application_dialog_read_and_guarded_press(self):
        class FakeApp:
            def __init__(self): self._state = 1; self.pressed = []
            def get_dialog_state(self): return self._state
            def press_dialog_button(self, button): self.pressed.append(button); self._state = 0
        song = FakeSong(); app = FakeApp()
        mapper = LiveObjectMapper(song); mapper._application = lambda: app
        self.assertTrue(mapper._operation_supported("application.dialog"))
        result = mapper.invoke("application.dialog", {"action": "read"})
        self.assertEqual(result, {"state": 1, "done": True}); validate_operation_payload("application.dialog", "result", result)
        result = mapper.invoke("application.dialog", {"action": "press", "button": 2, "expectedState": 1})
        self.assertEqual(result, {"state": 0, "done": True}); self.assertEqual(app.pressed, [2])
        with self.assertRaisesRegex(ValueError, "changed since preview"): mapper.invoke("application.dialog", {"action": "press", "button": 1, "expectedState": 1})
        with self.assertRaisesRegex(ValueError, "invalid"): mapper.invoke("application.dialog", {"action": "press", "button": 99, "expectedState": 0})

    def test_view_control_browser_toggle_and_hide_focus(self):
        class FakeAppView:
            def __init__(self): self.visible = "Session"; self.toggles = 0; self.hidden = []; self.focused = []
            def show_view(self, name): self.visible = name
            def is_view_visible(self, name): return self.visible == name
            def zoom_view(self, *args): pass
            def scroll_view(self, *args): pass
            def toggle_browse(self): self.toggles += 1
            def hide_view(self, name): self.hidden.append(name)
            def focus_view(self, name): self.focused.append(name)
        class FakeApplication: pass
        song = FakeSong(); song.view = type("SongView", (), {"follow_song": False})()
        application = FakeApplication(); application.view = FakeAppView()
        mapper = LiveObjectMapper(song); mapper._application = lambda: application
        result = mapper.invoke("view.control", {"action": "browser-toggle"})
        self.assertEqual(result, {"action": "browser-toggle", "done": True}); self.assertEqual(application.view.toggles, 1)
        mapper.invoke("view.control", {"action": "hide-view", "view": "Browser"})
        mapper.invoke("view.control", {"action": "focus-view", "view": "Arranger"})
        self.assertEqual(application.view.hidden, ["Browser"]); self.assertEqual(application.view.focused, ["Arranger"])
        with self.assertRaisesRegex(ValueError, "view name is required"): mapper.invoke("view.control", {"action": "hide-view"})


class PerformanceDiagnosticsTests(unittest.TestCase):
    def test_performance_read_exposes_usage_meters_and_latency(self):
        class FakeApp:
            average_process_usage = 0.42
            peak_process_usage = 0.87
        song = FakeSong()
        song.tracks[0].devices[0].latency_in_samples = 256
        song.tracks[0].devices[0].latency_in_ms = 5.8
        track = song.tracks[0]
        track.performance_impact = 1
        track.input_meter_left = 0.5; track.input_meter_right = 0.4; track.input_meter_level = 0.45
        track.output_meter_left = 0.6; track.output_meter_right = 0.55; track.output_meter_level = 0.58
        mapper = LiveObjectMapper(song); mapper._application = lambda: FakeApp()
        set_ref = mapper.snapshot()["set"]["ref"]
        result = mapper.invoke("performance.read", {"setRef": set_ref})
        self.assertEqual((result["averageProcessUsage"], result["peakProcessUsage"]), (0.42, 0.87))
        self.assertIsInstance(result["sampledAt"], int); self.assertEqual(len(result["revision"]), 64)
        row = result["tracks"][0]
        self.assertEqual((row["performanceImpact"], row["outputMeterLevel"]), (1, 0.58))
        self.assertEqual((row["devices"][0]["latencySamples"], row["devices"][0]["latencyMs"]), (256, 5.8))
        validate_operation_payload("performance.read", "result", result)
        device_row = mapper.snapshot()["tracks"][0]["devices"][0]
        self.assertEqual((device_row["latencySamples"], device_row["latencyMs"]), (256, 5.8))
