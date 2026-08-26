import { JOURNEY_IDS } from "./journeys.js";
import type { LiveCapability, LiveStatus } from "./live.js";

/**
 * Declarative tool catalog: one entry per MCP tool containing the schema,
 * annotations, exact capability/operation/provenance prerequisites, and the
 * deployment policy class. `tools/list`, the capability resource, and the
 * server-side dispatch gate all derive from this single source so discovery
 * can never advertise a tool that dispatch would refuse, or vice versa.
 */

export type ToolPolicyClass = "local" | "read" | "edit" | "performance" | "audio" | "filesystem" | "recording" | "realtime" | "capture";

export const TOOL_POLICY_CLASSES: readonly ToolPolicyClass[] = ["local", "read", "edit", "performance", "audio", "filesystem", "recording", "realtime", "capture"];

export type ToolPolicyProfile = "read-only" | "edit-no-audio" | "performance" | "full";

export const TOOL_POLICY_PROFILES: Record<ToolPolicyProfile, { readonly classes: readonly ToolPolicyClass[]; readonly include?: readonly string[]; readonly description: string }> = {
  "read-only": { classes: ["local", "read"], description: "Local tools and read-only Live discovery; no mutation of any kind." },
  "edit-no-audio": { classes: ["local", "read", "edit"], description: "Read plus structural, MIDI, device, mixer, automation, and routing edits; no audible, audio-file, recording, realtime, capture, or filesystem-mutating tools." },
  "performance": { classes: ["local", "read", "performance"], include: ["live_mixer_*", "live_mixer_extended_*", "live_chain_mixer_*", "live_tempo_*", "live_undo", "live_recovery_finalize"], description: "Read plus live-set control: transport, tempo, clip/scene launch, guarded audition, emergency stop, mixer, views, selection, and locator navigation. Guarded undo and recovery finalization remain available so applied transactions are never stranded; the owner-domain re-check still refuses undo for disallowed domains." },
  "full": { classes: [...TOOL_POLICY_CLASSES], description: "Every currently executable tool, subject to negotiated Live capabilities." },
};

/** Exact capability/operation/provenance prerequisites for one tool. */
export interface ToolAvailabilityPrereq {
  /** Available regardless of adapter state (local and always-on read tools). */
  readonly always?: boolean;
  /** Never callable; surfaced through the capability resource only. */
  readonly never?: boolean;
  /** Requires an exact adapter provenance. */
  readonly provenance?: "real-live";
  /** All of these negotiated capabilities must be present. */
  readonly capabilitiesAll?: readonly LiveCapability[];
  /** At least one of these negotiated capabilities must be present. */
  readonly capabilitiesAny?: readonly LiveCapability[];
  /** All of these negotiated operations must be present. */
  readonly operationsAll?: readonly string[];
  /** At least one of these negotiated operations must be present. */
  readonly operationsAny?: readonly string[];
  /** Requires the aggregate mutation surface (session/arrangement/audio/device/browser/routing/recording/realtime writes plus at least one exact mutation operation). */
  readonly mutationAvailable?: boolean;
}

type AvailabilityRule = { readonly name?: string; readonly prefix?: string; readonly prereq: ToolAvailabilityPrereq };

/** Ordered availability rules; the first exact-name or longest-prefix match wins.
 * Mirrors the negotiated capability/operation semantics previously hard-coded in
 * the host's availability computation. */
