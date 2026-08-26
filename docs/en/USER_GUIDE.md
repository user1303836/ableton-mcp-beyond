# User guide

English · [简体中文](../zh-CN/USER_GUIDE.md) · [日本語](../ja/USER_GUIDE.md)

How to install, configure, and drive Ableton MCP Beyond from an MCP client.

The server is fail-closed: with no `--config` it uses `UnavailableLiveAdapter`
and never inspects or changes Live. A bridge is accepted only after loopback,
secret, protocol, operation-registry hash, and status negotiation succeed.

## Install and start

Supported runtimes: Node.js 22, 24, and 25. Node 21, 23, 26, 27, and
unlisted/future majors are unsupported. From a source checkout:

```sh
cd apps/mcp-server
npm ci
npm run build
node dist/src/cli.js                              # fail-closed host
node dist/src/cli.js --config /absolute/path/bridge-config.json
```

The only accepted CLI option is one `--config PATH`. Secrets, endpoints,
adapters, and capabilities cannot be selected through MCP arguments or client
metadata. Initialize JSON-RPC with protocol `2025-11-25`, then send
`notifications/initialized`.

Tarball installations use the receipt-driven `ableton-mcp-lifecycle` flow in
[DELIVERY.md](DELIVERY.md) for install, activation, upgrade, repair, rollback,
and uninstall. The artifact is MIT licensed, locally delivered, unpublished,
unsigned, and installed by exact path and SHA-256. Package `private: true`
prevents accidental publication but does not change MIT rights; see
[DISTRIBUTION_POLICY.md](DISTRIBUTION_POLICY.md).

## Read-only tools

- `server_status` and `capabilities` report host state and the negotiated catalog.
- `live_status` reports protocol, adapter, epoch, registry hash, operations, and connection state.
- `live_snapshot` returns a bounded Set snapshot when `session.read` is negotiated. Treat fallback values in a fake or incomplete Live shape as unavailable evidence, not proof of Live state.
- `live_project_snapshot_export` returns deterministic pages of a versioned semantic Set artifact. Choose `strict` (typed name/path aliases), `collaboration` (names and basenames), or `local` (names and project-relative paths; external paths remain basenames/digests), retain every page through `complete=true`, and persist the complete bundle. Every page records Live/source provenance, section completeness, dependencies, unavailable fields, and that it contains no session refs or mutation authority.
- `live_project_snapshot_diff` compares two complete persisted page bundles and remains available without Live. It matches unique content/structure/name evidence, reports rename/reorder separately, leaves duplicate ties explicit, and suppresses absence claims for truncated sections. It never proposes `.als` edits, replay, Collect All and Save, or a merge; plug-in/Max blobs and portability remain opaque.
- `live_discover` validates all negotiated kinds and requires a parent for child kinds. When the adapter exposes mapper discovery it accepts `set`, `track`, `return-track`, `main-track`, `scene`, `clip-slot`, `session-clip`, `arrangement-clip`, `note`, `locator`, `device`, `parameter`, `selection`, `routing-choice`, and `session-playback`, with bounded parents, up to eight scalar filters, requested fields, traversal budget, paging, and epoch/revision-bound cursors. Requested fields are a projection over each kind's fixed row serializer — they select which already-computed fields are returned; they are not arbitrary Live Object Model property retrieval. The compatibility fallback remains limited to `track`, `scene`, `clip`, and `note`.
- `live_browser_inspect` reports one authoritative Browser result by exact item id: stable identity (id, object identity, and a content revision), type and browser-internal path metadata, adapter/epoch provenance, and explicit loadability with a reason. Raw filesystem paths are never returned; only device items are loadable through `live_browser_load_preview/apply`.
- `live_arrangement_automation_read` probes one exact Arrangement clip's automation envelope for one parameter: owner identity, exact time range, complete paged points (512-point bound with revision-bound cursors, never silently truncated), and an explicit note that curve shapes are not exposed. No Arrangement automation mutation is advertised.
- `live_take_lane_read` and `live_comp_read` inventory take lanes, lane clip ranges/fingerprints, main-lane summaries, and adapter-negotiated comp source segments, paged and revision-bound. No audition, lane mutation, take promotion, or best-take ranking exists, and relationships the adapter cannot enumerate are reported explicitly.
- `live_warp_marker_read` probes one exact audio clip's complete bounded warp-marker set with `(beatTime, sampleTime)` pairs, monotonicity checks, adapter/collection/clip-authority revisions, and read-only mutation-feasibility evidence. Markers are addressed by beat time; no separate marker identity is exposed.
- `live_key_estimate` estimates the musical key of one exact MIDI clip (or an explicit note set) as ranked candidates with correlation scores, an explicit confidence classification, and an ambiguity flag — never a forced single answer. Deterministic and read-only with revision fencing; ambiguous, chromatic, or insufficient material reports alternatives or insufficient-evidence honestly.
- `audio_analyze` analyzes caller-supplied float32 PCM and returns bounded aggregate, waveform, spectral, transient, dynamics, clipping, ITU-R BS.1770-5/EBU loudness, LRA, and validated 44.1/48 kHz true-peak summaries. It runs in an isolated cancellable worker, never captures Live audio, and never returns raw samples.
- `audio_compare_reference` compares two bounded PCM sources with band-limited resampling, coarse-to-fine (or explicit manual/disabled) alignment, standards level-match advice, and aggregate deltas. If automatic alignment is weak, separate source analyses remain available but overlap and comparative deltas are withheld. It returns no aligned PCM.
- `audio_diagnose_live_context` links caller PCM measurements to one fresh exact Live track snapshot. The relationship is caller-declared and unverified; observed devices are context, never asserted causes.
- `live_audio_capture_status` is read-only when the real bridge negotiates the capture provider. It redacts mapper authority and raw file paths.
- `plan_user_journey` returns a non-mutating, capability-aware plan for beat/song creation, advanced drums, sound design, reference comparison, or mix/recording/performance diagnosis. See [USER_JOURNEYS.md](USER_JOURNEYS.md).

