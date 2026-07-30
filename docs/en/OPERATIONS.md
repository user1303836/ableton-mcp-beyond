# Operations guide

English · [简体中文](../zh-CN/OPERATIONS.md) · [日本語](../ja/OPERATIONS.md)

Running, supervising, and shutting down the host in daily use. For uncertain
state after a failure, see [RECOVERY.md](RECOVERY.md).

Run the host under a supervisor with stdout and stderr kept separate.

## Start and observe

```sh
cd apps/mcp-server
npm ci
npm run build
node dist/src/cli.js --config /absolute/path/bridge-config.json
```

Use `server_status`, `capabilities`, and `live_status` after initialization. A
valid `live_status` identifies `ableton-live/v1`, a connected `remote-script`
adapter, a non-null epoch, the expected registry hash, and the negotiated
operations. `live_snapshot` and bounded discovery provide the active read-only
check. For audition, discover the exact Set, scene, target tracks/slots, and
Session playback before preview; diagnostics discovery is not authorization to
launch.

Diagnostics accepts no arguments or exactly one `--config PATH`:

```sh
npm run diagnostics -- --config /absolute/path/bridge-config.json
```

Diagnostics separates local host/package/configuration readiness from
authenticated reachability, discovery reachability, registry hash, epoch,
protocol, and `liveConnected`. A file, process, open port, installed package,
simulator, or fake-Live result cannot establish real Live connectivity.

Remote Script file diagnostics are a separate, disabled-by-default local
contract. They can be provisioned only during lifecycle install with
`--enable-bridge-diagnostics`; creating a predictable temporary file cannot
activate them. The destination is the owner-only, non-linked
`bridge-diagnostics.log` under the selected lifecycle state directory. A
nonblocking 64-record queue feeds one daemon writer; records are at most 512
bytes and the active file resets before exceeding 256 KiB. Records contain only
a timestamp, fixed event code, coarse allowlisted category, and bounded dropped
count—not exception messages/tracebacks, request data, secrets/MACs/tokens,
Set/project/object names, Browser queries, PCM, or media paths. Queue pressure
drops records. Link/path drift, log-full/write failure, or an unsafe descriptor
disables logging without changing the operational error. Uninstall/reinstall
without the flag disables the configured sink; after uninstall and inspection,
the retained log may be removed with the rest of owner state.

## Limits and shutdown

The host bounds JSON-RPC frames at 64 MiB, remote frames at 1 MiB, remote
pending work at 64 requests, tracked request identifiers at 4096, and tool
calls at 120 per rolling minute. Stdio allows bounded concurrent work (default
16, maximum 64), backpressures at four times the configured concurrency,
preserves response order, and treats cancellation after dispatch as
non-retracting. PCM analysis is limited to 10,000,000 samples / 600 seconds;
reference comparison to 4,000,000 samples / 30 seconds per source / 10 seconds
lag. DSP runs in at most two active and four queued disposable workers with a
512 MiB heap, 30 second wall limit, 64 MiB request, 2 MiB stdout, and 16 KiB
stderr. Live capture is limited to one mapper-owned lifecycle, one-to-nine
requested seconds, a ten-second watchdog, 32 MiB WAV, 12 seconds, and two
channels.

Close stdin for normal completion. On EOF, signal, initialization failure,
cancellation, output failure, timeout, or disconnect, the host closes the
adapter and settles pending work; reinitialize to obtain a new epoch. A
scene-audition disconnect, timeout, or acknowledgement loss is uncertain
playback state, not a safe retry condition.

## Realtime operations

A configured `realtimePort` does not grant authority by itself. Use
`live_realtime_arm_preview`/`apply`, keep the returned token out of logs,
inspect `live_realtime_stats`, and always call `live_realtime_disarm`. Accepted
UDP packets and applied Live-thread callbacks are separate counters. Endpoint,
replay, rate, queue, expiry, and generation-fence drops are explicit. See
[REALTIME_CONTROL.md](REALTIME_CONTROL.md) for packet formats, limits, OSC/XY/Max
extension semantics, and recovery.

