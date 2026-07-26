# Testing guide

## Deterministic gates

Run serially from `apps/mcp-server`:

```sh
npm ci
npm run typecheck
npm test
npm run property-test
npm run benchmark
npm run compatibility
npm run package:verify
npm pack --dry-run --json
```

Then run from the repository root:

```sh
python3 -m unittest discover -s remote-script -p 'test_*.py'
git diff --check
git diff --cached --check
```

Node tests compile into `dist/` and cover MCP lifecycle, schema validation, bounded concurrent stdio framing, async adapter behavior, authenticated loopback responses, transactions, analysis, properties, delivery, and package installation. Python tests cover the dependency-free Control Surface entrypoint, registry loading and hashing, authentication, sequencing/replay rejection, main-thread queueing, fake-Live references, hierarchical discovery, empty clip slots, shape-dependent operation advertisement, Session MIDI, locators, structure, device/parameter validation, and cleanup. The package verifier additionally starts the installed production bridge and checks authenticated fake scene discovery.

The benchmark warms the declared maximum PCM input and reports repeated latency measurements. Latency, output size, and bounded-memory evidence are distinct concerns; no unavailable platform runner or simulator result is a pass for real Live.

## What passing means

Passing proves deterministic repository behavior and package contracts. It does not prove a real Control Surface loaded in Ableton Live, a supported Live API shape, visible Set state, audible or realtime behavior, platform installer runtime, accessibility, hardware, signing, notarization, or release publication.

## Change discipline

Add success and fail-closed tests for every new protocol method or Live side effect. Cover stale epochs/cursors/revisions, expired confirmations, conflicting idempotency keys, timeouts, cancellation before and after dispatch, disconnects, lost acknowledgements, partial mutation, compensation failure, external edits, and guarded undo. No production journey or scene-audition test is present yet; do not substitute simulator output for that evidence. Keep fixtures bounded and privacy-preserving. Never open, copy, stage, package, or expose the protected local SDK evidence.
