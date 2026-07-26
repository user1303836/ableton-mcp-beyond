# AbletonMcpBridge Remote Script

This directory contains a dependency-light Control Surface package and its
transport implementation. Live loads `AbletonMcpBridge/__init__.py` and calls
`create_instance(c_instance)`. The entrypoint reads an explicit owner-only
configuration reference from `AbletonMcpBridge/bridge-reference.json`, whose
only field is an absolute path to a separate owner-only bridge configuration.
It does not use environment variables or command-line secrets; missing,
malformed, symlinked, non-loopback, or weak-secret configuration fails closed.

The bridge uses the authenticated `ableton-loopback/v1` wire contract with
HMAC-SHA256, canonical JSON, bounded frames and collections, positive safe
sequences, replay rejection, and redacted errors. Socket workers only frame,
authenticate, sequence, and enqueue. `update_display` or the scheduled
Control Surface callback drains Live-facing work on the main thread.

The mapper supports status, bounded track/scene/clip/note/locator discovery,
Session MIDI clip/note operations, bounded track/scene creation and deletion,
reconnect epoch invalidation, and Arrangement locator operations when the Live
object exposes cue points and `set_or_delete_cue`. Unsupported shapes are
unavailable, not fabricated. Discovery is not a complete Live object graph and
does not imply support for devices, routing, recording, or other unimplemented
domains.

Run contract tests from the repository root:

```sh
python3 -m unittest discover -s remote-script -p 'test_*.py'
```

These tests and fake-Live objects do not prove a real Ableton Live version,
Control Surface installation, or visible Set behavior.