## Domain and extension boundaries

Rename, Browser load, and audio-clip changes use purpose-specific
preview/apply/undo transactions; generic authenticated `invoke` is not
user-facing mutation authority. Browser load requires a fresh exact
`browser.inspect` device identity. Audio edits are field-negotiated per clip;
warp-marker readback does not grant marker-edit authority. Subscriptions
negotiate only event types with real producers (`transport`, `object`, and
protocol `reset`). Coalescing an undelivered adjacent event preserves its
sequence; actual queue overflow or an epoch change emits `reset`, and a reset
or sequence gap requires a fresh snapshot.

`ableton://max-extension` truthfully reports that no Max device is bundled.
Canonical `project.new/open/save/save-as/collect/export/bounce` identifiers
reserve a future adapter contract, but current adapters do not advertise or
execute them. Local `project.info` and receipt-bound `.als` backup remain the
only project operations.

## Recording operations

Both Session and Arrangement recording start require an exact armed
destination, explicit intent, and output-safety evidence. The mapper
atomically rechecks both prior recording booleans plus destination and safety
authority. Do not issue a second start or a new key after uncertainty: in an
unchanged bridge/Live epoch, reconcile only the exact original transaction and
key; otherwise discover fresh playback, then use
`live_session_emergency_stop` with exact active targets and `expectedRecording`
set to the freshly observed `stopped`, `session`, `arrangement`, or `both`
mode to clear playback and both recording modes; verify `recordingStopped=true`
and fresh stopped state.

## Audio capture supervision

Before capture, record the exact Set, source/destination slots, destination
route/arm/monitor baseline, playback/recording state, output-safety provenance,
and raw-file directory count. Do not supervise by port/process presence alone;
require `real-live` provenance and all canonical capture operations.

During apply, the MCP request can remain open for the requested duration plus
bounded finalization/analysis. Cancellation emits no MCP response but the host
continues independent stop/cleanup; wait for `live_audio_capture_status` from a
fresh client. A killed host does not remove mapper authority: the Live-side
watchdog stops recording, and a new packaged host can run
`live_audio_capture_emergency_stop` with exact observed identities.

A passing completion requires mapper state `cleaned`, `playbackStopped=true`,
transport/Session/Arrangement recording false, restored route/arm/monitoring,
an empty destination slot, `rawFileUnlinked=true`, and no WAV/ASD residual.
Never log a confirmation, mapper/recovery token, PCM, or media path. See
[AUDIO_INTELLIGENCE.md](AUDIO_INTELLIGENCE.md).

## Delivery lifecycle supervision

Use `ableton-mcp-lifecycle`; the direct Remote Script copier is a lower-level
development primitive, not the complete product lifecycle. Always review a
non-mutating plan, stop Live explicitly for install/upgrade/rollback/uninstall,
and retain the exact tarball SHA, receipt, journal, and any quarantine path.
Never delete or edit a backup outside the receipt while rollback is available.

After a mutation, status must show matching managed hashes, owner-only secret
permissions, stopped/unloaded Live as appropriate, and `restartRequired` until
manual Control Surface selection plus authenticated real-Live activation.
`activated` requires registry identity and `real-live` provenance; a free port,
process, fake mapper, or simulator does not satisfy it. Repair quarantines
drift and never invents a missing secret. Uninstall preserves modified/unknown
content and the secret by default. Exact commands and Windows/macOS path policy
are in [DELIVERY.md](DELIVERY.md).

## Evidence boundary

Node/Python tests, the simulator, fake-Live mapper, authenticated loopback
checks, package verification, and benchmarks establish repository-controlled
contracts only. They do not prove a real Ableton Live version, disposable Set,
visible UI state, audible/realtime behavior, hardware, accessibility, installer
runtime, signing, notarization, or release readiness.
