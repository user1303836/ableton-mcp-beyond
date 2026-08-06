# Ableton Live safety

English · [简体中文](../zh-CN/LIVE_SAFETY.md) · [日本語](../ja/LIVE_SAFETY.md)

The safety contract every Live interaction is held to. Read this before
connecting the server to a real Set.

The default adapter is `UnavailableLiveAdapter`: disconnected, no Live I/O,
and not selectable by caller metadata, MCP arguments, simulator output, or the
mere presence of Live on disk. A production bridge requires an explicit
loopback configuration, an owner-only secret, matching protocol/registry, and
reported operation capability.

## Deployment trust boundary

This project supports an owner-controlled, local, loopback-only deployment. It
trusts the local OS account and the MCP client's approval policy. The server
cannot independently prove that a human, rather than the same model making the
request, supplied a confirmation or output-safety statement; no out-of-band
arming UI is provided. Do not auto-approve audible, recording, routing,
capture, or realtime tools. For unattended clients, use client-side deny rules
or run without a production bridge, and work only in a disposable Set.

## Universal mutation boundary

Every mutation requires:

- fresh authenticated status and exact negotiated operations;
- authoritative epoch-scoped refs and state;
- bounded inputs and purpose-specific authority;
- a read-only preview where applicable;
- exact confirmation, expiry, and idempotency;
- an atomic Live-main-thread precondition recheck;
- fresh postcondition verification;
- transaction-owned compensation/undo/cleanup only;
- explicit **uncertain** state after timeout, lost acknowledgement, external
  edit, failed verification, or failed cleanup.

A client must never replace uncertain authority with a new preview or key. The
host may reconcile only the exact original transaction/key/arguments against
the Remote Script ledger in the same bridge and Live epoch, followed by fresh
postcondition verification. Unsupported attributes or enum values are
unavailable evidence, not safe defaults.

Authentication is not mutation authority. Before every mutating bridge
`invoke`, the production adapter performs a read-only `authority.preflight`,
echoes its unpredictable one-use confirmation through `authority.prepare`, and
obtains a one-use 10-second token bound to the exact operation/argument
digest, connection epoch, fresh authoritative target values, playback/recording
state, referenced-object revisions, and Session structure. The bridge consumes
it before Live-thread dispatch and rejects direct authenticated mutation
frames, preflight or token replay, guessed confirmations, mismatched arguments,
expiry, and intervening state changes. The bridge keeps a bounded
executed-result ledger across TCP reconnections, so a lost response can be
reconciled exactly instead of replayed blindly. Audible launch, capture-start,
recording, and realtime-arm contracts also revalidate output-safety evidence on
the bridge side.

## Implemented mutation classes

Guarded workflows cover transport; clip launch and exact stop; MIDI clips and
notes; Arrangement clips and locators; mixer and routing; Session automation;
devices and Browser loading; Session/Arrangement recording; project backup;
realtime control; and consent-bound audio capture. Each has narrower checks in
its user/operations documentation.

- Session-structure creation returns exact object identities; compensation and
  undo recheck those identities and call Live's indexed deletion APIs rather
  than deleting a stale proxy or reused path.
- `live_undo` is transaction-specific and refuses a changed epoch or
  postcondition.
- Arbitrary device and Arrangement clip deletion is unavailable: cleanup
  requires the exact transaction-created object identity, hierarchy, and
  creation-time fingerprint, and refuses modified or substituted objects.
- Device insertion and Browser loading require an empty exact device owner, and
  cleanup requires the created device to remain its sole sibling, so an indexed
  deletion can never select an unrelated sibling.
- Moves never mint destructive cleanup authority: a pre-existing clip remains
  pre-existing after a move, source and destination content fingerprints are
  fenced, and recovery uses only the exact unchanged inverse-move transaction.
  Moving a transaction-created clip atomically consumes its prior cleanup
  token without minting deletion authority for the moved result.
- MIDI capture is advertised only while every Session slot is empty, so a
  partially failing Capture MIDI implementation cannot change pre-existing clip
  content without an exact restoration path.

