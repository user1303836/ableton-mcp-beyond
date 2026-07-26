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
  main-thread queue, epoch-scoped references, registry hash negotiation,
  parent-scoped hierarchical discovery when the observed shape exposes it,
  shape-dependent operation advertisement, Session discovery/MIDI mapping,
  Arrangement locator support when the Live shape exists, and published
  numeric device-parameter mapping.
- Bounded Session discovery, Session-structure track/scene
  preview/apply/undo, MIDI preview/apply/undo, Arrangement locator
  preview/apply/undo, tempo preview/apply/undo, and device-parameter
  preview/apply/guarded-undo contracts in the host.
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
runtime or disposable Set in this checkout. The host `live_discover` tool
currently accepts track, scene, clip, and note pages. The Python bridge mapper
also has bounded parent/filter/field/traversal-budget discovery for the
observed hierarchy, including empty clip slots, Session/Arrangement clip
distinction, selection, routing choices, and playback metadata, but this is
not the full Live object graph and the host has not delegated every mapper
kind.
Session structure is limited to bounded named track/scene creation and guarded
removal. Arrangement support is limited to named locator operations. Device
support is limited to discovery and guarded numeric parameter adjustment; it
does not insert, delete, move, load presets, traverse racks/chains, or control
plug-in UI. Scene/clip launch and stop, recording, audio capture, warp/takes, automation, routing,
projects, realtime delivery, Max/OSC, performance mode, accessibility
certification, signing, notarization, and release publication are unavailable.

The RMS loudness field is explicitly a proxy, not LUFS or true peak. Simulator,
fake-Live, package, benchmark, and CI results are deterministic contract
evidence only. The protected `extensions-sdk-1.0.0-beta.0` is ignored local
evidence and must not be opened, copied, staged, packaged, or exposed.
