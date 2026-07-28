import { createHash } from "node:crypto";
import type { LiveStatus } from "./live.js";

export const JOURNEY_PLAN_VERSION = "ableton-user-journey/v1" as const;
export const JOURNEY_IDS = ["create-beat-or-song", "sequence-advanced-drums", "design-owned-sound", "compare-reference-mix", "diagnose-performance-setup"] as const;
export type JourneyId = typeof JOURNEY_IDS[number];
export type ExperienceLevel = "beginner" | "advanced";

export interface JourneyPlanInput {
  journey: JourneyId;
  traits: string;
  experienceLevel?: ExperienceLevel;
  bars?: number;
}

type Impact = "read-only" | "project-mutation" | "potentially-audible" | "recording" | "realtime" | "destructive-cleanup";
type AuthorityMechanism = "none" | "fixed-phrase" | "unpredictable-preview-token";

interface StageAuthority {
  tools: string[];
  mechanism: AuthorityMechanism;
  phrase?: "apply" | "undo" | "emergency-stop" | "emergency-stop-and-clean" | "disarm";
  note: string;
}

interface JourneyStageDefinition {
  id: string;
  announcement: string;
  impact: Impact;
  tools: string[];
  requiredForCore: boolean;
  capabilities?: string[];
  operations?: string[];
  provenance?: "real-live";
  authorities: StageAuthority[];
  verification: string;
  recovery: string;
  unavailableFallback: string;
}

interface JourneyDefinition {
  id: JourneyId;
  title: string;
  summary: string;
  fallback: string;
  stages: JourneyStageDefinition[];
}

const none = (tools: string[], note = "Read-only; grants no Live mutation authority."): StageAuthority[] => [{ tools, mechanism: "none", note }];
const fixed = (tools: string[], phrase: StageAuthority["phrase"], note: string): StageAuthority => ({ tools, mechanism: "fixed-phrase", phrase, note });
const token = (tools: string[], note: string): StageAuthority => ({ tools, mechanism: "unpredictable-preview-token", note });

const playbackOperations = ["session.playback", "session.audition-launch", "session.audition-stop", "session.emergency-stop"];
const clipPlaybackOperations = ["session.playback", "session.clip-launch", "session.clip-stop", "session.emergency-stop"];
const midiOperations = ["clip.create", "clip.delete", "note.add", "note.add-batch", "note.delete"];
const captureOperations = ["audio.capture.inspect", "audio.capture.start", "audio.capture.status", "audio.capture.stop", "audio.capture.cleanup", "audio.capture.emergency-stop"];

