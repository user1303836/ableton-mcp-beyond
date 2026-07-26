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

The mapper supports status, shape-dependent operation advertisement, bounded
hierarchical discovery, Session MIDI clip/note operations, bounded
track/scene creation and deletion, reconnect epoch invalidation, and
Arrangement locator operations when the Live object exposes cue points and
`set_or_delete_cue`. Discovery can represent the song, regular/group/return/
main tracks, scenes, empty clip slots, Session clips, Arrangement clips,
notes, locators, devices, parameters, selection, routing choices, and Session
playback. Parent references, filters, requested fields, traversal budgets, and
opaque epoch-bound cursors are bounded and validated. When the observed shape
exposes them, the mapper can invoke scene launch, stop-all-clips, and
transport-stop; unsupported shapes are unavailable, not fabricated. Discovery
is not a complete Live object graph and does not imply support for routing
mutation, recording, or general clip-launch workflows.

It also loads and hashes the canonical operation registry, advertises only
supported operations, and provides bounded device/parameter discovery plus
guarded writes to enabled, automatable, bounded, quantized numeric parameters.

Run contract tests from the repository root:

```sh
python3 -m unittest discover -s remote-script -p 'test_*.py'
```

These tests and fake-Live objects do not prove a real Ableton Live version,
Control Surface installation, or visible Set behavior.
