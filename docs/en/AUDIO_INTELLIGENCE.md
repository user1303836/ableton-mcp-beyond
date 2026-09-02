# Audio intelligence and consent-bound Live capture

English · [简体中文](../zh-CN/AUDIO_INTELLIGENCE.md) · [日本語](../ja/AUDIO_INTELLIGENCE.md)

The audio toolchain: caller-supplied PCM analysis, reference comparison,
Live-context diagnosis, and — only with a real authenticated bridge —
consent-bound Session Resampling capture.

## Capability boundary

Audio intelligence has three distinct sources that must not be conflated:

1. `audio_analyze` accepts caller-supplied interleaved little-endian float32
   PCM. It never attributes that PCM to Live.
2. `audio_compare_reference` accepts two caller-supplied PCM sources. It
   resamples, aligns, level-compares, and returns aggregates only.
3. `live_audio_capture_preview/apply` is available only when an authenticated
   `real-live` Remote Script negotiates all `audio.capture.*` operations and
   `audio.capture.resampling`. It records Live's Resampling input into one
   exact empty audio Session slot, analyzes the resulting bounded WAV, and
   removes both the transaction-owned Live clip and raw media.

A Remote Script does not expose PCM. The third workflow is a purpose-specific
Live recording lifecycle, not a fabricated mapper tap and not a Max for Live
claim.

## Standards analysis

`pcm-analysis/v3` retains `standardsAudio` and the old
`loudness.rms-derived-proxy` field only as an explicitly deprecated
compatibility value. It distinguishes normalized source samples that reach the
full-scale boundary (`clipping`) from values above 0 dBFS created by
band-limited comparison reconstruction (`reconstructedOvers`). Reconstruction
overs do not prove source clipping. Delivery or mastering decisions must use
`standardsAudio`, not the compatibility proxy.

The standards result identifies:

- ITU-R BS.1770-5 programme loudness;
- EBU R128 operating semantics;
- EBU Tech 3341 momentary (400 ms) and short-term (3 s) measures;
- EBU Tech 3342 loudness range, with a −70 LUFS absolute gate, −20 LU relative
  gate, and documented R-7 percentiles;
- 400 ms integrated blocks at 100 ms cadence, −70 LUFS absolute gating, and
  −10 LU relative gating;
- semantic channel labels and weights. Mono and stereo are inferred; larger
  layouts require explicit `M`, `L`, `R`, `C`, `Ls`, `Rs`, and `LFE` labels.
  LFE is excluded and surrounds use the conventional 1.41 weight;
- sample peak separately from true peak.

At 48 kHz, true peak uses the order-48, four-phase FIR coefficients published
in BS.1770-5 Annex 2. At 44.1 kHz, a bounded 64-tap Blackman-sinc conversion
to 48 kHz precedes that Annex 2 interpolator. Other rates return true peak as
unavailable rather than silently substituting sample peak. Programme loudness
supports integer rates from 8 to 384 kHz through rate-derived K-weighting
filters; the exact published coefficients are used at 48 kHz.

Silence, insufficient duration, unknown multichannel layout, and inputs beyond
the true-peak work bound return explicit unavailable/null values, never NaN,
infinity, or a fabricated measurement. Momentary and short-term series are
lossy and capped at 128 points; gating still uses all bounded windows.

Independent validation uses generated, redistributable PCM and FFmpeg's
`ebur128` implementation. No third-party test audio is committed. Run:

```sh
cd apps/mcp-server
npm run audio:oracle
```

The tracked oracle report is
[../evidence/phase-8-audio-oracle.json](../evidence/phase-8-audio-oracle.json).
The declared comparison tolerance is 0.1 LU/dB at 48 kHz and 0.15 dBTP for the
validated 44.1 kHz conversion. The primary specifications remain authoritative;
FFmpeg is an independent implementation check, not the normative definition.

## Isolated analysis and cancellation

