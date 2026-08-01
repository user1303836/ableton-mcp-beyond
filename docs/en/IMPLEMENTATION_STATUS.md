# Implementation status

English · [简体中文](../zh-CN/IMPLEMENTATION_STATUS.md) · [日本語](../ja/IMPLEMENTATION_STATUS.md)

What the current branch implements and verifies, and where the honest limits
are. Source, schemas, and tests are the final authority.

## Implemented and verified

- Strict newline-delimited JSON-RPC MCP host (`2025-11-25`) with bounded
  framing/concurrency, ordered backpressure-aware output, cancellation,
  duplicate-ID rejection, redacted diagnostics, and a fail-closed default
  adapter.
- Explicit host/bridge configuration, owner-only separate secrets, loopback
  enforcement, migration, setup, diagnostics, and atomic Remote Script
  installation with recoverable backup.
- Authenticated `ableton-loopback/v1` bridge with connection challenge and
  bridge epoch binding, canonical HMAC frames, replay/deadline fencing, bounded
  Live-main-thread dispatch, epoch-scoped refs/cursors, signed subscriptions,
  canonical registry negotiation, and a read-only preflight → unpredictable
  confirmation → one-use mutation authority protocol. Stable transaction-scoped
  replay keys include canonical argument digests, and the bounded bridge-epoch
  executed-result ledger survives TCP response loss without conflating steps or
  transactions. Exact same-key reconciliation requires unchanged bridge/Live
  epochs; verified transactions retire their ledger entries.
- Real-Live discovery and guarded lifecycle evidence for Live 12.4.5b8:
  transport; Session clip launch/stop/emergency stop; MIDI notes and clips;
  Arrangement clips and locators; mixer; Session automation; nested devices,
  racks/chains/pads/macros; Browser search/load; routing; Session and
  Arrangement recording; project path/manifest/backup; subscriptions; and
  realtime UDP JSON/OSC/XY plus bounded `max`-label extension packets (not a
  Max capability).
- Application view control (Session/Arranger switching, Arrangement
  zoom/scroll/follow, track collapse), next/previous locator playhead
  navigation, clip mute/color/MIDI-loop editing, and file-backed Arrangement
  audio import, each with preview/confirm/verify transactions and guarded undo
  where state is recoverable. These are verified at the host, simulator,
  Python contract, and packaged fake-Live levels; exact-candidate real-Live
  proof is pending.
- Warp-marker reads and native add/move/delete addressed by beat time with
  collection fencing and exact rollback; Session audio import with explicit
  file authority (allowed roots, canonical paths, size/type checks, SHA-256
  with apply-time re-verification, and transaction-owned cleanup); clip crop,
  loop/region duplication, scrub, and playing-position moves; note
  read-by-ID/selected, targeted duplication, and time/pitch quantization with
  exact prior-content undo; and counted, presence-fenced clearing of all clip
  envelopes. Content-destroying actions (crop, envelope clear) are honestly
  non-undoable. Verified at the host, simulator, Python contract, and packaged
  fake-Live levels; exact-candidate real-Live proof is pending.
- Take-lane discovery under `Track.take_lanes` with bounded rows and
  stable-in-snapshot references, lane creation and rename, MIDI and
  file-backed audio clip creation inside lanes, and `is_take_lane_clip`
  exposure on clip rows. The public LOM exposes no take-lane deletion and no
  comp-region editing; lane and lane-clip creation is therefore honestly
  non-compensatable, and comp editing stays unavailable. Verified at the host,
  simulator, Python contract, and packaged fake-Live levels; exact-candidate
  real-Live proof is pending.
- `Song.tuning_system` and scale state exposure (name, note range, reference
  pitch, pseudo-octave cents, and all 128 note tunings, plus root note, scale
  name/mode, and intervals) with full-state revision fencing, length/range
  validation, exact rollback, and full-state restore through `live_undo`.
  Tuning edits affect playback pitch globally and say so. Verified at the
  host, simulator, Python contract, and packaged fake-Live levels;
  exact-candidate real-Live proof is pending.
- `Song.groove_pool` and `groove_amount` exposure with pool discovery and
  read/write of groove name, base, quantization/random/timing/velocity
  amounts, plus `Clip.groove` assignment and `Clip.has_groove` on clip rows.
  Amount and groove edits restore exactly through `live_undo`; clip groove
  assignment rides the clip-properties transaction. The public API provides
  no complete groove import/extract workflow, so grooves must already exist
  in the pool — documented, not worked around. Verified at the host,
  simulator, Python contract, and packaged fake-Live levels; exact-candidate
  real-Live proof is pending.