## Tool discovery and deployment policy

`tools/list` returns only tools that are currently executable and allowed by the
effective deployment policy — never unavailable placeholders or tools the
negotiated Live shape cannot run. The server advertises
`notifications/tools/list_changed` and emits it on connect/disconnect, epoch or
operation-set change, and effective runtime policy change; adapter status
refreshes, same-epoch reconnects, and mid-session disconnects announce the
change as it happens rather than on the next request. The always-visible
`live_status` read first attempts a bounded refresh/reconnect, so a dropped
same-epoch bridge can never deadlock discovery behind a stale disconnected
cache. Save/open and other negotiated limitations are reported through the
`ableton://capabilities` resource's `limitations` section instead of callable
discovery.

The deployment policy intersects a named profile with explicit overrides;
deny always wins:

- `read-only` — local tools and read-only Live discovery; no mutation.
- `edit-no-audio` — read plus structural, MIDI, device, mixer, automation, and routing edits; no audible, audio-file, recording, realtime, capture, or filesystem-mutating tools.
- `performance` — read plus live-set control: transport, tempo, clip/scene launch, guarded audition, emergency stop, mixer, views, selection, and locator navigation. Guarded undo and recovery finalization remain available so applied transactions are never stranded; the owner-domain re-check still refuses undo for disallowed domains.
- `full` (default) — every currently executable tool.

Configure with `ABLETON_MCP_TOOL_POLICY` (profile name) and the optional
comma-separated `ABLETON_MCP_TOOL_ALLOW` / `ABLETON_MCP_TOOL_DENY` name or
`prefix_*` lists. Policy is enforced server-side by name at every dispatch —
including preview creation, apply, undo, and emergency-stop paths — so a hidden
tool is never callable, and undo refuses when its transaction's domain has been
revoked. Diagnostics report the effective profile and override patterns without
secrets; the capability resource reports executable, visible, and policy-denied
tool sets with each tool's policy class.

## Mutation workflow

All Live mutations require a connected negotiated adapter, fresh discovery, a
read-only preview, exact confirmation, a bounded idempotency key,
epoch/revision checks, and authoritative postcondition verification.
Implemented workflows:

