# Operations guide

Run the host as a supervised stdio process with stdout and stderr on separate
channels.

## Start

```sh
cd apps/mcp-server
npm ci
npm run build
node dist/src/cli.js
```

For an explicit bridge:

```sh
node dist/src/cli.js --config /absolute/path/bridge-config.json
```

The CLI loads only the supplied configuration path. It validates the version,
loopback endpoint, timeout, secret path, and secret before connecting. Startup
failure is written as redacted text to stderr and no protocol output is
manufactured.

## Observe

Use `server_status` and `capabilities` after initialization. `live_status`
reports the negotiated protocol, epoch, adapter kind, connection state, and
operations. `npm run diagnostics -- --config <path>` performs local readiness
checks and, for version 2, one authenticated read-only status probe. A port,
file, process, simulator, or installed package is not Live connectivity.

## Limits and shutdown

Input frames are limited to 64 MiB. Audio is limited as documented in the user
guide and to 120 calls per rolling minute. The stdio path preserves response
framing and observes output backpressure. Close stdin for normal completion or
terminate the supervisor; the host closes the adapter and rejects pending
remote requests. There is no durable session resume.

## Remote Script installation

Use `node dist/src/install-remote-script.js --destination <absolute-path>`.
`--dry-run` inspects the target. Installation refuses symlink trees and
overwrite by default. `--force` moves an existing target to a recoverable
timestamped backup before replacement. Never auto-select a Live destination.

## Evidence

Node/Python tests, the simulator, fake-Live mapper, package verification, and
loopback handshake prove repository-controlled contracts only. They do not
establish a real Live Set, Live version compatibility, audio capture,
hardware, accessibility, signing, notarization, or installer-runtime support.