export const JOURNEY_CATALOG: readonly JourneyDefinition[] = [
  {
    id: "create-beat-or-song",
    title: "Create and revise an editable beat or song section",
    summary: "Translate bounded rhythmic, harmonic, and production traits into editable Session structure and MIDI, with optional Arrangement, revision, and guarded audition stages.",
    fallback: "Return derived role/grid/section guidance and identify each unavailable stage. Never claim that Live contains or played the result.",
    stages: [
      { id: "discover", announcement: "Discovering the Set, empty slots, tempo, scenes, devices, and stopped playback.", impact: "read-only", tools: ["live_status", "live_discover"], requiredForCore: true, capabilities: ["session.read", "session.discovery"], operations: ["discover", "session.playback"], authorities: none(["live_status", "live_discover"]), verification: "Require a fresh epoch, exact target refs, an empty slot, and authoritative playback state.", recovery: "No mutation occurred; refresh status and refs when state changed.", unavailableFallback: "Return the derived editable draft only and ask the operator to configure read/discovery support." },
      { id: "draft", announcement: "Deriving bounded grid, role, section, and note guidance from allowlisted high-level traits.", impact: "read-only", tools: ["plan_user_journey"], requiredForCore: true, authorities: none(["plan_user_journey"]), verification: "Show recognized traits, excluded identity/copy intent, bar/note bounds, and any clarification requirement.", recovery: "Revise high-level traits without touching Live.", unavailableFallback: "This local planning stage is always available." },
      { id: "preview-create", announcement: "Previewing exact Session structure and MIDI targets without mutation.", impact: "read-only", tools: ["live_session_structure_preview", "live_midi_clip_preview"], requiredForCore: true, capabilities: ["session.structure", "session.midi_clip.create", "session.midi_note.write"], operations: ["track.create", "track.delete", "scene.create", "scene.delete", ...midiOperations], authorities: none(["live_session_structure_preview", "live_midi_clip_preview"]), verification: "Show exact proposed tracks/scenes/slot, editable notes, revisions, and impact.", recovery: "Discard or revise either preview independently.", unavailableFallback: "Keep a local role/grid/section draft and name unavailable creation operations." },
      { id: "apply-create", announcement: "Awaiting separate fixed apply confirmations before creating structure and MIDI.", impact: "project-mutation", tools: ["live_session_structure_apply", "live_midi_clip_apply", "live_undo"], requiredForCore: true, capabilities: ["session.structure", "session.midi_clip.create", "session.midi_note.write"], operations: ["track.create", "track.delete", "scene.create", "scene.delete", ...midiOperations], authorities: [fixed(["live_session_structure_apply", "live_midi_clip_apply"], "apply", "Each fresh preview is confirmed separately with the literal apply phrase and a new idempotency key."), fixed(["live_undo"], "undo", "Undo each applied structure/MIDI transaction separately while its postcondition still matches.")], verification: "Verify every created ref, parent, slot, note field, and idempotent replay result.", recovery: "Use guarded undo with the matching transaction while its postcondition remains exact.", unavailableFallback: "Do not issue an apply or claim creation; present the preview as instructions only." },
      { id: "arrange", announcement: "Optionally previewing and duplicating the exact created section into Arrangement.", impact: "project-mutation", tools: ["live_clip_duplicate_preview", "live_clip_duplicate_apply", "live_arrangement_clip_preview", "live_arrangement_clip_apply"], requiredForCore: false, capabilities: ["session.read", "arrangement.write"], operations: ["clip.duplicate", "arrangement.clip.delete"], authorities: [fixed(["live_clip_duplicate_apply", "live_arrangement_clip_apply"], "apply", "Confirm duplication and any exact cleanup preview independently with apply and a new idempotency key.")], verification: "Read the exact retained Arrangement clip ref, source relationship, position, length, parent, name, and revision.", recovery: "Freshly preview and apply deletion of only the exact transaction-created Arrangement clip. Arbitrary deleted pre-existing clips have no automatic undo and are outside this journey.", unavailableFallback: "Keep the section in Session and label Arrangement duplication unavailable." },
      { id: "arrange-edit", announcement: "Optionally replanning after duplication to move the retained section and prove temporary create/delete cleanup.", impact: "project-mutation", tools: ["live_clip_move_preview", "live_clip_move_apply", "live_arrangement_clip_preview", "live_arrangement_clip_apply"], requiredForCore: false, capabilities: ["session.read", "arrangement.write"], operations: ["arrangement.clip.create", "arrangement.clip.delete", "arrangement.clip.move"], authorities: [fixed(["live_clip_move_apply", "live_arrangement_clip_apply"], "apply", "Confirm each move, temporary create, or temporary delete preview independently with apply and a new idempotency key.")], verification: "Verify the retained section's exact moved position and verify that the temporary clip is absent.", recovery: "Use another exact move preview to restore position or a fresh delete preview for only a transaction-created clip; arbitrary deletion remains non-undoable.", unavailableFallback: "Retain the duplicated section at its original position and provide manual move guidance." },
      { id: "audition", announcement: "Optionally awaiting separate output-safety confirmation before one bounded audition.", impact: "potentially-audible", tools: ["live_clip_launch_preview", "live_clip_launch_apply", "live_clip_launch_stop", "live_session_emergency_stop"], requiredForCore: false, capabilities: ["session.read", "transport"], operations: clipPlaybackOperations, authorities: [token(["live_clip_launch_apply", "live_clip_launch_stop"], "Use the distinct unpredictable launch and owned-stop tokens returned by the same unexpired preview."), fixed(["live_session_emergency_stop"], "emergency-stop", "Independent stop requires exact freshly observed expected targets.")], verification: "Verify one preflighted target becomes fired/playing and then returns to the stopped baseline.", recovery: "Use the owning stop token; if ownership is unavailable, use exact fresh emergency targets.", unavailableFallback: "Do not start playback; provide visual/text inspection guidance." },
      { id: "revise", announcement: "Optionally previewing one bounded editable note revision after inspection or audition.", impact: "project-mutation", tools: ["live_note_update_preview", "live_note_update_apply", "live_undo"], requiredForCore: false, capabilities: ["session.midi_note.write"], operations: ["discover", "note.update"], authorities: [fixed(["live_note_update_apply"], "apply", "Confirm the exact stable note-ID preview with the literal apply phrase and a new idempotency key."), fixed(["live_undo"], "undo", "Undo requires the matching applied transaction and a new idempotency key.")], verification: "Read notes back by stable IDs and compare every supported changed field.", recovery: "Guardedly undo only while those note postconditions still match.", unavailableFallback: "Describe the revision without claiming it was written." },
      { id: "final-readback", announcement: "Reading final authoritative state and reporting every residual.", impact: "read-only", tools: ["live_discover", "live_snapshot"], requiredForCore: true, capabilities: ["session.read", "session.discovery"], operations: ["discover", "snapshot"], authorities: none(["live_discover", "live_snapshot"]), verification: "Report created refs, notes, Arrangement state, playback/recording state, and unresolved uncertainty.", recovery: "If readback is absent or contradictory, report uncertain and never replay a mutation blindly.", unavailableFallback: "Report that Live completion cannot be verified." },
    ],
  },
  {
    id: "sequence-advanced-drums",
    title: "Sequence expressive and probabilistic drums",
    summary: "Derive an editable bounded role pattern with fractional timing, probability, velocity/release variation, and explicit unsupported expressive fields.",
    fallback: "Return role/grid guidance and omit unsupported note fields. Never relabel velocity or timing as MPE, groove extraction, or per-note modulation.",
    stages: [
      { id: "discover", announcement: "Discovering drum pads, stable note support, clip target, tempo, and grid.", impact: "read-only", tools: ["live_status", "live_discover"], requiredForCore: true, capabilities: ["session.read", "session.discovery", "session.midi_note.read"], operations: ["discover"], authorities: none(["live_status", "live_discover"]), verification: "Resolve exact pad pitches from authoritative pad/device data or ask the operator; never guess a mapping.", recovery: "No mutation occurred.", unavailableFallback: "Return role names with pitch unset and manual mapping instructions." },
      { id: "draft", announcement: "Deriving a bounded editable drum pattern and variation from allowlisted traits.", impact: "read-only", tools: ["plan_user_journey"], requiredForCore: true, authorities: none(["plan_user_journey"]), verification: "Cap at sixteen bars/512 notes and expose role, fractional start, duration, velocity, probability, deviation, and release intent separately.", recovery: "Revise density, timing, or variation locally.", unavailableFallback: "This local planning stage is always available." },
      { id: "preview-write", announcement: "Previewing an exact empty clip target and supported drum note fields.", impact: "read-only", tools: ["live_midi_clip_preview"], requiredForCore: true, capabilities: ["session.midi_clip.create", "session.midi_note.write"], operations: midiOperations, authorities: none(["live_midi_clip_preview"]), verification: "Show exact slot/ref, normalized notes, unsupported fields, and bounds.", recovery: "Discard or revise the preview.", unavailableFallback: "Return the editable role pattern without a Live write claim." },
      { id: "apply-write", announcement: "Awaiting fixed apply confirmation before writing the exact drum clip.", impact: "project-mutation", tools: ["live_midi_clip_apply", "live_undo"], requiredForCore: true, capabilities: ["session.midi_clip.create", "session.midi_note.write"], operations: midiOperations, authorities: [fixed(["live_midi_clip_apply"], "apply", "Confirm the exact MIDI preview with apply and a new idempotency key."), fixed(["live_undo"], "undo", "Undo requires the matching transaction.")], verification: "Read notes back with server-assigned stable IDs and compare supported fields.", recovery: "Guardedly undo the transaction-created clip while its identity still matches.", unavailableFallback: "Do not write; provide manual note entry guidance." },
      { id: "expressive-revision", announcement: "Optionally previewing probability, timing, velocity, deviation, release, and mute changes by stable note ID.", impact: "project-mutation", tools: ["live_note_update_preview", "live_note_update_apply", "live_undo"], requiredForCore: false, capabilities: ["session.midi_note.write"], operations: ["discover", "note.update"], authorities: [fixed(["live_note_update_apply"], "apply", "Confirm exact note IDs/revisions with the literal apply phrase and a new idempotency key."), fixed(["live_undo"], "undo", "Undo requires the matching revision-safe transaction.")], verification: "Read back each advertised field; leave unsupported values explicitly unavailable.", recovery: "Undo only unchanged transaction-owned note updates.", unavailableFallback: "Keep expressive values as manual guidance; do not claim MPE or unavailable fields." },
      { id: "audition", announcement: "Optionally awaiting output-safety confirmation for one exact clip audition.", impact: "potentially-audible", tools: ["live_clip_launch_preview", "live_clip_launch_apply", "live_clip_launch_stop", "live_session_emergency_stop"], requiredForCore: false, capabilities: ["session.read", "transport"], operations: clipPlaybackOperations, authorities: [token(["live_clip_launch_apply", "live_clip_launch_stop"], "Use distinct unpredictable launch/owned-stop tokens."), fixed(["live_session_emergency_stop"], "emergency-stop", "Use only with exact fresh targets.")], verification: "Verify only the exact clip is active and then stopped.", recovery: "Use owned clip stop or exact emergency stop.", unavailableFallback: "Do not audition; inspect notes textually or in Live manually." },
      { id: "final-readback", announcement: "Reading final drum notes, playback state, and residuals.", impact: "read-only", tools: ["live_discover"], requiredForCore: true, capabilities: ["session.read", "session.discovery"], operations: ["discover"], authorities: none(["live_discover"]), verification: "Report exact clip/note refs, field values, and stopped state if audition occurred.", recovery: "Contradictory readback is uncertain; do not rewrite blindly.", unavailableFallback: "Report that the Live write cannot be verified." },
    ],
  },
  {
    id: "design-owned-sound",
    title: "Design a sound with available native or owned devices",
    summary: "Derive topology/control directions, select one stable Browser result, optionally edit published parameters, audition safely, and compare authoritative before/after state.",
    fallback: "Provide topology, preset, and manual-control guidance. Never claim plug-in UI control, ownership, loading, or verification without an advertised API and authoritative readback.",
    stages: [
      { id: "discover-browser", announcement: "Discovering Browser results and current topology without assuming a device exists.", impact: "read-only", tools: ["live_status", "live_browser_search", "live_discover"], requiredForCore: true, capabilities: ["session.read", "session.discovery", "browser"], operations: ["discover", "browser.search"], authorities: none(["live_status", "live_browser_search", "live_discover"]), verification: "Use stable Browser IDs and exact track/device refs; distinguish native, pack, Max, and plug-in categories.", recovery: "No mutation occurred.", unavailableFallback: "Return semantic topology/control guidance and manual Browser instructions." },
      { id: "draft", announcement: "Deriving bounded topology and semantic control directions from allowlisted sonic traits.", impact: "read-only", tools: ["plan_user_journey"], requiredForCore: true, authorities: none(["plan_user_journey"]), verification: "Explain rationale without promising an acoustic outcome; controls remain semantic until published refs/bounds exist.", recovery: "Revise high-level sonic traits locally.", unavailableFallback: "This local planning stage is always available." },
      { id: "preview-load", announcement: "Previewing one selected stable Browser result on an exact track.", impact: "read-only", tools: ["live_browser_load_preview"], requiredForCore: true, capabilities: ["browser"], operations: ["browser.load", "device.delete"], authorities: none(["live_browser_load_preview"]), verification: "Show stable result ID, exact target track, expected device identity, and cleanup operation.", recovery: "Discard the preview or choose another result.", unavailableFallback: "Do not claim load; provide manual selection guidance." },
      { id: "apply-load", announcement: "Awaiting fixed apply confirmation before loading one device.", impact: "project-mutation", tools: ["live_browser_load_apply", "live_undo"], requiredForCore: true, capabilities: ["browser"], operations: ["browser.load", "device.delete"], authorities: [fixed(["live_browser_load_apply"], "apply", "Confirm the exact Browser preview with apply and a new idempotency key."), fixed(["live_undo"], "undo", "Undo deletes only the transaction-created exact device.")], verification: "Rediscover and verify exact device parentage/class/enabled state; capabilities may change after load.", recovery: "Guardedly remove only the transaction-created device.", unavailableFallback: "Do not issue a load or claim a device was created." },
      { id: "shape-published-controls", announcement: "Optionally previewing one bounded published parameter change after rediscovery.", impact: "project-mutation", tools: ["live_device_parameter_preview", "live_device_parameter_apply", "live_undo"], requiredForCore: false, capabilities: ["devices", "parameters", "device.parameter.write"], operations: ["discover", "device.parameter.set"], authorities: [token(["live_device_parameter_apply"], "Use the unpredictable token tied to one exact enabled parameter/ref/value/revision."), fixed(["live_undo"], "undo", "Undo requires the same transaction and unchanged postcondition.")], verification: "Verify exact parentage, enabled state, bounds, quantization, value, and revision.", recovery: "Undo that parameter only; never automate an unpublished plug-in UI control.", unavailableFallback: "Present semantic manual adjustment guidance and label published parameter control unavailable." },
      { id: "audition", announcement: "Optionally awaiting output-safety confirmation for a bounded before/after audition.", impact: "potentially-audible", tools: ["live_clip_launch_preview", "live_clip_launch_apply", "live_clip_launch_stop", "live_session_emergency_stop"], requiredForCore: false, capabilities: ["session.read", "transport"], operations: clipPlaybackOperations, authorities: [token(["live_clip_launch_apply", "live_clip_launch_stop"], "Use distinct unpredictable launch and stop tokens."), fixed(["live_session_emergency_stop"], "emergency-stop", "Independent stop requires exact fresh targets.")], verification: "Compare authoritative settings; device presence is context, not causal audio proof.", recovery: "Stop exact playback and restore the prior parameter/topology through its own transaction.", unavailableFallback: "Do not play; use authoritative parameter/topology readback only." },
      { id: "final-readback", announcement: "Reading final topology, parameters, playback state, and residuals.", impact: "read-only", tools: ["live_discover"], requiredForCore: true, capabilities: ["session.read", "session.discovery"], operations: ["discover"], authorities: none(["live_discover"]), verification: "Report exact created device, changed parameter if any, playback state, and unsupported controls.", recovery: "Contradictory state is uncertain; do not reload or rewrite blindly.", unavailableFallback: "Report that Live topology cannot be verified." },
    ],
  },
  {
    id: "compare-reference-mix",
    title: "Compare a project section with a user-supplied reference",
    summary: "Analyze authorized caller PCM, align and level-match within bounds, optionally connect measured differences to fresh Live context/capture, and test one reversible hypothesis without claiming causality.",
    fallback: "Local standards/reference comparison remains available without Live. Label Live attribution unavailable and request explicit consent/provenance instead of inventing signal-chain evidence.",
    stages: [
      { id: "source-relationship", announcement: "Establishing that project/reference PCM is caller-supplied or generated and permitted for this analysis.", impact: "read-only", tools: ["audio_analyze"], requiredForCore: true, authorities: none(["audio_analyze"], "The caller supplies PCM and source relationship; this does not prove copyright ownership or legal clearance."), verification: "Record source relationship in the request without storing source paths or raw PCM in results.", recovery: "Cancel the disposable worker; no raw result is returned.", unavailableFallback: "This local stage is always available for bounded caller PCM." },
      { id: "measure", announcement: "Measuring bounded loudness, true peak, dynamics, spectrum, transients, and alignment.", impact: "read-only", tools: ["audio_compare_reference"], requiredForCore: true, authorities: none(["audio_compare_reference"]), verification: "Report standards versions, raw-audio privacy, alignment confidence/overlap, level match, and unavailable measurements.", recovery: "Use manual or disabled alignment when automatic alignment is ambiguous.", unavailableFallback: "This local stage is always available for supported PCM." },
      { id: "live-context", announcement: "Optionally linking measurements to fresh exact Live context without claiming device causality.", impact: "read-only", tools: ["live_status", "live_discover", "audio_diagnose_live_context"], requiredForCore: false, capabilities: ["session.read", "session.discovery"], operations: ["discover"], authorities: none(["live_status", "live_discover", "audio_diagnose_live_context"]), verification: "Separate measured facts, observed topology, declared source relationship, and hypotheses.", recovery: "Keep the result local-only when Live context is unavailable or stale.", unavailableFallback: "Report measurement-only advice with no Live attribution." },
      { id: "guarded-capture", announcement: "Optionally awaiting consent and exact confirmation for one ephemeral Live Resampling capture.", impact: "recording", tools: ["live_audio_capture_preview", "live_audio_capture_apply", "live_audio_capture_status", "live_audio_capture_emergency_stop"], requiredForCore: false, capabilities: ["audio.capture.resampling"], operations: captureOperations, provenance: "real-live", authorities: [token(["live_audio_capture_apply"], "Use the unpredictable token for the exact source/destination/duration/route/epoch preview."), fixed(["live_audio_capture_emergency_stop"], "emergency-stop-and-clean", "Independent capture recovery uses the literal emergency-stop-and-clean phrase and exact recovery identity.")], verification: "Require stopped playback/recording, restored route/arm/monitoring, deleted owned clip, absent WAV/ASD/quarantine, and no raw output.", recovery: "From a fresh host, inspect status and call capture emergency stop; Session playback emergency stop is not capture cleanup.", unavailableFallback: "Use caller-supplied PCM only and label Live capture unavailable." },
      { id: "reversible-hypothesis", announcement: "Optionally previewing one reversible mixer hypothesis before same-scope remeasurement.", impact: "project-mutation", tools: ["live_mixer_preview", "live_mixer_apply", "live_undo"], requiredForCore: false, capabilities: ["mixing"], operations: ["discover", "mixer.set"], authorities: [fixed(["live_mixer_apply"], "apply", "Confirm one exact bounded mixer-row preview with the literal apply phrase and a new idempotency key."), fixed(["live_undo"], "undo", "Restore the exact prior mixer state with the matching transaction.")], verification: "Restore the control and compare same-scope aggregate measurements; call it a hypothesis, never causality.", recovery: "Restore fresh authoritative mixer state and report uncertainty when recapture scope differs.", unavailableFallback: "Return measurement-led manual guidance without claiming a Live adjustment." },
      { id: "final-report", announcement: "Reporting measurement facts, text alternatives, confidence, advice, and every residual.", impact: "read-only", tools: ["audio_compare_reference"], requiredForCore: true, authorities: none(["audio_compare_reference"]), verification: "Include loudness/peak/dynamics/spectrum/transient text, alignment confidence, privacy, and Live attribution limits.", recovery: "If an optional capture or mutation is uncertain, do not call the journey complete until status/recovery reports residuals.", unavailableFallback: "This local reporting stage is always available." },
    ],
  },
  {
    id: "diagnose-performance-setup",
    title: "Diagnose a mix, recording, or performance setup",
    summary: "Aggregate authoritative playback, routing, monitoring, arm, mixer, recording, device, subscription, and realtime recovery readiness before proposing guarded fixes.",
    fallback: "Return a read-only risk checklist with exact missing capabilities. Never arm, monitor, record, route, play, or claim low-latency readiness when authority is absent.",
    stages: [
      { id: "diagnose", announcement: "Reading playback, arm, monitoring, routing, mixer, device, automation, project, and recovery readiness.", impact: "read-only", tools: ["live_status", "live_discover", "live_project_info"], requiredForCore: true, capabilities: ["session.read", "session.discovery", "routing", "mixing", "transport"], operations: ["discover", "session.playback"], authorities: none(["live_status", "live_discover", "live_project_info"]), verification: "Rank exact-ref/revision/provenance findings; unavailable measured latency remains unknown.", recovery: "No mutation occurred; if mapper-owned playback is already active, use only exact owned/emergency authority.", unavailableFallback: "Return a manual read-only feedback/clipping/arm/monitoring/latency checklist." },
      { id: "preview-fixes", announcement: "Previewing bounded routing and mixer fixes with audible/feedback impact and recovery.", impact: "read-only", tools: ["live_routing_preview", "live_mixer_preview"], requiredForCore: true, capabilities: ["routing", "mixing"], operations: ["discover", "routing.set", "mixer.set"], authorities: none(["live_routing_preview", "live_mixer_preview"]), verification: "Show exact before/after route/mixer rows, feedback refusal, revisions, and independent recovery.", recovery: "Discard previews when monitoring, output safety, refs, or stop authority is unclear.", unavailableFallback: "Keep findings read-only and identify routing/mixer operations that need manual action." },
      { id: "apply-fixes", announcement: "Optionally awaiting separate exact confirmations for each routing or mixer fix.", impact: "project-mutation", tools: ["live_routing_apply", "live_mixer_apply", "live_undo"], requiredForCore: false, capabilities: ["routing", "mixing"], operations: ["discover", "routing.set", "mixer.set"], authorities: [fixed(["live_routing_apply", "live_mixer_apply"], "apply", "Confirm each purpose-specific preview separately with the literal apply phrase and its own idempotency key."), fixed(["live_undo"], "undo", "Restore each exact transaction independently.")], verification: "Verify each route/mixer mutation independently before another consequential action.", recovery: "Undo exact unchanged rows and report any residual feedback/monitoring risk.", unavailableFallback: "Do not mutate; provide exact manual steps." },
      { id: "bounded-recording", announcement: "Optionally awaiting recording intent and exact confirmation for one bounded recording lifecycle.", impact: "recording", tools: ["live_recording_preview", "live_recording_apply", "live_session_emergency_stop"], requiredForCore: false, capabilities: ["recording"], operations: ["discover", "session.playback", "recording.session", "recording.arrangement", "session.emergency-stop"], authorities: [fixed(["live_recording_apply"], "apply", "Confirm exact mode/destination/arm/monitoring/playback preconditions with the literal apply phrase and a new idempotency key."), fixed(["live_session_emergency_stop"], "emergency-stop", "Independent playback/recording stop requires exact fresh targets/state.")], verification: "Verify start and stop, exact destination/clip or Arrangement state, and restored arm/monitoring/transport.", recovery: "Stop exact recording, restore routing/arm/monitoring, and report created media/clips.", unavailableFallback: "Do not arm or record; return a manual preflight checklist." },
      { id: "bounded-realtime", announcement: "Optionally awaiting short-lived realtime authority for exact channels, ports, and parameters.", impact: "realtime", tools: ["live_realtime_arm_preview", "live_realtime_arm_apply", "live_realtime_stats", "live_realtime_disarm", "live_session_emergency_stop"], requiredForCore: false, capabilities: ["osc", "realtime.events"], operations: ["realtime.arm", "realtime.disarm", "realtime.stats", "session.emergency-stop"], provenance: "real-live", authorities: [fixed(["live_realtime_arm_apply"], "apply", "Confirm exact TTL/channels/source ports/parameter refs with the literal apply phrase and a new idempotency key."), fixed(["live_realtime_disarm"], "disarm", "Immediately revoke realtime authority with the literal disarm phrase."), fixed(["live_session_emergency_stop"], "emergency-stop", "Emergency stop remains independent of UDP token state.")], verification: "Distinguish accepted/applied/dropped counters and verify expiry/disarm plus stopped state.", recovery: "Disarm immediately and use independent authenticated TCP emergency stop.", unavailableFallback: "Do not claim low-latency control; use bounded request/response tools." },
      { id: "final-readback", announcement: "Reading final routing, mixer, recording, playback, realtime authority, and residual state.", impact: "read-only", tools: ["live_discover"], requiredForCore: true, capabilities: ["session.read", "session.discovery"], operations: ["discover", "session.playback"], authorities: none(["live_discover"], "Realtime stats evidence is carried forward only when the optional realtime stage was available."), verification: "Report exact rows/refs, transport/recording, authority expiry/disarm, and every residual.", recovery: "Contradictory/missing state is uncertain; use fresh discovery and only independently authorized stop.", unavailableFallback: "Report that final Live state cannot be verified." },
    ],
  },
] as const;