export const TOOL_AVAILABILITY_RULES: readonly AvailabilityRule[] = [
  { name: "server_status", prereq: { always: true } },
  { name: "capabilities", prereq: { always: true } },
  { name: "plan_user_journey", prereq: { always: true } },
  { name: "audio_analyze", prereq: { always: true } },
  { name: "audio_compare_reference", prereq: { always: true } },
  { name: "live_status", prereq: { always: true } },
  { name: "live_project_snapshot_diff", prereq: { always: true } },
  { name: "live_snapshot", prereq: { capabilitiesAll: ["session.read"], operationsAll: ["snapshot"] } },
  { name: "live_project_info", prereq: { capabilitiesAll: ["session.read"], operationsAll: ["snapshot"] } },
  { name: "live_project_snapshot_export", prereq: { capabilitiesAll: ["session.read"], operationsAll: ["snapshot"] } },
  { prefix: "live_project_backup_", prereq: { capabilitiesAll: ["session.read"], operationsAll: ["snapshot"] } },
  { name: "audio_diagnose_live_context", prereq: { capabilitiesAll: ["session.read"], operationsAll: ["snapshot"] } },
  { name: "live_discover", prereq: { capabilitiesAll: ["session.discovery"], operationsAll: ["discover"] } },
  { name: "live_audio_capture_status", prereq: { provenance: "real-live", operationsAll: ["audio.capture.status", "audio.capture.emergency-stop", "audio.capture.cleanup"] } },
  { name: "live_audio_capture_emergency_stop", prereq: { provenance: "real-live", operationsAll: ["audio.capture.status", "audio.capture.emergency-stop", "audio.capture.cleanup"] } },
  { prefix: "live_audio_capture_", prereq: { provenance: "real-live", capabilitiesAll: ["audio.capture.resampling"], operationsAll: ["audio.capture.inspect", "audio.capture.start", "audio.capture.stop", "audio.capture.status", "audio.capture.emergency-stop", "audio.capture.cleanup"] } },
  { name: "live_session_audition_stop", prereq: { capabilitiesAll: ["transport"], operationsAll: ["snapshot", "session.playback", "session.audition-stop"] } },
  { prefix: "live_session_audition_", prereq: { capabilitiesAll: ["transport"], operationsAll: ["snapshot", "session.playback", "session.audition-launch", "session.audition-stop", "session.emergency-stop"] } },
  { name: "live_session_emergency_stop", prereq: { capabilitiesAll: ["transport"], operationsAll: ["snapshot", "session.playback", "session.emergency-stop"] } },
  { prefix: "live_transport_action_", prereq: { capabilitiesAll: ["transport"], operationsAll: ["transport.action"] } },
  { prefix: "live_transport_", prereq: { capabilitiesAll: ["transport"], operationsAll: ["snapshot", "transport.set"] } },
  { name: "live_clip_launch_stop", prereq: { capabilitiesAll: ["transport"], operationsAll: ["snapshot", "session.playback", "session.clip-stop"] } },
  { prefix: "live_clip_launch_", prereq: { capabilitiesAll: ["transport"], operationsAll: ["snapshot", "session.playback", "session.clip-launch", "session.clip-stop"] } },
  { prefix: "live_tempo_", prereq: { capabilitiesAll: ["transport"], operationsAll: ["snapshot", "get", "tempo.set"] } },
  { prefix: "live_capture_midi_", prereq: { capabilitiesAll: ["session.structure"], operationsAll: ["snapshot", "session.capture-midi", "clip.delete"] } },
  { prefix: "live_scene_capture_", prereq: { capabilitiesAll: ["session.structure"], operationsAll: ["snapshot", "scene.capture", "scene.delete"] } },
  { prefix: "live_session_structure_", prereq: { capabilitiesAll: ["session.structure"], operationsAll: ["snapshot", "track.create", "track.delete", "scene.create", "scene.delete"] } },
  { prefix: "live_note_update_", prereq: { capabilitiesAll: ["session.midi_note.write"], operationsAll: ["snapshot", "note.update"] } },
  { prefix: "live_note_delete_", prereq: { capabilitiesAll: ["session.midi_note.write"], operationsAll: ["snapshot", "note.delete", "note.add-batch"] } },
  { prefix: "live_midi_clip_", prereq: { capabilitiesAll: ["session.midi_clip.create", "session.midi_note.write"], operationsAll: ["snapshot", "discover", "clip.create", "note.add-batch", "clip.delete"] } },
  { prefix: "live_midi_transform_", prereq: { capabilitiesAll: ["session.midi_note.read", "session.midi_note.write"], operationsAll: ["snapshot", "note.update", "note.delete", "note.add-batch"] } },
  { prefix: "live_arrangement_section_", prereq: { capabilitiesAll: ["arrangement.write"], operationsAll: ["snapshot", "locator.add", "locator.delete"] } },
  { prefix: "live_arrangement_clip_", prereq: { capabilitiesAll: ["arrangement.write"], operationsAll: ["snapshot", "arrangement.clip.delete"], operationsAny: ["arrangement.clip.create", "arrangement.audio-clip.create", "take-lane.clip.create"] } },
  { name: "live_arrangement_automation_read", prereq: { capabilitiesAll: ["arrangement.read"], operationsAll: ["snapshot", "arrangement.automation.read"] } },
  { prefix: "live_clip_properties_", prereq: { capabilitiesAll: ["clips"], operationsAll: ["snapshot", "clip.set"] } },
  { prefix: "live_locator_jump_", prereq: { capabilitiesAll: ["arrangement.read"], operationsAll: ["snapshot", "locator.jump"] } },
  { prefix: "live_view_", prereq: { capabilitiesAll: ["view"], operationsAll: ["view.set", "view.control"] } },
  { prefix: "live_audio_import_", prereq: { capabilitiesAll: ["session.structure"], operationsAll: ["snapshot"], operationsAny: ["session.audio-clip.create", "take-lane.audio-clip.create"] } },
  { name: "live_warp_marker_read", prereq: { capabilitiesAll: ["warp"], operationsAll: ["snapshot", "audio.warp-marker.read"] } },
  { prefix: "live_warp_marker_", prereq: { capabilitiesAll: ["warp"], operationsAll: ["snapshot", "audio.warp-marker.read"], operationsAny: ["audio.warp-marker.add", "audio.warp-marker.move", "audio.warp-marker.delete"] } },
  { name: "live_take_lane_read", prereq: { capabilitiesAll: ["takes"], operationsAll: ["snapshot", "audio.take-lane.read"] } },
  { name: "live_comp_read", prereq: { capabilitiesAll: ["takes"], operationsAll: ["snapshot", "audio.comp.read"] } },
  { prefix: "live_clip_action_", prereq: { capabilitiesAll: ["clips"], operationsAll: ["snapshot", "clip.action"] } },
  { prefix: "live_note_edit_", prereq: { capabilitiesAll: ["session.midi_note.write"], operationsAll: ["snapshot"], operationsAny: ["note.quantize", "note.duplicate"] } },
  { name: "live_note_read", prereq: { capabilitiesAll: ["session.midi_note.read"], operationsAny: ["note.read-by-id", "note.read-selected"] } },
  { name: "live_key_estimate", prereq: { capabilitiesAll: ["clips"], operationsAll: ["snapshot"] } },
  { prefix: "live_tuning_", prereq: { capabilitiesAll: ["tuning"], operationsAll: ["tuning.read", "tuning.set"] } },
  { prefix: "live_groove_", prereq: { capabilitiesAll: ["groove"], operationsAll: ["groove.read"], operationsAny: ["groove.set", "groove.edit"] } },
  { name: "live_scene_preview", prereq: { capabilitiesAll: ["scenes"], operationsAll: ["snapshot", "scene.set"] } },
  { name: "live_scene_apply", prereq: { capabilitiesAll: ["scenes"], operationsAll: ["snapshot", "scene.set"] } },
  { prefix: "live_scene_fire_", prereq: { capabilitiesAll: ["scenes", "transport"], operationsAll: ["snapshot", "scene.fire-selected"] } },
  { name: "live_song_state", prereq: { capabilitiesAll: ["session.read"], operationsAll: ["song.read"] } },
  { prefix: "live_song_settings_", prereq: { capabilitiesAll: ["session.read"], operationsAll: ["song.read", "song.set"] } },
  { prefix: "live_track_structure_", prereq: { capabilitiesAll: ["session.structure"], operationsAll: ["snapshot"], operationsAny: ["track.create-return", "track.delete-return", "track.duplicate", "scene.duplicate"] } },
  { prefix: "live_device_delete_", prereq: { capabilitiesAll: ["devices"], operationsAll: ["snapshot", "device.delete"] } },
  { prefix: "live_track_view_", prereq: { capabilitiesAll: ["tracks"], operationsAll: ["snapshot"], operationsAny: ["track.view.set", "track.select-instrument"] } },
  { prefix: "live_track_properties_", prereq: { capabilitiesAll: ["tracks"], operationsAll: ["snapshot", "track.set"] } },
  { prefix: "live_selection_", prereq: { capabilitiesAll: ["tracks", "scenes"], operationsAll: ["snapshot"], operationsAny: ["selection.set", "song.view.set"] } },
  { prefix: "live_clip_view_", prereq: { capabilitiesAll: ["clips"], operationsAll: ["snapshot", "clip.view.set"] } },
  { prefix: "live_device_view_", prereq: { capabilitiesAll: ["devices"], operationsAll: ["snapshot", "device.view.set"] } },
  { prefix: "live_application_dialog_", prereq: { operationsAll: ["application.dialog"] } },
  { name: "live_performance_read", prereq: { capabilitiesAll: ["session.read"], operationsAll: ["performance.read"] } },
  { prefix: "live_mixer_extended_", prereq: { capabilitiesAll: ["mixing"], operationsAll: ["snapshot", "mixer.extended.set"] } },
  { prefix: "live_chain_mixer_", prereq: { capabilitiesAll: ["racks", "chains"], operationsAll: ["snapshot", "chain-mixer.set"] } },
  { prefix: "live_device_io_", prereq: { capabilitiesAll: ["devices"], operationsAll: ["snapshot"], operationsAny: ["device-io.set", "compressor.sidechain.set"] } },
  { prefix: "live_device_advanced_", prereq: { capabilitiesAll: ["devices"], operationsAll: ["snapshot"], operationsAny: ["device.bank.set", "parameter.re-enable-automation", "device.comparison.save-to-slot", "device.insert", "device.move"] } },
  { name: "live_chain_preview", prereq: { capabilitiesAll: ["chains"], operationsAll: ["snapshot", "chain.set"] } },
  { name: "live_chain_apply", prereq: { capabilitiesAll: ["chains"], operationsAll: ["snapshot", "chain.set"] } },
  { prefix: "live_drum_pad_", prereq: { capabilitiesAll: ["devices"], operationsAll: ["snapshot"], operationsAny: ["drum-pad.set", "drum-pad.delete-all-chains"] } },
  { name: "live_rack_preview", prereq: { capabilitiesAll: ["racks"], operationsAll: ["snapshot"], operationsAny: ["rack.set", "rack.action"] } },
  { name: "live_rack_apply", prereq: { capabilitiesAll: ["racks"], operationsAll: ["snapshot"], operationsAny: ["rack.set", "rack.action"] } },
  { prefix: "live_rack_view_", prereq: { capabilitiesAll: ["racks"], operationsAll: ["snapshot", "rack.view.set"] } },
  { prefix: "live_device_specialized_", prereq: { capabilitiesAll: ["devices"], operationsAll: ["snapshot"], operationsAny: ["drift.set", "drum-cell.set", "eq8.set", "hybrid-reverb.set", "meld.set", "plugin.set"] } },
  { prefix: "live_looper_", prereq: { capabilitiesAll: ["devices"], operationsAll: ["snapshot"], operationsAny: ["looper.action", "looper.set"] } },
  { prefix: "live_simpler_", prereq: { capabilitiesAll: ["devices"], operationsAll: ["snapshot", "simpler.replace-sample"] } },
  { name: "live_observe_subscribe", prereq: { capabilitiesAll: ["session.read"], operationsAll: ["observe.subscribe"] } },
  { name: "live_observe_poll", prereq: { capabilitiesAll: ["session.read"], operationsAll: ["observe.poll"] } },
  { name: "live_observe_unsubscribe", prereq: { capabilitiesAll: ["session.read"], operationsAll: ["observe.unsubscribe"] } },
  { name: "live_browser_roots", prereq: { capabilitiesAll: ["browser"], operationsAll: ["browser.roots"] } },
  { name: "live_browser_inspect", prereq: { capabilitiesAll: ["browser"], operationsAll: ["browser.inspect"] } },
  { prefix: "live_clip_move_", prereq: { operationsAll: ["snapshot", "clip.move", "arrangement.clip.move"] } },
  { prefix: "live_clip_duplicate_", prereq: { capabilitiesAll: ["clips"], operationsAll: ["snapshot", "clip.duplicate", "clip.delete", "arrangement.clip.delete"] } },
  { prefix: "live_audio_clip_", prereq: { capabilitiesAll: ["audio"], operationsAll: ["snapshot", "audio.clip.set"] } },
  { prefix: "live_mixer_", prereq: { capabilitiesAll: ["mixing"], operationsAll: ["snapshot", "mixer.set"] } },
  { prefix: "live_automation_", prereq: { capabilitiesAll: ["automation"], operationsAll: ["snapshot", "automation.envelope.read", "automation.envelope.create", "automation.envelope.delete", "automation.point.insert", "automation.point.delete"] } },
  { name: "live_browser_search", prereq: { capabilitiesAll: ["browser"], operationsAll: ["browser.search"] } },
  { prefix: "live_browser_load_", prereq: { capabilitiesAll: ["browser"], operationsAll: ["snapshot", "browser.inspect", "browser.load", "device.delete"] } },
  { prefix: "live_device_parameter_", prereq: { capabilitiesAll: ["devices", "parameters", "device.parameter.write"], operationsAll: ["snapshot", "device.parameter.set"] } },
  { prefix: "live_device_", prereq: { capabilitiesAll: ["devices"], operationsAll: ["snapshot", "device.insert", "device.delete", "device.enable", "device.move"] } },
  { prefix: "live_routing_", prereq: { capabilitiesAll: ["routing"], operationsAll: ["snapshot", "routing.set"] } },
  { prefix: "live_recording_", prereq: { capabilitiesAll: ["recording"], operationsAll: ["snapshot"], operationsAny: ["recording.session", "recording.arrangement"] } },
  { name: "live_subscribe", prereq: { capabilitiesAll: ["subscriptions"], operationsAll: ["subscribe"] } },
  { name: "live_unsubscribe", prereq: { capabilitiesAll: ["subscriptions"], operationsAll: ["subscribe"] } },
  { name: "live_realtime_stats", prereq: { capabilitiesAll: ["realtime.events"], operationsAll: ["realtime.stats"] } },
  { name: "live_realtime_disarm", prereq: { capabilitiesAll: ["realtime.events"], operationsAll: ["realtime.disarm"] } },
  { prefix: "live_realtime_arm_", prereq: { provenance: "real-live", capabilitiesAll: ["realtime.events"], operationsAll: ["snapshot", "realtime.arm", "realtime.disarm", "realtime.stats"] } },
  { prefix: "live_object_rename_", prereq: { capabilitiesAny: ["tracks", "scenes", "clips", "devices"], operationsAny: ["track.rename", "scene.rename", "clip.rename", "device.rename", "locator.rename", "take-lane.rename"] } },
  { name: "live_undo", prereq: { mutationAvailable: true, operationsAll: ["snapshot"] } },
  { name: "live_recovery_finalize", prereq: { mutationAvailable: true, operationsAll: ["snapshot"] } },
  { prefix: "live_", prereq: { never: true } },
];

/** Deployment policy classes; the first exact-name or longest-prefix match wins. */
type PolicyRule = { readonly name?: string; readonly prefix?: string; readonly policyClass: ToolPolicyClass };

export const TOOL_POLICY_RULES: readonly PolicyRule[] = [
  { name: "server_status", policyClass: "local" },
  { name: "capabilities", policyClass: "local" },
  { name: "plan_user_journey", policyClass: "local" },
  { name: "audio_analyze", policyClass: "local" },
  { name: "audio_compare_reference", policyClass: "local" },
  { name: "live_status", policyClass: "read" },
  { name: "live_snapshot", policyClass: "read" },
  { name: "live_discover", policyClass: "read" },
  { name: "live_note_read", policyClass: "read" },
  { name: "live_key_estimate", policyClass: "read" },
  { name: "live_song_state", policyClass: "read" },
  { name: "live_performance_read", policyClass: "read" },
  { prefix: "live_observe_", policyClass: "read" },
  { name: "live_subscribe", policyClass: "read" },
  { name: "live_unsubscribe", policyClass: "read" },
  { name: "live_browser_search", policyClass: "read" },
  { name: "live_browser_roots", policyClass: "read" },
  { name: "live_browser_inspect", policyClass: "read" },
  { name: "live_project_info", policyClass: "read" },
  { name: "live_project_snapshot_export", policyClass: "read" },
  { name: "live_project_snapshot_diff", policyClass: "read" },
  { name: "live_audio_capture_status", policyClass: "read" },
  { name: "audio_diagnose_live_context", policyClass: "read" },
  { name: "live_warp_marker_read", policyClass: "read" },
  { name: "live_take_lane_read", policyClass: "read" },
  { name: "live_comp_read", policyClass: "read" },
  { name: "live_arrangement_automation_read", policyClass: "read" },
  { name: "live_session_emergency_stop", policyClass: "performance" },
  { prefix: "live_session_audition_", policyClass: "performance" },
  { prefix: "live_transport_", policyClass: "performance" },
  { prefix: "live_tempo_", policyClass: "edit" },
  { prefix: "live_clip_launch_", policyClass: "performance" },
  { prefix: "live_scene_fire_", policyClass: "performance" },
  { prefix: "live_mixer_extended_", policyClass: "edit" },
  { prefix: "live_chain_mixer_", policyClass: "edit" },
  { prefix: "live_mixer_", policyClass: "edit" },
  { prefix: "live_view_", policyClass: "performance" },
  { prefix: "live_track_view_", policyClass: "performance" },
  { prefix: "live_track_properties_", policyClass: "edit" },
  { prefix: "live_song_settings_", policyClass: "edit" },
  { prefix: "live_selection_", policyClass: "performance" },
  { prefix: "live_clip_view_", policyClass: "performance" },
  { prefix: "live_device_view_", policyClass: "performance" },
  { prefix: "live_locator_jump_", policyClass: "performance" },
  { prefix: "live_audio_capture_", policyClass: "capture" },
  { prefix: "live_audio_clip_", policyClass: "audio" },
  { prefix: "live_warp_marker_", policyClass: "audio" },
  { prefix: "live_audio_import_", policyClass: "filesystem" },
  { prefix: "live_project_backup_", policyClass: "filesystem" },
  { prefix: "live_simpler_", policyClass: "filesystem" },
  { prefix: "live_recording_", policyClass: "recording" },
  { prefix: "live_realtime_", policyClass: "realtime" },
  { prefix: "live_", policyClass: "edit" },
];

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: Record<string, unknown>;
}

