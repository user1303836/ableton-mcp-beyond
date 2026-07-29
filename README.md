# Ableton MCP Beyond

A safety-first MCP host for bounded Ableton Live integration.

The server speaks newline-delimited JSON-RPC over stdio. Without `--config`,
it uses `UnavailableLiveAdapter`; no Live state is read or changed. With an
explicit validated version-2 configuration, the packaged CLI connects to the
loopback `AbletonMcpBridge` over the authenticated `ableton-loopback/v1`
transport.

## Quick start

Requirements: Node.js 22, 24, or 25 (all three are exercised in CI).

```sh
cd apps/mcp-server
npm ci
npm test
npm start
```

The MCP executable is `dist/src/cli.js`. It accepts one JSON-RPC message per
line on stdin and writes only JSON-RPC responses to stdout. Initialize with
protocol version `2025-11-25`, then send `notifications/initialized`.

For the client-facing tool list and mutation sequence, see
[`docs/USER_GUIDE.md`](docs/USER_GUIDE.md). For supervision and failure
handling, see [`docs/OPERATIONS.md`](docs/OPERATIONS.md) and
[`docs/RECOVERY.md`](docs/RECOVERY.md).

The source-controlled operation contract is
[`protocol/ableton-live-v1.operations.json`](protocol/ableton-live-v1.operations.json).
The bridge negotiates its canonical SHA-256 before serving Live operations. The current host surface includes bounded discovery; guarded Session and
Arrangement lifecycles; transport, MIDI, mixer, automation, devices/racks,
Browser, routing, recording, projects, subscriptions, realtime control;
standards audio/reference intelligence; and consent-bound real-Live Resampling
capture. The Python mapper supports bounded,
epoch-scoped discovery for the observed hierarchy, including regular/group,
return and main tracks, scenes, parent-scoped clip slots and clips, notes,
locators, devices, parameters, selection, routing choices, and Session
playback. Unsupported or unobserved Live shapes remain unavailable.

Build a host-only client configuration:

```sh
npm run build
npm run setup -- --output /absolute/path/client-config.json
```

To enable the bridge, create a strong owner-only secret separately, then
generate a version-2 configuration:

```sh
npm run setup -- --output /absolute/path/bridge-config.json \
  --bridge-host 127.0.0.1 --bridge-port 9000 \
  --realtime-port 9001 \
  --secret-file /absolute/path/bridge.secret --bridge-timeout 5000
```

The generated version-2 client entry includes `--config
/absolute/path/bridge-config.json`; the secret remains in its separate
owner-only file and is never placed in client arguments. `--realtime-port` is
optional; when present it enables only the separately armed loopback control
plane documented in [`docs/REALTIME_CONTROL.md`](docs/REALTIME_CONTROL.md).

The CLI loads a bridge only when `--config /absolute/path/bridge-config.json`
is supplied. Configuration, secret, and Remote Script installation are never
selected from JSON-RPC arguments or client metadata.

For an installed artifact, run `npm run diagnostics -- --config
/absolute/path/bridge-config.json`. Diagnostics validate the package manifest's
raw asset hashes and canonical registry hash, then perform authenticated,
bounded Set, scene, track, child clip-slot, and Session-playback discovery.
They report adapter operations separately from capabilities. `fake-live`,
simulator, unavailable, and unknown provenance remain non-passing evidence for
`liveConnected`, real Live state, audible state, or restoration.

Private installed artifacts use the receipt-driven lifecycle CLI for exact
install, manual activation verification, upgrade, repair, rollback, status, and
ownership-safe uninstall:

```sh
ableton-mcp-lifecycle install \
  --remote-scripts-dir '/absolute/path/to/Live/Remote Scripts' \
  --state-dir '/absolute/owner-only/ableton-mcp' \
  --package-root '/absolute/installed/package/root' \
  --artifact '/absolute/path/to/exact-candidate.tgz' \
  --artifact-sha256 '<exact-tarball-sha>'
```

Omit `--apply` for a plan. Mutating install/upgrade/rollback/uninstall also
require `--confirm-live-stopped`; the tool never guesses a Live path, kills
Live, follows symlink/junction ancestors, deletes drift, or claims activation
without authenticated `real-live` discovery. See
[`docs/DELIVERY.md`](docs/DELIVERY.md),
[`docs/DISTRIBUTION_POLICY.md`](docs/DISTRIBUTION_POLICY.md),
[`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md),
[`docs/CAPABILITY_MATRIX.md`](docs/CAPABILITY_MATRIX.md), and
[`docs/LIVE_SAFETY.md`](docs/LIVE_SAFETY.md).

Scene audition is a potentially audible workflow. Preview is read-only and
requires an exact Set name, authoritative stopped/non-recording playback,
unarmed and non-input-monitored tracks, safe launch quantization, callable
launch/stop operations, and explicit output-safety evidence. Apply requires
the returned confirmation and idempotency key, verifies fresh playback, and
must be stopped with the returned stop confirmation. It is not real-Live
evidence unless a real authenticated bridge and disposable Set have been
independently established.

## Capability-aware journeys

`plan_user_journey`, `ableton://journeys`, and five matching MCP prompts expose
bounded beat/song, advanced-drum, sound-design, reference-mix, and
recording/performance-diagnosis plans. Plans negotiate the current epoch,
capabilities, operations, and provenance; contain no mutation authority; use
ordered non-color progress text; stop at purpose-specific confirmation gates;
and include verification, recovery, accessibility, and truthful per-stage
fallback. Only allowlisted high-level traits influence derived guidance;
artist/song identity and exact-copy wording is excluded, and a copy-only request
requires clarification—never an exact-replication or legal-clearance claim. See
[`docs/USER_JOURNEYS.md`](docs/USER_JOURNEYS.md).

## Audio intelligence

`audio_analyze` runs caller PCM in a cancellable secret-stripped worker and
returns privacy-bounded `pcm-analysis/v2` summaries, including ITU-R BS.1770-5,
EBU R128/Tech 3341/3342 loudness/LRA and validated 44.1/48 kHz true peak.
`audio_compare_reference` adds bounded band-limited resampling,
coarse-to-fine/manual alignment, standards level matching, and aggregate deltas.
`audio_diagnose_live_context` links measurements to fresh refs without claiming
that caller PCM came from Live or that an observed device caused a result.

When—and only when—the installed authenticated bridge reports `real-live` and
`audio.capture.resampling`, `live_audio_capture_preview/apply` can record one
exact source through Live's Resampling input into one exact empty audio slot.
It requires explicit ephemeral consent and output safety, has a ten-second
Live-side watchdog and post-restart emergency recovery, analyzes a fresh
bounded WAV internally, deletes the owned clip, and unlinks the WAV/ASD without
returning raw audio or its path. See
[`docs/AUDIO_INTELLIGENCE.md`](docs/AUDIO_INTELLIGENCE.md).

## Evidence boundary

The deterministic simulator, Python fake-Live mapper, package smoke tests,
benchmarks, and authenticated loopback tests are contract evidence only. They
do not prove a real Ableton Live version, disposable Set, audio device,
hardware, accessibility, signing, notarization, or installer-runtime result.
Tracked evidence distinguishes those contracts from macOS Live 12.4.5b8
observations through Phase 8; it is not Windows Live, signing, notarization, or
publication proof. Current limitations are recorded in
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md), and the
real-Live safety boundary is in [`docs/LIVE_SAFETY.md`](docs/LIVE_SAFETY.md).
