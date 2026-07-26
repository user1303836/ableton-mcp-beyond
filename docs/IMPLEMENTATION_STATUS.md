# Implementation status and operating boundaries

This document records the current implementation state for users, developers,
operators, testing, recovery, delivery, checkpoint, and Live-safety decisions.
It is based on the source and tests in this checkout; it is not a roadmap.

## Shipped components

- The MCP host speaks newline-delimited JSON-RPC, requires protocol
  `2025-11-25`, keeps protocol responses on stdout, and defaults to
  `UnavailableLiveAdapter`.
- `live_discover` provides bounded track, scene, clip, and note pages.
- `live_midi_clip_preview` and `live_midi_clip_apply` implement a bounded
  Session MIDI transaction. Preview is read-only; apply requires exact,
  unexpired confirmation and idempotency; authoritative verification follows
  note insertion; failed partial work compensates by deleting the newly created
  clip; guarded undo refuses epoch or postcondition conflicts.
- `analysis.ts` returns aggregate and per-channel peak, RMS, DC offset,
  clipping, and stereo phase-correlation measurements. The loudness field is an
  RMS-derived proxy and is not LUFS, true peak, mastering validation, Live
  capture, or realtime evidence. `integratedLufsEstimate` is retained only as
  a deprecated compatibility field.
- `RemoteScriptLiveAdapter` is an asynchronous TCP client. It accepts only
  loopback endpoints with a strong secret, performs an authenticated handshake,
  verifies response MACs, enforces bounded frames/pending work, applies
  deadlines, and tracks reconnect epochs. Its synchronous adapter methods throw;
  callers use the `*Async` methods.
- The Python `AbletonMcpBridge` provides `create_instance`, an explicit
  loopback-only listener, HMAC requests/responses, sequence checks, a bounded
  queue, epoch-scoped references, fake-Live-compatible mapping, discovery, MIDI
  clip creation/deletion, and note insertion. Socket workers do not access Live
  objects; `update_display` or `drain_main_thread` performs queued work.
- Delivery includes versioned host/bridge configuration, secure secret-file
  helpers, diagnostics, an explicit-target Remote Script installer with symlink
  refusal and recoverable forced replacement, and tarball verification.

## User procedure

Run `npm ci`, `npm test`, then `npm start` from `apps/mcp-server`. Initialize
the MCP host before tools. Use `server_status` and `capabilities` as the source
of truth. For MIDI: discover an empty MIDI slot, preview, confirm/apply once,
read back the created clip, reuse the same idempotency key only for a known
retry, and undo only when the captured state still matches.

## Configuration and installation

Version 1 configuration remains host-only. Version 2 adds loopback host, port,
secret-file, and timeout. Validation rejects non-loopback addresses, invalid
ports/timeouts, missing or symbolic-link secrets, unknown fields, and unsafe
paths. The CLI does not automatically load the bridge or construct the remote
adapter. Install the packaged Remote Script only to an explicit destination;
the installer refuses overwrite without `--force`, refuses symbolic-link trees,
and keeps a timestamped backup during forced replacement.

## Recovery

The stdio host has no durable session resume. Restart it, repeat initialization,
and use a new request ID. If a remote mutation times out, disconnects, or loses
its acknowledgement, treat the result as uncertain and read authoritative state
before retrying; never blind-retry. Reconnect invalidates references/cursors by
epoch. MIDI preview expiry, stale revision, occupied slot, failed verification,
or compensation failure requires fresh discovery and operator review. Undo is
refused after any captured postcondition conflict.

## Test and checkpoint evidence

Run TypeScript typecheck/tests/property tests/benchmarks/compatibility/package
verification and Python unittest discovery as described in the companion docs.
The tests cover fake-Live mapping, listener and queue cleanup, authentication,
replay/sequence checks, wire limits, async adapter failures, discovery, MIDI
transactions, analysis, installation, and the real npm tarball. This is
deterministic repository evidence only. It is not proof of a real Ableton Live
Set, supported Live version, realtime behavior, devices, hardware, signing,
notarization, accessibility, or installer runtime on every platform.

## Known limitations

The CLI has no automatic production adapter selection. No disposable real Live
Set or authenticated production bridge has been validated in this checkout.
Arrangement mutation, audio capture, warp/takes, devices/racks/chains, browser
loading, routing, recording, project persistence, Max/OSC/UDP delivery,
plug-in UI fallback, performance mode, signing, notarization, and accessibility
certification remain unavailable. The protected
`extensions-sdk-1.0.0-beta.0` is local ignored evidence and must not be opened,
copied, staged, or exposed.

## Evidence classification

`UnavailableLiveAdapter` status is the truthful default. The simulator and fake
Live modules are test doubles. A passing Python or Node test, package smoke
test, installed asset, running Live process, or local benchmark cannot by
itself establish authenticated Live connectivity or production readiness.
