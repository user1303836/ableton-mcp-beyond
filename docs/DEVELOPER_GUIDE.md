# Developer guide

## Layout

- `apps/mcp-server/src/host.ts` implements JSON-RPC framing, MCP lifecycle,
  tool dispatch, limits, and the unavailable Live adapter.
- `apps/mcp-server/src/analysis.ts` implements bounded, deterministic PCM
  decoding and analysis.
- `apps/mcp-server/test/` contains unit, protocol, process, and property tests.

## Build and test

```sh
cd apps/mcp-server
npm ci
npm run typecheck
npm test
npm run property-test
```

The build uses `tsc -p tsconfig.json`; tests execute compiled files from
`dist/test`. Generated `dist/` and dependencies are local build outputs.

## Protocol contract

Requests are JSON-RPC 2.0 objects with only `jsonrpc`, `id`, `method`, `params`,
and `_meta` fields. Request IDs are non-empty strings up to 128 characters or
safe integers. Duplicate IDs are rejected while tracked; up to 4,096 IDs are
retained. Initialization is required before ordinary requests. The supported
methods are `initialize`, `ping`, `tools/list`, and `tools/call`.

The host accepts notifications without manufacturing responses. Malformed JSON
produces a JSON-RPC parse error and the redacted diagnostic
`mcp-host: malformed input` on stderr. A message is limited to 64 MiB. Audio
tool calls are limited to 120 calls per rolling minute.

## Extension rules

Keep tool schemas strict (`additionalProperties: false`). Keep protocol output
on stdout and diagnostics on stderr. A Live adapter must expose an explicit
status and must not be treated as available merely because a caller supplies
authority-like fields. Add tests that prove both successful behavior and safe
failure before documenting a new capability.
