# Ableton Live safety

The default adapter is `UnavailableLiveAdapter`. It reports disconnected,
performs no Live I/O, and cannot be enabled by caller metadata, JSON-RPC
arguments, a local Ableton installation, or a simulator result.

## Mutation boundary

The implemented mutation workflows are Session-structure track/scene
creation, Session MIDI clip/note creation, Arrangement locator creation, tempo
change, and guarded undo. Each requires a
connected adapter, negotiated operation capability, bounded validated input,
preview, explicit confirmation, idempotency, epoch checks, and authoritative
postcondition verification. Arrangement partial creation compensates only
locators created by the current request.

`live_snapshot`, `live_discover`, previews, status, capability reads, and
`audio_analyze` are read-only. Session-structure apply creates only the named
tracks and scenes in its bounded request; it does not alter clips, devices,
routing, transport, recording, or pre-existing objects. Audio analysis uses
only caller-supplied PCM and returns lossy aggregates; it is not a Live tap or
realtime meter.

## Bridge safety

The bridge is loopback-only and uses a separate owner-controlled secret file.
Requests and responses are authenticated, sequences are monotonic and bounded,
frames are bounded, and malformed or unauthenticated work fails closed. Socket
workers do not access Live objects. The Control Surface queues work and drains
it on the scheduled Live main thread. Disconnect closes listeners and clients,
releases queued work, invalidates references, and cleans up workers. A bridge
reconnect creates a new epoch; old references, cursors, confirmations, and
transaction inputs must not be reused.

## Real Live boundary

The Python mapper is version-tolerant and omits unsupported operations. Its
fake-Live tests prove mapping and lifecycle contracts, not Ableton behavior.
No real Live Set, Live version, audible output, armed-track safety, audio
device, hardware, accessibility runner, signing identity, or notarization
credential is established by this repository. Treat those categories as
unavailable until observed in a dedicated safe harness.

If observed behavior contradicts `server_status`, `live_status`, or
`capabilities`, stop the client, preserve redacted evidence, inspect the Set,
and treat the discrepancy as a defect.
