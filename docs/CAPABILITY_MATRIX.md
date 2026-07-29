# Capability and evidence matrix

This matrix is the version-controlled source of truth for the named platform
domains and north-star journeys. “Implemented” never means “proved in every
external environment.” Evidence scope is explicit:

- **unit/property/simulator** — deterministic repository contract only;
- **packaged fake-Live** — installed tarball, authenticated cross-process bridge,
  deliberately fake Live provenance;
- **real-Live** — authenticated Remote Script observation in the named disposable
  Live environment; and
- **host matrix** — Node/package/lifecycle behavior, never Windows Live.

Safety classes: **R** read-only; **G** revision/epoch-bound preview-confirm-verify
mutation; **A** audible or recording with output/recording gates and independent
stop; **RT** short-lived realtime authority; **FS** owner/allowlist-bound
filesystem mutation; **P** consent/privacy-sensitive audio; **D** delivery and
installation authority.

## Foundation and control domains

| Domain | Public API / canonical operations | Implementation and safety | Primary tests | Platform / production evidence | Documentation and negotiated limitations |
|---|---|---|---|---|---|
| MCP transport and host | initialize, tools/resources/prompts, stdio JSON-RPC | `host.ts`, `stdio.ts`, `framing.ts`; R/G; bounded frames, work, rate, cancellation, ordering | `host.test.ts`, `stdio.test.ts`, `framing.test.ts`, property/benchmark | Node 22/24/25 host matrix is configured; packaged fake-Live journey; exact-SHA result required | `DEVELOPER_GUIDE.md`, `OPERATIONS.md`; no generic mutation tool |
| Canonical Live contract | `ableton-live/v1`, operation registry, manifest/hash | `registry.ts`, `live.ts`, Python mapper; R/G/A/RT; strict schemas and one canonical digest | `registry.test.ts`, Python contract tests, package/candidate verifiers | Historical macOS real-Live negotiation used an older registry digest; current-digest exact-candidate proof is required | `DEVELOPER_GUIDE.md`, `LIVE_SAFETY.md`; unsupported shapes stay unavailable |
| Authenticated bridge | status/snapshot/discover/get plus purpose-specific operations | `remote-adapter.ts`, Python listener; loopback challenge, HMAC, epoch/sequence/deadline fences | `registry.test.ts`, `live.test.ts`, package journey | Packaged fake-Live and macOS real-Live | `OPERATIONS.md`, `RECOVERY.md`; no remote-network mode |
| References, discovery, selection | set, track/return/main, scene, slot, clip, note, locator, device, parameter, routing, playback, selection | registry + mapper traversal; R; parent-scoped refs/cursors/revisions; selection reuses canonical dereferenceable track/scene/slot refs | registry, host, Python tests | `phase-3-readonly-live-discovery.json` and later real-Live phase evidence | `USER_GUIDE.md`; stale refs/epochs are rejected |
| Transport, loop, metronome, punch, count-in | `transport.set`, transport preview/apply/undo | host transactions + mapper; G/A where playback can change | host/Python/package journey | `phase-5a-transport-clip-live.txt` (macOS real-Live) | `LIVE_SAFETY.md`; fresh playback/recording state required |
| Session audition and emergency stop | `session.audition-launch/stop`, `session.emergency-stop`, playback discovery | dedicated host/mapper transaction; A; unpredictable token, exact targets, replay, owned stop | host, Python, package journey | `phase-4-guarded-audition.json` and exact-candidate read-only status externally retained | `LIVE_SAFETY.md`, `RECOVERY.md`; external playback is never claimed as owned |
| Session structure | track/scene create/delete/rename plus clip/device/locator rename; slot and Session clip discovery | preview/apply/undo manager + mapper; G | host/Python/package journey | Real-Live phase 5 evidence; packaged fake-Live | `USER_GUIDE.md`; group/return/main edits are only exposed where canonical operations exist |
| Session MIDI clips and notes | `clip.create/delete`, single-note `note.add`, atomic `note.add-batch`, `note.update/delete`, Session MIDI preview/apply/undo | `session-midi.ts`, host, mapper; G; stable note identity, one bounded native batch per clip creation, and compensation | `session-midi.test.ts`, host/Python/package journey | Historical real-Live phases cover the then-current basic lifecycle; current contract and expressive lifecycle are packaged fake-Live pending exact-candidate real-Live proof | `USER_GUIDE.md`; pitch, velocity, channel, duration, probability, deviation, release velocity, mute are negotiated |
| Advanced MIDI / MPE | probability, velocity deviation, release velocity, mute where exposed | note schemas and mapper; G | registry/host/Python journey tests | Expressive fields are proven in packaged fake-Live only; successful current-candidate real-Live proof is pending, and per-note MPE pressure/slide/tuning is unavailable | `USER_GUIDE.md`; extension point is canonical note schema plus negotiated mapper operation, never fabricated fields |
| Session capture | `session.capture-midi`, `scene.capture` | host preview/apply/idempotency/guarded-undo transactions plus mapper preflight, immutable object-identity delete fences, and fresh revision/readback; G/A | host/Python/package journey | Real-Live phase 5 evidence | `LIVE_SAFETY.md`; capture result must be newly discoverable; MIDI capture is advertised only while every Session slot is empty so native failure cleanup cannot alter pre-existing clip content |
| Arrangement navigation and clips | arrangement discovery; clip create/duplicate/move; transaction-owned cleanup; locators add/delete | host transaction managers + mapper; G | host/Python/package journey | `phase-5cd-clip-arrangement-live.txt` plus current tests | `USER_GUIDE.md`; arbitrary Arrangement deletion is refused; exact created identity+fingerprint cleanup applies to create/duplicate only, while moves fence source/destination content and use exact inverse-move recovery, never mint deletion authority, and consume any prior cleanup token for a transaction-created source |
| Audio clip properties | field-negotiated gain, pitch, loop, warp enable/mode and fades in `audio.clip.set`; bounded warp-marker readback | host/registry/mapper; G; each requested field must appear in the exact clip's `availableAudioFields` | host, registry and Python fake-Live tests | Real-Live phase 5cd proves safe refusal on a MIDI target, not a successful audio edit | `USER_GUIDE.md`; successful current-candidate real-Live audio edits and warp-marker editing/take-lane/comp APIs remain unproven or unavailable; marker readback never implies edit authority; reserved canonical `audio.warp-marker.*`, `audio.take-lane.read`, and `audio.comp.read` contracts stay unadvertised until executable |
| Automation | clip envelopes and points create/read/insert/delete/restore | host + mapper; G, parent/revision bound | host/Python/package journey | `phase-5e-mixer-automation-live.txt` | `USER_GUIDE.md`; Arrangement automation/modulation is unavailable in observed API; strict `arrangement.automation.*` contracts are registry-tested and remain unadvertised until executable |
| Mixer, sends, returns, groups, cue | mixer discovery/set with exact row revision | host + mapper; G/A | host/Python/package journey | `phase-5e-mixer-automation-live.txt` | `LIVE_SAFETY.md`; only discovered writable fields are changed; clipping is not inferred away |
| Routing, monitoring, arm | routing-choice discovery, `routing.set` | host + mapper; G/A; feedback refusal, exact route, arm/monitor fences | host/Python/package journey | `phase-6cd-routing-recording-live.txt` | `LIVE_SAFETY.md`; operator-prepared capture routing is required |
| Session/Arrangement recording | `recording.session`, `recording.arrangement` preview/apply/stop | host + mapper; A; exact prior recording state, armed destination and output-safety authority are rechecked atomically in the mapper; verified stop | host/Python/package journey | `phase-6cd-routing-recording-live.txt` | `LIVE_SAFETY.md`, `RECOVERY.md`; no unbounded record command |
| Device hierarchy | devices, racks, chains, drum pads, macros, parameters | recursively flattened parent-scoped nested-device/parameter discovery plus device/parameter transactions; G/A | host/registry/Python/package journey | `phase-6ab-devices-browser-live.txt` | `USER_GUIDE.md`; macro variations and sidechain fields are reported only when Live exposes them |
| Device lifecycle and parameters | insert/enable/move, transaction-owned cleanup, bounded published parameter set/undo | host + mapper; G; mutation binds exact device, owner, track, sibling order, state, and creation fingerprint where applicable | host/Python/package journey | `phase-6ab-devices-browser-live.txt` plus current tests | Arbitrary device deletion and plug-in UI control are unsupported; cleanup is limited to exact transaction-created devices, and insert/load is conservatively limited to an empty device owner so cleanup cannot affect an unrelated sibling |
| Presets and third-party plug-ins | exact Browser item inspection and device-only load; published parameters after discovery | browser/device transactions; G; non-device results are rejected before mutation and ownership/availability are operator facts | journey/host/Python tests | Packaged fake-Live; native Browser load in macOS real-Live | Exact third-party preset workflow and UI automation are not certified; extension point is discovered Browser identity + published parameters |
| Browser | search/filter/inspect plus exact device-only load | host + mapper; R/G; inspection fence is rechecked before load | host/Python/package journey | `phase-6ab-devices-browser-live.txt` | Browser audio preview/stop is unavailable where no authoritative preview/stop API exists; strict `browser.preview.start/stop` contracts are tested as unadvertised extension points |
| Projects and files | project info, manifest, missing-media metadata, verified colocated backup | `project.ts`; R/FS; caller allow-root, `.als` content marker, bounded file, no media reads, atomic hash-verified copy | `project.test.ts`, host/Python phase tests | `phase-7a-project-ops-live.txt` | Canonical `project.new/open/save/save-as/collect/export/bounce` extension IDs exist but remain unadvertised and uncallable until an adapter can execute and verify them |
| Subscriptions/events | authenticated subscribe/unsubscribe for produced `transport`, `object`, and `reset` events; bounded event queue | adapter/mapper; R; signed epoch-bound events carry epoch; undelivered adjacent coalescing preserves continuity, while real overflow emits a reset event | loopback/Python/package journey | `phase-7b-subscriptions-live.txt` | Unsupported state/meter/Max/OSC event filters are rejected rather than silently accepted; epoch change, reset, or sequence gaps require resnapshot; events are not mutation authority |
| UDP/OSC/XY/Max-packet-compatible realtime | realtime arm/disarm/stats; bounded JSON, OSC, XY and `max`-label packet ingress | mapper realtime plane; RT/A; token/TTL/source/channel/rate/queue/generation fences plus exact parameter, owner, track, path, and sibling identities rechecked on every Live-thread packet; truthful `ableton://max-extension` resource | host/Python/package journey | `phase-7c-realtime-live.json` | Runtime advertises OSC/realtime, not a `max` capability. The packet label is an extension format only; no bundled Max device, handshake, `.amxd`, or arbitrary packet authority is claimed |
| Emergency recovery | Session emergency stop, capture emergency stop/status, realtime disarm | purpose-specific independent authority; A/RT/P; Session emergency stop atomically clears clip playback, transport and both recording modes | host/Python/package/restart tests | real-Live phases 4, 7c, 8 | `RECOVERY.md`; uncertain mutation is never auto-replayed |