Production MCP analysis does not run synchronously on the host event loop.
`AnalysisRunner` starts a disposable Node child with:

- two active jobs and four queued jobs maximum;
- a 512 MiB V8 heap ceiling;
- a 30 second wall deadline;
- 2 MiB stdout and 16 KiB stderr limits;
- a 64 MiB worker request limit;
- no inherited application secrets;
- immediate child termination on MCP cancellation or timeout.

Only JSON aggregate results cross back. The worker does not accept URLs or
filesystem paths. Public tools accept normalized PCM only; a Live capture file
path is internal to the verified capture lifecycle.

## Reference comparison

`audio_compare_reference` supports 32–96 kHz mono/stereo sources (the validated
range of its fixed 32-tap kernel), at most four million input samples across
the pair, at most 30 seconds per source, and at most ten seconds of alignment
lag. It:

1. converts each source to 48 kHz with a deterministic 32-tap
   Blackman-windowed sinc resampler;
2. performs a 100 Hz coarse envelope search followed by a 1 kHz, ±10 ms fine
   search, avoiding unbounded quadratic fine correlation;
3. refuses weak, silent, or competing automatic matches; manual and disabled
   alignment modes are explicit;
4. analyzes only the equal overlap when alignment is trusted; if automatic
   alignment is unavailable, it retains separate per-source analyses but sets
   overlap to zero and all comparative deltas/level-match advice to
   unavailable;
5. reports BS.1770 integrated level difference and a bounded ±24 dB advisory
   match value when both sources qualify;
6. reports loudness, true/sample peak, RMS, crest, dynamic range, spectrum,
   and transient-density deltas without returning aligned PCM.

`reference-analysis/v2` reports source-domain boundary counts under
`resampling.*.sourceClipping`. For sources actually converted to 48 kHz, the
nested analysis reports reconstruction values above 0 dBFS separately as
`reconstructedOvers` and never mislabels them as source `clipping`. Its lossy
amplitude histogram scales to the bounded reconstructed range so dynamics
quantiles do not collapse every value above 1 into the final bin.

Resampling is not time-stretching or tempo matching. A suggested level match
changes no audio.

## Signal-chain-linked diagnosis

`audio_diagnose_live_context` links caller PCM measurements to one fresh track
snapshot but marks the relationship as caller-declared and unverified.
Mapper-owned capture analysis marks the relationship as
`verified-by-capture-lifecycle`. Diagnosis includes the exact Set, track,
mixer/routing refs, ordered device refs, and bounded published parameter
values.

Findings distinguish measurements from hypotheses. Device presence is never
called causal. Missing latency, sidechain topology, hidden parameters, gain
reduction, and exact intra-device tap position are named explicitly. A mixer
preview suggestion, when present, is a reversible normalized-control experiment
that requires explicit confirmation and same-scope recapture; it is not a
promised dB correction. `causality.claimed` is always false.

## Live Resampling lifecycle

### Preview

`live_audio_capture_preview` requires:

- `real-live` provenance and all six canonical capture operations;
- the exact disposable Set name;
- one exact source Session clip slot and a different exact empty audio slot;
- a restorable, currently available destination input route;
- stopped transport, Session and Arrangement recording off, no active targets,
  every track unarmed, and no input-monitored track;
- a one-to-nine second requested duration;
- `consent=ephemeral-analysis-and-delete`;
- fresh non-simulator output-safety evidence.

The operator may need to select an available safe route such as `No Input`
before preview if Live's stale `Ext. In` route is no longer selectable. That is
an explicit normal routing transaction, not a hidden capture side effect.

### Apply and watchdog

Apply requires the unpredictable preview confirmation and an idempotency key.
On Live's main thread, `audio.capture.start` rechecks source/destination
track/slot object identities and the complete fence, temporarily gives the
destination track an unexposed random ownership tag, sets Resampling,
monitoring off, and arm on that exact destination, temporarily sets launch
quantization to immediate, and fires exactly the destination and source slots.
An asynchronously appearing clip is owned only when Live marks it recording and
its name carries that private tag; the destination name and launch quantization
are then restored. It never automatically retries start.

