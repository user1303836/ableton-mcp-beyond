# Developer guide

Source and tests are authoritative. Documentation must not promote a
capability unless its tool, adapter contract, and tests support it.

## Layout

- `src/host.ts`: MCP lifecycle, schemas, tool dispatch, transactions, and
  safe error text.
- `src/live.ts`: Live contracts, the in-memory simulator, and async adapter
  compatibility methods.
- `src/bridge/remote-adapter.ts`: authenticated asynchronous TCP client,
  response correlation, deadlines, frame limits, and cleanup.
- `src/transactions/session-midi.ts`: bounded Session MIDI preview/apply/undo
  and paged discovery.
- `src/analysis.ts`: bounded PCM decoding, waveform, spectral bands, and
  transient summaries.
- `src/delivery.ts`: versioned config, secrets, installer, package checks, and
  active diagnostics.
- `remote-script/AbletonMcpBridge/__init__.py`: one-argument Control Surface
  entrypoint and safe config loading.
- `remote-script/ableton_mcp_remote_script.py`: authenticated transport,
  main-thread queue, fake-Live mapper, discovery, MIDI, and locator operations.

## Commands

```sh
cd apps/mcp-server
npm ci
npm run typecheck
npm test
npm run property-test
npm run benchmark
npm run compatibility
npm run package:verify
npm pack --dry-run --json
cd ../..
python3 -m unittest discover -s remote-script -p 'test_*.py'
```

`dist/` is generated and must not be staged. Tests use the built JavaScript.
Benchmarks measure deterministic local budgets, not realtime Live behavior.

## Contracts

Keep JSON schemas strict and keep stdout protocol-only. The remote wire
protocol is `ableton-loopback/v1`; it uses canonical sorted-key JSON,
HMAC-SHA256, bounded frames/collections, positive safe request sequences,
nonces, and authenticated responses. The Python worker frames and authenticates
only; Live-facing work is queued for `update_display`/the scheduled main-thread
callback.

`RemoteScriptLiveAdapter` is asynchronous (`snapshotAsync`, `getAsync`,
`setAsync`, `invokeAsync`, `reconnectAsync`, `close`). Its synchronous methods
intentionally throw. `McpHost.handleAsync` is the process-backed dispatch path;
the synchronous path remains for in-process compatibility tests.

Capability negotiation is the source of truth. Unsupported Live object shapes
must be omitted or reported unavailable, never fabricated. Epochs bind
references, cursors, previews, and undo inputs.