- `live_device_parameter_preview/apply` — an already-discovered enabled numeric parameter on an authoritative device. Bounds, finite values, quantization, parentage, and revisions are checked; guarded undo through `live_undo`.
- `live_session_structure_preview/apply` — bounded named MIDI/audio track and scene creation. Insertion indexes address only regular tracks and are checked against the current collection before mutation. Existing objects, clips, devices, routing, transport, and recording are not changed.
- `live_midi_clip_preview/apply` — a bounded MIDI clip in an empty Session slot, including normalized notes. Apply creates the clip, submits the complete validated note set through one canonical `note.add-batch` mutation, then verifies authoritative note content.
- `live_arrangement_section_preview/apply` — two named locators in a bounded non-colliding range.
- `live_tempo_preview/apply` — a bounded tempo change.
- `live_midi_transform_preview/apply` — one deterministic seeded MIDI transform on an exact clip: transpose, scale-constrain, quantize, swing, velocity-curve, seeded humanize, legato, staccato, rotate, repeat, ratchet, chord voicing, arpeggiate, or seeded variation. The preview returns the exact add/update/delete note diff, source revision, constraints, assumptions, the MPE probe, and the undo path. Stochastic transforms require an explicit seed and are byte-for-byte repeatable. Generative or large transforms default to duplicate-first into an exact empty slot (the source is preserved); in-place generative edits are refused because delete/recreate cannot preserve per-note expression the canonical note schema does not expose, while update-only transforms patch exposed fields through `note.update`, which preserves unexposed per-note data. Note mutations execute in registry-bounded chunks, and every chunk is fenced against the expected intermediate note set, so an external edit between chunks fails closed rather than being overwritten; an exact-key retry resumes the recorded plan after a mid-plan failure. In-place undo requires the exact verified post-transform state (identity-bound, so a content swap between notes also refuses) and restores prior fields in resume-aware chunks; duplicate-scope undo deletes only the transaction-created clip, and a failed duplicate apply leaves the transaction-owned duplicate for the exact-key resume rather than blind-deleting it.
- `live_undo` — undo an applied transaction whose epoch and verified postcondition still match, or exact-key reconciliation of an acknowledgement-lost undo in the unchanged epoch.
- `live_recovery_finalize` — retire a recovery-protected record only after explicit authoritative manual recovery evidence. It never mutates Live, refuses active audible work, and retires Remote Script replay authority before forgetting the record.
- Purpose-specific clip launch/stop, transport, note update/delete/read/edit, clip duplicate/move/rename/properties/actions, track/scene/device/locator rename, Arrangement clip creation/move and file-backed audio import, Session audio import with explicit file authority, audio-clip, warp-marker, mixer, Session automation (including clear-all-envelopes), Browser/device insertion, routing, recording, project-backup, subscription, locator-jump, view, and realtime workflows when their exact operations are negotiated. Capture MIDI is negotiated only while every Session slot is empty. Arbitrary device or Arrangement clip deletion is refused because prior state cannot be reconstructed; only identity-and-fingerprint-bound transaction-owned cleanup is available through `live_undo`.
- Audio-clip preview accepts only fields advertised by the exact clip (`availableAudioFields`): gain, pitch, loop, warp enable/mode, and fades where supported. Warp-marker edits use `live_warp_marker_preview/apply`, address markers by beat time, and include collection fencing and guarded undo; `live_warp_marker_read` provides the read-only probe. Session audio import (`live_audio_import_preview/apply`) requires an owner-allowlisted root, a regular file with container magic bytes matching its declared format, size and SHA-256 preview, an exact empty destination slot, apply-time re-verification (anti-TOCTOU), and transaction-owned cleanup of only the unchanged created clip; source media is never deleted or rewritten, and MIDI files are explicitly refused until a canonical Session MIDI-file operation exists. Existing take lanes are discoverable and renamable, and `live_audio_import_preview/apply` can create a file-backed audio clip inside one. Lane creation and MIDI lane-clip creation exist in mapper operations but are not advertised by the current public MCP tool schemas. The public LOM exposes no take-lane deletion, audition, or comp-region editing; those remain unavailable.
- Device discovery traverses racks/chains recursively with canonical parent refs. Browser loading requires a fresh exact `browser.inspect` result, rejects non-device items, and targets an empty device owner so any failed-load cleanup cannot affect an unrelated sibling.
- `live_session_audition_preview/apply/stop` — one guarded, potentially audible Session scene launch. Preview is read-only and requires the exact Set name, authoritative stopped/non-recording playback, no armed or input-monitored tracks, safe launch quantization, callable launch/stop operations, and explicit output-safety evidence. Apply requires the exact preview confirmation and idempotency key, launches once, and verifies fresh fired/playing state. Stop requires the returned stop confirmation, stops only mapper-owned playback, and verifies the stopped baseline.