- Scene color, empty/triggered/fire-button state, tempo and `tempo_enabled`,
  and time-signature numerator/denominator/enable — read on scene rows and
  editable through one fenced transaction with exact rollback and `live_undo`
  restore. Clip-slot rows now expose color, `controls_other_clips`, stop
  button, group-slot, playing, and record-on-start state.
  `Scene.fire_as_selected` ships as a distinct direct-fire action: fenced,
  audible, explicitly not undoable, and documented as separate from the
  guarded scene audition workflow. Verified at the host, simulator, Python
  contract, and packaged fake-Live levels; exact-candidate real-Live proof is
  pending.
- Comprehensive Song state reads: visible tracks, appointed device, song
  length/start, time signature, swing, overdub/arrangement-overdub,
  back-to-arranger, can-capture/undo/redo, exclusive arm/solo, counting-in,
  tempo follower, automation re-enable, Session record/automation, and
  Ableton Link enable/start-stop-sync, plus beat/SMPTE and loop-time
  conversions. Momentary transport actions (start, continue, stop, play
  selection, scrub, tap tempo, nudge, re-enable automation, trigger Session
  record, force Link beat time) ship as fenced, non-undoable actions with
  audible ones labeled; emergency stop remains a separate authority.
  `CuePoint.jump` joins next/previous locator navigation. Raw Song
  undo/redo is deliberately not exposed as a mutation: it would bypass
  transaction-owned rollback and recovery, so only `can_undo`/`can_redo`
  state is reported and the decision is documented. Verified at the host,
  simulator, Python contract, and packaged fake-Live levels; exact-candidate
  real-Live proof is pending.
- Performance and latency diagnostics: `Application.average_process_usage`
  and `peak_process_usage`, per-track input/output meters and
  `performance_impact`, and device latency in samples and milliseconds, in
  one bounded on-demand sample. Telemetry is point-in-time evidence only —
  meter values are Live UI meters, never decoded audio analysis, and the
  sampling model (single bounded read, no streaming queue, no retained
  history) is documented rather than implied. Verified at the host,
  simulator, Python contract, and packaged fake-Live levels; exact-candidate
  real-Live proof is pending.
- Specialized device APIs: Drift modulation-matrix source/target lists,
  pitch-bend range, and voice count/mode; Drum Cell semantic gain; Eq8 edit
  and global modes, oversampling, and selected band; Hybrid Reverb IR
  category/file selection plus attack, decay, size, and time shaping; Meld
  selected engine, unison, mono/poly mode, and polyphony; Max device
  audio/MIDI IO descriptors on rows; plug-in preset discovery/selection and
  editor-window state (read/write); Looper record/overdub/play/stop/clear/
  undo/export as momentary actions and speed, loop length, tempo, and fixed
  record length with exact undo; and capability-gated Simpler
  `replace_sample` with the same explicit file authority as audio import and
  an inverse-replacement undo. Each family advertises only when the device
  class and the members exist on the connected Live build; first-supported
  Live versions are recorded in the capability matrix. Verified at the host,
  simulator, Python contract, and packaged fake-Live levels; exact-candidate
  real-Live proof is pending.
- Chain, rack, macro, and drum pad surfaces: chain color/index, auto-color,
  audio/MIDI I/O flags, muted-via-solo, and typed chain mixers on rows with
  chain color/mute/solo edits restoring exactly; drum-chain input/output
  notes and choke groups; drum pad note/solo edits with exact restore and an
  explicit, honestly non-undoable `delete_all_chains`; rack return chains,
  macro-mapping state, selected variation, and visible macro count on rows;
  macro add/remove/randomize, rack chain insertion, pad copying, and
  variation store/recall/delete as momentary actions; and rack view selected
  chain/pad, pad scroll position, and chain-device visibility with exact
  restore. Verified at the host, simulator, Python contract, and packaged
  fake-Live levels; exact-candidate real-Live proof is pending.
- Deep device and parameter surfaces: parameter rows now expose default
  value, original name, state, enumeration items, and display-value
  semantics; device rows expose parameter banks, comparison capability and
  active side, class display name/type, latency, and (shape-gated) collapsed
  view state. Parameter bank edits restore exactly; automation re-enable and
  A/B comparison save-to-slot ship as momentary actions; chain device
  insertion is empty-owner guarded; and cross-track/chain device movement
  runs through `Song.move_device` with an exact inverse-move undo. Writable
  bypass is never inferred from read-only `Device.is_active` — only the
  name-independently probed Device On parameter is used. Verified at the
  host, simulator, Python contract, and packaged fake-Live levels;
  exact-candidate real-Live proof is pending.