## Audio intelligence and privacy

| Domain | API / implementation | Safety | Tests and oracle | Production evidence | Limitations / docs |
|---|---|---|---|---|---|
| PCM analysis | `audio_analyze`; `analysis.ts` and disposable worker runner | P; bounded input/time/memory/output, cancellation, secret-stripped workers, no raw PCM result | analysis, worker, property, benchmark tests | Packaged local analysis | `AUDIO_INTELLIGENCE.md`; supplied PCM relationship is caller-declared |
| Waveform/spectrum/time-frequency/transients/phase/dynamics | `pcm-analysis/v2` aggregate summaries | P/R | deterministic fixtures and bounds | Packaged journey | Lossy aggregate evidence, not source reconstruction or mastering verdict |
| Loudness/LRA/true peak | `audio-standards.ts`, BS.1770-5 / EBU R128/Tech 3341/3342 | P/R | independent FFmpeg oracle in `phase-8-audio-oracle.json` | Packaged analysis | True peak validated only at 44.1/48 kHz; immersive/object layouts unavailable |
| Reference comparison | `audio_compare_reference`; bounded resample, alignment, level-match | P/R | `reference-analysis.test.ts`, property/benchmark | Packaged reference journey | 32–96 kHz input; ambiguity fails closed by withholding overlap, cross-source deltas, and gain advice while retaining separate source analyses; legal/source relationship is not inferred |
| Signal-chain diagnosis | `diagnoseAudioWithLiveContext` | R/P; exact refs, non-causal language | diagnosis/host tests | Packaged journey and phase 8 | Measurements do not prove a device caused a difference |
| Live audio capture | guarded Session Resampling start/status/stop/cleanup/emergency stop | A/P; consent, source/destination identity, watchdog, media identity/unlink, state restoration | capture host/file/Python/package recovery tests | `phase-8-audio-live.json` on macOS Live 12.4.5b8 | No native PCM tap is claimed; saved Set, WAV, safe routing and real-Live provenance required |

