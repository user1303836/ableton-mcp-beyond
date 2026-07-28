# Implementation status

This file describes the current branch. The historical checkpoint and phased
finish criteria remain in `REPOSITORY_STATE_AND_FINISH_PLAN.html`; they are not
a current capability report.

## Implemented and verified

- Strict newline-delimited JSON-RPC MCP host (`2025-11-25`) with bounded
  framing/concurrency, ordered backpressure-aware output, cancellation,
  duplicate-ID rejection, redacted diagnostics, and fail-closed default
  adapter.
- Explicit host/bridge configuration, owner-only separate secrets, loopback
  enforcement, migration, setup, diagnostics, and atomic Remote Script
  installation with recoverable backup.
- Authenticated `ableton-loopback/v1` bridge with connection challenge and
  bridge epoch binding, canonical HMAC frames, replay/deadline fencing, bounded
  Live-main-thread dispatch, epoch-scoped refs/cursors, signed subscriptions,
  canonical registry negotiation, and a read-only preflight → unpredictable
  confirmation → one-use mutation authority protocol. Stable transaction-scoped
  replay keys and the bridge-epoch executed-result ledger survive TCP response
  loss without conflating distinct host transactions.
- Real-Live discovery and guarded lifecycle evidence for Live 12.4.5b8:
  transport; Session clip launch/stop/emergency stop; MIDI notes and clips;
  Arrangement clips and locators; mixer; Session automation; nested devices,
  racks/chains/pads/macros; Browser search/load; routing; Session and
  Arrangement recording; project path/manifest/backup; subscriptions; and
  realtime UDP JSON/OSC/XY plus bounded `max`-label extension packets (not a Max capability).
- Purpose-specific preview/apply/verify/undo or cleanup workflows with exact
  targets, epochs/revisions, expiry, idempotency, fresh postconditions, bounded
  compensation, and explicit uncertain state. Unsupported Live shapes remain
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
  validated 44.1/48 kHz true peak. Generated independent FFmpeg-oracle
  evidence is tracked; no third-party audio is stored.
- Bounded 48 kHz reference comparison with band-limited resampling,
  coarse-to-fine alignment, ambiguity refusal, standards level matching, and
  aggregate deltas.
- Disposable secret-stripped analysis workers with two active/four queued job
  limits, wall/output/memory/request bounds, kill-on-cancel, and no raw PCM in
  results.
- Real-Live-only consent-bound Session Resampling capture with an exact source
  and empty destination, ten-second mapper watchdog, immediate launch
  quantization restoration, independently recoverable stop, internal WAV
  validation, standards analysis, signal-chain-linked non-causal diagnosis,
  transaction-owned clip deletion, WAV/ASD unlink, and zero-residual readback.
  See `AUDIO_INTELLIGENCE.md` and the Phase 8 evidence files.
- Five capability-aware composition journeys for editable beat/song creation,
  advanced drums, owned/native sound design, standards reference comparison,
  and mix/recording/performance diagnosis. The tool/resource/prompts expose
  ordered text progress, impact labels, exact confirmation boundaries,
  verification, recovery, rights-aware high-level trait translation,
  accessibility scope, per-stage capability/provenance negotiation, and
  truthful fallback. The packed fake-Live boundary translates allowlisted
  traits into guidance, blocks identity/copy collisions, executes every
  `planned` stage through actual purpose-specific tool results, validates
  non-regressing runtime progress, and records residual state,
  replans after device capability renegotiation, and leaves real-Live-only
  capture/realtime stages unavailable without claiming real-Live or
  third-party client accessibility evidence.
- Packed-artifact production journey, Python mapper tests, property tests,
  isolated resource benchmarks, compatibility/package verification, and
  Windows permission hardening.
- Private/unpublished `UNLICENSED` release staging with an independently exact
  77-file allowlist, full payload hashes, and clean-SHA/toolchain/lock/workflow
  provenance. The release workflow is configured to require fresh-clone byte
  reproducibility and share one exact candidate across Node 22/24/25 on Ubuntu 24.04, macOS 15, and Windows Server 2025.
- Receipt-driven install, truthful manual activation, strict newer-version
  upgrade, exact rollback, receipt-bound repair/quarantine, retained cleanup,
  ownership-safe uninstall/purge, and status. The lifecycle verifies actual
  tarball bytes/inventory, owner permissions, link/junction ancestors, ports,
  locks, generations, package/config/Remote Script integrity, and recoverable
  failure state. Legacy/v1-to-v2 migration is explicit and secret-preserving.

## Evidence boundary

Tracked evidence under `docs/evidence/` distinguishes deterministic fake-Live,
packaged bridge, and real-Live observations. Phase 8 real-Live evidence was
produced by an installed `npm pack` artifact against macOS Live 12.4.5b8 and
includes cancellation and host-restart/watchdog recovery. It is not Windows
Live proof and does not prove signing/notarization or release publication.

The local protected `extensions-sdk-1.0.0-beta.0` remains excluded: it must not
be opened, copied, staged, packaged, or cited as implementation evidence.

## Truthful limitations

- Live save/open/new/export/collect/bounce, Arrangement automation, warp-marker
  editing, take/comp editing, and Browser audio preview remain unavailable where
  the observed API has no authoritative operation. Strict reserved canonical
  contracts are tested but remain unadvertised until an adapter can execute and
  verify them.
- No Max for Live `.amxd`, plug-in UI control, streaming PCM tap, arbitrary
  path/URL analysis, immersive/object loudness layout, automatic mastering
  verdict, or forensic secure erase is claimed.
- True peak is currently validated at 44.1 and 48 kHz; other rates report it
  unavailable.
- Live capture requires a saved Set, WAV recording, a selectable restorable
  destination route, explicit consent/output safety, and real-Live provenance.
- Current real-Live proof is on macOS. The latest pushed Phase 10 candidate jobs
  started but failed because performance tests were run under V8 coverage
  instrumentation, so all dependent Windows jobs were skipped. Performance now
  remains an uninstrumented independent gate; a new exact-SHA run is required.
- The stdio journey surface is text-first and has no server-owned visual focus,
  but VoiceOver/Narrator behavior in third-party MCP clients, Ableton Live, and
  plug-in windows remains client/version-dependent and is not claimed.
- Native signing/notarization, Windows desktop/real-Live evidence, public
  publication, hosted exact-candidate results for the eventual pushed SHA, and
  the final capability/documentation/release audit remain unproven. The chosen
  channel stays private, unsigned, unnotarized, and unpublished.

## Operating procedure

Use `USER_GUIDE.md`, `USER_JOURNEYS.md`, `AUDIO_INTELLIGENCE.md`, and
`REALTIME_CONTROL.md` for client contracts; `OPERATIONS.md` for supervision; `RECOVERY.md` for uncertain
state; and `TESTING.md` for release gates.