The mapper watchdog has a hard maximum of ten seconds. Host stop, cancellation,
watchdog expiry, emergency stop, and bridge shutdown stop the exact source and
destination slots/tracks, stop transport and recording, restore position, name,
routing, arm, and monitoring, and reassert stop while playback or the owned
clip remains recording. Bridge/Live teardown cannot unlink media itself: it
deliberately preserves an owned clip/path as a visible host-or-manual cleanup
residual instead of deleting the only recovery identity. External edits are
reported as residual state rather than silently overwritten.

### Acquisition and teardown

Only a fresh regular, non-symlink, single-link WAV inside the saved project
directory or conventional `User Library/Samples/Recorded` boundary is accepted.
The file must be at most 32 MiB, 12 seconds, two channels, and use supported
PCM16/24/32 or float32 packing. Identity, size, mtime, and SHA-256 are fenced
while it is read. The public response includes format/rate/channel/duration
summaries but no raw path, digest, PCM, token, or confirmation.

After isolated analysis, the host opens the WAV/ASD with no-follow descriptor
semantics, rechecks device/inode/link-count/digest identity, moves the verified
inodes into a random owner-only same-filesystem quarantine, truncates them, and
unlinks them. Only after raw cleanup succeeds does `audio.capture.cleanup`
delete the exact transaction-owned Live clip. It then performs a bounded
post-clip stable-absence sweep for an `.asd` created during analysis/cleanup
and verifies that neither media path nor a quarantine residual remains. This
ordering retains Live's path/clip recovery identity across host failure.
"Deleted" means verified unlink; it is not a claim of forensic erasure on SSD
or copy-on-write storage. Final readback must show stopped/non-recording
playback, restored destination state, an empty slot, mapper state `cleaned`,
and no residual raw files.

## Independent recovery

`live_audio_capture_status` redacts the mapper token and media path.
`live_audio_capture_emergency_stop` requires
`confirmation=emergency-stop-and-clean` plus the exact freshly observed
capture/source/destination identities. It works after host restart, obtains the
mapper-held recovery authority over the authenticated bridge, stops the
capture, securely revalidates/quarantines/unlinks the raw file, and only then
deletes the owned clip. If path, identity, file format, or cleanup cannot be
proven, it returns uncertain residual state and does not delete an arbitrary
file.

The checked-in operator runner is
`apps/mcp-server/scripts/verify-phase8-live.mjs` (`npm run audio:live-verify`);
its required receipt, clean Git SHA, exact artifact and registry digests,
installed-byte verification, and fresh output-safety inputs are documented in
[TESTING.md](TESTING.md). Real-Live packaged evidence, including normal
capture, controlled recapture, proven MCP response suppression, mapper watchdog
after host death, independent recovery, and zero raw/quarantine residuals, is
tracked in
[../evidence/phase-8-audio-live.json](../evidence/phase-8-audio-live.json).

## Explicit limitations

- No `.amxd` device, streaming Max for Live tap, plug-in UI meter, arbitrary
  path, URL fetch, time-stretch, mastering grade, or automatic compliance
  verdict is claimed.
- True peak is currently validated only at 44.1 and 48 kHz.
- Conventional semantic channel labels are supported; immersive/object layouts
  are unavailable.
- Live capture is WAV-only and requires a saved Set and a restorable route.
- Raw unlink cannot promise forensic media erasure. The owner account is the
  local trust boundary: a malicious process already running as that same user
  can read the owner-only bridge secret and is outside the threat model;
  no-follow, link-count, inode, digest, and private-quarantine checks defend
  against accidental/stale/path-substitution hazards within that boundary.
- Real-Live evidence is macOS Live 12.4.5b8 evidence, not Windows Live proof.
