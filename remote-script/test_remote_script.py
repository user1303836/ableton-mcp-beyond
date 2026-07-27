import base64
import hashlib
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from ableton_mcp_remote_script import (
    AbletonMcpBridge,
    AuthenticatedRemoteScript,
    LiveObjectMapper, _MainThreadQueue, operation_registry,
    PROTOCOL,
    create_instance,
)
from AbletonMcpBridge import _owner_controlled, _normalize_bridge_config


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

    def test_version_one_shape_passes_through_and_others_fail(self):
        self.assertEqual(_normalize_bridge_config({"version": 1, "host": "::1", "port": 9765, "secretFile": "/tmp/s"}), {"version": 1, "host": "::1", "port": 9765, "secretFile": "/tmp/s"})
        with self.assertRaises(ValueError):
            _normalize_bridge_config({"version": 1, "host": "127.0.0.1", "port": 9765, "secretFile": "/tmp/s", "timeoutMs": 5000})
        with self.assertRaises(ValueError):
            _normalize_bridge_config("not-a-dict")


def fake_status_result():
    return {"connected": False, "adapter": "unavailable", "epoch": None, "protocol": "ableton-live/v1", "registryHash": operation_registry()[1], "operations": ["status", "snapshot", "discover", "get", "set", "reconnect", "session.playback"], "capabilities": []}


class RemoteScriptTests(unittest.TestCase):
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
        first = AuthenticatedRemoteScript(secret, lambda method, request: {"connected": False, "adapter": "unavailable", "epoch": None, "protocol": "ableton-live/v1", "registryHash": operation_registry()[1], "operations": ["status", "snapshot", "discover", "get", "set", "reconnect", "session.playback"]}, "bridge-epoch-0000000000000001", "connection-one-0000000000001")
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

    def test_random_ordered_nonces_and_unknown_fields(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: fake_status_result())
        first = remote.bound({"version": PROTOCOL, "id": "one", "method": "status", "nonce": "zzzzzzzzzzzzzzzz1", "sequence": 1})
        second = remote.bound({"version": PROTOCOL, "id": "two", "method": "status", "nonce": "aaaaaaaaaaaaaaaa2", "sequence": 2})
        self.assertTrue(remote.dispatch({**first, "mac": remote.sign(first)})["ok"])
        self.assertTrue(remote.dispatch({**second, "mac": remote.sign(second)})["ok"])
        extra = {**second, "id": "three", "nonce": "bbbbbbbbbbbbbbbb3", "unexpected": True}
        self.assertFalse(remote.dispatch({**extra, "mac": remote.sign(extra)})["ok"])

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

    def test_invoke_forwards_domain_operations_with_bounded_args(self):
        calls = []
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: calls.append((method, request["operation"])) or {"stopped": True, "stoppedTargets": []})
        unsigned = remote.bound({"version": PROTOCOL, "id": "invoke", "method": "invoke", "operation": "session.emergency-stop", "args": {"expectedTargets": []}, "nonce": "invoke-nonce-0001", "sequence": 1})
        result = remote.dispatch({**unsigned, "mac": remote.sign(unsigned)})
        self.assertTrue(result["ok"])
        self.assertEqual(calls, [("invoke", "session.emergency-stop")])

    def test_invoke_rejects_unbounded_or_malformed_arguments(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: method)
        unsigned = remote.bound({"version": PROTOCOL, "id": "invoke", "method": "invoke", "operation": "invalid", "args": {}, "nonce": "invoke-nonce-0002", "sequence": 1})
        self.assertFalse(remote.dispatch({**unsigned, "mac": remote.sign(unsigned)})["ok"])