Read-only operations include status, capability negotiation, snapshot,
discovery, previews, project inspection, subscription reads, realtime stats,
caller PCM analysis/reference comparison, and caller-declared Live-context
diagnosis. A read-only tool never starts playback or recording.

## Audible Session actions

Scene/clip launch requires explicit output-safety evidence, exact eligible
targets, a stopped non-recording baseline, safe monitoring/arm state, fresh
playback revision, bounded launch quantization, and preview-captured
track/scene/slot/clip identities that are carried to and rechecked on Live's
thread. Owned stop clears only the preflighted target;
`live_session_emergency_stop` independently requires exact fresh active target
keys and recording state, atomically clears Session clips, transport, Session
Record, and Arrangement Record, and survives host restart.

## Recording authority

A recording start preview requires explicit intent, output-safety evidence, and
an exact armed destination for either lane. Apply carries the exact prior
Session/Arrangement recording booleans, destination identity, and output-safety
evidence into the mapper; all are rechecked on Live's mutation thread before
record state changes. Acknowledgement loss is uncertain and never blindly
replayed. Stop uses the same fenced operation; independent emergency stop
clears both modes.

## Realtime authority

A configured UDP port grants no standing authority. `realtime.arm` selects an
endpoint, token, 1–30 second TTL, channel set, optional sender ports, and exact
published parameter refs. Live compares the exact parameter/owner/track/sibling
identities atomically before granting a token and again before every queued
write, so traversal-index replacement or reparenting revokes authority. Packets
are bounded to 512 bytes and 64/s with burst 16. *Accepted* does not mean
*applied*. Disarm generation-fences queued work. See
[REALTIME_CONTROL.md](REALTIME_CONTROL.md).

## Audio analysis and capture

Public analysis accepts normalized PCM, never paths or URLs, and returns only
bounded aggregates. It runs in disposable secret-stripped workers and can be
cancelled by killing the worker. Caller PCM is never attributed to Live unless
the relationship is explicitly declared — and a declaration remains unverified.

Live capture is a separate real-Live-only capability. Preview requires an exact
source clip slot and a distinct empty audio slot, a saved disposable Set,
stopped non-recording/unarmed/non-input-monitored state, a restorable route, a
one-to-nine second duration, explicit `ephemeral-analysis-and-delete` consent,
and output safety. A ten-second mapper watchdog, slot/track/transport stop,
bridge shutdown hook, MCP cancellation recovery, and an independent
post-restart emergency tool bound the recording authority. Cleanup deletes only
the exact owned clip and unlinks the verified WAV/ASD after private quarantine;
no arbitrary deletion or forensic-erasure claim is made. See
[AUDIO_INTELLIGENCE.md](AUDIO_INTELLIGENCE.md).

## Bridge safety

The bridge is numeric-loopback-only. Requests and responses use canonical
HMAC-SHA256, challenge/bridge-epoch binding, positive sequence and replay
checks, bounded frames/collections, and deadlines. Socket workers never touch
Live objects; the scheduled Control Surface callback drains Live work on the
main thread. Reconnect creates a new reference epoch. Shutdown releases
subscriptions, listeners, clients, workers, queued callbacks, realtime
authority, and refs. For active capture it reasserts exact stop/restoration
but, because a Remote Script cannot unlink PCM, preserves the owned clip/path
as a visible recovery residual rather than destroying that identity.

## Real-Live evidence boundary

Fake-Live, simulator, package, property, and benchmark results prove controlled
contracts, not Live behavior. Tracked evidence separately records installed
real-Live observations through Phase 8 on macOS Live 12.4.5b8, including normal
cleanup and failure recovery. It does not prove Windows Live behavior, hardware
output safety, accessibility, signing, or notarization.

If visible Live state conflicts with authenticated status or fresh discovery,
stop the client, preserve redacted evidence, use independent emergency recovery
if an owned audible lifecycle is active, and treat the discrepancy as a defect.
