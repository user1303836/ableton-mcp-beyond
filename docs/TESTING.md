# Testing guide

## Required local checks

Run from `apps/mcp-server`:

```sh
npm run typecheck
npm test
npm run property-test
npm run benchmark
```

The current suite has 24 tests covering deterministic analysis, clipping
remediation, invalid and unsafe PCM, mono/stereo spectral handling, MCP
initialization, strict schemas, duplicate IDs, notifications, malformed JSON,
the built process, metadata, unsupported methods, boundedness, and float32
decoding.

## Acceptance checks

A documentation or implementation checkpoint is valid only when typechecking,
the full test command, property tests, benchmark gates, package dry-run, and
diff whitespace checks pass. Confirm that the built process writes only JSON
responses to stdout, emits no stderr for valid traffic, reports the unavailable
Live adapter, and exposes exactly the three implemented tools.

Integration, end-to-end, device, platform, signing, and Ableton Live checks
are not represented as passing by this repository. They require external
runtime evidence and must remain explicitly unavailable when those dependencies
are missing.

## Benchmark gates

`npm run benchmark` runs fixed, local fixtures and emits a JSON report. The
gates cover in-process request latency and throughput, newline-delimited batch
loss and latency, cancellation notification handling, recovery after malformed
input, bounded PCM analysis, and a restart-and-reinitialize resume handshake.
Each measurement includes its numerical budget and pass state; a budget breach
returns a nonzero status. The current gates are 5 ms ping p95, 5,000 ping
requests/s minimum, 100 ms batch p95, zero response loss, 5 ms cancellation
p95, 100 ms malformed-stream recovery, 250 ms analysis p95, and 100 ms resume.
These are host-process measurements, not evidence of Ableton Live, device,
platform, network, signing, or realtime performance.
