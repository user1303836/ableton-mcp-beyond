# Ableton MCP Beyond

A safety-first Model Context Protocol host for Ableton Live integrations.

The current implementation is a local JSON-lines MCP server. Its protocol
surface exposes host tools plus a guarded Live workflow, but the default
adapter is unavailable:

- `server_status`, `capabilities`, and `audio_analyze` are enabled locally.
- `live_status`, `live_snapshot`, `live_tempo_preview`, `live_tempo_apply`, and
  `live_undo` are exposed but fail safely until a connected adapter is supplied.
- `resources/*` and `prompts/*` publish capability, safety, audio, and guarded
  tempo workflow descriptions.

No production Live adapter is installed or selected by the CLI. The repository
does include a deterministic in-memory adapter and an authenticated
`ableton-loopback/v1` adapter boundary for contract tests; neither is Live
connectivity. No default-host call starts playback, changes a Live set, accesses
a path, uses the network, or returns raw audio.
See [`docs/LIVE_SAFETY.md`](docs/LIVE_SAFETY.md) and the other documents in
[`docs/`](docs/) for setup, limits, recovery, and checkpoint procedures.

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
entrypoint used by the package export. `npm start` launches the stdio server
after the package has been built.

After building, generate an MCP client configuration without overwriting an
existing file:

```sh
npm run build
npm run setup -- --output "$PWD/client-config.json"
```

The package also provides `npm run migrate` for versioned configuration
migration and `npm run diagnostics` for local readiness checks. Diagnostics
separate host readiness from external Ableton Live, signing, and notarization,
which remain unavailable without observed evidence.

The optional bridge configuration is version 2 and must name a loopback host,
port, and owner-only secret file. Generate the secret out of band and do not
place it on a command line. The Remote Script installer always requires an
explicit destination; use `ableton-mcp-install-remote-script --dry-run` to
inspect an installation, and `--force` only when replacing a known disposable
destination. Existing installations are retained as recoverable backups.

The server reads one JSON-RPC request per line from stdin and writes one JSON
response per line to stdout. Diagnostics are written to stderr. An MCP client
must send `initialize` with protocol version `2025-11-25`, then the
`notifications/initialized` notification, before calling tools.

This repository is under active development. The shipped scope and known gaps
are recorded in [`docs/OPERATIONS.md`](docs/OPERATIONS.md),
[`docs/CHECKPOINT.md`](docs/CHECKPOINT.md), and the consolidated
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md), not inferred
from the project motivation references.