export const JOURNEY_PROMPTS = JOURNEY_CATALOG.map((journey) => ({
  name: journey.id.replaceAll("-", "_"),
  description: journey.summary,
  arguments: [
    { name: "traits", description: "Bounded natural-language intent. Only allowlisted high-level traits enter derived guidance; identity/exact-copy text is excluded.", required: true },
    { name: "experienceLevel", description: "beginner or advanced (default beginner).", required: false },
    { name: "bars", description: "Optional 1-16 bar planning bound, encoded as a decimal string.", required: false },
  ],
}));

const TRAIT_VOCABULARY: Readonly<Record<string, readonly string[]>> = {
  rhythm: ["straight", "syncopated", "swung", "swing", "half-time", "double-time", "broken", "steady", "offbeat"],
  density: ["sparse", "minimal", "dense", "busy", "layered"],
  energy: ["calm", "relaxed", "driving", "energetic", "aggressive", "gentle"],
  timbre: ["warm", "bright", "dark", "soft", "gritty", "clean", "rounded", "sharp", "organic", "metallic", "airy"],
  space: ["dry", "intimate", "wide", "narrow", "spacious", "reverberant", "distant", "close"],
  dynamics: ["controlled", "punchy", "dynamic", "compressed", "clear", "balanced", "loud", "quiet"],
  harmony: ["major", "minor", "modal", "dissonant", "consonant", "chromatic"],
  arrangement: ["gradual", "contrasting", "repetitive", "evolving", "short", "long"],
};
const EXACT_COPY_PATTERN = /\b(?:copy|replicate|recreate|duplicate|identical|exact(?:ly)?|signature|sound\s+like|in\s+the\s+style\s+of)\b/i;
const IDENTITY_HINT_PATTERN = /\b(?:artist|song|record|track|band|producer|composer|singer)\b/i;