## North-star user journeys

All journey plans are read-only composition layers over purpose-specific tools;
they grant no mutation authority.

| Journey | Tool/resource/prompt and implementation | Consequential path | Packaged evidence | Real-Live / platform status | Rights, accessibility, fallback |
|---|---|---|---|---|---|
| Create beat or song | `plan_user_journey`, `ableton://journeys`, `create_beat_or_song`; `journeys.ts` | MIDI/structure/Arrangement/audition previews and exact confirmations | `phase-9-journeys-packaged.json` | Guarded primitives have macOS real-Live phase evidence; full composed journey is packaged fake-Live | High-level traits only; unavailable Arrangement stages replan/fallback |
| Sequence advanced drums | `sequence_advanced_drums` | Session MIDI creation, expressive revision, audition, readback | phase 9 packaged evidence | MIDI/audition primitives observed on macOS | No kit mapping is invented; operator-owned/discovered mappings only |
| Design owned/native sound | `design_owned_sound` | Browser load, discovered parameter shaping, audition/recovery | phase 9 packaged evidence | Browser/device primitives observed on macOS | No ownership, plug-in availability, preset, or artist identity is fabricated |
| Compare reference mix | `compare_reference_mix` | local standards/reference analysis, optional guarded capture/mixer hypothesis and restoration | phase 9 packaged evidence | Capture primitive observed on macOS; local analysis cross-platform | No exact replication/legal-clearance claim; raw audio not retained |
| Diagnose performance/recording setup | `diagnose_performance_setup` | routing/mixer preview, bounded recording, optional realtime, final restoration | phase 9 packaged evidence | component primitives observed on macOS | Latency remains unknown without authoritative API; realtime/capture require real-Live |
| Session/Arrangement editing within journeys | stages in create/song and drum plans | existing purpose-specific clip/locator/automation tools | phase 9 packaged evidence | component real-Live evidence in phases 5–6 | Unsupported Arrangement automation and comp workflows remain unavailable |

