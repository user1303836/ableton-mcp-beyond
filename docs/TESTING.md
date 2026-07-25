# Testing guide

## Required local checks

Run from `apps/mcp-server`:

```sh
npm run typecheck
npm test
npm run property-test
```

The current suite has 16 tests covering deterministic analysis, clipping
remediation, invalid and unsafe PCM, mono/stereo spectral handling, MCP
initialization, strict schemas, duplicate IDs, notifications, malformed JSON,
the built process, metadata, unsupported methods, boundedness, and float32
decoding.

## Acceptance checks

A documentation or implementation checkpoint is valid only when typechecking
and the full test command pass. Confirm that the built process writes only JSON
responses to stdout, emits no stderr for valid traffic, reports the unavailable
Live adapter, and exposes exactly the three implemented tools.

Integration, end-to-end, device, platform, signing, and Ableton Live checks
are not represented as passing by this repository. They require external
runtime evidence and must remain explicitly unavailable when those dependencies
are missing.