function definition(id: JourneyId): JourneyDefinition {
  const result = JOURNEY_CATALOG.find((candidate) => candidate.id === id);
  if (!result) throw new RangeError("unknown user journey");
  return result;
}

function normalizeInput(input: JourneyPlanInput): Required<JourneyPlanInput> {
  if (!JOURNEY_IDS.includes(input.journey)) throw new RangeError("journey must be one of the five supported user journeys");
  if (typeof input.traits !== "string" || input.traits.trim().length < 1 || input.traits.length > 1_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.traits)) throw new RangeError("traits must be 1-1000 printable characters");
  const experienceLevel = input.experienceLevel ?? "beginner";
  if (experienceLevel !== "beginner" && experienceLevel !== "advanced") throw new RangeError("experienceLevel must be beginner or advanced");
  const bars = input.bars ?? 4;
  if (!Number.isInteger(bars) || bars < 1 || bars > 16) throw new RangeError("bars must be an integer from 1 to 16");
  return { journey: input.journey, traits: input.traits.trim(), experienceLevel, bars };
}

function translateIntent(original: string) {
  const lower = original.toLocaleLowerCase("en-US");
  const containsTrait = (value: string): boolean => new RegExp(`(?:^|[^a-z0-9])${value.replaceAll("-", "[- ]")}(?:$|[^a-z0-9])`, "i").test(lower);
  const candidates = Object.entries(TRAIT_VOCABULARY).flatMap(([dimension, values]) => values.filter(containsTrait).map((value) => ({ dimension, value: value === "swing" ? "swung" : value })));
  const deduplicated = candidates.filter((entry, index, all) => all.findIndex((candidate) => candidate.dimension === entry.dimension && candidate.value === entry.value) === index);
  const exactCopyIntentDetected = EXACT_COPY_PATTERN.test(original);
  const vocabularyWords = new Set(Object.values(TRAIT_VOCABULARY).flat().flatMap((value) => value.split("-")));
  const ambiguousTitleIdentity = [...original.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g)].some((match) => match[0].split(/\s+/).some((word) => !vocabularyWords.has(word.toLocaleLowerCase("en-US"))));
  const identityReferenceMayBePresent = IDENTITY_HINT_PATTERN.test(original) || exactCopyIntentDetected || ambiguousTitleIdentity;
  // A name can itself contain an allowlisted word (for example “Bright Eyes”
  // or “Major Lazer”). Without a rights-aware language model we cannot prove
  // which matched words are descriptors rather than identity. Fail closed and
  // ask the caller to restate traits without names/copy language.
  const policyBlocked = exactCopyIntentDetected || identityReferenceMayBePresent;
  const highLevelTraits = policyBlocked ? [] : deduplicated;
  const excludedIntent = [
    ...(exactCopyIntentDetected ? ["exact replication or signature-copy request"] : []),
    ...(identityReferenceMayBePresent ? ["artist/song/person identity reference; all coincident trait words excluded"] : []),
  ];
  return {
    untrustedOriginalRequest: original,
    highLevelTraits,
    exactCopyIntentDetected,
    identityReferenceMayBePresent,
    excludedIntent,
    translationPolicy: "identity/copy detection blocks all extraction; otherwise only allowlisted high-level traits influence guidance",
    clarificationRequired: highLevelTraits.length === 0,
  };
}