## Delivery, compatibility, and accessibility

| Domain | Implementation / safety | Tests and evidence | Supported status | Limitations / docs |
|---|---|---|---|---|
| Private artifact | strict 77-path npm tarball, release manifest, payload roles/hashes, private license | `package:verify`, candidate and Python binders, fresh-clone byte comparison | Private local tarball only | `DISTRIBUTION_POLICY.md`; unsigned, unnotarized, unpublished |
| Install/activation | `ableton-mcp-lifecycle` receipt/journal/lock; D/FS | lifecycle unit + installed-candidate matrix; activation requires real-Live and intact receipt-bound package | macOS 15 and Windows Server 2025 host contracts conditional on exact-SHA CI | Windows Live/Windows 11 activation not certified; `DELIVERY.md` |
| Upgrade/repair/rollback/uninstall | exact newer artifact, quarantine/retained cleanup, exact prior generation, owner-only purge | lifecycle unit, candidate OS matrix including Windows ACL/junction/held-file cases | Host contract only until hosted exact-SHA result | No native installer; operator must stop/restart Live |
| Node/OS compatibility | Node 22/24/25; Ubuntu 24.04, macOS 15, Windows Server 2025 workflow | full Node tests plus exact installed candidate; Python 3.11 mapper | Conditional; see current check results | Linux has no Live claim; Windows 11 is not inherited from Server |
| Keyboard operation | server stdio and lifecycle CLIs require only keyboard/stdin; ordered text statuses | packaged journey and candidate CLI tests | Server-owned text boundary | Third-party clients, terminals and Live own focus behavior |
| Screen readers | no server-owned visual UI; semantic text and non-color states | contract checks only, not VoiceOver/Narrator interaction evidence | **Not certified** | VoiceOver, Narrator, Live, plug-ins and MCP client behavior require separate interactive platform evidence; `USER_JOURNEYS.md`, `SUPPORT_MATRIX.md` |
| Signing/publication | explicit unavailable diagnostic and policy | package/candidate policy assertions | Not applicable to chosen private local channel | Authorized identities and a separate channel decision are required |

## Evidence freshness rule

Tracked phase evidence proves the named historical phase and environment. It is
not silently promoted to a later artifact. Final readiness additionally
requires the pushed-head CI artifact metadata, exact-candidate host results, and
an externally retained real-Live observation naming that same Git SHA and
artifact SHA-256. Windows Server host evidence never fills a Windows
Live/Windows 11 cell.
