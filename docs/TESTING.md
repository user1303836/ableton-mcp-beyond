# Testing guide

Tests prove the local implementation and its failure behavior. They do not
manufacture evidence for unavailable Live, device, platform-runner, signing,
notarization, or realtime dependencies.

## Required local checks

Run from `apps/mcp-server`:

```sh
npm run typecheck
npm test
npm run property-test
npm run benchmark
npm run compatibility
npm run package:verify
npm pack --dry-run
git diff --check
```

The current suite covers deterministic analysis, clipping remediation, invalid
and unsafe PCM, mono/stereo spectral handling, MCP initialization, strict
schemas, duplicate IDs, notifications, malformed JSON, the built process,
metadata, unsupported methods, boundedness, delivery configuration, packaging
compatibility, float32 decoding, static safety resources, the audio-analysis
prompt workflow, the exposed Live tool list, and the connected-adapter tempo
preview/apply/verify/undo workflow. The default adapter tests also prove
unavailable Live calls do not mutate state. The package smoke test runs setup,
legacy migration, diagnostics, and a protocol handshake against the installed
tarball on the current runner.
From the repository root, also run
`python3 -m unittest discover -s remote-script -p 'test_*.py'`. Those tests
cover HMAC authentication, replay protection, nonce ordering, unknown-field
and method rejection, and wire-safe operation errors. The TypeScript simulator
tests cover stable references, bounded property changes, subscriptions, and
reconnect epochs; they are test-double evidence, not Live integration.

The loopback tests additionally cover authenticated status, replay rejection,
tamper rejection, bounded nonces, subscriptions, and wire-safe operation
failures. The fixture uses a deterministic simulator and must not be reported
as an Ableton Live integration test.

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

When a check cannot run because a tool, credential, device, Live installation,
or runner is absent, record it as unavailable and do not replace it with a
static or simulated success.

## Benchmark gates

`npm run benchmark` runs fixed, local fixtures and emits a JSON report. The
gates cover in-process request latency and throughput, newline-delimited batch
loss and latency, cancellation notification handling, recovery after malformed
input, and bounded PCM analysis. Each measurement includes its numerical budget
and pass state; a budget breach returns a nonzero status. The current gates are
5 ms ping p95, 5,000 ping requests/s minimum, 100 ms batch p95, zero response
loss, 5 ms cancellation p95, 100 ms malformed-stream recovery, 100 ms
restart-and-resume (fresh host, initialization, and retry), and 250 ms analysis
p95. Stdio has no in-place resumable session; the resume fixture measures the
documented restart procedure. These are host-process measurements, not evidence
of Ableton Live, device, platform, network, signing, or realtime performance.