- Extended mixer controls: track activator, crossfader, crossfade
  assignment, panning mode, and split-stereo left/right panners with exact
  restore; the master track's semantic song-tempo parameter is exposed
  read-only on its mixer row so the tempo workflow stays single-sourced.
  Rack chain mixers (volume, pan, sends, chain activator) through a typed
  chain surface, and device-level routing (device IO type/channel,
  `default_external_routing_channel_is_none` where Live exposes it) and
  compressor sidechain selection through a separate typed surface — track
  routing, chain routing, and device sidechain routing remain distinct by
  design. Verified at the host, simulator, Python contract, and packaged
  fake-Live levels; exact-candidate real-Live proof is pending.
- Song.View selections (track, scene, highlighted slot, detail clip,
  device, parameter, chain) and draw mode with exact restore; clip view
  grid quantization, triplet grid, envelope visibility, and show-loop;
  device collapsed state (exposed only where Live supports it);
  Application.View main-view switch/hide/focus, zoom/scroll, follow-song,
  track collapse, and Browser-mode toggle; and the application dialog
  surface — state reads plus one guarded button press that is refused the
  moment the previewed dialog state changes, because dialog buttons can be
  destructive. Device.View collapse remains shape-gated: where Live does
  not expose it, the operation reports unavailable instead of pretending.
  Verified at the host, simulator, Python contract, and packaged fake-Live
  levels; exact-candidate real-Live proof is pending.
- Track rows now expose group-track relationship, visibility, selection
  membership, frozen/fold state, implicit arm, back-to-arranger,
  muted-via-solo, all input/output meters, and performance impact, plus
  Track.View selected device, device insert mode, and collapsed state.
  Guarded return-track creation (with cleanup) and explicit return-track
  deletion (honestly non-undoable), guarded track and scene duplication,
  guarded existing-device deletion with exact sibling fencing (explicitly
  non-undoable), and track-view edits with exact restore. Clip-slot
  duplication is served by the existing `clip.duplicate` slot-to-slot
  operation, running-clip jumping by `clip.action`
  (move-playing-position), and direct stop-all by the transport action —
  each documented at its tool. Verified at the host, simulator, Python
  contract, and packaged fake-Live levels; exact-candidate real-Live proof
  is pending.
- Purpose-specific preview/apply/verify/undo or cleanup workflows with exact
  object and hierarchy identities, state/content revisions, creation-time
  fingerprints, epochs, expiry, idempotency, fresh postconditions, bounded
  compensation, and explicit uncertain state. Atomic Session clip move runs
  duplicate/delete/compensation on Live's main thread. The capability catalog
  classifies every Live tool from both its domain capability and exact
  negotiated operation set; unsupported or partial Live shapes remain
  negotiated limitations.
- Realtime authority limited by loopback endpoint, unpredictable token, TTL,
  source ports, channels, exact parameter refs, packet/rate/queue bounds,
  sequence/replay checks, generation fencing, verified writes, XY compensation,
  telemetry, disarm, and independent TCP emergency stop.
- `pcm-analysis/v2`: privacy-preserving waveform, spectral, time-frequency,
  transient, channel, phase, dynamics, clipping, and deterministic aggregate
  analysis.
- ITU-R BS.1770-5 / EBU R128, Tech 3341, and Tech 3342 programme loudness,
  momentary/short-term measures, loudness range, semantic channel weights, and
  validated 44.1/48 kHz true peak. Generated independent FFmpeg-oracle evidence
  is tracked; no third-party audio is stored.
- Bounded 48 kHz reference comparison with band-limited resampling,
  coarse-to-fine alignment, ambiguity refusal, standards level matching, and
  aggregate deltas. Untrusted automatic alignment retains separate source
  analyses but withholds overlap, comparative deltas, and gain advice.
- Disposable secret-stripped analysis workers with two active/four queued job
  limits, wall/output/memory/request bounds, kill-on-cancel, and no raw PCM in
  results.
- Real-Live-only consent-bound Session Resampling capture with an exact source
  and empty destination, ten-second mapper watchdog, immediate launch
  quantization restoration, independently recoverable stop, internal WAV
  validation, standards analysis, signal-chain-linked non-causal diagnosis,
  transaction-owned clip deletion, WAV/ASD unlink, and zero-residual readback.
  See [AUDIO_INTELLIGENCE.md](AUDIO_INTELLIGENCE.md) and the Phase 8 evidence
  files.
