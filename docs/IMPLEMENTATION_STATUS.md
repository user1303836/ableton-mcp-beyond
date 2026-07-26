# Implementation status

## Implemented

- JSON-RPC stdio host with protocol `2025-11-25`, strict validation, bounded
  framing, backpressure-aware output, redacted diagnostics, and safe default
  adapter selection.
- Explicit version-1 host configuration and version-2 loopback bridge
  configuration with owner-controlled secret files, migration, setup, and
  active authenticated diagnostics.
- Asynchronous authenticated `RemoteScriptLiveAdapter` with deadlines,
  bounded pending requests, response authentication/correlation, reconnect
  epochs, and deterministic close behavior.
- Loadable `AbletonMcpBridge/__init__.py` with one-argument `create_instance`,
  fail-closed configuration, Control Surface scheduling, socket lifecycle,
  main-thread queue, epoch-scoped references, Session discovery/MIDI mapping,
  and version-negotiated Arrangement locator support when the Live shape exists.
- Bounded Session discovery, Session-structure track/scene
  preview/apply/undo, MIDI preview/apply/undo, Arrangement locator
  preview/apply/undo, and tempo preview/apply/undo contracts in the host.
- Privacy-preserving PCM aggregate, waveform envelope, logarithmic
  time-frequency, and transient summaries.
- Explicit-target Remote Script packaging/installation with manifest hashes,
  symlink refusal, overwrite protection, and recoverable replacement.

## Operating procedure

Use `docs/USER_GUIDE.md` for clients, `docs/OPERATIONS.md` for supervision,
`docs/RECOVERY.md` for uncertainty and failure handling, and
`docs/CHECKPOINT.md` for validation.

## Known limitations

The production bridge has not been validated against a real Ableton Live
runtime or disposable Set in this checkout. Discovery is currently limited to
the implemented track/scene/clip/note/locator pages and the Python mapper's
supported objects; it is not the full Live hierarchy. Session structure is
limited to bounded named track/scene creation and guarded removal. Arrangement
support is limited to named locator operations. Launch/recording, audio capture,
warp/takes, automation, devices/racks, routing, projects, realtime delivery,
Max/OSC, plug-in UI fallback, performance mode, accessibility certification,
signing, notarization, and release publication are unavailable.

The RMS loudness field is explicitly a proxy, not LUFS or true peak. Simulator,
fake-Live, package, benchmark, and CI results are deterministic contract
evidence only. The protected `extensions-sdk-1.0.0-beta.0` is ignored local
evidence and must not be opened, copied, staged, packaged, or exposed.
