# User guide

This guide describes the implementation in `apps/mcp-server/src`, not the
roadmap. The shipped CLI is local-only and defaults to `UnavailableLiveAdapter`.
The simulator and loopback modules are exported adapter-boundary test
components; they are not selected by the CLI.

## What is available

Build, then run `node dist/src/cli.js` from `apps/mcp-server`. The process accepts newline-delimited
JSON-RPC 2.0 messages on stdin and emits responses on stdout. The MCP
handshake must use protocol version `2025-11-25`.

The lifecycle is `initialize`, followed by the
`notifications/initialized` notification. `ping` is available after
`initialize`; tools require the initialized notification. Notifications do not
produce responses.

After initialization, `tools/list` exposes these tools:

| Tool | Purpose | Live side effects |
| --- | --- | --- |
| `server_status` | Reports host readiness and adapter availability. | None |
| `capabilities` | Reports implemented and unavailable capability families. | None |
| `audio_analyze` | Analyzes supplied PCM and returns aggregate metrics. | None |
| `live_status` | Reports adapter status and epoch. | None |
| `live_snapshot` | Reads a bounded Live Set snapshot through an adapter that negotiated `session.read`. | None when enabled; unavailable with the default adapter |
| `live_tempo_preview` | Previews a tempo change and returns a short-lived transaction. | None |
| `live_tempo_apply` | Applies an unexpired preview after exact confirmation and verifies the authoritative result. | Changes tempo only when a connected adapter negotiated `transport` |
| `live_undo` | Restores a verified applied tempo transaction if epoch and postcondition checks still match. | Changes tempo only when a connected adapter negotiated `transport` |

`audio_analyze` requires `pcmBase64` and `sampleRate`. PCM must be little-endian
float32, normalized to `[-1, 1]`. Optional `channels` defaults to 1 and
`frameSize` defaults to 2048.

## Analysis result

The result includes duration, peak and RMS levels, an RMS-based loudness
estimate (not standards-compliant LUFS),
crest factor, a histogram-based dynamic-range estimate, silence and clipping
ratios, spectral centroid, dominant frequency, analyzed-frame count, and
bounded reversible remediation suggestions. The result also reports hard
performance bounds: no more than 32 spectral frames and a 4,096-point FFT.
The result explicitly reports that raw audio was neither retained nor returned
and that playback and project mutation did not occur.

The analyzer accepts at most 10,000,000 samples and 600 seconds of audio. It
accepts sample rates from 8,000 to 384,000 Hz, 1–32 channels, and frame sizes
from 256–4,096 samples. Invalid input is returned as an MCP tool error.
Input must contain complete interleaved channel frames; the base64 payload is
canonical standard base64 and must decode to finite little-endian float32
samples. Audio calls are limited to 120 per rolling minute.

## Important expectation

The CLI does not currently control Ableton Live. `server_status` and
`live_status` report
`connected: false`, `adapter: "unavailable"`, and
`reason: "live-adapter-not-installed"`. Treat the capability catalog as the
source of truth for what is actually enabled.

## Client configuration and readiness

After building, generate a versioned configuration with:

```sh
npm run setup -- --output /absolute/path/client-config.json
```

Existing files are protected unless `--force` is supplied. Legacy
`{ "command": "...", "args": ["..."] }` files can be converted with
`npm run migrate -- --input /absolute/path/old.json --output /absolute/path/new.json`.
`npm run diagnostics` reports local Node and entrypoint readiness separately
from unavailable Live, signing, and notarization evidence.

## Known limitations

There is no production Live adapter, playback, recording, project mutation,
device access, network transport, filesystem tool, raw-audio return path,
Remote Script installer, signing, or notarization flow. The benchmark command
measures only local host behavior and does not establish realtime, platform, or
Ableton Live performance.
The `npm start` package script launches the stdio server after the package has
been built. You can also use `node dist/src/cli.js` or a generated client
configuration.

The host also exposes read-only resources `ableton://capabilities`,
`ableton://safety`, and `ableton://live-workflow`. The `analyze_audio` prompt
describes the same bounded tool; `change_tempo_safely` describes the guarded
Live sequence. Prompts do not accept audio or grant Live access.

The guarded tempo tools are protocol and adapter-boundary code, but are not
enabled by the default host. The simulator and authenticated loopback modules
are adapter-boundary test components, not a shipped Live connection. The
Python Remote Script is a dependency-free authenticated dispatch shim; it does
not implement a Control Surface entrypoint, socket listener, Live main-thread
scheduler, or documented Live-object mapper.

The simulator can model snapshots, bounded edits, subscriptions, and reconnect
epochs for adapter tests, but it is not selected by the MCP host. Its
`ableton-live/v1` contract and the loopback `ableton-loopback/v1` protocol do
not constitute Live connectivity or permission to use a real set.
