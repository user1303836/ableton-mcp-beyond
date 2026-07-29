# AbletonMcpBridge Remote Script

This directory contains a dependency-light Control Surface package and its
transport implementation. Live loads `AbletonMcpBridge/__init__.py` and calls
`create_instance(c_instance)`. The entrypoint reads an explicit owner-only
configuration reference from `AbletonMcpBridge/bridge-reference.json`, whose
only field is an absolute path to a separate owner-only bridge configuration.
It does not use environment variables or command-line secrets; missing,
malformed, symlinked, non-loopback, or weak-secret configuration fails closed.

Remote Script file diagnostics are absent and disabled by default. The supported
opt-in is lifecycle provisioning with `--enable-bridge-diagnostics`, which adds
an absolute owner-only, single-link regular file under the lifecycle state
directory to the owner-only configuration. Creating the former predictable
`/tmp/ableton-mcp-bridge-debug.log` path has no effect. Callers enqueue only
fixed event and coarse error-category codes into a nonblocking 64-record queue;
a daemon writer emits records of at most 512 bytes and resets the owner file
before it can exceed 256 KiB. It never writes exception messages, tracebacks,
requests, names, queries, secrets, tokens, MACs, PCM, or media paths. Queue
saturation drops events, and descriptor/path drift or any write failure disables
the sink without changing bridge behavior.

The bridge uses the authenticated `ableton-loopback/v1` wire contract with
HMAC-SHA256, canonical JSON, bounded frames and collections, positive safe
sequences, replay rejection, and redacted errors. An authenticated server
hello binds every frame to a bridge authentication epoch and one connection
challenge, so captured frames cannot cross connections or bridge restarts.
Absolute deadlines fence queued callbacks; a timed-out queued callback is
cancelled and skipped by the main-thread drain, while a callback already
claimed by Live is reported as uncertain. Socket workers only frame,
authenticate, sequence, and enqueue. `update_display` or the scheduled
Control Surface callback drains Live-facing work on the main thread.

The mapper supports status, shape-dependent operation advertisement, bounded
hierarchical discovery, Session MIDI clip/note operations, bounded
track/scene creation and deletion, reconnect epoch invalidation, and
Arrangement locator operations when the Live object exposes cue points and
`set_or_delete_cue`. Discovery can represent the song, regular/group/return/
main tracks, scenes, empty clip slots, Session clips, Arrangement clips,
notes, locators, devices, parameters, selection, routing choices, and Session
playback through one canonical top-level payload. Playback targets contain
exact track, scene, clip-slot, scene-index, and nullable clip references derived
from authoritative track slot indexes. Unknown arm, monitoring, transport, or
quantization values remain null rather than becoming safe defaults. Parent references, filters, requested fields, traversal budgets, and
opaque epoch-bound cursors are bounded and validated. Generic audible
invocation is not a production capability: the wire exposes one purpose-specific
guarded audition launch, one owned audition stop, and one separately authorized
emergency stop. Each rechecks Set identity, scene identity, playback revision,
recording state, arm/monitoring state, quantization, existing playback, and
target eligibility atomically on Live's main thread immediately before firing,
and verifies fresh authoritative state after acting. Purpose-specific guarded
operations also cover individual clip launch/track stop, transport, bounded
recording, routing, mixer, Session clip automation, devices, Browser loading,
Arrangement clips, project-path discovery, and authenticated subscriptions
when the observed Live shape supports them. Unsupported shapes remain
unavailable rather than fabricated.

Direct/package construction reports `fake-live`; only the installed Control
Surface wrapper supplies `real-live` provenance, which still requires external
visible evidence before it counts as a real-Live test.

It also loads and hashes the canonical operation registry, validates request
and result payloads at runtime, advertises only supported operations, and provides bounded device/parameter discovery plus
guarded writes to enabled, automatable, bounded, quantized numeric parameters.

An optional distinct `realtimePort` enables a second loopback-only UDP socket.
It grants no standing authority: an authenticated `realtime.arm` request must
select UDP JSON, OSC, XY, and/or Max-compatible channels plus an exact
published-parameter allowlist for at most 30 seconds, optionally restrict
sender ports, and receive an unpredictable bearer token.
The ingress enforces 512-byte packets, a 64/s token bucket with burst 16,
positive safe sequences, replay and endpoint rejection, bounded nonblocking
main-thread queueing, generation fencing on disarm/re-arm/expiry, verified
published-parameter and compensated XY writes, jitter/loss/drop counters, and
an emergency stop. See `docs/REALTIME_CONTROL.md` in the repository; no `.amxd`
device is claimed or bundled.

The mapper also conditionally advertises `audio.capture.resampling` and six
purpose-specific `audio.capture.*` operations when the Live shape exposes the
required Session clip-slot, Resampling routing, arm/monitoring, transport,
recording, file-path, and clip deletion APIs. Start atomically rechecks one
exact source and different empty audio destination, snapshots restorable state,
sets Resampling, briefly uses immediate launch quantization, and starts both
slots. A hard ten-second watchdog, explicit stop, emergency stop, and bridge
disconnect independently stop playback/recording and restore owned state.
The authenticated mapper status includes recovery authority and the raw media
path for the host; the public MCP status tool redacts those two sensitive
fields while retaining bounded clip reference/name/length availability
metadata. Acquire returns
path and identity only across that authenticated host boundary. Host-side code separately validates and analyzes WAV/ASD media, then performs
descriptor-fenced quarantine/unlink before cleanup deletes only the exact owned
clip and moves mapper state to `cleaned`. Unsupported or externally changed state is
reported as residual rather than overwritten. See `docs/AUDIO_INTELLIGENCE.md`.

Run contract tests from the repository root:

```sh
python3 -m unittest discover -s remote-script -p 'test_*.py'
```

These tests and fake-Live objects do not prove a real Ableton Live version,
Control Surface installation, or visible Set behavior.
