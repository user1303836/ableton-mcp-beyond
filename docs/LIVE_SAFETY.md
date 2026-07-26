# Ableton Live safety

The default is `UnavailableLiveAdapter`: disconnected, no Live I/O, and not selectable by caller metadata, JSON-RPC arguments, a local installation, or simulator output.

## Mutation boundary

Read-only operations are status, capabilities, snapshot, discovery, previews, resources, prompts, and caller-supplied PCM analysis. Confirmed mutation tools are bounded tempo change; named Session MIDI/audio track and scene creation; MIDI clip/note creation in an empty Session slot; Arrangement locator creation; numeric adjustment of an already-discovered published device parameter; and guarded Session scene audition. `live_undo` is guarded and transaction-specific.

Scene audition is potentially audible and is available only through the
asynchronous host path. Preview requires an exact disposable Set name,
authoritative stopped transport, disabled Arrangement and Session recording,
no armed or input-monitored track, no fired or playing Session target, safe
launch quantization, callable `scene.launch`, `session.playback`,
`stop-all-clips`, and `transport.stop` operations, and explicit output-safety
evidence whose provenance is not unknown or simulator-only. Apply rechecks
those conditions, launches exactly one scene, and requires fresh fired/playing
readback. Stop is allowed only for mapper-owned playback, invokes stop-all-
clips and transport-stop once, and verifies the stopped baseline. Any stale,
external, disconnected, cancelled-after-dispatch, failed, or unknown state is
uncertain and must be read back before further action.

Every mutation requires an explicit configured adapter, exact protocol and registry negotiation, fresh authoritative discovery, bounded input, an expiring preview, exact confirmation, idempotency, epoch/revision checks, and post-mutation readback. Structure compensation deletes only objects created by that transaction. Parameter undo refuses when the epoch, parentage, applied value, or revision no longer matches.

No implemented host workflow launches individual clips, inserts or deletes
devices, loads browser results, edits racks/chains, changes routing, starts
recording, controls plug-in UI, captures Live audio, or provides realtime
performance authority. Scene audition does not provide general clip launch or
recording control.

## Bridge safety

The bridge is loopback-only and uses a separate owner-controlled secret. Requests and responses are HMAC-authenticated, canonicalized, sequenced, and bounded. Socket workers do not access Live objects; the scheduled Control Surface callback drains Live work on the main thread. Shutdown releases listeners, clients, workers, queued work, subscriptions, and epoch-bound references. A reconnect creates a fresh epoch.

## Real-Live boundary

The Python mapper is version-tolerant and omits unsupported shapes. It can expose parent-scoped hierarchical discovery, empty clip slots, playback fields, and shape-dependent mutation operations when the observed object supplies the required attributes. Fake-Live objects and deterministic tests prove mapper and transaction contracts, not a real Live version, visible values, undo grouping, automation behavior, armed/monitoring safety, audible output, or restoration. No disposable Set, Live runner, audio device, hardware controller, accessibility runner, signing identity, or notarization credential is established by this checkout. Unknown preconditions remain unavailable evidence.

If observed behavior conflicts with `server_status`, `live_status`, `capabilities`, or fresh discovery, stop the client, preserve redacted evidence, inspect the Set, and treat the discrepancy as a defect.
