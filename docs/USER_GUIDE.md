# User guide

Ableton MCP Beyond is a fail-closed MCP host. With no explicit configuration it uses `UnavailableLiveAdapter`; it does not inspect or change Live. A configured bridge is accepted only after loopback, secret, protocol, operation-registry hash, and status negotiation succeed.

## Start

Requirements: Node.js 22 or newer. Node 20 is end-of-life and is not a
supported runtime for this package.

```sh
cd apps/mcp-server
npm ci
npm run build
node dist/src/cli.js
```

For an explicitly configured bridge:

```sh
node dist/src/cli.js --config /absolute/path/bridge-config.json
```

The only accepted CLI option is one `--config PATH`. Secrets, endpoints, adapters, and capabilities cannot be selected through MCP arguments or client metadata. Initialize JSON-RPC with protocol `2025-11-25`, then send `notifications/initialized`.

## Read-only tools

- `server_status` and `capabilities` report host state and the negotiated catalog.
- `live_status` reports protocol, adapter, epoch, registry hash, operations, and connection state.
- `live_snapshot` returns a bounded set snapshot when `session.read` is negotiated. Treat fallback values in a fake or incomplete Live shape as unavailable evidence, not proof of Live state.
- `live_discover` currently accepts `track`, `scene`, `clip`, and `note` on the MCP host and uses bounded paging. The Python mapper additionally accepts `set`/`song`, `group_track`, `return_track`, `main_track`, `clip_slot`, `session_clip`, `arrangement_clip`, `locator`, `device`, `parameter`, `selection`, `routing_choice`, and `session_playback`, with optional parent, filters, requested fields, traversal budget, and opaque epoch-bound cursors. These extra mapper kinds are not all reachable through the current host tool.
- `audio_analyze` accepts caller-supplied little-endian float32 PCM and returns bounded aggregate, waveform, logarithmic-band, and transient summaries. It never captures Live audio or returns raw samples.

## Mutation workflow

All Live mutations require a connected negotiated adapter, fresh discovery, a read-only preview, exact confirmation, a bounded idempotency key, epoch/revision checks, and authoritative postcondition verification. Implemented workflows are:

- `live_device_parameter_preview` and `live_device_parameter_apply` for an already-discovered enabled numeric parameter on an authoritative device. Bounds, finite values, quantization, parentage, and revisions are checked; guarded undo is performed through `live_undo`.
- `live_session_structure_preview/apply` for bounded named MIDI/audio track and scene creation. Existing objects, clips, devices, routing, transport, and recording are not changed.
- `live_midi_clip_preview/apply` for a bounded MIDI clip in an empty Session slot, including normalized notes.
- `live_arrangement_section_preview/apply` for two named locators in a bounded non-colliding range.
- `live_tempo_preview/apply` for a bounded tempo change.
- `live_undo` for an applied transaction whose epoch and verified postcondition still match.

Preview records expire after 30 seconds. A lost acknowledgement, timeout, disconnect, failed verification, or failed compensation is uncertain state: stop mutation, read authoritative state, and do not blindly retry. An epoch change invalidates old references, cursors, previews, confirmations, idempotency inputs, and undo inputs. The current host does not implement the planned scene-audition preview/apply/stop workflow.

## Configuration and installation

Build first, then create a host-only configuration:

```sh
npm run setup -- --output /absolute/path/client-config.json
```

For a bridge configuration, create a separate owner-only secret file and run:

```sh
npm run setup -- --output /absolute/path/bridge-config.json \
  --bridge-host 127.0.0.1 --bridge-port 9000 \
  --secret-file /absolute/path/bridge.secret --bridge-timeout 5000
```

Version 2 writes the explicit `--config PATH` argument. The secret is never placed in client arguments, the package, the Remote Script reference, logs, or diagnostics. Paths must be explicit, safe, non-symlink paths; hosts must be loopback; secrets must be strong and owner-controlled.

Install only to an explicitly selected destination:

```sh
npm run build
node dist/src/install-remote-script.js --destination /absolute/path/ControlSurface --dry-run
```

The installer refuses symlink trees and overwrite by default. `--force` is for a known recoverable destination only. See `LIVE_SAFETY.md`, `OPERATIONS.md`, and `RECOVERY.md` before connecting to Live.

## Resources and prompts

Read-only resources include `ableton://capabilities`, `ableton://safety`, and the safe tempo workflow. Prompts prepare requests; they do not grant mutation authority. No resource or prompt authorizes scene launch, recording, routing, or audio capture.
