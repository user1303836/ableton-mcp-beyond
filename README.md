# Ableton MCP Beyond

**Give your AI agent real, safety-first control of Ableton Live 12 — Session and
Arrangement, devices, mixer, browser, recording — plus standards-based audio
analysis, all over the Model Context Protocol.**

![Node 22 | 24 | 25](https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2025-339933)
![MCP 2025-11-25](https://img.shields.io/badge/MCP-2025--11--25-blue)
![Ableton Live 12](https://img.shields.io/badge/Ableton%20Live-12-5b2ee5)

A Node.js MCP host (76 tools, stdio JSON-RPC) that talks to Live through an
authenticated, HMAC-sealed loopback bridge and a Python Remote Script
(`AbletonMcpBridge`). Developed and verified against **Live 12.4.5b8 (beta)**.
Without an explicit bridge configuration it is **fail-closed**: it never reads
or touches your Set.

## See it work — no Live required

```sh
cd apps/mcp-server
npm ci && npm run build
npm run demo
```

This drives a real MCP session against the server: handshake, full tool
catalog, fail-closed status, a live `audio_analyze` run on a synthesized tone,
and a generated beat-making plan.

<details>
<summary><b>Actual demo output</b></summary>

```text
▶ initialize (MCP protocol 2025-11-25)
  server: {"name":"ableton-mcp-host","version":"1.0.0"}

▶ tools/list
  tools exposed: 76
  server_status, capabilities, plan_user_journey, audio_analyze, … live_undo, live_recovery_finalize

▶ server_status + live_status (no Live configured → fail-closed)
  server_status: {"host":"ready","live":{"connected":false,"adapter":"unavailable", … }}
  live_status.adapter: "unavailable"

▶ audio_analyze: 2 s 440 Hz sine @ 48 kHz → BS.1770-5 loudness, true peak, spectra
  peak / rms: "-6.02 dBFS / -9.03 dBFS"
  BS.1770-5 integrated loudness: "-9.71 LUFS (standardsCompliant: true)"
  BS.1770-5 Annex 2 true peak: "-6.008 dBTP (ITU-R BS.1770-5 Annex 2 order-48 four-phase FIR)"

▶ plan_user_journey: beat-making plan
  journey: "create-beat-or-song"
  stages: ["discover","draft","preview-create","apply-create","arrange",
           "arrange-edit","audition","revise","final-readback"]

▶ done — no Live instance was read or changed
```

</details>

## Quick start

**Requirements:** Node.js 22, 24, or 25 (all exercised in CI). Ableton Live 12
for the bridge; the host, tests, and demo run without it.

```sh
cd apps/mcp-server
npm ci
npm test          # full build + test suite
npm start         # serve MCP over stdio
```

**1. Point your MCP client at the server.** Generate a client config:

```sh
npm run setup -- --output /absolute/path/client-config.json
```

**2. Connect Live.** Create a strong owner-only secret, then generate a
bridge configuration:

```sh
npm run setup -- --output /absolute/path/bridge-config.json \
  --bridge-host 127.0.0.1 --bridge-port 9000 \
  --secret-file /absolute/path/bridge.secret --bridge-timeout 5000
```

**3. Install the Remote Script** into a Live Control Surface folder
(dry-run first; refuses symlink trees and overwrites by default):

```sh
node dist/src/install-remote-script.js --destination '/absolute/path/to/Live/Remote Scripts/AbletonMcpBridge' --dry-run
```

**4. Restart Live, then verify** the authenticated end-to-end path:

```sh
npm run diagnostics -- --config /absolute/path/bridge-config.json
```

The full mutation sequence, safety model, and client-facing tool reference:
[`docs/USER_GUIDE.md`](docs/USER_GUIDE.md).

## What your agent gets

- **Deep Live control, both views.** Transport, Session clips/scenes/slots,
  Arrangement clips and locators, MIDI notes (add/update/delete), mixer,
  Session automation, routing, recording, project info/save/open/backup, and
  live subscriptions.
- **Real device mastery.** Recursive discovery of racks, chains, pads, and
  macros; guarded parameter changes with bounds/quantization checks; Browser
  search and guarded device loading.
- **Standards-based audio intelligence — even without Live.** `audio_analyze`
  returns ITU-R BS.1770-5 / EBU R128 loudness, LRA, and validated true peak
  (Tech 3341/3342), plus spectral, transient, dynamics, and clipping summaries.
  `audio_compare_reference` aligns and level-matches your mix against a
  reference track. PCM is analyzed in an isolated, cancellable worker and raw
  audio is never returned.
- **Consent-bound Live audio capture.** When the authenticated bridge reports
  `real-live`, the agent can resample one exact source clip into an empty slot,
  analyze it internally, then delete every trace — with a 10-second Live-side
  watchdog and emergency-stop recovery.
- **Realtime control.** A separately armed, token-fenced UDP/OSC/XY channel for
  low-latency parameter rides — with verified writes, replay protection, and an
  independent TCP emergency stop.
- **Capability-aware journeys.** `plan_user_journey` (plus MCP prompts and the
  `ableton://journeys` resource) turns "make a dusty lo-fi beat" into an
  ordered, confirmable plan — beat/song creation, advanced drums, sound design,
  reference mixing, or performance diagnosis — that degrades truthfully when a
  capability isn't negotiated.

## Built to never wreck your Set

Every mutation follows the same protocol: **fresh discovery → read-only
preview → exact confirmation → one-use apply → authoritative verification →
guarded undo.** Idempotency keys, bridge/Live epoch fencing, and an
execution ledger make retry storms and lost acknowledgements safe to
reconcile. Arbitrary device or Arrangement-clip deletion is *refused* — the
server only cleans up what it created, and can prove it. Configuration,
secrets, and Remote Script installation can never be smuggled in through MCP
tool arguments. See [`docs/LIVE_SAFETY.md`](docs/LIVE_SAFETY.md).

## Compatibility

| Surface | Status |
|---|---|
| Node.js 22 / 24 / 25 | Supported (CI-tested) |
| macOS + Live 12.4.5b8 beta | Verified engineering target (`docs/evidence/`) |
| macOS + Live 12 Suite / Standard / Intro | Runtime-negotiated; missing content stays unavailable |
| Windows host | CI-tested; Windows 11 + Live not yet certified |
| Linux / Live 11 or earlier | Unsupported |

The capability catalog is negotiated at connect time, so your agent always
knows exactly what this Live installation can do — unsupported shapes report
as unavailable instead of failing mid-mutation. Full matrix:
[`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md).

## Documentation

| Doc | What it covers |
|---|---|
| [USER_GUIDE](docs/USER_GUIDE.md) | Tool list, mutation workflow, resources, prompts |
| [LIVE_SAFETY](docs/LIVE_SAFETY.md) | The real-Live safety boundary |
| [OPERATIONS](docs/OPERATIONS.md) / [RECOVERY](docs/RECOVERY.md) | Supervision, failure handling, uncertain-state recovery |
| [AUDIO_INTELLIGENCE](docs/AUDIO_INTELLIGENCE.md) | DSP standards, capture consent, privacy limits |
| [USER_JOURNEYS](docs/USER_JOURNEYS.md) | The five guided composition workflows |
| [REALTIME_CONTROL](docs/REALTIME_CONTROL.md) | The armed UDP/OSC/XY control plane |
| [CAPABILITY_MATRIX](docs/CAPABILITY_MATRIX.md) | Per-tool capability and operation requirements |
| [DELIVERY](docs/DELIVERY.md) / [DISTRIBUTION_POLICY](docs/DISTRIBUTION_POLICY.md) | Install, upgrade, rollback, and uninstall of packed artifacts |
| [IMPLEMENTATION_STATUS](docs/IMPLEMENTATION_STATUS.md) | What's verified and what's still limited |

## Development

```sh
npm test                 # build + unit/integration/property tests
npm run benchmark        # isolated performance gates
npm run package:verify   # verify the packed artifact
```

Open source under the [MIT License](LICENSE.md). Ableton Live is a trademark
of Ableton AG; this project is not affiliated with or endorsed by Ableton AG.
