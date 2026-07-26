# Developer guide

The implementation source and compiled tests are authoritative. Keep this
guide synchronized with exported methods and test assertions; references and
roadmap material do not add capabilities.

## Layout

- `apps/mcp-server/src/host.ts` implements JSON-RPC framing, MCP lifecycle,
  tool dispatch, limits, and the unavailable Live adapter.
- `apps/mcp-server/src/analysis.ts` implements bounded, deterministic PCM
  decoding and analysis.
- `apps/mcp-server/src/live.ts` defines the Live adapter contract and an
  in-memory simulator; it does not connect to Live.
- `apps/mcp-server/src/loopback.ts` defines the HMAC-authenticated
  `ableton-loopback/v1` adapter boundary, request sequencing, response-MAC
  verification, request-id binding, and authenticated event delivery.
- `remote-script/ableton_mcp_remote_script.py` is a dependency-free Python
  authenticated dispatch shim. It is not yet a Control Surface package or
  socket server.
- `apps/mcp-server/src/delivery.ts` implements versioned client configuration,
  legacy migration, supported-platform detection, and local diagnostics.
- `apps/mcp-server/src/benchmark.ts` implements deterministic local benchmark
  gates for protocol, recovery, and bounded analysis behavior.
- `apps/mcp-server/test/` contains unit, protocol, process, benchmark, and
  property tests.
- `apps/mcp-server/scripts/verify-package.mjs` audits and installs the real npm
  tarball in a disposable directory for cross-platform packaging checks.

## Build and test

```sh
cd apps/mcp-server
npm ci
npm run typecheck
npm test
npm run property-test
npm run benchmark
```

The built stdio executable is `dist/src/cli.js`. `dist/src/index.js` is the
library export and is not a process runner; generated client configuration
targets `cli.js`.

The build uses `tsc -p tsconfig.json`; tests execute compiled files from
`dist/test`. Generated `dist/` and dependencies are local build outputs.
`npm run property-test` runs focused invariant tests. `npm run benchmark` emits
JSON and fails if a fixed local protocol, recovery, or analysis budget is
breached. These are host-process measurements, not Live or realtime evidence.

## Protocol contract

Requests are JSON-RPC 2.0 objects with only `jsonrpc`, `id`, `method`, `params`,
and `_meta` fields. Request IDs are non-empty strings up to 128 characters or
safe integers. Duplicate IDs are rejected while tracked; up to 4,096 IDs are
retained. Initialization is required before ordinary requests. The supported
methods are `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`,
`resources/read`, `prompts/list`, and `prompts/get`.

The host accepts notifications without manufacturing responses. Malformed JSON
produces a JSON-RPC parse error and the redacted diagnostic
`mcp-host: malformed input` on stderr. A message is limited to 64 MiB. Audio
tool calls are limited to 120 calls per rolling minute. The initialize request
must use exactly protocol version `2025-11-25`; unsupported versions are
rejected. Read-only capability and safety resources are available through
`resources/list` and `resources/read`; the bounded audio workflow is available
as the `analyze_audio` and `change_tempo_safely` prompts through `prompts/list`
and `prompts/get`. The host
has no persistent session or in-place resume mechanism. `shutdown` and
`$/cancelRequest` are unsupported; `notifications/cancelled` is accepted as a
no-response notification. The exposed tool set is `server_status`,
`capabilities`, `audio_analyze`, `live_status`, `live_snapshot`,
`live_tempo_preview`, `live_tempo_apply`, and `live_undo`.

## Extension rules

Keep tool schemas strict (`additionalProperties: false`). Keep protocol output
on stdout and diagnostics on stderr. A Live adapter must expose an explicit
status and must not be treated as available merely because a caller supplies
authority-like fields. Add tests that prove both successful behavior and safe
failure before documenting a new capability.

Configuration writers validate version 1 documents before writing, refuse to
overwrite unless `--force` is supplied, require a non-empty command, and create
files with owner-only permissions where supported. PCM base64 decoding requires
canonical base64 and bounded little-endian float32 data.

The default host constructs `UnavailableLiveAdapter`, so Live-dependent calls
return safe tool errors. A connected adapter enables status, snapshot only with
`session.read`, and the guarded tempo workflow only with `transport`. A tempo
preview expires after 30 seconds; apply and undo require the matching epoch,
explicit confirmation, and an idempotency key. Undo also refuses if the tempo
changed after apply. Preview transactions are bounded to 256 entries; applied
and undone records remain available for idempotent responses.

`src/live.ts` is an in-memory simulator and adapter contract, not a Live
connection. `src/loopback.ts` and `remote-script/ableton_mcp_remote_script.py`
define compatible HMAC-authenticated `ableton-loopback/v1` message contracts
with bounded IDs, nonces, monotonic request sequences, response authentication,
and replay protection. The Python shim has no Ableton import-time dependency.

The simulator's deterministic fixture contains a set, track, scene, MIDI clip,
device, parameter, locator, and browser entries. Its bounded test operations
validate transport, track and parameter properties, MIDI notes, automation,
warp flags, takes, subscriptions, and reconnect epochs. These exports are
adapter-boundary evidence only; `McpHost` constructs the unavailable adapter
by default and does not dispatch simulator operations as MCP tools.
