# Developer guide

## Layout

- `apps/mcp-server/src/host.ts` implements JSON-RPC framing, MCP lifecycle,
  tool dispatch, limits, and the unavailable Live adapter.
- `apps/mcp-server/src/analysis.ts` implements bounded, deterministic PCM
  decoding and analysis.
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
methods are `initialize`, `ping`, `tools/list`, and `tools/call`.

The host accepts notifications without manufacturing responses. Malformed JSON
produces a JSON-RPC parse error and the redacted diagnostic
`mcp-host: malformed input` on stderr. A message is limited to 64 MiB. Audio
tool calls are limited to 120 calls per rolling minute. The initialize request
must use exactly protocol version `2025-11-25`; unsupported versions are
rejected. The host has no persistent session or in-place resume mechanism.

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
