# Ableton MCP Beyond

A safety-first MCP host for bounded Ableton Live integration.

The server speaks newline-delimited JSON-RPC over stdio. Without `--config`,
it uses `UnavailableLiveAdapter`; no Live state is read or changed. With an
explicit validated version-2 configuration, the packaged CLI connects to the
loopback `AbletonMcpBridge` over the authenticated `ableton-loopback/v1`
transport.

## Quick start

Requirements: Node.js 20 or newer.

```sh
cd apps/mcp-server
npm ci
npm test
npm start
```

The MCP executable is `dist/src/cli.js`. It accepts one JSON-RPC message per
line on stdin and writes only JSON-RPC responses to stdout. Initialize with
protocol version `2025-11-25`, then send `notifications/initialized`.

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
  --secret-file /absolute/path/bridge.secret --bridge-timeout 5000
```

The CLI loads a bridge only when `--config /absolute/path/bridge-config.json`
is supplied. Configuration, secret, and Remote Script installation are never
selected from JSON-RPC arguments or client metadata.

The Remote Script installer requires an explicit destination:

```sh
npm run build
node dist/src/install-remote-script.js --destination /absolute/path/ControlSurface --dry-run
```

Use `--force` only for a known disposable or recoverable destination. See
[`docs/USER_GUIDE.md`](docs/USER_GUIDE.md), [`docs/OPERATIONS.md`](docs/OPERATIONS.md),
and [`docs/LIVE_SAFETY.md`](docs/LIVE_SAFETY.md) for operating boundaries.

## Evidence boundary

The deterministic simulator, Python fake-Live mapper, package smoke tests,
benchmarks, and authenticated loopback tests are contract evidence only. They
do not prove a real Ableton Live version, disposable Set, audio device,
hardware, accessibility, signing, notarization, or installer-runtime result.
Those limitations are recorded in [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md).
