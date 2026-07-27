# Ableton MCP Beyond

A safety-first MCP host for bounded Ableton Live integration.

The server speaks newline-delimited JSON-RPC over stdio. Without `--config`,
it uses `UnavailableLiveAdapter`; no Live state is read or changed. With an
explicit validated version-2 configuration, the packaged CLI connects to the
loopback `AbletonMcpBridge` over the authenticated `ableton-loopback/v1`
transport.

## Quick start

Requirements: Node.js 22 or newer (Node 22 and 24 are exercised in CI).

```sh
cd apps/mcp-server
npm ci
npm test
npm start
```

The MCP executable is `dist/src/cli.js`. It accepts one JSON-RPC message per
line on stdin and writes only JSON-RPC responses to stdout. Initialize with
protocol version `2025-11-25`, then send `notifications/initialized`.

For the client-facing tool list and mutation sequence, see
[`docs/USER_GUIDE.md`](docs/USER_GUIDE.md). For supervision and failure
handling, see [`docs/OPERATIONS.md`](docs/OPERATIONS.md) and
[`docs/RECOVERY.md`](docs/RECOVERY.md).

The source-controlled operation contract is
[`protocol/ableton-live-v1.operations.json`](protocol/ableton-live-v1.operations.json).
The bridge negotiates its canonical SHA-256 before serving Live operations. The
current host surface includes bounded discovery, guarded Session scene
audition, Session structure and MIDI, Arrangement locators, tempo, and guarded
numeric device-parameter adjustment. The Python mapper supports bounded,
epoch-scoped discovery for the observed hierarchy, including regular/group,
return and main tracks, scenes, parent-scoped clip slots and clips, notes,
locators, devices, parameters, selection, routing choices, and Session
playback. Unsupported or unobserved Live shapes remain unavailable.

Build a host-only client configuration:

```sh
npm run build
npm run setup -- --output /absolute/path/client-config.json
```

To enable the bridge, create a strong owner-only secret separately, then
generate a version-2 configuration:

```sh
npm run setup -- --output /absolute/path/bridge-config.json \
  --bridge-host 127.0.0.1 --bridge-port 9000 \
  --realtime-port 9001 \
  --secret-file /absolute/path/bridge.secret --bridge-timeout 5000
```

The generated version-2 client entry includes `--config
/absolute/path/bridge-config.json`; the secret remains in its separate
owner-only file and is never placed in client arguments. `--realtime-port` is
optional; when present it enables only the separately armed loopback control
plane documented in [`docs/REALTIME_CONTROL.md`](docs/REALTIME_CONTROL.md).

The CLI loads a bridge only when `--config /absolute/path/bridge-config.json`
is supplied. Configuration, secret, and Remote Script installation are never
selected from JSON-RPC arguments or client metadata.

For an installed artifact, run `npm run diagnostics -- --config
/absolute/path/bridge-config.json`. Diagnostics validate the package manifest's
raw asset hashes and canonical registry hash, then perform authenticated,
bounded Set, scene, track, child clip-slot, and Session-playback discovery.
They report adapter operations separately from capabilities. `fake-live`,
simulator, unavailable, and unknown provenance remain non-passing evidence for
`liveConnected`, real Live state, audible state, or restoration.

The Remote Script installer requires an explicit destination:

```sh
npm run build
node dist/src/install-remote-script.js --destination /absolute/path/ControlSurface --dry-run
```

Use `--force` only for a known disposable or recoverable destination. See
[`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) and
[`docs/LIVE_SAFETY.md`](docs/LIVE_SAFETY.md) for operating boundaries.

Scene audition is a potentially audible workflow. Preview is read-only and
requires an exact Set name, authoritative stopped/non-recording playback,
unarmed and non-input-monitored tracks, safe launch quantization, callable
launch/stop operations, and explicit output-safety evidence. Apply requires
the returned confirmation and idempotency key, verifies fresh playback, and
must be stopped with the returned stop confirmation. It is not real-Live
evidence unless a real authenticated bridge and disposable Set have been
independently established.

## Evidence boundary

The deterministic simulator, Python fake-Live mapper, package smoke tests,
benchmarks, and authenticated loopback tests are contract evidence only. They
do not prove a real Ableton Live version, disposable Set, audio device,
hardware, accessibility, signing, notarization, or installer-runtime result.
Those limitations are recorded in [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md)
and the real-Live safety boundary is in [`docs/LIVE_SAFETY.md`](docs/LIVE_SAFETY.md).