const toolDescriptors = [
  {
    name: "server_status",
    description: "Return host and Live-adapter availability without changing Live state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "capabilities",
    description: "Return the negotiated read-only capability catalog.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "plan_user_journey",
    description: "Build a capability-aware, non-mutating plan for one of five bounded composition, sound-design, reference, recording, or performance journeys.",
    inputSchema: {
      type: "object",
      properties: {
        journey: { type: "string", enum: [...JOURNEY_IDS] },
        traits: { type: "string", minLength: 1, maxLength: 1000 },
        experienceLevel: { type: "string", enum: ["beginner", "advanced"] },
        bars: { type: "integer", minimum: 1, maximum: 16 },
      },
      required: ["journey", "traits"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "audio_analyze",
    description: "Analyze caller-supplied normalized float32 PCM in a cancellable isolated worker; returns bounded aggregates including BS.1770-5/EBU R128 loudness and never starts playback or mutates Live.",
    inputSchema: {
      type: "object",
      properties: {
        pcmBase64: { type: "string", description: "Little-endian float32 PCM, normalized to [-1, 1]." },
        sampleRate: { type: "integer", minimum: 8000, maximum: 384000 },
        channels: { type: "integer", minimum: 1, maximum: 32 },
        channelLayout: { type: "array", items: { type: "string", enum: ["M", "L", "R", "C", "Ls", "Rs", "LFE"] }, minItems: 1, maxItems: 7, uniqueItems: true },
        frameSize: { type: "integer", minimum: 256, maximum: 4096 },
      },
      required: ["pcmBase64", "sampleRate"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "audio_compare_reference",
    description: "Compare two caller-supplied PCM sources in an isolated worker with bounded band-limited resampling, optional alignment, standards loudness level matching, and aggregate deltas; never returns raw audio.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "object", properties: { pcmBase64: { type: "string" }, sampleRate: { type: "integer", minimum: 32000, maximum: 96000 }, channels: { type: "integer", minimum: 1, maximum: 2 }, channelLayout: { type: "array", items: { type: "string", enum: ["M", "L", "R", "C", "Ls", "Rs", "LFE"] }, minItems: 1, maxItems: 2, uniqueItems: true } }, required: ["pcmBase64", "sampleRate"], additionalProperties: false },
        reference: { type: "object", properties: { pcmBase64: { type: "string" }, sampleRate: { type: "integer", minimum: 32000, maximum: 96000 }, channels: { type: "integer", minimum: 1, maximum: 2 }, channelLayout: { type: "array", items: { type: "string", enum: ["M", "L", "R", "C", "Ls", "Rs", "LFE"] }, minItems: 1, maxItems: 2, uniqueItems: true } }, required: ["pcmBase64", "sampleRate"], additionalProperties: false },
        alignment: { type: "object", properties: { mode: { type: "string", enum: ["auto", "manual", "disabled"] }, maxLagSeconds: { type: "number", minimum: 0, maximum: 10 }, manualOffsetSeconds: { type: "number", minimum: -10, maximum: 10 } }, additionalProperties: false },
      },
      required: ["project", "reference"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "audio_diagnose_live_context",
    description: "Analyze caller-supplied PCM in isolation and link measurements to one fresh authoritative Live track snapshot without claiming that Live supplied the audio or that observed devices caused a result.",
    inputSchema: { type: "object", properties: { pcmBase64: { type: "string" }, sampleRate: { type: "integer", minimum: 8000, maximum: 384000 }, channels: { type: "integer", minimum: 1, maximum: 2 }, channelLayout: { type: "array", items: { type: "string", enum: ["M", "L", "R", "C", "Ls", "Rs", "LFE"] }, minItems: 1, maxItems: 2, uniqueItems: true }, trackRef: { type: "string", minLength: 1, maxLength: 256 }, provenance: { type: "object", properties: { observedAt: { type: "string", minLength: 1, maxLength: 128 }, description: { type: "string", minLength: 1, maxLength: 512 } }, required: ["observedAt", "description"], additionalProperties: false } }, required: ["pcmBase64", "sampleRate", "trackRef", "provenance"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_audio_capture_preview",
    description: "Read-only preflight for one consent-bound, bounded Session-slot Resampling capture in an exact disposable Set. Requires real-Live provenance, an empty audio destination slot, and output-safety evidence.",
    inputSchema: { type: "object", properties: { setName: { type: "string", minLength: 1, maxLength: 256 }, sourceSlotRef: { type: "string", minLength: 1, maxLength: 256 }, destinationSlotRef: { type: "string", minLength: 1, maxLength: 256 }, durationSeconds: { type: "number", minimum: 1, maximum: 9 }, consent: { type: "string", const: "ephemeral-analysis-and-delete" }, outputSafety: { type: "object", properties: { safe: { type: "boolean", const: true }, provenance: { type: "string", minLength: 1, maxLength: 512 }, observedAt: { type: "string", minLength: 1, maxLength: 128 }, scope: { type: "string", minLength: 1, maxLength: 256 } }, required: ["safe", "provenance"], additionalProperties: false } }, required: ["setName", "sourceSlotRef", "destinationSlotRef", "durationSeconds", "consent", "outputSafety"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_audio_capture_apply",
    description: "After exact confirmation, perform one bounded potentially audible Resampling capture, isolated standards analysis, evidence-linked diagnosis, and transaction-owned clip/raw-file cleanup. No raw audio or path is returned.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", minLength: 32, maxLength: 128 }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_audio_capture_status",
    description: "Read the authenticated mapper-owned capture lifecycle without exposing its token or raw media path.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_audio_capture_emergency_stop",
    description: "Independently stop and clean the exact observed mapper-owned capture after cancellation or host restart. Requires fresh exact capture and slot identities.",
    inputSchema: { type: "object", properties: { confirmation: { type: "string", const: "emergency-stop-and-clean" }, captureId: { type: "string", minLength: 16, maxLength: 128 }, sourceSlotRef: { type: "string", minLength: 1, maxLength: 256 }, destinationSlotRef: { type: "string", minLength: 1, maxLength: 256 } }, required: ["confirmation", "captureId", "sourceSlotRef", "destinationSlotRef"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_status",
    description: "Return truthful Live-adapter status and negotiated capabilities without changing Live state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_snapshot",
    description: "Read a bounded snapshot of the current Live Set through the configured adapter.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_discover",
    description: "Read bounded, deterministic parent-scoped Live objects without changing Live state.",
    inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["set", "track", "return-track", "main-track", "scene", "clip-slot", "session-clip", "arrangement-clip", "note", "locator", "device", "parameter", "selection", "routing-choice", "session-playback"] }, parent: { type: "string", minLength: 1, maxLength: 256 }, filter: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"], maxLength: 256, minimum: -9007199254740991, maximum: 9007199254740991 }, maxProperties: 8 }, fields: { type: "array", items: { type: "string", minLength: 1, maxLength: 64 }, maxItems: 32 }, budget: { type: "integer", minimum: 1, maximum: 10000 }, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string", maxLength: 1024 } }, required: ["kind"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_session_audition_preview",
    description: "Read-only preflight for one potentially audible Session scene launch. Requires explicit output-safety evidence.",
    inputSchema: { type: "object", properties: { sceneRef: { type: "string", minLength: 1, maxLength: 256 }, setName: { type: "string", minLength: 1, maxLength: 256 }, outputSafety: { type: "object", properties: { safe: { type: "boolean", const: true }, provenance: { type: "string", minLength: 1, maxLength: 512 }, observedAt: { type: "string", minLength: 1, maxLength: 128 }, scope: { type: "string", minLength: 1, maxLength: 256 } }, required: ["safe", "provenance"], additionalProperties: false } }, required: ["sceneRef", "setName", "outputSafety"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_session_audition_apply",
    description: "Launch exactly one preflighted Session scene after exact confirmation; playback is potentially audible and is verified fresh.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", minLength: 32, maxLength: 128 }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_session_audition_stop",
    description: "Stop only the mapper-owned audition once and verify fresh stopped state.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", minLength: 32, maxLength: 128, description: "The exact unpredictable stopConfirmation token returned by preview/apply." }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_session_emergency_stop",
    description: "Independently authorized emergency stop of exactly the Session playback targets and recording mode observed in fresh discovery. Requires no transaction and survives host restart.",
    inputSchema: { type: "object", properties: { confirmation: { type: "string", const: "emergency-stop" }, expectedTargets: { type: "array", items: { type: "string", minLength: 1, maxLength: 1024 }, maxItems: 256, description: "Exact active playback target keys (trackRef|clipSlotRef|sceneRef) observed in a fresh live_discover/live_snapshot read." }, expectedRecording: { type: "string", enum: ["stopped", "session", "arrangement", "both"], description: "Exact recording mode observed in the same fresh read." }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["confirmation", "expectedTargets", "expectedRecording"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_transport_preview",
    description: "Read-only preflight for one bounded transport change (position, loop, punch, metronome, count-in) with a playback-revision fence.",
    inputSchema: { type: "object", properties: { position: { type: "number", minimum: 0 }, loopEnabled: { type: "boolean" }, loopStart: { type: "number", minimum: 0 }, loopLength: { type: "number", exclusiveMinimum: 0 }, metronome: { type: "boolean" }, punchIn: { type: "boolean" }, punchOut: { type: "boolean" } }, required: [], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_transport_apply",
    description: "Apply an exact, unexpired transport preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_clip_launch_preview",
    description: "Read-only preflight for launching one exact clip slot, with explicit output-safety evidence and a playback-revision fence. Recording-active states refuse.",
    inputSchema: { type: "object", properties: { slotRef: { type: "string", minLength: 1, maxLength: 256 }, outputSafety: { type: "object", properties: { safe: { type: "boolean", const: true }, provenance: { type: "string", minLength: 1, maxLength: 512 }, observedAt: { type: "string", minLength: 1, maxLength: 128 }, scope: { type: "string", minLength: 1, maxLength: 256 } }, required: ["safe", "provenance"], additionalProperties: false } }, required: ["slotRef", "outputSafety"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_clip_launch_apply",
    description: "Launch the exact previewed clip slot once and verify fresh fired/playing evidence.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", minLength: 32, maxLength: 128 }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_clip_launch_stop",
    description: "Stop only the preview-owned launched clip through its track and verify it is no longer active; other playback continues.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", minLength: 32, maxLength: 128 }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_capture_midi_preview",
    description: "Read-only preflight for capturing recently played MIDI, fenced to exact Session clips and scenes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_capture_midi_apply",
    description: "Apply one exact MIDI-capture preview with idempotency, verified new clip identities, and guarded undo.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_scene_capture_preview",
    description: "Read-only preflight for capturing current Session content into one new scene, fenced to structure and playback.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_scene_capture_apply",
    description: "Apply one exact scene-capture preview with idempotency, verified scene identity, and guarded undo.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_note_update_preview",
    description: "Read-only preflight for bounded MIDI note edits by note id, including velocity, mute, probability, velocity deviation, and release velocity.",
    inputSchema: { type: "object", properties: { clipRef: { type: "string", minLength: 1, maxLength: 256 }, notes: { type: "array", maxItems: 512, items: { type: "object", properties: { id: { type: "integer", minimum: 0 }, pitch: { type: "integer", minimum: 0, maximum: 127 }, start: { type: "number", minimum: 0 }, duration: { type: "number", exclusiveMinimum: 0 }, velocity: { type: "number", minimum: 0, maximum: 127 }, mute: { type: "boolean" }, probability: { type: "number", minimum: 0, maximum: 1 }, velocityDeviation: { type: "number", minimum: -127, maximum: 127 }, releaseVelocity: { type: "number", minimum: 0, maximum: 127 } }, required: ["id"], additionalProperties: false } } }, required: ["clipRef", "notes"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_note_update_apply",
    description: "Apply an exact, unexpired note-update preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_note_delete_preview",
    description: "Read-only preflight for deleting exact MIDI notes by id, capturing the prior notes for guarded undo.",
    inputSchema: { type: "object", properties: { clipRef: { type: "string", minLength: 1, maxLength: 256 }, noteIds: { type: "array", maxItems: 512, items: { type: "integer", minimum: 0 } } }, required: ["clipRef", "noteIds"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_note_delete_apply",
    description: "Apply an exact, unexpired note-delete preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_clip_duplicate_preview",
    description: "Read-only preflight for duplicating a Session clip to another Session slot or into the Arrangement.",
    inputSchema: { type: "object", properties: { clipRef: { type: "string", minLength: 1, maxLength: 256 }, targetTrackRef: { type: "string", minLength: 1, maxLength: 256 }, targetSceneIndex: { type: "integer", minimum: 0, maximum: 10000 }, arrangementPosition: { type: "number", minimum: 0 } }, required: ["clipRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_clip_duplicate_apply",
    description: "Apply an exact, unexpired clip-duplicate preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_arrangement_clip_preview",
    description: "Read-only preflight for creating one Arrangement clip (MIDI, or an audio clip imported from a file path) with exact fencing. Arbitrary deletion is unavailable; transaction-owned cleanup uses live_undo.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["create"] }, kind: { type: "string", enum: ["midi", "audio"] }, trackRef: { type: "string", minLength: 1, maxLength: 256 }, position: { type: "number", minimum: 0 }, length: { type: "number", exclusiveMinimum: 0 }, name: { type: "string", minLength: 1, maxLength: 256 }, filePath: { type: "string", minLength: 1, maxLength: 1024 }, clipRef: { type: "string", minLength: 1, maxLength: 256 } }, required: ["action"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_arrangement_clip_apply",
    description: "Apply an exact, unexpired arrangement-clip preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_clip_move_preview",
    description: "Read-only preflight for repositioning an Arrangement clip or moving a Session clip to another slot.",
    inputSchema: { type: "object", properties: { clipRef: { type: "string", minLength: 1, maxLength: 256 }, position: { type: "number", minimum: 0 }, targetTrackRef: { type: "string", minLength: 1, maxLength: 256 }, targetSceneIndex: { type: "integer", minimum: 0, maximum: 10000 } }, required: ["clipRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_clip_move_apply",
    description: "Apply an exact, unexpired clip-move preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_audio_clip_preview",
    description: "Read-only preflight for bounded audio clip edits (gain, pitch, loop region, warp mode) with prior-value capture.",
    inputSchema: { type: "object", properties: { clipRef: { type: "string", minLength: 1, maxLength: 256 }, gain: { type: "number", minimum: 0 }, pitchCoarse: { type: "number", minimum: -48, maximum: 48 }, pitchFine: { type: "number", minimum: -50, maximum: 50 }, loopStart: { type: "number", minimum: 0 }, loopEnd: { type: "number", minimum: 0 }, warpMode: { type: "integer", minimum: 0, maximum: 16 }, warping: { type: "boolean" }, fadeInLength: { type: "number", minimum: 0 }, fadeOutLength: { type: "number", minimum: 0 } }, required: ["clipRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_audio_clip_apply",
    description: "Apply an exact, unexpired audio-clip preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_mixer_preview",
    description: "Read-only preflight for bounded mixer edits (volume, pan, mute, solo, cue, sends) with prior-value capture.",
    inputSchema: { type: "object", properties: { trackRef: { type: "string", minLength: 1, maxLength: 256 }, volume: { type: "number", minimum: 0, maximum: 1 }, pan: { type: "number", minimum: -1, maximum: 1 }, mute: { type: "boolean" }, solo: { type: "boolean" }, cueVolume: { type: "number", minimum: 0, maximum: 1 }, sends: { type: "array", maxItems: 64, items: { type: "number", minimum: 0, maximum: 1 } } }, required: ["trackRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_mixer_apply",
    description: "Apply an exact, unexpired mixer preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_automation_preview",
    description: "Read-only preflight for bounded Session clip envelope edits (create/delete envelope, insert/delete points) with conflict-aware fencing.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["create-envelope", "delete-envelope", "insert", "delete-range"] }, clipRef: { type: "string", minLength: 1, maxLength: 256 }, parameterRef: { type: "string", minLength: 1, maxLength: 256 }, points: { type: "array", maxItems: 512, items: { type: "object", properties: { time: { type: "number", minimum: 0 }, value: { type: "number" } }, required: ["time", "value"], additionalProperties: false } }, from: { type: "number", minimum: 0 }, to: { type: "number", minimum: 0 } }, required: ["action", "clipRef", "parameterRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_automation_apply",
    description: "Apply an exact, unexpired automation preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_browser_search",
    description: "Search the Live Browser catalog by category and query with stable result identities.",
    inputSchema: { type: "object", properties: { category: { type: "string", enum: ["instruments", "audio_effects", "midi_effects", "drums", "plugins", "packs", "max_for_live", "clips"] }, query: { type: "string", maxLength: 256 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: [], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_browser_load_preview",
    description: "Read-only preflight for loading one exact browser item onto a target track with postcondition verification.",
    inputSchema: { type: "object", properties: { itemId: { type: "string", minLength: 1, maxLength: 256 }, trackRef: { type: "string", minLength: 1, maxLength: 256 } }, required: ["itemId", "trackRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_browser_load_apply",
    description: "Apply an exact, unexpired browser-load preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_device_preview",
    description: "Read-only preflight for guarded device insert, enable, or move with exact fencing. Transaction-owned inserted-device cleanup uses live_undo.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["insert", "enable", "move"] }, trackRef: { type: "string", minLength: 1, maxLength: 256 }, deviceName: { type: "string", minLength: 1, maxLength: 256 }, deviceRef: { type: "string", minLength: 1, maxLength: 256 }, index: { type: "integer", minimum: -1, maximum: 256 }, enabled: { type: "boolean" } }, required: ["action"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_device_apply",
    description: "Apply an exact, unexpired device preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_routing_preview",
    description: "Read-only preflight for bounded routing, arm, and monitoring edits with feedback-loop guards and prior-value capture.",
    inputSchema: { type: "object", properties: { trackRef: { type: "string", minLength: 1, maxLength: 256 }, inputType: { type: "string", maxLength: 256 }, inputSubRouting: { type: "string", maxLength: 256 }, outputType: { type: "string", maxLength: 256 }, outputSubRouting: { type: "string", maxLength: 256 }, arm: { type: "boolean" }, monitoring: { type: "string", enum: ["in", "auto", "off"] } }, required: ["trackRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_routing_apply",
    description: "Apply an exact, unexpired routing preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_recording_preview",
    description: "Read-only preflight for one bounded Session or Arrangement recording start/stop with explicit intent, destination identity, and output-safety evidence.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["start", "stop"] }, lane: { type: "string", enum: ["session", "arrangement"] }, intent: { type: "string", minLength: 1, maxLength: 256 }, destinationTrackRef: { type: "string", minLength: 1, maxLength: 256 }, outputSafety: { type: "object", properties: { safe: { type: "boolean", const: true }, provenance: { type: "string", minLength: 1, maxLength: 512 }, observedAt: { type: "string", minLength: 1, maxLength: 128 }, scope: { type: "string", minLength: 1, maxLength: 256 } }, required: ["safe", "provenance"], additionalProperties: false } }, required: ["action", "lane", "intent", "outputSafety"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_recording_apply",
    description: "Apply an exact, unexpired recording preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_subscribe",
    description: "Subscribe to authenticated, epoch- and sequence-bound transport and object events with continuity-preserving coalescing, bounded queues, overflow reset, and resnapshot recovery.",
    inputSchema: { type: "object", properties: { types: { type: "array", maxItems: 3, uniqueItems: true, items: { type: "string", enum: ["transport", "object", "reset"] } } }, required: [], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_unsubscribe",
    description: "End the active Live event subscription.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_project_info",
    description: "Read the current set's file identity, gzip/XML manifest, referenced media, and missing-media report (metadata only).",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_project_snapshot_export",
    description: "Export one deterministic, bounded page of a versioned privacy-redacted semantic Set artifact. Pages contain no Live session refs or mutation authority and can be persisted for offline diffing.",
    inputSchema: { type: "object", properties: { profile: { type: "string", enum: ["strict", "collaboration", "local"] }, limit: { type: "integer", minimum: 1, maximum: 200 }, cursor: { type: "string", minLength: 1, maxLength: 4096 } }, required: [], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_project_snapshot_diff",
    description: "Compare two complete semantic Set page bundles offline with conservative rename/reorder matching and explicit ambiguity. Observational only: no merge or Live authority is proposed.",
    inputSchema: { type: "object", properties: { beforePages: { type: "array", minItems: 1, maxItems: 512, items: { type: "object" } }, afterPages: { type: "array", minItems: 1, maxItems: 512, items: { type: "object" } }, limit: { type: "integer", minimum: 1, maximum: 200 }, cursor: { type: "string", minLength: 1, maxLength: 4096 } }, required: ["beforePages", "afterPages"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_project_backup_preview",
    description: "Read-only preflight for one verified atomic backup of the current set inside its own directory.",
    inputSchema: { type: "object", properties: { confirmation: { type: "string", enum: ["backup"] }, allowedRoot: { type: "string", minLength: 1, maxLength: 4096, description: "Explicit absolute directory allowlisting the current Set for this backup." } }, required: ["confirmation", "allowedRoot"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_project_backup_apply",
    description: "Apply an exact, unexpired project backup preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_realtime_arm_preview",
    description: "Read-only preflight for one short-lived armed realtime UDP control window scoped to exact authoritative parameter refs and explicit output-safety evidence.",
    inputSchema: { type: "object", properties: { ttlMs: { type: "integer", minimum: 1000, maximum: 30000 }, channels: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", enum: ["udp-json", "osc", "xy", "max"] } }, parameterRefs: { type: "array", maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 256 } }, sourcePorts: { type: "array", maxItems: 16, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 65535 } }, outputSafety: { type: "object", properties: { safe: { type: "boolean", const: true }, provenance: { type: "string", minLength: 1, maxLength: 512 }, observedAt: { type: "string", minLength: 1, maxLength: 128 }, scope: { type: "string", minLength: 1, maxLength: 256 } }, required: ["safe", "provenance"], additionalProperties: false } }, required: ["channels", "parameterRefs", "outputSafety"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_realtime_arm_apply",
    description: "Apply an exact, unexpired realtime arm preview and receive the single-use UDP control token.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_realtime_disarm",
    description: "Immediately end the active realtime control window.",
    inputSchema: { type: "object", properties: { confirmation: { type: "string", enum: ["disarm"] } }, required: ["confirmation"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_realtime_stats",
    description: "Read realtime control-plane acceptance, drop, replay, rate-limit, and sequence-gap counters.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_device_parameter_preview",
    description: "Discover an authoritative device parameter and preview a bounded numeric change without mutation.",
    inputSchema: { type: "object", properties: { deviceRef: { type: "string", minLength: 1, maxLength: 256 }, parameterRef: { type: "string", minLength: 1, maxLength: 256 }, value: { type: "number" } }, required: ["deviceRef", "parameterRef", "value"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_device_parameter_apply",
    description: "Apply an exact confirmed device-parameter preview once, verify fresh authoritative state, and support guarded undo.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string" }, confirmation: { type: "string", minLength: 32, maxLength: 128, description: "The exact unpredictable token returned by the matching preview." }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "live_session_structure_preview",
    description: "Preview bounded MIDI/audio track and named scene creation without mutation. Track indexes address only mutable regular tracks, never return or main tracks.",
    inputSchema: { type: "object", properties: { tracks: { type: "array", maxItems: 16, items: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 128 }, kind: { type: "string", enum: ["audio", "midi"] }, index: { type: "integer", minimum: 0, maximum: 1024, description: "Insertion index in the regular-track collection; omitted entries default to request order." } }, required: ["name", "kind"], additionalProperties: false } }, scenes: { type: "array", maxItems: 32, items: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 128 }, index: { type: "integer", minimum: 0, maximum: 1024, description: "Insertion index in the scene collection; omitted entries default to request order." } }, required: ["name"], additionalProperties: false } } }, required: ["tracks", "scenes"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_session_structure_apply",
    description: "Apply a confirmed Session-structure preview once, verify authoritative ordering, and support guarded undo.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string" }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "live_object_rename_preview",
    description: "Preview a purpose-specific track, scene, clip, device, or locator rename against its exact current name.",
    inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["track", "scene", "clip", "device", "locator", "takeLane"] }, ref: { type: "string", minLength: 1, maxLength: 256 }, name: { type: "string", minLength: 1, maxLength: 256 } }, required: ["kind", "ref", "name"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_object_rename_apply",
    description: "Apply one exact revision-fenced rename and support guarded undo.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", const: "apply" }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_midi_clip_preview",
    description: "Preview creation of a bounded MIDI clip in an empty Session slot.",
    inputSchema: { type: "object", properties: { trackRef: { type: "string", minLength: 1, maxLength: 256 }, sceneIndex: { type: "integer", minimum: 0, maximum: 1023 }, name: { type: "string", minLength: 1, maxLength: 256 }, length: { type: "number", exclusiveMinimum: 0, maximum: 1024 }, notes: { type: "array", maxItems: 512, items: { type: "object", properties: { pitch: { type: "integer", minimum: 0, maximum: 127 }, start: { type: "number", minimum: 0, maximum: 1024 }, duration: { type: "number", exclusiveMinimum: 0, maximum: 1024 }, velocity: { type: "integer", minimum: 1, maximum: 127 }, channel: { type: "integer", minimum: 1, maximum: 16 }, mute: { type: "boolean" }, probability: { type: "number", minimum: 0, maximum: 1 }, velocityDeviation: { type: "number", minimum: -127, maximum: 127 }, releaseVelocity: { type: "number", minimum: 0, maximum: 127 } }, required: ["pitch", "start", "duration", "velocity", "channel"], additionalProperties: false } } }, required: ["trackRef", "sceneIndex", "name", "length", "notes"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_midi_clip_apply",
    description: "Apply an exact, unexpired MIDI preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string" }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "live_arrangement_section_preview",
    description: "Preview two named Arrangement locators for a bounded section without mutation.",
    inputSchema: { type: "object", properties: { start: { type: "number", minimum: 0, maximum: 100000 }, end: { type: "number", minimum: 0, maximum: 100000 }, startName: { type: "string", minLength: 1, maxLength: 128 }, endName: { type: "string", minLength: 1, maxLength: 128 } }, required: ["start", "end", "startName", "endName"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_arrangement_section_apply",
    description: "Create the confirmed Arrangement section locators once and verify them authoritatively.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string" }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "live_tempo_preview",
    description: "Preview a reversible tempo change without mutating Live.",
    inputSchema: {
      type: "object",
      properties: { tempo: { type: "number", minimum: 20, maximum: 999 } },
      required: ["tempo"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_tempo_apply",
    description: "Apply an unexpired tempo preview after explicit confirmation and verify the authoritative result.",
    inputSchema: {
      type: "object",
      properties: { transactionId: { type: "string" }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } },
      required: ["transactionId", "confirmation", "idempotencyKey"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "live_undo",
    description: "Undo a verified guarded transaction only when fresh authoritative state still matches its exact postcondition.",
    inputSchema: {
      type: "object",
      properties: { transactionId: { type: "string" }, confirmation: { type: "string", enum: ["undo"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } },
      required: ["transactionId", "confirmation", "idempotencyKey"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "live_recovery_finalize",
    description: "Retire a protected transaction record only after authoritative manual recovery or explicit acceptance of current state. Never mutates Live or finalizes active audible work.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", minLength: 1, maxLength: 128 },
        resolution: { type: "string", enum: ["manually-restored", "accepted-current-state"] },
        confirmation: { type: "string", const: "finalize-recovery-record" },
        evidence: { type: "object", properties: { provenance: { type: "string", minLength: 1, maxLength: 512 }, observedAt: { type: "string", minLength: 1, maxLength: 64 }, scope: { type: "string", minLength: 1, maxLength: 256 } }, required: ["provenance", "scope"], additionalProperties: false },
      },
      required: ["transactionId", "resolution", "confirmation", "evidence"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "live_view_preview",
    description: "Read-only preflight for switching Live's main view or controlling the Arrangement view (zoom, scroll, follow, track collapse).",
    inputSchema: { type: "object", properties: { view: { type: "string", minLength: 1, maxLength: 64 }, action: { type: "string", enum: ["zoom-in", "zoom-out", "scroll-left", "scroll-right", "follow-on", "follow-off", "collapse-track", "expand-track", "hide-view", "focus-view", "browser-toggle"] }, trackRef: { type: "string", minLength: 1, maxLength: 256 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_view_apply",
    description: "Apply an exact, unexpired view preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_locator_jump_preview",
    description: "Read-only preflight for jumping the playhead to the next/previous locator or to one exact locator.",
    inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["next", "previous"] }, ref: { type: "string", minLength: 1, maxLength: 256 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_locator_jump_apply",
    description: "Apply an exact, unexpired locator-jump preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_clip_properties_preview",
    description: "Read-only preflight for bounded clip edits (mute, color, MIDI clip loop, launch mode/quantization, legato, RAM mode for audio clips, velocity amount for MIDI clips) with prior-value capture.",
    inputSchema: { type: "object", properties: { clipRef: { type: "string", minLength: 1, maxLength: 256 }, muted: { type: "boolean" }, colorIndex: { type: "integer", minimum: 0, maximum: 69 }, looping: { type: "boolean" }, loopStart: { type: "number", minimum: 0 }, loopEnd: { type: "number", minimum: 0 }, launchMode: { type: "integer", minimum: 0, maximum: 3 }, launchQuantization: { type: "integer", minimum: 0, maximum: 14 }, legato: { type: "boolean" }, ramMode: { type: "boolean" }, velocityAmount: { type: "number", minimum: 0, maximum: 1 } }, required: ["clipRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_clip_properties_apply",
    description: "Apply an exact, unexpired clip-properties preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_audio_import_preview",
    description: "Read-only preflight for importing one audio file into an empty Session clip slot or a take lane, with explicit file authority (allowed root, canonical path, size/type, SHA-256).",
    inputSchema: { type: "object", properties: { filePath: { type: "string", minLength: 1, maxLength: 1024 }, allowedRoot: { type: "string", minLength: 1, maxLength: 1024 }, trackRef: { type: "string", minLength: 1, maxLength: 256 }, sceneIndex: { type: "integer", minimum: 0, maximum: 10000 }, takeLaneRef: { type: "string", minLength: 1, maxLength: 256 }, position: { type: "number", minimum: 0 }, name: { type: "string", minLength: 1, maxLength: 256 } }, required: ["filePath", "allowedRoot"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_audio_import_apply",
    description: "Apply an exact, unexpired audio-import preview with confirmation, idempotency, and apply-time file re-verification.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_warp_marker_preview",
    description: "Read-only preflight for adding, moving, or deleting one audio-clip warp marker addressed by beat time.",
    inputSchema: { type: "object", properties: { clipRef: { type: "string", minLength: 1, maxLength: 256 }, action: { type: "string", enum: ["add", "move", "delete"] }, beatTime: { type: "number" }, distance: { type: "number" } }, required: ["clipRef", "action", "beatTime"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_warp_marker_apply",
    description: "Apply an exact, unexpired warp-marker preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_clip_action_preview",
    description: "Read-only preflight for clip crop, loop/region duplication, scrub, and playing-position moves. Content actions are not undoable; scrub and position moves are transient.",
    inputSchema: { type: "object", properties: { clipRef: { type: "string", minLength: 1, maxLength: 256 }, action: { type: "string", enum: ["crop", "duplicate-loop", "duplicate-region", "scrub-start", "scrub-stop", "move-playing-position"] }, regionStart: { type: "number", minimum: 0 }, regionEnd: { type: "number", minimum: 0 }, destination: { type: "number", minimum: 0 }, offset: { type: "number" } }, required: ["clipRef", "action"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_clip_action_apply",
    description: "Apply an exact, unexpired clip-action preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_note_edit_preview",
    description: "Read-only preflight for clip note quantization (timing or pitch) and targeted note duplication by stable note IDs.",
    inputSchema: { type: "object", properties: { clipRef: { type: "string", minLength: 1, maxLength: 256 }, action: { type: "string", enum: ["quantize", "quantize-pitch", "duplicate"] }, noteIds: { type: "array", maxItems: 512, items: { type: "integer", minimum: 0 } }, grid: { type: "number", exclusiveMinimum: 0 }, amount: { type: "number", minimum: 0, maximum: 1 }, pitch: { type: "integer", minimum: 0, maximum: 127 } }, required: ["clipRef", "action"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_note_edit_apply",
    description: "Apply an exact, unexpired note-edit preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_note_read",
    description: "Read notes by stable IDs, or the currently selected notes, from one MIDI clip.",
    inputSchema: { type: "object", properties: { clipRef: { type: "string", minLength: 1, maxLength: 256 }, noteIds: { type: "array", maxItems: 1024, items: { type: "integer", minimum: 0 } }, selected: { type: "boolean" } }, required: ["clipRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_key_estimate",
    description: "Estimate the musical key of a MIDI clip (or an explicit note set) as ranked candidates with correlation scores, an explicit confidence classification, and an ambiguity flag — never a forced single answer. Read-only and deterministic.",
    inputSchema: { type: "object", properties: { clipRef: { type: "string", minLength: 1, maxLength: 256 }, notes: { type: "array", maxItems: 4096, items: { type: "object", properties: { pitch: { type: "integer", minimum: 0, maximum: 127 }, start: { type: "number", minimum: 0 }, duration: { type: "number", exclusiveMinimum: 0 }, velocity: { type: "integer", minimum: 0, maximum: 127 } }, required: ["pitch", "start", "duration"], additionalProperties: false } }, expectedNotesRevision: { type: "string", minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_tuning_preview",
    description: "Read-only preflight for tuning-system and scale edits (name, note range, reference pitch, note tunings, root note, scale). Changes affect playback pitch globally.",
    inputSchema: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 256 }, lowestNote: { type: "object", maxProperties: 8 }, highestNote: { type: "object", maxProperties: 8 }, referencePitch: { type: "object", maxProperties: 8 }, noteTunings: { type: "array", minItems: 128, maxItems: 128, items: { type: "object", properties: { note: { type: "integer", minimum: 0, maximum: 127 }, deviation: { type: "number", minimum: -1200, maximum: 1200 } }, required: ["note", "deviation"], additionalProperties: false } }, rootNote: { type: "integer", minimum: 0, maximum: 11 }, scaleName: { type: "string", minLength: 1, maxLength: 256 }, scaleMode: { type: "boolean" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_tuning_apply",
    description: "Apply an exact, unexpired tuning preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_groove_preview",
    description: "Read-only preflight for the global groove amount and editing one groove in the pool. Clip groove assignment lives in live_clip_properties_preview (grooveRef).",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["set-amount", "edit"] }, grooveAmount: { type: "number", minimum: 0, maximum: 1.3 }, grooveRef: { type: "string", minLength: 1, maxLength: 256 }, name: { type: "string", minLength: 1, maxLength: 256 }, base: { type: "integer", minimum: 0, maximum: 16 }, quantizationAmount: { type: "number", minimum: 0, maximum: 1 }, randomAmount: { type: "number", minimum: 0, maximum: 1 }, timingAmount: { type: "number", minimum: 0, maximum: 1 }, velocityAmount: { type: "number", minimum: 0, maximum: 1 } }, required: ["action"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_groove_apply",
    description: "Apply an exact, unexpired groove preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_scene_preview",
    description: "Read-only preflight for scene property edits: color, tempo (+enable), and time signature (numerator, denominator, enable).",
    inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 1, maxLength: 256 }, colorIndex: { type: "integer", minimum: 0, maximum: 69 }, tempo: { type: "number", minimum: 20, maximum: 999 }, tempoEnabled: { type: "boolean" }, signatureNumerator: { type: "integer", minimum: 1, maximum: 99 }, signatureDenominator: { type: "integer", minimum: 1, maximum: 99 }, timeSignatureEnabled: { type: "boolean" } }, required: ["ref"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_scene_apply",
    description: "Apply an exact, unexpired scene-properties preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_scene_fire_preview",
    description: "Read-only preflight for directly firing one scene (fire-as-selected). This is a direct fire, distinct from the guarded scene audition workflow; it is audible and not undoable.",
    inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 1, maxLength: 256 } }, required: ["ref"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_scene_fire_apply",
    description: "Apply an exact, unexpired scene-fire preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_song_state",
    description: "Read the comprehensive Song state (tracks, devices, signature, swing, overdub/record/arm/solo/Link states) and optionally run the documented loop-beats or current-SMPTE-time queries.",
    inputSchema: { type: "object", properties: { conversion: { type: "string", enum: ["beats-loop", "current-smpte"] }, smpteFormat: { type: "string", enum: ["smpte-24", "smpte-25", "smpte-29", "smpte-30", "smpte-30-drop"] } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_song_settings_preview",
    description: "Read-only preflight for song playback settings (global time signature, swing amount, clip-trigger quantization, MIDI recording quantization) with exact prior-value capture. Signature and trigger-quantization changes affect playback feel immediately.",
    inputSchema: { type: "object", properties: { signatureNumerator: { type: "integer", minimum: 1, maximum: 99 }, signatureDenominator: { type: "integer", minimum: 1, maximum: 99 }, swingAmount: { type: "number", minimum: 0, maximum: 1 }, clipTriggerQuantization: { type: "integer", minimum: 0, maximum: 13 }, midiRecordingQuantization: { type: "integer", minimum: 0, maximum: 8 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_song_settings_apply",
    description: "Apply an exact, unexpired song-settings preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_transport_action_preview",
    description: "Read-only preflight for momentary transport actions (start, continue, stop, play selection, scrub, tap tempo, nudge, re-enable automation, trigger Session record, force Link beat time). Audible actions are fenced but not undoable; emergency stop stays separate.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["start", "continue", "stop", "play-selection", "scrub", "tap-tempo", "nudge-up", "nudge-down", "re-enable-automation", "trigger-session-record", "force-link-beat-time", "stop-all-clips"] }, beatTime: { type: "number" } }, required: ["action"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_transport_action_apply",
    description: "Apply an exact, unexpired transport-action preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_track_structure_preview",
    description: "Read-only preflight for return-track creation/deletion and track or scene duplication with structure fencing.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["create-return", "delete-return", "duplicate-track", "duplicate-scene"] }, name: { type: "string", minLength: 1, maxLength: 256 }, ref: { type: "string", minLength: 1, maxLength: 256 } }, required: ["action"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_track_structure_apply",
    description: "Apply an exact, unexpired track-structure preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_device_delete_preview",
    description: "Read-only preflight for deleting one existing device with exact identity and sibling fencing. Deletion is honest and not undoable: prior device state cannot be reconstructed.",
    inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 1, maxLength: 256 } }, required: ["ref"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_device_delete_apply",
    description: "Apply an exact, unexpired device-deletion preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_track_view_preview",
    description: "Read-only preflight for track view state (collapsed, device insert mode) and selecting the track's instrument in Live's device view.",
    inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 1, maxLength: 256 }, collapsed: { type: "boolean" }, deviceInsertMode: { type: "integer", minimum: 0, maximum: 8 }, selectInstrument: { type: "boolean" } }, required: ["ref"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_track_view_apply",
    description: "Apply an exact, unexpired track-view preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_track_properties_preview",
    description: "Read-only preflight for track property edits (color palette index 0-69) with exact prior-value capture.",
    inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 1, maxLength: 256 }, colorIndex: { type: "integer", minimum: 0, maximum: 69 } }, required: ["ref"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_track_properties_apply",
    description: "Apply an exact, unexpired track-properties preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_selection_preview",
    description: "Read-only preflight for setting Song.View selections (track, scene, highlighted slot, detail clip, device, parameter, chain) and draw mode, with exact restore.",
    inputSchema: { type: "object", properties: { trackRef: { type: ["string", "null"], minLength: 1, maxLength: 256 }, sceneRef: { type: ["string", "null"], minLength: 1, maxLength: 256 }, slotRef: { type: ["string", "null"], minLength: 1, maxLength: 256 }, detailClipRef: { type: ["string", "null"], minLength: 1, maxLength: 256 }, deviceRef: { type: ["string", "null"], minLength: 1, maxLength: 256 }, parameterRef: { type: ["string", "null"], minLength: 1, maxLength: 256 }, chainRef: { type: ["string", "null"], minLength: 1, maxLength: 256 }, drawMode: { type: "boolean" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_selection_apply",
    description: "Apply an exact, unexpired selection preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_clip_view_preview",
    description: "Read-only preflight for clip view state: grid quantization, triplet grid, envelope visibility, and show-loop.",
    inputSchema: { type: "object", properties: { clipRef: { type: "string", minLength: 1, maxLength: 256 }, gridQuantization: { type: "integer", minimum: 0, maximum: 16 }, gridIsTriplet: { type: "boolean" }, showEnvelope: { type: "boolean" }, showLoop: { type: "boolean" } }, required: ["clipRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_clip_view_apply",
    description: "Apply an exact, unexpired clip-view preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_device_view_preview",
    description: "Read-only preflight for a device's collapsed state in Live's chain view (exposed only where Live supports it).",
    inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 1, maxLength: 256 }, collapsed: { type: "boolean" } }, required: ["ref", "collapsed"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_device_view_apply",
    description: "Apply an exact, unexpired device-view preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_performance_read",
    description: "Read one bounded, on-demand performance sample: process usage, per-track meters and performance impact, and device latency in samples and milliseconds. Point-in-time evidence; meter values are Live UI meters, not decoded audio analysis.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_mixer_extended_preview",
    description: "Read-only preflight for extended mixer controls: track activator, crossfader, crossfade assignment, panning mode, and split-stereo left/right panners.",
    inputSchema: { type: "object", properties: { trackRef: { type: "string", minLength: 1, maxLength: 256 }, trackActivator: { type: "boolean" }, crossfader: { type: "number", minimum: -1, maximum: 1 }, crossfadeAssign: { type: "integer", minimum: 0, maximum: 2 }, panningMode: { type: "integer", minimum: 0, maximum: 8 }, panningLeft: { type: "number", minimum: -1, maximum: 1 }, panningRight: { type: "number", minimum: -1, maximum: 1 } }, required: ["trackRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_mixer_extended_apply",
    description: "Apply an exact, unexpired extended-mixer preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_chain_mixer_preview",
    description: "Read-only preflight for a rack chain's mixer: volume, pan, sends, and chain activator.",
    inputSchema: { type: "object", properties: { chainRef: { type: "string", minLength: 1, maxLength: 256 }, volume: { type: "number", minimum: 0, maximum: 1 }, pan: { type: "number", minimum: -1, maximum: 1 }, sends: { type: "array", maxItems: 64, items: { type: "number", minimum: 0, maximum: 1 } }, chainActivator: { type: "boolean" } }, required: ["chainRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_chain_mixer_apply",
    description: "Apply an exact, unexpired chain-mixer preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_device_io_preview",
    description: "Read-only preflight for device-level routing (device IO type/channel where Live exposes it) or a compressor's sidechain source — separate typed surfaces, never conflated.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["routing", "sidechain"] }, deviceRef: { type: "string", minLength: 1, maxLength: 256 }, routingType: { type: "string", minLength: 1, maxLength: 128 }, routingChannel: { type: "string", minLength: 1, maxLength: 128 } }, required: ["action", "deviceRef", "routingType"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_device_io_apply",
    description: "Apply an exact, unexpired device-IO preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_application_dialog_preview",
    description: "Read the current application dialog (message, button count, open-dialog count) and preflight one guarded dialog-button press. Dialog buttons can be destructive (save/discard); the press fences on the exact message content and dialog instance counts, and the preview returns the message so the operator confirms the semantic.",
    inputSchema: { type: "object", properties: { button: { type: "integer", minimum: 0, maximum: 16 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_application_dialog_apply",
    description: "Press the previewed dialog button only if the dialog state still exactly matches the preview.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_device_advanced_preview",
    description: "Read-only preflight for device parameter banks, automation re-enable, A/B comparison save, chain insertion, and cross-track/chain device moves.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["set-bank", "re-enable-automation", "save-comparison", "insert-chain", "move-cross"] }, ref: { type: "string", minLength: 1, maxLength: 256 }, bank: { type: "integer", minimum: 0, maximum: 32 }, scriptIndex: { type: "integer", minimum: 0, maximum: 16 }, trackRef: { type: "string", minLength: 1, maxLength: 256 }, chainRef: { type: "string", minLength: 1, maxLength: 256 }, deviceName: { type: "string", minLength: 1, maxLength: 256 }, index: { type: "integer", minimum: 0, maximum: 256 }, targetTrackRef: { type: "string", minLength: 1, maxLength: 256 }, targetChainRef: { type: "string", minLength: 1, maxLength: 256 } }, required: ["action"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_device_advanced_apply",
    description: "Apply an exact, unexpired device-advanced preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_chain_preview",
    description: "Read-only preflight for rack chain color, auto-color, mute, and solo with exact undo.",
    inputSchema: { type: "object", properties: { chainRef: { type: "string", minLength: 1, maxLength: 256 }, colorIndex: { type: "integer", minimum: 0, maximum: 69 }, autoColor: { type: "boolean" }, mute: { type: "boolean" }, solo: { type: "boolean" } }, required: ["chainRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_chain_apply",
    description: "Apply an exact, unexpired chain preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_drum_pad_preview",
    description: "Read-only preflight for drum pad note and solo, or deleting all chains inside one pad (explicitly non-undoable).",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["set", "delete-all-chains"] }, padRef: { type: "string", minLength: 1, maxLength: 256 }, note: { type: "integer", minimum: 0, maximum: 127 }, solo: { type: "boolean" } }, required: ["action", "padRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_drum_pad_apply",
    description: "Apply an exact, unexpired drum-pad preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_rack_preview",
    description: "Read-only preflight for rack visible macro count and selected variation (exact undo), plus rack actions: add/remove/randomize macros, insert chain, copy pad, and variation store/recall/delete (momentary, non-undoable).",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["set", "add-macro", "remove-macro", "randomize-macros", "insert-chain", "copy-pad", "store-variation", "recall-variation", "delete-variation"] }, rackRef: { type: "string", minLength: 1, maxLength: 256 }, selectedVariationIndex: { type: "integer", minimum: -1, maximum: 256 }, index: { type: "integer", minimum: -1, maximum: 256 }, sourceIndex: { type: "integer", minimum: 0, maximum: 127 }, targetIndex: { type: "integer", minimum: 0, maximum: 127 } }, required: ["action", "rackRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_rack_apply",
    description: "Apply an exact, unexpired rack preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_rack_view_preview",
    description: "Read-only preflight for rack view state: selected chain/pad, pad scroll position, and chain-device visibility.",
    inputSchema: { type: "object", properties: { rackRef: { type: "string", minLength: 1, maxLength: 256 }, selectedChainRef: { type: ["string", "null"], minLength: 1, maxLength: 256 }, selectedPadIndex: { type: "integer", minimum: -1, maximum: 127 }, padScrollPosition: { type: "integer", minimum: 0, maximum: 127 }, showChainDevices: { type: "boolean" } }, required: ["rackRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_rack_view_apply",
    description: "Apply an exact, unexpired rack-view preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_device_specialized_preview",
    description: "Read-only preflight for specialized device families: Drift, Drum Cell, Eq8, Hybrid Reverb, Meld, and plug-ins (presets and editor state).",
    inputSchema: { type: "object", properties: { family: { type: "string", enum: ["drift", "drum-cell", "eq8", "hybrid-reverb", "meld", "plugin"] }, deviceRef: { type: "string", minLength: 1, maxLength: 256 }, pitchBendRange: { type: "integer", minimum: 1, maximum: 96 }, voiceCount: { type: "integer", minimum: 1, maximum: 64 }, voiceMode: { type: "integer", minimum: 0, maximum: 8 }, gain: { type: "number", minimum: -70, maximum: 24 }, editMode: { type: "integer", minimum: 0, maximum: 4 }, globalMode: { type: "integer", minimum: 0, maximum: 4 }, oversampling: { type: "boolean" }, selectedBand: { type: "integer", minimum: 0, maximum: 8 }, irCategory: { type: "string", minLength: 1, maxLength: 128 }, irFile: { type: "string", minLength: 1, maxLength: 256 }, attack: { type: "number", minimum: 0 }, decay: { type: "number", minimum: 0 }, size: { type: "number", minimum: 0 }, time: { type: "number", minimum: 0 }, engine: { type: "integer", minimum: 0, maximum: 4 }, unison: { type: "integer", minimum: 1, maximum: 16 }, monoPoly: { type: "boolean" }, polyphony: { type: "integer", minimum: 1, maximum: 64 }, presetIndex: { type: "integer", minimum: 0, maximum: 1024 }, isEditorOpen: { type: "boolean" } }, required: ["family", "deviceRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_device_specialized_apply",
    description: "Apply an exact, unexpired specialized-device preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_looper_preview",
    description: "Read-only preflight for Looper actions (record, overdub, play, stop, clear, undo, double-speed, half-speed, export to an exact empty clip slot — momentary) and writable properties (overdubAfterRecord, recordLengthIndex — exact undo). loopLength and tempo are read-only and reported in the looper device row.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["set", "record", "overdub", "play", "stop", "clear", "undo", "double-speed", "half-speed", "export"] }, deviceRef: { type: "string", minLength: 1, maxLength: 256 }, slotRef: { type: "string", minLength: 1, maxLength: 256 }, overdubAfterRecord: { type: "boolean" }, recordLengthIndex: { type: "integer", minimum: 0, maximum: 8 } }, required: ["action", "deviceRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_looper_apply",
    description: "Apply an exact, unexpired looper preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_simpler_preview",
    description: "Read-only preflight for replacing one Simpler device's sample with explicit file authority (allowed root, canonical path, size/type, SHA-256 with apply-time re-verification).",
    inputSchema: { type: "object", properties: { deviceRef: { type: "string", minLength: 1, maxLength: 256 }, filePath: { type: "string", minLength: 1, maxLength: 1024 }, allowedRoot: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["deviceRef", "filePath", "allowedRoot"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_simpler_apply",
    description: "Apply an exact, unexpired simpler sample-replacement preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_observe_subscribe",
    description: "Start a bounded negotiated observer subscription over documented observable state (transport, selection, track, clip, device, parameter, groove, tuning, scene, meters, rack). Events carry revision and identity context; nothing here is mutation authority.",
    inputSchema: { type: "object", properties: { topics: { type: "array", minItems: 1, maxItems: 64, items: { type: "object", properties: { kind: { type: "string", enum: ["transport", "selection", "track", "clip", "device", "parameter", "groove", "tuning", "scene", "meters", "rack"] }, ref: { type: "string", minLength: 1, maxLength: 256 } }, required: ["kind"], additionalProperties: false } }, minIntervalMs: { type: "integer", minimum: 100, maximum: 60000 } }, required: ["topics"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_observe_poll",
    description: "Poll one observer subscription for changed topics since the last poll, with deduplication, revision context, and explicit overflow.",
    inputSchema: { type: "object", properties: { subscriptionId: { type: "string", minLength: 16, maxLength: 128 } }, required: ["subscriptionId"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_observe_unsubscribe",
    description: "End one observer subscription and release its quota.",
    inputSchema: { type: "object", properties: { subscriptionId: { type: "string", minLength: 16, maxLength: 128 } }, required: ["subscriptionId"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_browser_roots",
    description: "List the Browser roots available on the connected Live build, whether each binding is public or internal, and whether preview is available. Internal bindings are never stable public LOM APIs.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_midi_transform_preview",
    description: "Read-only preflight for one deterministic seeded MIDI transform (transpose, scale-constrain, quantize, swing, velocity-curve, humanize, legato, staccato, rotate, repeat, ratchet, chord-voicing, arpeggiate, seeded-variation); returns the exact add/update/delete note diff, source revision, constraints, assumptions, MPE probe, and undo path.",
    inputSchema: {
      type: "object",
      properties: {
        clipRef: { type: "string", minLength: 1, maxLength: 256 },
        transform: { type: "string", enum: ["transpose", "scale-constrain", "quantize", "swing", "velocity-curve", "humanize-velocity", "humanize-timing", "legato", "staccato", "rotate", "repeat", "ratchet", "chord-voicing", "arpeggiate", "seeded-variation"] },
        params: { type: "object", maxProperties: 12, additionalProperties: { type: ["string", "number"] } },
        scope: { type: "string", enum: ["in-place", "duplicate"] },
        target: { type: "object", properties: { trackRef: { type: "string", minLength: 1, maxLength: 256 }, sceneIndex: { type: "integer", minimum: 0, maximum: 10000 } }, required: ["trackRef", "sceneIndex"], additionalProperties: false },
      },
      required: ["clipRef", "transform", "params"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_midi_transform_apply",
    description: "Apply an exact, unexpired MIDI transform preview with confirmation and idempotency; the deterministic diff is re-verified against a fresh fence before any note write.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_browser_inspect",
    description: "Inspect one authoritative Browser result by exact item id: stable identity, type, metadata/provenance, and explicit loadability. Browser-internal paths only; raw filesystem paths are never returned.",
    inputSchema: { type: "object", properties: { itemId: { type: "string", minLength: 1, maxLength: 256 } }, required: ["itemId"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_arrangement_automation_read",
    description: "Read-only Arrangement automation discovery probe: one exact arrangement clip + parameter envelope with owner identity, time range, complete paged points, explicit curve unavailability, and a content revision. No arrangement automation mutation is advertised.",
    inputSchema: {
      type: "object",
      properties: {
        clipRef: { type: "string", minLength: 1, maxLength: 256 },
        parameterRef: { type: "string", minLength: 1, maxLength: 256 },
        limit: { type: "integer", minimum: 1, maximum: 512 },
        cursor: { type: "string", maxLength: 1024 },
      },
      required: ["clipRef", "parameterRef"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_take_lane_read",
    description: "Read-only bounded take-lane discovery for one exact track: ordered lane identity/name/index, per-lane clip ranges and content fingerprints, a main-lane summary, complete/unavailable flags, and a revision-bound cursor. Never starts audition, creates/deletes lanes, promotes takes, or edits the main lane.",
    inputSchema: {
      type: "object",
      properties: {
        trackRef: { type: "string", minLength: 1, maxLength: 256 },
        limit: { type: "integer", minimum: 1, maximum: 128 },
        cursor: { type: "string", maxLength: 1024 },
      },
      required: ["trackRef"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_comp_read",
    description: "Read-only comp discovery for one exact clip: adapter-reported take-lane source segments with lane identity, paged and revision-bound; relationships the adapter cannot enumerate are reported explicitly. No comp mutation or audition.",
    inputSchema: {
      type: "object",
      properties: {
        clipRef: { type: "string", minLength: 1, maxLength: 256 },
        limit: { type: "integer", minimum: 1, maximum: 512 },
        cursor: { type: "string", maxLength: 1024 },
      },
      required: ["clipRef"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_warp_marker_read",
    description: "Read-only warp-marker probe for one exact audio clip: the complete bounded marker set with (beatTime, sampleTime), paged without silent truncation, monotonicity checks, clip and collection revisions, explicit identity limits, and read-only mutation-feasibility evidence. Never adds, moves, or deletes a marker.",
    inputSchema: {
      type: "object",
      properties: {
        clipRef: { type: "string", minLength: 1, maxLength: 256 },
        limit: { type: "integer", minimum: 1, maximum: 256 },
        cursor: { type: "string", maxLength: 1024 },
      },
      required: ["clipRef"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
] as const;

export interface ToolCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: Record<string, unknown>;
  /** True for host-local tools; false for Live-adapter tools. */
  readonly local: boolean;
  readonly policyClass: ToolPolicyClass;
  readonly prereq: ToolAvailabilityPrereq;
}

function resolveRule<T extends { readonly name?: string; readonly prefix?: string }>(rules: readonly T[], name: string): T | undefined {
  let best: T | undefined;
  for (const rule of rules) {
    if (rule.name !== undefined) { if (rule.name === name) return rule; continue; }
    if (rule.prefix !== undefined && name.startsWith(rule.prefix) && (best === undefined || rule.prefix.length > (best.prefix ?? "").length)) best = rule;
  }
  return best;
}

function buildCatalog(): readonly ToolCatalogEntry[] {
  const entries: ToolCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const descriptor of toolDescriptors) {
    const name = descriptor.name;
    if (typeof name !== "string" || name.length === 0 || seen.has(name)) throw new Error(`tool catalog name is invalid: ${String(name)}`);
    seen.add(name);
    const local = !name.startsWith("live_");
    const availabilityRule = resolveRule(TOOL_AVAILABILITY_RULES, name);
    if (!availabilityRule) throw new Error(`tool catalog availability rule is missing: ${name}`);
    const policyRule = resolveRule(TOOL_POLICY_RULES, name);
    if (!policyRule) throw new Error(`tool catalog policy class is missing: ${name}`);
    entries.push({ name, description: descriptor.description, inputSchema: descriptor.inputSchema, annotations: descriptor.annotations, local, policyClass: policyRule.policyClass, prereq: availabilityRule.prereq });
  }
  return Object.freeze(entries);
}

/** Every known tool with its declarative prerequisites and policy class. */
export const TOOL_CATALOG: readonly ToolCatalogEntry[] = buildCatalog();

const TOOL_CATALOG_BY_NAME: ReadonlyMap<string, ToolCatalogEntry> = new Map(TOOL_CATALOG.map((entry) => [entry.name, entry]));

export function toolCatalogEntry(name: string): ToolCatalogEntry | undefined {
  return TOOL_CATALOG_BY_NAME.get(name);
}

/** Aggregate mutation surface check shared by undo and recovery finalization. */
export function liveMutationAvailable(status: LiveStatus): boolean {
  const capabilities = new Set<string>(status.capabilities);
  const operations = new Set<string>(status.operations ?? []);
  const hasAnyCapability = (...required: string[]): boolean => required.some((capability) => capabilities.has(capability));
  const hasAnyOperation = (...required: string[]): boolean => required.some((operation) => operations.has(operation));
  return hasAnyCapability("session.structure", "session.midi_clip.create", "session.midi_note.write", "arrangement.write", "audio", "audio.capture.resampling", "automation", "device.parameter.write", "devices", "browser", "routing", "recording", "mixing", "transport", "realtime.events")
    && hasAnyOperation("transport.set", "tempo.set", "session.audition-launch", "session.audition-stop", "session.emergency-stop", "session.clip-launch", "session.clip-stop", "session.capture-midi", "scene.capture", "track.create", "scene.create", "clip.create", "note.update", "note.delete", "clip.duplicate", "clip.move", "arrangement.clip.create", "arrangement.clip.move", "audio.clip.set", "mixer.set", "automation.envelope.create", "automation.envelope.delete", "automation.point.insert", "automation.point.delete", "browser.load", "device.insert", "device.enable", "device.move", "device.parameter.set", "routing.set", "recording.session", "recording.arrangement", "realtime.arm", "realtime.disarm", "locator.add");
}

/** Evaluate exact negotiated prerequisites for one tool against adapter status. */
export function toolExecutable(entry: ToolCatalogEntry, status: LiveStatus): boolean {
  const prereq = entry.prereq;
  if (prereq.always === true) return true;
  if (prereq.never === true) return false;
  if (!status.connected) return false;
  if (prereq.provenance !== undefined && status.provenance !== prereq.provenance) return false;
  const capabilities = new Set<string>(status.capabilities);
  const operations = new Set<string>(status.operations ?? []);
  if (prereq.capabilitiesAll !== undefined && !prereq.capabilitiesAll.every((capability) => capabilities.has(capability))) return false;
  if (prereq.capabilitiesAny !== undefined && !prereq.capabilitiesAny.some((capability) => capabilities.has(capability))) return false;
  if (prereq.operationsAll !== undefined && !prereq.operationsAll.every((operation) => operations.has(operation))) return false;
  if (prereq.operationsAny !== undefined && !prereq.operationsAny.some((operation) => operations.has(operation))) return false;
  if (prereq.mutationAvailable === true && !liveMutationAvailable(status)) return false;
  return true;
}

export interface ToolPolicySpec {
  readonly profile: ToolPolicyProfile;
  /** Explicit tool names or `prefix*` domain patterns additionally allowed (intersected with the profile). */
  readonly allow: readonly string[];
  /** Explicit tool names or `prefix*` domain patterns denied; deny always wins. */
  readonly deny: readonly string[];
}

export const DEFAULT_TOOL_POLICY: ToolPolicySpec = Object.freeze({ profile: "full", allow: Object.freeze([]), deny: Object.freeze([]) });

export function toolPolicyMatches(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

function validToolPattern(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_*]{1,128}$/.test(value) && (!value.includes("*") || value.endsWith("_*") || value.endsWith("*"));
}

export function parseToolPolicySpec(value: unknown): ToolPolicySpec {
  if (value === undefined) return DEFAULT_TOOL_POLICY;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("tool policy must be an object");
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.some((key) => !["profile", "allow", "deny"].includes(key))) throw new Error("tool policy has unknown keys");
  const profile = candidate.profile ?? "full";
  if (typeof profile !== "string" || !(profile in TOOL_POLICY_PROFILES)) throw new Error("tool policy profile is unknown");
  const allow = candidate.allow ?? [];
  const deny = candidate.deny ?? [];
  if (!Array.isArray(allow) || allow.length > 256 || !allow.every(validToolPattern)) throw new Error("tool policy allow list is invalid");
  if (!Array.isArray(deny) || deny.length > 256 || !deny.every(validToolPattern)) throw new Error("tool policy deny list is invalid");
  if ([...allow, ...deny].some((pattern) => !TOOL_CATALOG.some((entry) => toolPolicyMatches(pattern, entry.name)))) throw new Error("tool policy pattern matches no known tool");
  return Object.freeze({ profile: profile as ToolPolicyProfile, allow: Object.freeze([...allow]), deny: Object.freeze([...deny]) });
}

/** Read the deployment tool policy from process environment (ABLETON_MCP_TOOL_POLICY, ABLETON_MCP_TOOL_ALLOW, ABLETON_MCP_TOOL_DENY). */
export function toolPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): ToolPolicySpec {
  const profile = env.ABLETON_MCP_TOOL_POLICY;
  const allow = env.ABLETON_MCP_TOOL_ALLOW;
  const deny = env.ABLETON_MCP_TOOL_DENY;
  if (profile === undefined && allow === undefined && deny === undefined) return DEFAULT_TOOL_POLICY;
  const split = (value: string | undefined): string[] => value === undefined ? [] : value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  return parseToolPolicySpec({ ...(profile !== undefined ? { profile } : {}), allow: split(allow), deny: split(deny) });
}

/** Server-side policy decision: the profile's classes (plus profile include patterns), narrowed by an allow list, with deny always winning. */
export function toolAllowedByPolicy(entry: ToolCatalogEntry, policy: ToolPolicySpec): boolean {
  if (policy.deny.some((pattern) => toolPolicyMatches(pattern, entry.name))) return false;
  const profile = TOOL_POLICY_PROFILES[policy.profile];
  const inProfile = profile.classes.includes(entry.policyClass) || (profile.include ?? []).some((pattern) => toolPolicyMatches(pattern, entry.name));
  if (policy.allow.length > 0) return policy.allow.some((pattern) => toolPolicyMatches(pattern, entry.name)) && inProfile;
  return inProfile;
}

export interface ToolVisibilityRow {
  readonly entry: ToolCatalogEntry;
  readonly executable: boolean;
  readonly policyAllowed: boolean;
  /** Callable right now: executable and policy-allowed. */
  readonly visible: boolean;
}

export function resolveToolVisibility(status: LiveStatus, policy: ToolPolicySpec): readonly ToolVisibilityRow[] {
  return TOOL_CATALOG.map((entry) => {
    const executable = toolExecutable(entry, status);
    const policyAllowed = toolAllowedByPolicy(entry, policy);
    return Object.freeze({ entry, executable, policyAllowed, visible: executable && policyAllowed });
  });
}

/** The tool descriptors a caller may currently discover and call. */
export function visibleToolDescriptors(status: LiveStatus, policy: ToolPolicySpec): readonly ToolDescriptor[] {
  return resolveToolVisibility(status, policy).filter((row) => row.visible).map((row) => ({ name: row.entry.name, description: row.entry.description, inputSchema: row.entry.inputSchema, annotations: row.entry.annotations }));
}