class FakeClip:
    def __init__(self, length):
        self.length = length
        self.name = ""
        self.notes = []

    def add_new_notes(self, notes):
        self.notes.extend(notes)

    def get_notes(self, *_):
        return list(self.notes)


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

    def delete_track(self, track):
        self.tracks.remove(track)

    def delete_scene(self, scene):
        self.scenes.remove(scene)


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
        self.assertEqual(digest, "006104fd05c0c2eed6dc790ee2215a9e2154fa0a8f0a6f081b53cca4829f108d")
        self.assertIn("device.parameter.set", [item["id"] for item in registry["operations"]])
        self.assertNotIn("scene.launch", [item["id"] for item in registry["operations"]])

    def test_provenance_is_explicit_and_fake_is_the_direct_default(self):
        self.assertEqual(LiveObjectMapper(FakeSong()).status()["provenance"], "fake-live")
        self.assertEqual(LiveObjectMapper(FakeSong(), provenance="real-live").status()["provenance"], "real-live")
        with self.assertRaises(ValueError): LiveObjectMapper(FakeSong(), provenance="unknown")
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

    def test_device_parameter_discovery_and_guarded_mutation(self):
        mapper = LiveObjectMapper(FakeSong())
        track = mapper.discover("track")["items"][0]
        device = mapper.discover("device", parent=track["ref"])["items"][0]
        parameter = mapper.discover("parameter", parent=device["ref"])["items"][0]
        self.assertEqual(parameter["parentRef"], device["ref"])
        self.assertEqual(parameter["revision"], 1)
        changed = mapper.invoke("device.parameter.set", {"ref": parameter["ref"], "value": 0.75})
        self.assertEqual(changed["value"], 0.75)
        self.assertEqual(changed["revision"], 2)
        with self.assertRaises(ValueError):
            mapper.invoke("device.parameter.set", {"ref": parameter["ref"], "value": 0.7})

    def test_session_structure_lifecycle_and_empty_slots_are_authoritative(self):
        mapper = LiveObjectMapper(FakeSong())
        track = mapper.discover("track")["items"][0]
        self.assertTrue(track["clipSlots"][0]["empty"])
        created_track = mapper.invoke("track.create", {"name": "Strings", "kind": "midi", "index": 1})
        created_scene = mapper.invoke("scene.create", {"name": "Verse", "index": 1})
        self.assertEqual(created_track["name"], "Strings")
        self.assertEqual(created_scene["name"], "Verse")
        self.assertEqual(mapper.invoke("track.delete", {"ref": created_track["ref"]}), {"deleted": created_track["ref"]})
        self.assertEqual(mapper.invoke("scene.delete", {"ref": created_scene["ref"]}), {"deleted": created_scene["ref"]})

    def test_structure_operations_fail_closed_when_live_shape_is_unsupported(self):
        class UnsupportedSong:
            tracks = []
            scenes = []
        mapper = LiveObjectMapper(UnsupportedSong())
        with self.assertRaises(ValueError):
            mapper.invoke("track.create", {"name": "Nope", "kind": "midi", "index": 0})

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
        stop_args = {"ref": launch["ref"], "setName": launch["setName"], "eligibleTargets": launch["eligibleTargets"]}
        with self.assertRaises(ValueError):
            mapper.invoke("session.audition-stop", {**stop_args, "setName": "Other Set"})
        self.assertTrue(mapper.song.is_playing)
        self.assertEqual(mapper.invoke("session.audition-stop", stop_args), {"stopped": True})
        self.assertFalse(mapper.song.is_playing)
        self.assertEqual(mapper.song.stopped_all, 1)
        # Stopping again with no active playback is an idempotent no-op.
        self.assertEqual(mapper.invoke("session.audition-stop", stop_args), {"stopped": True})
        # External playback outside the owned target set refuses the owned stop.
        mapper.invoke("session.audition-launch", launch)
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
            mapper.invoke("session.emergency-stop", {"expectedTargets": []})
        self.assertTrue(mapper.song.is_playing)
        result = mapper.invoke("session.emergency-stop", {"expectedTargets": launch["eligibleTargets"]})
        self.assertEqual(result["stopped"], True)
        self.assertEqual(result["stoppedTargets"], launch["eligibleTargets"])
        self.assertFalse(mapper.song.is_playing)
        # An empty observation is exact when nothing is playing.
        self.assertEqual(mapper.invoke("session.emergency-stop", {"expectedTargets": []})["stopped"], True)

    def test_generic_audible_operations_are_not_mapper_capabilities(self):
        mapper = LiveObjectMapper(FakeAuditionSong())
        for operation in ("scene.launch", "stop-all-clips", "transport.stop"):
            with self.assertRaises(ValueError):
                mapper.invoke(operation, {})

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
        created = mapper.invoke("arrangement.locator.create", {"name": "Verse", "position": 8})
        self.assertEqual(created["name"], "Verse")
        self.assertEqual(mapper.discover("locator")["items"][-1]["position"], 8)
        self.assertEqual(mapper.invoke("arrangement.locator.delete", {"ref": created["ref"]}), {"deleted": created["ref"]})
        self.assertEqual([item["name"] for item in mapper.discover("locator")["items"]], ["Intro"])

    def test_arrangement_locator_rejects_collisions_and_unsupported_shapes(self):
        mapper = LiveObjectMapper(FakeArrangementSong())
        with self.assertRaises(ValueError):
            mapper.invoke("arrangement.locator.create", {"name": "Other", "position": 0})
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

    def test_mapper_get_and_set_support_remote_verification(self):
        mapper = LiveObjectMapper(FakeSong())
        track_ref = mapper.discover("track")["items"][0]["ref"]
        self.assertEqual(mapper.get(track_ref)["name"], "Drums")
        mapper.set(track_ref, "name", "Percussion")
        self.assertEqual(mapper.get(track_ref)["name"], "Percussion")

    def test_mapper_discovery_and_midi_lifecycle_use_fake_live_objects(self):
        mapper = LiveObjectMapper(FakeSong())
        status = mapper.status()
        self.assertTrue(status["connected"])
        self.assertIn("session.midi_clip.create", status["capabilities"])
        track = mapper.discover("track")["items"][0]["ref"]
        created = mapper.invoke("clip.create", {"trackRef": track, "sceneIndex": 0, "name": "Four bars", "length": 16})
        self.assertEqual(created["name"], "Four bars")
        mapper.invoke("note.add", {"ref": created["ref"], "note": {"pitch": 36, "start": 0, "duration": 0.25, "velocity": 110, "channel": 1}})
        clip = mapper.refs.get(created["ref"])
        self.assertEqual(clip.get_notes(0, 0, 0, 128)[0]["pitch"], 36)
        self.assertEqual(mapper.invoke("clip.delete", {"ref": created["ref"]}), {"deleted": created["ref"]})

    def test_mapper_clip_creation_uses_session_slot_index(self):
        mapper = LiveObjectMapper(FakeSong())
        track = mapper.discover("track")["items"][0]["ref"]
        created = mapper.invoke("clip.create", {"trackRef": track, "sceneIndex": 0, "name": "Session slot", "length": 16})
        self.assertEqual(mapper.refs.get(created["ref"]).length, 16)

    def test_mapper_rejects_unsafe_clip_and_note_mutations(self):
        mapper = LiveObjectMapper(FakeSong())
        track = mapper.discover("track")["items"][0]["ref"]
        with self.assertRaises(ValueError):
            mapper.invoke("clip.create", {"trackRef": track, "sceneIndex": 0, "name": "bad", "length": float("nan")})
        created = mapper.invoke("clip.create", {"trackRef": track, "sceneIndex": 0, "name": "bounded", "length": 4})
        with self.assertRaises(ValueError):
            mapper.invoke("note.add", {"ref": created["ref"], "note": {"pitch": 36, "start": 3.5, "duration": 1, "velocity": 100, "channel": 1}})

    def test_discovery_pages_notes_and_rejects_stale_cursor(self):
        mapper = LiveObjectMapper(FakeSong())
        track = mapper.discover("track")["items"][0]["ref"]
        created = mapper.invoke("clip.create", {"trackRef": track, "sceneIndex": 0, "name": "Paged", "length": 16})
        mapper.invoke("note.add", {"ref": created["ref"], "note": {"pitch": 36, "start": 0, "duration": 0.25, "velocity": 100, "channel": 1}})
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
                self.parameters = {}
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
            for capability in ("max", "osc", "realtime.events"):
                self.assertIn(capability, status["capabilities"])
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
            parameter = bridge.mapper._resolve_parameter(parameter_ref)
            holder = {}
            arm_request = {"operation": "realtime.arm", "args": {"ttlMs": 30000, "channels": ["udp-json"], "parameterRefs": [parameter_ref]}}
            armed = bridge._dispatch_with_holder("invoke", arm_request, holder)
            for sequence in (1, 2):
                bridge._realtime._handle(self._json(token=armed["token"], seq=sequence, channel="udp-json", op="parameter.set", ref=parameter_ref, value=0.75))
            self.assertEqual(bridge.queue.items.qsize(), 2)
            self.assertEqual(bridge._dispatch_with_holder("invoke", {"operation": "realtime.disarm", "args": {}}, holder), {"armed": False})

            armed = bridge._dispatch_with_holder("invoke", arm_request, holder)
            for sequence in (1, 2):
                bridge._realtime._handle(self._json(token=armed["token"], seq=sequence, channel="udp-json", op="parameter.set", ref=parameter_ref, value=1.0))
            self.assertEqual(bridge.queue.items.qsize(), 4)
            bridge._dispatch_with_holder("invoke", arm_request, holder)
            self.assertEqual(bridge.queue.drain(), 4)
            self.assertEqual(parameter.value, 0.5)
            stats = bridge._realtime.stats()
            self.assertEqual(stats["applied"], 0)
            self.assertEqual(stats["revokedBeforeApply"], 4)
            self.assertEqual(stats["applyFailures"], 4)
            self.assertEqual(stats["pending"], 0)
        finally:
            bridge.disconnect()

    def test_arm_bounds_endpoint_channel_and_drop_accounting(self):
        plane = self._plane()
        try:
            with self.assertRaises(ValueError):
                plane.arm(500, ["udp-json"], ["p"])
            with self.assertRaises(ValueError):
                plane.arm(30000, ["udp-json", "udp-json"], ["p"])
            armed = plane.arm(30000, ["udp-json", "xy"], ["p", "x", "y"], [41000])
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
            armed = plane.arm(30000, ["osc", "max", "xy"], ["p", "x", "y"])
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

    def test_disarm_expiry_and_rearm_fence_accepted_callbacks(self):
        plane = self._plane()
        try:
            queue = plane._bridge.queue
            queue.defer = True
            armed = plane.arm(30000, ["udp-json"], ["p"])
            plane._handle(self._json(token=armed["token"], seq=1, channel="udp-json", op="parameter.set", ref="p", value=0.75))
            self.assertEqual(plane.stats()["accepted"], 1)
            self.assertEqual(plane.stats()["pending"], 1)
            plane.disarm()
            with self.assertRaises(ValueError):
                queue.calls.pop(0)()
            self.assertNotIn("p", plane._bridge.mapper.parameters)

            expired = plane.arm(30000, ["udp-json"], ["p"])
            plane._handle(self._json(token=expired["token"], seq=1, channel="udp-json", op="parameter.set", ref="p", value=0.5))
            with plane._lock:
                token, _, channels, ports, parameters = plane._armed
                plane._armed = (token, time.time() - 1, channels, ports, parameters)
            with self.assertRaises(ValueError):
                queue.calls.pop(0)()

            old = plane.arm(30000, ["udp-json"], ["p"])
            plane._handle(self._json(token=old["token"], seq=1, channel="udp-json", op="parameter.set", ref="p", value=0.4))
            plane.arm(30000, ["udp-json"], ["p"])
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
            armed = plane.arm(30000, ["udp-json"], ["p"], [sender.getsockname()[1]])
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
            armed = plane.arm(30000, ["udp-json"], ["p"])
            for seq in range(1, 41):
                plane._handle(self._json(token=armed["token"], seq=seq, channel="udp-json", op="parameter.set", ref="p", value=0.5))
            stats = plane.stats()
            self.assertGreater(stats["droppedRateLimited"], 0)
            self.assertLess(stats["accepted"], 40)
            self.assertEqual(stats["sequenceGaps"], 0)
            self.assertEqual(stats["lastSequence"], 40)
        finally:
            plane.close()
