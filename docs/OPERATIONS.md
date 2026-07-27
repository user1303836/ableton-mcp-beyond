# Operations guide

Run the host under a supervisor with stdout and stderr kept separate.

## Start and observe

```sh
cd apps/mcp-server
npm ci
npm run build
node dist/src/cli.js --config /absolute/path/bridge-config.json
```

Use `server_status`, `capabilities`, and `live_status` after initialization. A valid `live_status` must identify `ableton-live/v1`, a connected `remote-script` adapter, a non-null epoch, the expected registry hash, and the negotiated operations. `live_snapshot` and bounded discovery provide the active read-only check. For audition, discover the exact Set, scene, target tracks/slots, and Session playback before preview; diagnostics discovery is not authorization to launch.

Diagnostics accepts no arguments or exactly one `--config PATH`:

```sh
npm run diagnostics -- --config /absolute/path/bridge-config.json
```

Diagnostics separates local host/package/configuration readiness from authenticated reachability, discovery reachability, registry hash, epoch, protocol, and `liveConnected`. A file, process, open port, installed package, simulator, or fake-Live result cannot establish real Live connectivity. The package verifier does exercise an authenticated installed Python bridge and scene discovery, but that remains fake-Live contract evidence.

## Limits and shutdown

The host bounds JSON-RPC frames at 64 MiB, remote frames at 1 MiB, remote pending work at 64 requests, tracked request identifiers at 4096, and tool calls at 120 per rolling minute. Stdio allows bounded concurrent work (default 16, maximum 64), preserves response order, observes output backpressure, and treats cancellation after dispatch as non-retracting. Audio analysis is bounded to the limits in `USER_GUIDE.md`. Close stdin for normal completion. On EOF, signal, initialization failure, cancellation, output failure, timeout, or disconnect, close the adapter and settle pending work; reinitialize to obtain a new epoch. A scene-audition disconnect, timeout, or acknowledgement loss is uncertain playback state, not a safe retry condition.

## Realtime operations

A configured `realtimePort` does not grant authority by itself. Use
`live_realtime_arm_preview`/`apply`, keep the returned token out of logs, inspect
`live_realtime_stats`, and always call `live_realtime_disarm`. Accepted UDP
packets and applied Live-thread callbacks are separate counters. Endpoint,
replay, rate, queue, expiry, and generation-fence drops are explicit. See
`REALTIME_CONTROL.md` for packet formats, limits, OSC/XY/Max extension semantics,
and recovery.

## Installation

Use `node dist/src/install-remote-script.js --destination <absolute-path>`. Inspect with `--dry-run`; use `--force` only for a known recoverable destination. Installation refuses symlink trees, does not auto-select a Live folder, and writes only the allowlisted bridge assets plus a non-secret reference when configured.

## Evidence boundary

Node/Python tests, the simulator, fake-Live mapper, authenticated loopback checks, package verification, and benchmarks establish repository-controlled contracts only. They do not prove a real Ableton Live version, disposable Set, visible UI state, audible/realtime behavior, hardware, accessibility, installer runtime, signing, notarization, or release readiness.