function traitSet(intent: ReturnType<typeof translateIntent>): Set<string> {
  return new Set(intent.highLevelTraits.map((entry) => entry.value));
}

function deriveGuidance(journey: JourneyId, intent: ReturnType<typeof translateIntent>, bars: number) {
  const traits = traitSet(intent);
  const dense = traits.has("dense") || traits.has("busy") || traits.has("layered");
  const sparse = traits.has("sparse") || traits.has("minimal");
  const syncopated = traits.has("syncopated") || traits.has("broken") || traits.has("offbeat");
  const swung = traits.has("swung");
  const energetic = traits.has("energetic") || traits.has("driving") || traits.has("aggressive");
  const calm = traits.has("calm") || traits.has("relaxed") || traits.has("gentle");
  const tempoRangeBpm = energetic ? [120, 138] : calm ? [78, 108] : [96, 124];
  const eventsPerBar = [
    ...[0, 2, ...(syncopated ? [2.75] : [])].map((start) => ({ role: "kick", startBeat: start, durationBeats: 0.25, velocityRange: energetic ? [96, 116] : [82, 106], probability: 1, fractionalOffsetBeats: 0 })),
    ...[1, 3].map((start) => ({ role: "snare-or-clap", startBeat: start, durationBeats: 0.25, velocityRange: [88, 112], probability: 1, fractionalOffsetBeats: swung ? 0.02 : 0 })),
    ...Array.from({ length: dense ? 8 : sparse ? 4 : 6 }, (_, index) => ({ role: "closed-hat", startBeat: index * (dense ? 0.5 : sparse ? 1 : 2 / 3), durationBeats: 0.125, velocityRange: [58, 88], probability: index % 4 === 3 ? 0.75 : 0.95, fractionalOffsetBeats: swung && index % 2 === 1 ? 0.03 : 0 })),
  ];
  const drumRoleEvents = Array.from({ length: bars }, (_, bar) => eventsPerBar.map((event) => ({ ...event, startBeat: Number((event.startBeat + bar * 4).toFixed(4)), pitch: null as null }))).flat().slice(0, 512);
  if (journey === "create-beat-or-song") return {
    kind: "editable-song-draft",
    derivedFromAllowlistedTraits: [...traits],
    tempoRangeBpm,
    meter: "4/4",
    bars,
    drumRoleEvents,
    pitchMapping: "unset-until-authoritative-pad-or-instrument-discovery",
    harmonicDirection: traits.has("minor") ? "minor" : traits.has("major") ? "major" : "ask-for-key-or-keep-pitch-content-unset",
    sections: bars >= 8 ? [{ name: "A", startBar: 1, lengthBars: Math.floor(bars / 2) }, { name: "B-variation", startBar: Math.floor(bars / 2) + 1, lengthBars: Math.ceil(bars / 2) }] : [{ name: "A", startBar: 1, lengthBars: bars }],
  };
  if (journey === "sequence-advanced-drums") return {
    kind: "editable-drum-role-pattern",
    derivedFromAllowlistedTraits: [...traits],
    bars,
    drumRoleEvents,
    pitchMapping: "unset-until-authoritative-drum-pad-discovery",
    expressiveFields: ["fractional-start", "velocity", "probability", "velocity-deviation", "release-velocity", "mute"],
    notClaimed: ["MPE", "groove-extraction", "per-note-modulation"],
  };
  if (journey === "design-owned-sound") return {
    kind: "semantic-sound-design-directions",
    derivedFromAllowlistedTraits: [...traits],
    browserQueryTerms: [...traits].filter((value) => ["warm", "bright", "dark", "soft", "gritty", "clean", "organic", "metallic", "airy"].includes(value)).slice(0, 4),
    topology: traits.has("wide") || traits.has("spacious") ? ["instrument-or-source", "tone-shaping", "bounded-stereo-or-space-stage"] : ["instrument-or-source", "tone-shaping"],
    controlDirections: [
      ...(traits.has("bright") || traits.has("sharp") ? [{ semanticControl: "filter-cutoff-or-high-frequency-balance", direction: "increase-within-published-bounds" }] : []),
      ...(traits.has("warm") || traits.has("dark") || traits.has("soft") ? [{ semanticControl: "filter-cutoff-or-high-frequency-balance", direction: "decrease-moderately-within-published-bounds" }] : []),
      ...(traits.has("punchy") ? [{ semanticControl: "amplitude-envelope-attack", direction: "shorten-within-published-bounds" }] : []),
    ],
    exactValues: "unset-until-published-parameter-discovery",
  };
  if (journey === "compare-reference-mix") return {
    kind: "measurement-focus",
    derivedFromAllowlistedTraits: [...traits],
    compare: ["integrated/momentary/short-term loudness", "true peak", "LRA/dynamics", "spectrum", "transients", "alignment confidence"],
    focus: [...(traits.has("clear") || traits.has("balanced") ? ["spectral-balance-and-dynamics"] : []), ...(traits.has("punchy") ? ["transient-and-crest-factor"] : []), ...(traits.has("wide") || traits.has("narrow") ? ["channel-correlation-and-width-proxies"] : [])],
    causalClaim: false,
  };
  return {
    kind: "performance-risk-checklist",
    derivedFromAllowlistedTraits: [...traits],
    orderedChecks: ["owned playback/recording", "arm and monitoring", "input/output routes and feedback", "mixer clipping/mute/solo", "device and automation state", "recording destination", "realtime TTL/ports/targets", "independent stop and residual state"],
    latency: "unknown-unless-measured-by-an-external-authoritative-path",
  };
}

