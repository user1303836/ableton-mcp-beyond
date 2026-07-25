# Ableton MCP Beyond

A safety-first Model Context Protocol host for Ableton Live integrations.

The current implementation is a local JSON-lines MCP server with a deliberately
small, read-only surface:

- `server_status` reports host readiness and the Live-adapter status.
- `capabilities` reports implemented and unavailable capability families.
- `audio_analyze` analyzes caller-supplied, normalized little-endian float32
  PCM and returns aggregate measurements only.

The Live adapter is not installed yet. No tool starts playback, changes a Live
set, accesses a path, uses the network, or returns raw audio. See the operator
and safety documents in [`docs/`](docs/) for setup, limits, recovery, and
checkpoint procedures.

## Quick start

Requirements: Node.js 20 or newer.

```sh
cd apps/mcp-server
npm ci
npm test
npm run build
node dist/src/cli.js
```

The host executable is `dist/src/cli.js`; `dist/src/index.js` is the library
entrypoint used by the package export. The current `npm start` script targets
the library entrypoint and therefore does not start a stdio server.

After building, generate an MCP client configuration without overwriting an
existing file:

```sh
npm run build
npm run setup -- --output "$PWD/client-config.json"
```

The package also provides `npm run migrate` for versioned configuration
migration and `npm run diagnostics` for local readiness checks. External
Ableton Live, signing, and notarization capabilities are reported as
unavailable until real platform evidence exists.

The server reads one JSON-RPC request per line from stdin and writes one JSON
response per line to stdout. Diagnostics are written to stderr. An MCP client
must send `initialize` with protocol version `2025-11-25`, then the
`notifications/initialized` notification, before calling tools.

This repository is under active development. The shipped scope and known gaps
are recorded in [`docs/OPERATIONS.md`](docs/OPERATIONS.md) and
[`docs/CHECKPOINT.md`](docs/CHECKPOINT.md), not inferred from the project
motivation references.
