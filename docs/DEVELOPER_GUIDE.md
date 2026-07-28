# Developer guide

Source, schemas, and tests are authoritative. Documentation must not promote a capability unless its exported tool, adapter contract, mapper, and tests support it.

## Layout

- `apps/mcp-server/src/host.ts`: MCP lifecycle, strict tool schemas, async dispatch, transaction state, and recovery errors.
- `apps/mcp-server/src/live.ts`: Live types, registry-derived identifiers/hash, unavailable adapter, simulator, and the synchronous plus Promise-based adapter contracts currently used by tests and process-backed callers.
- `apps/mcp-server/src/registry.ts`: canonical registry loading, bounded schema validation, and derived operation identifiers/hash.
- `apps/mcp-server/src/bridge/remote-adapter.ts`: authenticated asynchronous loopback client, registry negotiation, deadlines, correlation, and cleanup.
- `apps/mcp-server/src/transactions/`: bounded MIDI transaction and async discovery helpers.
- `apps/mcp-server/src/analysis.ts`: bounded PCM decoding and privacy-preserving analysis.
- `apps/mcp-server/src/delivery.ts`: configuration, secret validation, packaging, installation, and diagnostics.
- `protocol/ableton-live-v1.operations.json`: canonical version-1 operation registry. Its canonical registry hash is `616268a4464c3e3db4ea9f08a67fc1e755714ebd7a42ca070ab3b029213d19c4` for the current contract.
- `remote-script/AbletonMcpBridge/__init__.py`: one-argument Control Surface entrypoint and fail-closed reference loading.
- `remote-script/ableton_mcp_remote_script.py`: authenticated transport, bounded main-thread dispatch, epoch-scoped references, shape-dependent operation advertisement, hierarchical discovery, structure, MIDI, locator, and published device-parameter mapping.

## Contract rules

The wire protocol is `ableton-loopback/v1`. Canonical JSON sorts keys and normalizes negative zero; HMAC-SHA256 authenticates requests and responses; frames, collections, nesting, strings, pending work, and sequences are bounded. Negotiation rejects malformed, duplicate, unknown, unsupported, or registry-hash-mismatched operations.

The process-backed adapter is consumed through Promise-based methods such as
`snapshotAsync`, `getAsync`, `invokeAsync`, `reconnectAsync`, and `close`, while the shared TypeScript interface and simulator retain
synchronous compatibility methods. This is not yet the planned single
asynchronous contract. `McpHost.handleAsync` is required for scene audition
and other process-backed Live tools; verify compatibility work against both
paths until the synchronous simulator-only surface is removed. Neither contract
exposes generic `set`; mutation is available only through canonical,
purpose-specific operations.

The Python worker performs framing, authentication, sequencing, and queueing only. Live-facing traversal and mutation are drained by the scheduled main-thread callback. A fresh connection epoch invalidates prior references and cursors. Unsupported Live shapes are unavailable, never fabricated. Device control is limited to an authoritative published numeric parameter with valid bounds, quantization, enabled state, automatable state, parentage, and post-mutation readback. Discovery rows retain parent references; empty clip slots are explicit rows and must not be inferred as clips.

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
git diff --check
git diff --cached --check
```

`dist/` and packed archives are generated outputs and must not be staged. Do not use local-only reference material as a fixture or package input. Keep stdout protocol-only and redact diagnostics on stderr. Do not modify, stage, package, copy, or expose `extensions-sdk-1.0.0-beta.0`.
