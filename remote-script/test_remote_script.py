import os
import unittest
from pathlib import Path
from unittest.mock import patch

from ableton_mcp_remote_script import (
    AbletonMcpBridge,
    AuthenticatedRemoteScript,
    LiveObjectMapper, operation_registry,
    PROTOCOL,
    create_instance,
)
from AbletonMcpBridge import _owner_controlled


class RemoteScriptTests(unittest.TestCase):
    def test_security_sensitive_files_require_current_owner(self):
        path = Path(__file__).resolve()
        self.assertTrue(_owner_controlled(path))
        if os.name == "nt":
            with patch("AbletonMcpBridge._windows_owner_controlled", return_value=False):
                self.assertFalse(_owner_controlled(path))
        else:
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
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: {"method": method})
        unsigned = {"version": PROTOCOL, "id": "one", "method": "status", "nonce": "0000000000000001", "sequence": 1}
        request = {**unsigned, "mac": remote.sign(unsigned)}
        self.assertTrue(remote.dispatch(request)["ok"])
        self.assertFalse(remote.dispatch(request)["ok"])

    def test_sequence_must_be_positive_and_safe(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: method)
        for sequence in (0, -1, 2**53, 2**53 + 1):
            unsigned = {"version": PROTOCOL, "id": "sequence", "method": "status", "nonce": "sequence-nonce-0001", "sequence": sequence}
            self.assertFalse(remote.dispatch({**unsigned, "mac": remote.sign(unsigned)})["ok"])

    def test_operation_failures_are_wire_errors(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: (_ for _ in ()).throw(RuntimeError("not available")))
        unsigned = {"version": PROTOCOL, "id": "one", "method": "snapshot", "nonce": "0000000000000001", "sequence": 1}
        result = remote.dispatch({**unsigned, "mac": remote.sign(unsigned)})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "request failed")

    def test_random_ordered_nonces_and_unknown_fields(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: method)
        first = {"version": PROTOCOL, "id": "one", "method": "status", "nonce": "zzzzzzzzzzzzzzzz1", "sequence": 1}
        second = {"version": PROTOCOL, "id": "two", "method": "status", "nonce": "aaaaaaaaaaaaaaaa2", "sequence": 2}
        self.assertTrue(remote.dispatch({**first, "mac": remote.sign(first)})["ok"])
        self.assertTrue(remote.dispatch({**second, "mac": remote.sign(second)})["ok"])
        extra = {**second, "id": "three", "nonce": "bbbbbbbbbbbbbbbb3", "unexpected": True}
        self.assertFalse(remote.dispatch({**extra, "mac": remote.sign(extra)})["ok"])

    def test_unknown_method_is_rejected_before_operation(self):
        called = []
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: called.append(method))
        request = {"version": PROTOCOL, "id": "one", "method": "delete", "nonce": "cccccccccccccccc4", "sequence": 1}
        self.assertFalse(remote.dispatch({**request, "mac": remote.sign(request)})["ok"])
        self.assertEqual(called, [])

    def test_malformed_requests_are_wire_errors_and_nonces_are_bounded(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: method)
        self.assertFalse(remote.dispatch(None)["ok"])
        unsigned = {"version": PROTOCOL, "id": "large", "method": "status", "nonce": "x" * 257, "sequence": 1}
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
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: calls.append((method, request["operation"])) or {"accepted": True})
        unsigned = {"version": PROTOCOL, "id": "invoke", "method": "invoke", "operation": "browser.search", "args": {"query": "utility"}, "nonce": "invoke-nonce-0001", "sequence": 1}
        result = remote.dispatch({**unsigned, "mac": remote.sign(unsigned)})
        self.assertTrue(result["ok"])
        self.assertEqual(calls, [("invoke", "browser.search")])

    def test_invoke_rejects_unbounded_or_malformed_arguments(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: method)
        unsigned = {"version": PROTOCOL, "id": "invoke", "method": "invoke", "operation": "invalid", "args": {}, "nonce": "invoke-nonce-0002", "sequence": 1}
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
        self.scenes = [FakeScene()]

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
        self.assertEqual(len(digest), 64)
        self.assertIn("device.parameter.set", [item["id"] for item in registry["operations"]])

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
        device = mapper.discover("device")["items"][0]
        parameter = mapper.discover("parameter")["items"][0]
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
        page = mapper.discover("note", 1)
        self.assertEqual(len(page["items"]), 1)
        mapper.invoke("session.reconnect", {})
        with self.assertRaises(ValueError):
            mapper.discover("note", 1, page.get("nextCursor", "invalid"))

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