function stageAvailability(stage: JourneyStageDefinition, status: LiveStatus) {
  const capabilities = new Set<string>(status.capabilities ?? []);
  const operations = new Set<string>(status.operations ?? []);
  const requiredCapabilities = stage.capabilities ?? [];
  const requiredOperations = stage.operations ?? [];
  const needsLive = requiredCapabilities.length > 0 || requiredOperations.length > 0 || stage.provenance !== undefined;
  const missingCapabilities = requiredCapabilities.filter((value) => !capabilities.has(value));
  const missingOperations = requiredOperations.filter((value) => !operations.has(value));
  const provenanceAvailable = stage.provenance === undefined || status.provenance === stage.provenance;
  const available = !needsLive || (status.connected && status.epoch !== null && missingCapabilities.length === 0 && missingOperations.length === 0 && provenanceAvailable);
  return { available, missingCapabilities, missingOperations, requiredProvenance: stage.provenance ?? null, provenanceAvailable };
}

export function planUserJourney(input: JourneyPlanInput, status: LiveStatus) {
  const normalized = normalizeInput(input);
  const selected = definition(normalized.journey);
  const intent = translateIntent(normalized.traits);
  const stages = selected.stages.map((stage, index) => {
    const availability = stageAvailability(stage, status);
    const capabilityAvailable = availability.available;
    const available = capabilityAvailable && !intent.clarificationRequired;
    return { order: index + 1, status: intent.clarificationRequired ? "blocked-by-intent" : capabilityAvailable ? "planned" : "unavailable", ...stage, ...availability, capabilityAvailable, available, blockedByIntent: intent.clarificationRequired };
  });
  const coreStages = stages.filter((stage) => stage.requiredForCore);
  const coreCapabilitiesAvailable = coreStages.every((stage) => stage.capabilityAvailable);
  const allStagesAvailable = stages.every((stage) => stage.capabilityAvailable);
  const executable = coreCapabilitiesAvailable && !intent.clarificationRequired;
  const mode = intent.clarificationRequired ? "intent-clarification-required" : !coreCapabilitiesAvailable ? "capability-limited" : allStagesAvailable ? "capability-complete" : normalized.journey === "compare-reference-mix" && !status.connected ? "local-analysis" : "core-capability-complete";
  const requiredCapabilities = [...new Set(coreStages.flatMap((stage) => stage.capabilities ?? []))];
  const requiredOperations = [...new Set(coreStages.flatMap((stage) => stage.operations ?? []))];
  const missingCapabilities = [...new Set(coreStages.flatMap((stage) => stage.missingCapabilities))];
  const missingOperations = [...new Set(coreStages.flatMap((stage) => stage.missingOperations))];
  const planIdentity = JSON.stringify({ normalized, translated: intent.highLevelTraits, connected: status.connected, adapter: status.adapter, epoch: status.epoch, provenance: status.provenance ?? "unknown", registryHash: status.registryHash ?? null, operations: [...(status.operations ?? [])].sort(), capabilities: [...status.capabilities].sort() });
  return {
    version: JOURNEY_PLAN_VERSION,
    planId: `journey_${createHash("sha256").update(planIdentity).digest("hex").slice(0, 24)}`,
    journey: selected.id,
    title: selected.title,
    intent,
    guidance: deriveGuidance(normalized.journey, intent, normalized.bars),
    mode,
    executable,
    beginner: {
      summary: intent.clarificationRequired ? "No allowlisted high-level trait could be derived safely. Ask for musical, rhythmic, timbral, spatial, dynamic, harmonic, energy, density, or arrangement traits without relying on identity or exact copying." : !coreCapabilitiesAvailable ? `This Live setup cannot complete the core journey. ${selected.fallback}` : selected.summary,
      nextAction: intent.clarificationRequired ? "Request high-level traits; do not forward identity/exact-copy wording into creation." : stages.find((stage) => stage.status === "planned")?.announcement,
      consequentialActionsRequirePurposeSpecificConfirmation: true,
    },
    advanced: {
      adapter: status.adapter,
      connected: status.connected,
      epoch: status.epoch,
      provenance: status.provenance ?? "unknown",
      registryHash: status.registryHash ?? null,
      requiredCapabilities,
      requiredOperations,
      missingCapabilities,
      missingOperations,
      unavailableOptionalStages: stages.filter((stage) => !stage.requiredForCore && !stage.capabilityAvailable).map((stage) => ({ id: stage.id, missingCapabilities: stage.missingCapabilities, missingOperations: stage.missingOperations, fallback: stage.unavailableFallback })),
      exactRefsRequiredBeforeMutation: true,
      staleEpochOrRevisionPolicy: "refuse-and-replan",
    },
    bounds: { bars: normalized.bars, maximumBars: 16, maximumNotes: 512, maximumConsequentialAppliesPerStage: 16 },
    stages,
    progress: {
      orderedStatuses: ["discovering", "planned", "awaiting_confirmation", "applying", "verifying", "completed", "recovered", "uncertain"],
      templateStatusOnly: true,
      executionStatusSource: "client-or-agent-must-derive-from-actual-purpose-specific-tool-results",
      announcementsAreText: true,
      statusIsNeverColorOnly: true,
      terminalResultRequiresResidualState: true,
      cancellationRule: "stop-advancing-read-fresh-state-and-use-only-the-stage-recovery-authority",
    },
    rights: {
      translationPerformed: true,
      exactReplicationDelivered: false,
      protectedExpressionAccessClaimed: false,
      legalClearanceClaimed: false,
      userSuppliedReferenceMustBeAuthorizedByUser: true,
    },
    accessibility: {
      semanticTitle: selected.title,
      orderedStageAnnouncements: true,
      nonColorStatusLabels: true,
      boundedVisualsRequireTextAlternatives: true,
      mouseOnlyInstructions: false,
      stdioFocusManagement: "not-applicable-no-shipped-interactive-ui",
      clientAndLiveScreenReaderSupport: "client-and-Live-version-dependent-see-documented-limitations",
    },
    fallback: selected.fallback,
    residualStateTemplate: { status: "not-started", requiredAtTerminal: true, items: [] as string[] },
  };
}

