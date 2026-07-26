# Ableton Live safety

The default is `UnavailableLiveAdapter`: disconnected, no Live I/O, and not selectable by caller metadata, JSON-RPC arguments, a local installation, or simulator output.

## Mutation boundary

Read-only operations are status, capabilities, snapshot, discovery, previews, resources, prompts, and caller-supplied PCM analysis. Confirmed mutation tools are bounded tempo change; named Session MIDI/audio track and scene creation; MIDI clip/note creation in an empty Session slot; Arrangement locator creation; and numeric adjustment of an already-discovered published device parameter. `live_undo` is guarded and transaction-specific. Scene-audition preview/apply/stop is not implemented in the current host and must not be represented as available.

Every mutation requires an explicit configured adapter, exact protocol and registry negotiation, fresh authoritative discovery, bounded input, an expiring preview, exact confirmation, idempotency, epoch/revision checks, and post-mutation readback. Structure compensation deletes only objects created by that transaction. Parameter undo refuses when the epoch, parentage, applied value, or revision no longer matches.

No implemented host workflow launches scenes or individual clips, stops clips, inserts or deletes devices, loads browser results, edits racks/chains, changes routing, starts recording, controls plug-in UI, captures Live audio, or provides realtime performance authority.

## Bridge safety

The bridge is loopback-only and uses a separate owner-controlled secret. Requests and responses are HMAC-authenticated, canonicalized, sequenced, and bounded. Socket workers do not access Live objects; the scheduled Control Surface callback drains Live work on the main thread. Shutdown releases listeners, clients, workers, queued work, subscriptions, and epoch-bound references. A reconnect creates a fresh epoch.

## Real-Live boundary

The Python mapper is version-tolerant and omits unsupported shapes. It can expose parent-scoped hierarchical discovery, empty clip slots, playback fields, and shape-dependent mutation operations when the observed object supplies the required attributes. Fake-Live objects and deterministic tests prove mapper and transaction contracts, not a real Live version, visible values, undo grouping, automation behavior, armed/monitoring safety, audible output, or restoration. No disposable Set, Live runner, audio device, hardware controller, accessibility runner, signing identity, or notarization credential is established by this checkout. Unknown preconditions remain unavailable evidence.

If observed behavior conflicts with `server_status`, `live_status`, `capabilities`, or fresh discovery, stop the client, preserve redacted evidence, inspect the Set, and treat the discrepancy as a defect.