Preview records expire after 30 seconds. A lost acknowledgement, timeout,
disconnect, failed verification, or failed compensation is **uncertain state**.
Never submit new authority or a new idempotency key. In the same bridge and
Live epoch, the still-running host may reconcile only the exact original
transaction, confirmation, arguments, and idempotency key against the Remote
Script execution ledger, then verify fresh postconditions. If either epoch
changed, stop mutating and recover from fresh authoritative state — see
[RECOVERY.md](RECOVERY.md).

## Consent-bound Live audio capture

Live audio is not exposed by Remote Script metadata. Capture is available only
when `live_status` reports `real-live`, `audio.capture.resampling`, and all six
`audio.capture.*` operations.

1. Save and visibly inspect a disposable Set. Ensure all tracks are unarmed, recording and playback are off, and monitoring/output level is safe.
2. Select one exact source Session clip and a distinct empty audio slot. The destination's current input route must be selectable so it can be restored; use the normal routing preview/apply workflow to select a safe `No Input` baseline when Live's stale `Ext. In` value is not available.
3. Call `live_audio_capture_preview` with the exact Set/slot refs, a one-to-nine second duration, `consent=ephemeral-analysis-and-delete`, and fresh output-safety evidence.
4. Review the disclosed audible/recording impact, watchdog/recovery tools, destination baseline, and expiry. Apply once with the exact unpredictable confirmation and a new idempotency key.
5. A successful result contains standards analysis and evidence-linked diagnosis, but no PCM, path, token, confirmation, or raw digest. It must report stopped transport, restored route/arm/monitoring, exact Live clip deletion, WAV/ASD unlink, and no retained raw audio.
6. On cancellation, host failure, timeout, or acknowledgement loss, call `live_audio_capture_status` from a fresh process. If the exact capture is not cleaned, call `live_audio_capture_emergency_stop` with `confirmation=emergency-stop-and-clean` and the exact freshly observed identities. Never start another capture while residual state remains.

See [AUDIO_INTELLIGENCE.md](AUDIO_INTELLIGENCE.md) for DSP standards, limits,
privacy, reference comparison, diagnosis semantics, and recovery details.

## Configuration and installation

Build first, then create a host-only configuration:

```sh
npm run setup -- --output /absolute/path/client-config.json
```

For a bridge configuration, create a separate owner-only secret file and run:

```sh
npm run setup -- --output /absolute/path/bridge-config.json \
  --bridge-host 127.0.0.1 --bridge-port 9000 \
  --realtime-port 9001 \
  --secret-file /absolute/path/bridge.secret --bridge-timeout 5000
```

Version 2 writes the explicit `--config PATH` argument. The secret is never
placed in client arguments, the package, the Remote Script reference, logs, or
diagnostics. Paths must be explicit, safe, non-symlink paths; hosts must be
loopback; secrets must be strong and owner-controlled. `--realtime-port` is
optional, must differ from the authenticated TCP port, and enables only the
separately armed channel described in [REALTIME_CONTROL.md](REALTIME_CONTROL.md).

Remote Script file diagnostics are disabled by default and are not enabled by
`setup` or by creating a temporary sentinel. The supported opt-in is
`ableton-mcp-lifecycle install --enable-bridge-diagnostics`, which provisions
one bounded owner-state file without placing payloads or secrets in it. See
[OPERATIONS.md](OPERATIONS.md) and [DELIVERY.md](DELIVERY.md); use
uninstall/reinstall without the flag to disable it.

Install the Remote Script only to an explicitly selected destination:

```sh
npm run build
node dist/src/install-remote-script.js --destination /absolute/path/ControlSurface --dry-run
```

The installer refuses symlink trees and overwrite by default. `--force` is for
a known recoverable destination only. Read [LIVE_SAFETY.md](LIVE_SAFETY.md),
[OPERATIONS.md](OPERATIONS.md), and [RECOVERY.md](RECOVERY.md) before
connecting to Live.

## Resources and prompts

Read-only resources include `ableton://capabilities`, `ableton://safety`,
`ableton://journeys`, `ableton://max-extension`, and the safe tempo workflow.
Prompts prepare requests; they do not grant mutation authority. No resource or
prompt authorizes scene launch, recording, routing, or audio capture.