- Five capability-aware composition journeys for editable beat/song creation,
  advanced drums, owned/native sound design, standards reference comparison,
  and mix/recording/performance diagnosis. Plans expose ordered text progress,
  impact labels, exact confirmation boundaries, verification, recovery,
  rights-aware high-level trait translation, accessibility scope, per-stage
  capability/provenance negotiation, and truthful fallback. See
  [USER_JOURNEYS.md](USER_JOURNEYS.md).
- Packed-artifact production journey, Python mapper tests, property tests,
  isolated resource benchmarks, compatibility/package verification, and Windows
  permission hardening.
- MIT-licensed, local/unpublished release-v2 staging with an independently
  exact 77-file allowlist, full payload hashes, packed-license byte equality,
  and clean-SHA/toolchain/lock/workflow provenance. Package `private: true`
  prevents accidental npm publication without changing MIT rights. The release
  workflow requires fresh-clone byte reproducibility and shares one exact
  candidate across Node 22/24/25 on Ubuntu 24.04, macOS 15, and Windows Server
  2025.
- Receipt-driven install, truthful manual activation, strict newer-version
  upgrade, exact rollback, receipt-bound repair/quarantine, retained cleanup,
  ownership-safe uninstall/purge, and status. The lifecycle verifies actual
  tarball bytes/inventory, owner permissions, link/junction ancestors, ports,
  locks, generations, package/config/Remote Script integrity, and recoverable
  failure state. An explicit install-only diagnostics opt-in provisions one
  descriptor-fenced owner file; fixed redacted records are queued off callback
  threads, capped at 256 KiB, and disabled on drift/write failure. Legacy/v1-to-v2
  migration is explicit and secret-preserving.

## Evidence boundary

Tracked evidence under [`../evidence/`](../evidence/) distinguishes
deterministic fake-Live, packaged bridge, and real-Live observations. Phase 8
real-Live evidence was produced by an installed `npm pack` artifact against
macOS Live 12.4.5b8 and includes cancellation and host-restart/watchdog
recovery. It is not Windows Live proof and does not prove signing/notarization
or release publication.

The local protected `extensions-sdk-1.0.0-beta.0` remains excluded: it must not
be opened, copied, staged, packaged, or cited as implementation evidence.

## Truthful limitations

- Arbitrary device and Arrangement clip deletion is refused because prior state
  cannot be reconstructed. Only exact transaction-created identity, hierarchy,
  and creation-fingerprint cleanup is available through guarded undo.
- Live save/open/new/export/collect/bounce, Arrangement automation, warp-marker
  editing, take/comp editing, and Browser audio preview remain unavailable
  where the observed API has no authoritative operation. Strict reserved
  canonical contracts are tested but remain unadvertised until an adapter can
  execute and verify them.
- No Max for Live `.amxd`, plug-in UI control, streaming PCM tap, arbitrary
  path/URL analysis, immersive/object loudness layout, automatic mastering
  verdict, or forensic secure erase is claimed.
- True peak is currently validated at 44.1 and 48 kHz; other rates report it
  unavailable.
- Live capture requires a saved Set, WAV recording, a selectable restorable
  destination route, explicit consent/output safety, and real-Live provenance.
- Current tracked real-Live proof is on macOS and remains candidate-specific.
  Hosted host/package evidence is valid only when the complete exact-SHA matrix
  is green; no historical run transfers to a newer commit. Performance remains
  an uninstrumented gate separate from V8 coverage.
- The stdio journey surface is text-first and has no server-owned visual focus,
  but VoiceOver/Narrator behavior in third-party MCP clients, Ableton Live, and
  plug-in windows remains client/version-dependent and is not claimed.
- Native signing/notarization, Windows desktop/real-Live evidence, external
  VoiceOver/Narrator/client evidence, and public publication are unavailable
  for the chosen channel. The channel stays explicitly local, unsigned,
  unnotarized, and unpublished; npm `private: true` prevents accidental
  publication without changing MIT rights. Those external cells are not
  inferred from host CI or the server-owned text accessibility contract.

## Operating procedure

Use [USER_GUIDE.md](USER_GUIDE.md), [USER_JOURNEYS.md](USER_JOURNEYS.md),
[AUDIO_INTELLIGENCE.md](AUDIO_INTELLIGENCE.md), and
[REALTIME_CONTROL.md](REALTIME_CONTROL.md) for client contracts;
[OPERATIONS.md](OPERATIONS.md) for supervision; [RECOVERY.md](RECOVERY.md) for
uncertain state; and [TESTING.md](TESTING.md) for release gates.