export function journeyResource(status: LiveStatus) {
  return {
    version: JOURNEY_PLAN_VERSION,
    description: "Five bounded journeys over purpose-specific guarded tools; this read-only resource grants no mutation authority.",
    journeys: JOURNEY_CATALOG.map((journey) => {
      const plan = planUserJourney({ journey: journey.id, traits: "controlled clear balanced", experienceLevel: "beginner", bars: 4 }, status);
      return { id: journey.id, title: journey.title, summary: journey.summary, mode: plan.mode, executable: plan.executable, missingCapabilities: plan.advanced.missingCapabilities, missingOperations: plan.advanced.missingOperations, unavailableOptionalStages: plan.advanced.unavailableOptionalStages, fallback: journey.fallback };
    }),
    rightsPolicy: "Only allowlisted high-level traits influence guidance; names and exact-copy language are excluded. No exact replication, protected-expression access, or legal-clearance claim.",
    authority: "Read-only catalog. Every mutation still requires its purpose-specific preview, real authority mechanism, idempotency key, verification, and recovery path.",
  };
}

export function renderJourneyPrompt(input: JourneyPlanInput, status: LiveStatus): string {
  const plan = planUserJourney(input, status);
  return [
    `# ${plan.title}`,
    "",
    `Status: ${plan.mode}.`,
    `Beginner summary: ${plan.beginner.summary}`,
    "",
    "Follow only stages whose status is planned. Announce them in order, mark unavailable stages as skipped with their fallback, stop at every listed per-tool authority gate, and never substitute a generic mutation.",
    "Use only intent.highLevelTraits and guidance for creative decisions. Never forward untrustedOriginalRequest names or exact-copy wording into creation. Do not promise exact replication or legal clearance.",
    "The returned stage statuses are a planning template, not execution truth. Derive progress from actual purpose-specific tool results. If any apply is cancelled, times out, loses acknowledgement, or fails verification, report uncertain state, perform fresh readback, and use only that stage's listed recovery authority.",
    "Provide text alternatives for waveform/spectral summaries and never communicate status by color alone. Every terminal report must enumerate residual state.",
    "",
    JSON.stringify(plan, null, 2),
  ].join("\n");
}
