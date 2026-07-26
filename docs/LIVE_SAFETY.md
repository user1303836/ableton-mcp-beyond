# Ableton Live safety

This document is a safety boundary for the shipped host. It does not grant
authority to a real Live process and cannot turn unavailable evidence into a
passing integration result.

## Current guarantee

The shipped default adapter is `UnavailableLiveAdapter`. It always reports
`connected: false`, `adapter: "unavailable"`, and
`reason: "live-adapter-not-installed"`. No current tool starts playback,
records, edits a project, changes routing, accesses the filesystem or network,
or returns raw audio.

The Live tools are present in `tools/list`, but `live_status`,
`live_snapshot`, `live_tempo_preview`, `live_tempo_apply`, and `live_undo`
return safe unavailable errors with the default adapter. They do not become
enabled from client metadata.

`audio_analyze` operates only on PCM supplied in the request. It returns
aggregates and remediation suggestions; remediation entries are marked
reversible and `changesAudio: false`. Suggestions are advisory and never apply
gain, limiting, deletion, or other edits automatically.

The analyzer also reports privacy and safety fields showing that raw audio was
not returned or retained and that the project was not mutated. These fields are
claims about this local code path, not proof that an unavailable external Live
process was inspected.

The safe operating assumption is therefore offline analysis only: the input
must be supplied as bounded PCM by the caller, and the returned remediation is
advisory. A successful MCP handshake, a supported Node platform, or a local
Ableton installation does not change the adapter status or authorize Live
access.

## Capability boundary

The unavailable catalog includes Live mutations, transport, recording, routing,
audio, MIDI, realtime features, resource subscriptions, filesystem, network,
delivery, and Live audio analysis. Do not infer capability from roadmap prose,
caller-supplied authority fields, or a local Ableton installation.

## Future adapter requirements

Before adding a Live adapter, require explicit capability negotiation, read-only
defaults, confirmation for every mutation, reversible operations where possible,
bounded inputs, clear status/epoch reporting, and tests that prove failure does
not alter Live state. The existing tempo workflow is the minimum mutation
pattern: preview, explicit confirmation, idempotency, authoritative
postcondition verification, epoch checks, and guarded undo. Add recovery
instructions and update the capability catalog in the same change. Missing
Live, device, platform, signing, or runner evidence is unavailable—not a pass.

## Operational stop rule

If observed client or device behavior contradicts `server_status` or the
capability catalog, stop the client and treat the discrepancy as a defect. Do
not enable a caller-supplied authority field or continue testing against a
Live set until the implementation and recovery path have been reviewed.

Missing Live, device, platform-runner, signing, or notarization evidence is an
explicit limitation, not a safety pass. Do not promote any unavailable
capability based on documentation, environment detection, or caller metadata.

The repository also contains a deterministic simulator with a broader adapter
contract and an HMAC-authenticated `ableton-loopback/v1` boundary. Both are
development/test components. The Python Remote Script shim likewise does not
enable those capabilities in the MCP host or prove that Live is installed.

When testing a future adapter, treat the loopback secret as a credential, use
localhost-only transport, reject replayed or tampered messages, and verify the
status epoch after reconnect. Never place secrets, raw PCM, or Live project
data in protocol logs or documentation.

The simulator's connected status is intentionally scoped to its in-memory test
state. It must not be copied into production status, used as a proxy for Live,
or treated as proof that a Control Surface callback, localhost transport, or
device is present.
