# User guide

## What is available

Run `npm start` from `apps/mcp-server`. The process accepts newline-delimited
JSON-RPC 2.0 messages on stdin and emits responses on stdout. The MCP
handshake must use protocol version `2025-11-25`.

After initialization, the available tools are:

| Tool | Purpose | Live side effects |
| --- | --- | --- |
| `server_status` | Reports host readiness and adapter availability. | None |
| `capabilities` | Reports implemented and unavailable capability families. | None |
| `audio_analyze` | Analyzes supplied PCM and returns aggregate metrics. | None |

`audio_analyze` requires `pcmBase64` and `sampleRate`. PCM must be little-endian
float32, normalized to `[-1, 1]`. Optional `channels` defaults to 1 and
`frameSize` defaults to 2048.

## Analysis result

The result includes duration, peak and RMS levels, an RMS-based LUFS estimate,
crest factor, a histogram-based dynamic-range estimate, silence and clipping
ratios, spectral centroid, dominant frequency, analyzed-frame count, and
bounded reversible remediation suggestions. The result also reports hard
performance bounds: no more than 32 spectral frames and a 4,096-point FFT.
The result explicitly reports that raw audio was neither retained nor returned
and that playback and project mutation did not occur.

The analyzer accepts at most 10,000,000 samples and 600 seconds of audio. It
accepts sample rates from 8,000 to 384,000 Hz, 1–32 channels, and frame sizes
from 256–4,096 samples. Invalid input is returned as an MCP tool error.

## Important expectation

The server does not currently control Ableton Live. `server_status` reports
`connected: false`, `adapter: "unavailable"`, and
`reason: "live-adapter-not-installed"`. Treat the capability catalog as the
source of truth for what is actually enabled.
