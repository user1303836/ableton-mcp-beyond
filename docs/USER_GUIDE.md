# User guide

This guide describes the implemented MCP surface. The default process is
fail-closed and uses `UnavailableLiveAdapter`.

## Start and initialize

```sh
cd apps/mcp-server
npm ci
npm run build
node dist/src/cli.js
```

Use `node dist/src/cli.js --config /absolute/path/bridge-config.json` only
after creating and validating a version-2 configuration. The MCP lifecycle is
`initialize` with protocol `2025-11-25`, followed by the
`notifications/initialized` notification. Notifications have no response.

## Tools

| Tool | Behavior | Mutation |
| --- | --- | --- |
| `server_status` | Host and adapter status. | None |
| `capabilities` | Implemented and unavailable capability catalog. | None |
| `audio_analyze` | Bounded analysis of caller-supplied PCM. | None |
| `live_status` | Adapter protocol, epoch, connection, and capabilities. | None |
| `live_snapshot` | Bounded authoritative snapshot when `session.read` is negotiated. | None |
| `live_discover` | Bounded paged track, scene, clip, note, or locator discovery. | None |
| `live_session_structure_preview` | Read-only plan for named MIDI/audio tracks and scenes. | None |
| `live_session_structure_apply` | Confirmed, idempotent track/scene creation with verification. | Creates tracks/scenes |
| `live_midi_clip_preview` | Read-only Session MIDI clip preview. | None |
| `live_midi_clip_apply` | Confirmed, idempotent MIDI clip creation with verification. | Creates a clip and notes |
| `live_arrangement_section_preview` | Read-only named start/end locator preview. | None |
| `live_arrangement_section_apply` | Confirmed locator creation with compensation and verification. | Creates locators |
| `live_tempo_preview` | Read-only tempo transaction preview. | None |
| `live_tempo_apply` | Confirmed tempo change with postcondition verification. | Changes tempo |
| `live_undo` | Guarded undo for structure, tempo, MIDI, or Arrangement transactions. | Reverts a prior mutation |

Live tools remain unavailable unless the adapter reports the exact
`ableton-live/v1` protocol, `connected: true`, a non-null epoch, and the
required negotiated capability.

## Safe workflows

For any mutation: read status, discover current state, preview, confirm with
the exact confirmation value, supply a fresh bounded idempotency key, verify
authoritative state, and undo only if the captured epoch and postcondition
still match. Session structure accepts bounded named MIDI/audio tracks and
scenes; it does not mutate clips, devices, routing, transport, or existing
objects. Arrangement section apply creates two distinct locators within
`0..100000`, requires `start < end`, rejects name/position collisions, and
compensates a partial creation where possible.

If a response is lost after a mutation may have been sent, treat the result as
uncertain. Read the current authoritative state before retrying; never blindly
retry. A reconnect changes the epoch and invalidates old references and
transaction inputs.

## Audio analysis

`audio_analyze` accepts canonical base64 little-endian float32 PCM only. Limits
are 8,000–384,000 Hz, 1–32 channels, 256–4,096 frame size, 10,000,000 samples,
and 600 seconds. Results include aggregate and per-channel peak/RMS/DC/clipping
metrics, a bounded 256-bin waveform envelope, up to 32 Hann-windowed FFT
frames with 24 logarithmic bands, and a bounded transient summary. Outputs are
lossy aggregates: no raw PCM is retained or returned. The loudness value is an
RMS-derived proxy, not LUFS or true peak.

## Configuration and installation

`npm run setup -- --output <path>` writes a protected version-1 host config.
Adding `--bridge-host`, `--bridge-port`, `--secret-file`, and optionally
`--bridge-timeout` writes version 2. Host-only files can be migrated with
`npm run migrate -- --input <old> --output <new>`. Existing files require
`--force`; symlinks, unknown fields, non-loopback hosts, invalid ports, and
unsafe or missing secrets are rejected.

Install the packaged Remote Script only to an explicit destination. The
installer copies `AbletonMcpBridge/__init__.py`, the bridge module, and a
manifest with hashes; it does not choose a Live folder automatically.

When a bridge configuration is supplied to the installer, it also writes the
non-secret `bridge-reference.json` beside the package. The reference points to
the separate host configuration; the secret remains outside the package.

## Resources and prompts

Read-only resources are `ableton://capabilities` and `ableton://safety`.
Prompts are `analyze_audio` and `change_tempo_safely`; prompts describe a
workflow and do not grant authority.
