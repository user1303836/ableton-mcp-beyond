# Testing guide

## Deterministic gates

Run serially from `apps/mcp-server`:

```sh
npm ci
npm run typecheck
npm test
npm run property-test
npm run coverage
npm run benchmark
npm run audio:oracle
npm run compatibility
npm run package:verify
npm run journey:verify
npm pack --dry-run --json
```

Then run from the repository root:

```sh
python3 -m unittest discover -s remote-script -p 'test_*.py'
git diff --check
git diff --cached --check
```

Node tests compile into `dist/` and cover MCP lifecycle, schema validation,
bounded concurrent stdio framing, async adapter behavior, authenticated
loopback responses, Session audition preflight/apply/stop, transactions, standards loudness/true peak, bounded reference alignment,
secret-stripped worker cancellation/queue limits, secure WAV/ASD lifecycle,
signal-chain diagnosis, consent-bound capture normal/cancel paths, properties,
delivery, receipt-driven install/activation/upgrade/repair/rollback/uninstall,
journey planning/fallback/rights/accessibility contracts, and package
installation. `journey:verify` installs the packed artifact, translates only
allowlisted traits, blocks identity/copy collisions, and drives every `planned`
stage of all five plans through actual tool results. It validates stage/status
ordering, binds events across any explicit replan, records package SHA-256 and
terminal residual state, and covers MIDI/structure/Arrangement, expressive notes,
Browser loading followed by capability replan and published-parameter undo,
standards reference analysis and non-causal Live context,
routing/recording/subscription/realtime contracts, uncertainty, and recovery
with explicit `fake-live` provenance. Real-Live-only capture and host realtime
authority remain unavailable in that evidence rather than being promoted. Python tests cover
the dependency-free Control Surface entrypoint, canonical registry loading and
hashing, authentication, sequencing/replay rejection, main-thread queueing,
fake-Live references, hierarchical discovery, empty clip slots,
shape-dependent operation advertisement, Session playback operations, Session
MIDI, locators, structure, device/parameter validation, track-scoped routing
choices, capture fences/watchdog/emergency/cleanup, and bridge teardown. The
package verifier starts the installed production bridge and checks
authenticated fake Set, scene, track, child-slot, and playback discovery.

CI builds one clean private tarball on Ubuntu 24.04, repeats the pack from a
fresh detached local clone plus fresh `npm ci` and compares bytes, records the exact Git SHA and tarball SHA-256, then installs that same
artifact in every Node 22/24/25 Ubuntu 24.04, macOS 15, and Windows Server 2025
job. Each candidate job verifies strict inventory/hashes and exercises lifecycle
plan/install, unavailable activation, idempotent repair, unowned rollback
refusal, and uninstall; Windows additionally tests native ACL repair, junction
refusal, held-file recovery, and shipped version-2 migration. These remain host/package
contracts.

The operator-only packaged real-Live Phase 8 verifier is not a CI substitute.
After installing an `npm pack` artifact and visibly preparing the disposable
Set/output/destination route, run it with explicit evidence inputs:

```sh
PHASE8_CLI=/absolute/installed/dist/src/cli.js \
PHASE8_TARBALL_SHA=<64-hex-sha256> \
PHASE8_OUTPUT_SAFETY_PROVENANCE='<fresh operator observation>' \
PHASE8_LIVE_VERSION='<visible Live version>' \
  npm run audio:live-verify > /owner-only/path/phase-8-audio-live.json
```

The verifier refuses a missing raw-media directory, non-empty source device
baseline, absent source clip, or destination other than visibly prepared
`No Input`/unarmed/monitoring-off/empty. It verifies cancellation response
suppression while the original host remains alive, kills another host during
capture, requires mapper-watchdog finalization, independently recovers, and
compensates its temporary notes/mixer/device mutations on failure.

The built-in V8 coverage gate measures compiled runtime code (excluding the
separate benchmark-only entrypoints and wall-clock benchmark test, which runs
uninstrumented only in the standalone `npm run benchmark` gate and is deliberately excluded from `npm test` and coverage) and enforces at least 85% lines, 65%
branches, and 84% functions overall, production-module floors, and stronger
thresholds for delivery, lifecycle, host, remote-adapter, project, and Session
MIDI modules. Instrumented timing is not performance evidence. Coverage is a
regression signal, not a substitute
for real-Live, security, recovery, or platform evidence.

The benchmark warms the declared maximum PCM input and reports repeated latency measurements. `audio:oracle` generates temporary PCM, compares BS.1770/EBU and true-peak outputs to FFmpeg `ebur128`, and removes the owner-only temporary tree; it commits no third-party audio. Latency, output size, bounded-memory, DSP-oracle, package, and real-Live evidence are distinct concerns; none substitutes for another.

## What passing means

Passing proves deterministic repository behavior and package contracts. It does not prove a real Control Surface loaded in Ableton Live, a supported Live API shape, visible Set state, audible or realtime behavior, platform installer runtime, accessibility, hardware, signing, notarization, or release publication.

## Change discipline

Add success and fail-closed tests for every new protocol method or Live side
effect. Cover stale epochs/cursors/revisions, expired confirmations,
conflicting idempotency keys, timeouts, cancellation before and after
dispatch, disconnects, lost acknowledgements, partial mutation, compensation
failure, external edits, external playback, and guarded undo. The packaged production journey and tracked real-Live phase evidence must keep
`fake-live`, simulator, and `real-live` provenance distinct. Phase 8 evidence
must include normal capture, controlled recapture, cancellation cleanup, host-
restart watchdog recovery, exact baseline readback, and zero WAV/ASD residuals.
Keep fixtures bounded and privacy-preserving. Never open, copy, stage, package, or
expose the protected local SDK evidence.
