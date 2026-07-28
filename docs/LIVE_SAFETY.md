# Ableton Live safety

The default adapter is `UnavailableLiveAdapter`: disconnected, no Live I/O,
and not selectable by caller metadata, MCP arguments, simulator output, or the
mere presence of Live on disk. A production bridge requires an explicit
loopback configuration, owner-only secret, matching protocol/registry, and
reported operation capability.

## Universal mutation boundary

Every mutation requires:

- fresh authenticated status and exact negotiated operations;
- authoritative epoch-scoped refs and state;
- bounded inputs and purpose-specific authority;
- read-only preview where applicable;
- exact confirmation, expiry, and idempotency;
- an atomic Live-main-thread precondition recheck;
- fresh postcondition verification;
- transaction-owned compensation/undo/cleanup only;
- explicit uncertain state after timeout, lost acknowledgement, external edit,
  failed verification, or failed cleanup.

A client must never replay an uncertain mutation automatically. Unsupported
attributes or enum values are unavailable evidence, not safe defaults.

## Implemented mutation classes

Guarded workflows cover transport; clip launch and exact stop; MIDI clips and
notes; Arrangement clips and locators; mixer and routing; Session automation;
devices and Browser loading; Session/Arrangement recording; project backup;
realtime control; and consent-bound audio capture. Each has narrower checks in
its user/operations documentation. `live_undo` is transaction-specific and
refuses a changed epoch or postcondition.

Read-only operations include status, capability negotiation, snapshot,
discovery, previews, project inspection, subscription reads, realtime stats,
caller PCM analysis/reference comparison, and caller-declared Live-context
diagnosis. A read-only tool does not start playback or recording.

## Audible Session actions

Scene/clip launch requires explicit output-safety evidence, exact eligible
targets, a stopped non-recording baseline, safe monitoring/arm state, fresh
playback revision, and bounded launch quantization. Owned stop clears only the
preflighted target; `live_session_emergency_stop` independently requires exact
fresh active target keys and survives host restart.

## Realtime authority

A configured UDP port grants no standing authority. `realtime.arm` selects an
endpoint, token, one-to-thirty-second TTL, channel set, optional sender ports,
and exact published parameter refs. Empty parameter scope permits emergency
stop only. Packets are bounded to 512 bytes and 64/s with burst 16. Endpoint,
target, replay, expiry, rate, queue, generation, and validation failures are
counted. Accepted does not mean applied. Disarm bypasses the Live callback FIFO
and generation-fences queued work. See `REALTIME_CONTROL.md`.

## Audio analysis and capture

Public analysis accepts normalized PCM, never paths or URLs, and returns only
bounded aggregates. It runs in disposable secret-stripped workers and can be
cancelled by killing the worker. Caller PCM is never attributed to Live unless
the relationship is explicitly declared—and a declaration remains unverified.

Live capture is a separate real-Live-only capability. Preview requires an exact
source clip slot and distinct empty audio slot, saved disposable Set, stopped
non-recording/unarmed/non-input-monitored state, restorable route, one-to-nine
second duration, explicit `ephemeral-analysis-and-delete` consent, and output
safety. Start switches only the destination to Resampling, monitoring off, and
armed; launch quantization is temporarily immediate and restored before the
main-thread callback returns.

A ten-second mapper watchdog, slot/track/transport stop, repeated stop across
quantized-launch races, bridge shutdown hook, MCP cancellation recovery, and
independent post-restart emergency tool bound recording authority. Acquisition
accepts only a fresh regular WAV inside the saved project/User Library
boundary. Cleanup descriptor-verifies and privately quarantines the exact
WAV/ASD inodes before truncation/unlink, then deletes only the exact owned Live
clip while that clip still provides recovery identity. Any external route/arm/monitor edit or raw
identity ambiguity is residual uncertain state. No arbitrary deletion or
forensic-erasure claim is made. See `AUDIO_INTELLIGENCE.md`.

## Bridge safety

The bridge is numeric-loopback-only. Requests and responses use canonical
HMAC-SHA256, challenge/bridge-epoch binding, positive sequence and replay
checks, bounded frames/collections, and deadlines. Socket workers never touch
Live objects. The scheduled Control Surface callback drains Live work on the
main thread. Reconnect creates a new reference epoch. Shutdown releases
subscriptions, listeners, clients, workers, queued callbacks, realtime
authority, and refs. For active capture it reasserts exact stop/restoration but,
because Remote Script cannot unlink PCM, preserves the owned clip/path as a
visible recovery residual rather than destroying that identity.

## Real-Live evidence boundary

Fake-Live, simulator, package, property, and benchmark results prove controlled
contracts, not Live behavior. Tracked evidence separately records installed
real-Live observations through Phase 8 on macOS Live 12.4.5b8, including
normal cleanup and failure recovery. It does not prove Windows Live behavior,
hardware output safety, accessibility, signing, notarization, or publication.

If visible Live state conflicts with authenticated status or fresh discovery,
stop the client, preserve redacted evidence, use independent emergency
recovery if an owned audible lifecycle is active, and treat the discrepancy as
a defect.
