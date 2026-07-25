# Ableton Live safety

## Current guarantee

The shipped default adapter is `UnavailableLiveAdapter`. It always reports
`connected: false`, `adapter: "unavailable"`, and
`reason: "live-adapter-not-installed"`. No current tool starts playback,
records, edits a project, changes routing, accesses the filesystem or network,
or returns raw audio.

`audio_analyze` operates only on PCM supplied in the request. It returns
aggregates and remediation suggestions; remediation entries are marked
reversible and `changesAudio: false`. Suggestions are advisory and never apply
gain, limiting, deletion, or other edits automatically.

## Capability boundary

The unavailable catalog includes Live mutations, transport, recording, routing,
audio, MIDI, realtime features, resource subscriptions, filesystem, network,
delivery, and Live audio analysis. Do not infer capability from roadmap prose,
caller-supplied authority fields, or a local Ableton installation.

## Future adapter requirements

Before adding a Live adapter, require explicit capability negotiation, read-only
defaults, confirmation for every mutation, reversible operations where possible,
bounded inputs, clear status/epoch reporting, and tests that prove failure does
not alter Live state. Add recovery instructions and update the capability
catalog in the same change. Missing Live, device, platform, signing, or runner
evidence is unavailable—not a pass.
