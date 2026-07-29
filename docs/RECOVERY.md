# Recovery procedures

## Protocol and input errors

Correct the request and use a fresh request identifier. For malformed or oversized input, discard the rejected frame and inspect only the redacted stderr diagnostic. If authentication, framing, sequencing, or response correlation is no longer trustworthy, stop and restart the process; do not continue the stream.

## Configuration and lifecycle errors

Verify that the path is explicit, regular, non-symlink, and owner-controlled;
configuration is version 1 or 2; the bridge host is exact loopback; ports are
distinct/free at install preflight; and the separate secret has conclusive
owner-only permissions. Never put a secret on the command line.

For receipt-driven lifecycle failures, stop Live and inspect
`install-receipt.json`, `lifecycle-journal.json`, managed hashes, and quarantine
before retrying. A failed install removes newly created secret/config/bridge
state. A failed upgrade restores the old config/bridge and leaves the receipt
generation unchanged. A held file, ACL error, symlink/junction, occupied port,
or interrupted rename is not success; release the handle or fix permissions,
then use status and repair. Repair preserves drift in quarantine and refuses to
manufacture a missing secret. Rollback uses only the exact receipt-bound prior
generation. Uninstall stages owned paths before commit, restores them if commit
fails, retires receipt-owned rollback generations, quarantines drift, and
preserves secrets unless receipt-owned purge is explicit. If post-commit
removal is blocked, the receipt retains `pendingCleanup`; release the handle and
repeat the exact uninstall command. `preserved` paths are operator content and
are never deleted by retry. Never manually replace/delete a backup while rollback is advertised.
See `DELIVERY.md`.

## Adapter uncertainty

Authentication failure, registry mismatch, response-MAC failure, replay, sequence error, malformed response, timeout, cancellation, disconnect, or acknowledgement loss means the result is unknown. Do not issue new mutation authority. The still-running Host may reconnect only to the same authenticated bridge and unchanged Live epoch, reuse the exact original transaction, confirmation, canonical arguments, and idempotency key, obtain the Remote Script ledger result, and verify fresh postconditions. This is reconciliation, not a new replay. A changed bridge or Live epoch fails closed and requires manual authoritative recovery. Hidden cleanup tokens survive a transport reconnect performed by the same adapter instance, but are intentionally not persisted to disk or transferable to a replacement Host/adapter process. Host transaction records are likewise in-memory: after process replacement, automatic destructive cleanup is unavailable and exact manual readback/recovery is required; only the independently authorized emergency stop survives restart.

For a cancelled stdio request, no cancellation response is emitted. Cancellation before handler dispatch may prevent work; cancellation after dispatch does not undo Live work. Treat the latter as uncertain and perform fresh readback before any further mutation.

## Transaction recovery

Preview expiry, stale epoch, stale revision, invalid parent, occupied Session slot, duplicate structure name, locator collision, unsupported or disabled parameter, out-of-range or incorrectly quantized value, or an external edit requires fresh authoritative discovery and a new preview. An acknowledgement-lost apply, undo, or compensation remains recovery-protected and accepts only the exact original idempotency key in the unchanged bridge/Live epoch. Multi-step structure, locator, capture, MIDI, and automation recovery replays retained exact step arguments, verifies already completed steps, and resumes only transaction-owned remainder. A different key fails closed. For device parameters, verify the same device-child relationship and exact prior/applied value before restoration.

Arbitrary device and Arrangement clip deletion is unavailable because deleted state cannot be reconstructed. Cleanup deletes only an exact transaction-created identity whose creation fingerprint and current hierarchy still match. Modified or substituted owned objects are refused. After authoritative manual recovery, `live_recovery_finalize` requires `confirmation=finalize-recovery-record`, a declared resolution, and bounded provenance/scope evidence; it refuses active audible/recording/realtime work and retires Remote Script replay authority before releasing Host capacity.

For scene audition, first perform fresh authenticated playback discovery. If the connection epoch, Set name, scene revision, recording state, arm/monitoring state, output evidence, or active targets differ from the transaction, guarded stop is refused and the operator must inspect the Set manually. Same-epoch acknowledgement loss accepts only the original apply or stop key; never substitute a new key. The independent fresh-observation `live_session_emergency_stop` remains available after Host restart.

Recording acknowledgement loss is always uncertain. Re-read both recording
modes, the exact destination track and playback targets. Reconcile a possibly
applied start only through the exact original transaction/key in the unchanged
epoch; never preview or dispatch a second start as recovery. If any recording mode remains active, call `live_session_emergency_stop` with
the exact fresh playback targets and mandatory `expectedRecording` value (`session`, `arrangement`, or `both`; use `stopped` only when both fresh flags are false); its mapper-side fence also verifies recording
state and clears Session Record and Arrangement Record before reporting
`recordingStopped=true`.

## Realtime recovery

Disarm immediately when `live_realtime_stats` reports callback failures,
revoked work, pre-dispatch drops, or persistent pending work. Disarm, expiry,
re-arm, and bridge teardown generation-fence callbacks that have not started.
Do not infer delivery from UDP send success or the `accepted` counter; only
`applied` reports a completed verified Live-thread write. Restore touched
parameters through fresh authoritative refs and verify stopped/non-recording
state. The TCP `live_session_emergency_stop` is the independent recovery path
when the realtime token is missing or the data plane is suspect. See
`REALTIME_CONTROL.md`.

## Audio-capture recovery

Do not infer cleanup from MCP cancellation, host exit, or transport silence.
Open a fresh packaged host and call `live_audio_capture_status`. The tool
redacts the recovery token and raw path but reports exact capture/source/
destination identities, active/state, watchdog stop, file availability, and
playback stop.

If state is not `cleaned`, call `live_audio_capture_emergency_stop` with
`confirmation=emergency-stop-and-clean` and the exact freshly observed
identities. This independently:

1. stops the exact source/destination slots and tracks, transport, and recording;
2. reasserts stop across any quantized-fire race;
3. restores owned route/arm/monitor/position state unless an external edit is
   detected;
4. validates, privately quarantines, truncates, and unlinks the exact fresh
   regular WAV/`.asd` inodes inside the saved project/User Library boundary;
5. deletes only the exact mapper-owned capture clip after raw cleanup.

Success requires `cleanup.safe=true`, empty residuals, final state `cleaned`,
`playbackStopped=true`, and no WAV/ASD file. If the route changed externally,
media is outside the boundary, the Set path is unavailable, file identity
changed, format is unsupported, or unlink fails, stop all new capture attempts
and resolve the named residual manually. Never delete an arbitrary path and do
not claim forensic erasure. See `AUDIO_INTELLIGENCE.md`.

## Restart

1. Stop the supervisor and preserve redacted diagnostics.
2. Confirm that no generated archive or credential file is being collected.
3. Restart `dist/src/cli.js` with stdout and stderr separate.
4. Initialize with `2025-11-25`, then send `notifications/initialized`.
5. Obtain fresh status and discovery, preview again, and use a new bounded idempotency key.

If real Live is involved, stop and inspect the Set visibly before continuing. Repository-controlled evidence cannot substitute for that inspection or prove restoration.
