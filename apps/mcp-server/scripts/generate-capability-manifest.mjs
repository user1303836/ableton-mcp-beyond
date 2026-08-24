#!/usr/bin/env node
// Generate the versioned capability manifest mapping public Live class
// surfaces to read/write/call/observe support. The operation list is derived
// from the canonical registry; executable versus reserved status and
// first-tested evidence are curated honestly per family.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const outputPath = process.argv[2];

function canonical(value, depth = 0) {
  if (depth > 32) throw new Error("registry is too deeply nested");
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
  }
  throw new Error("registry contains an unsupported value");
}

function canonicalRegistryHash(registry) {
  return createHash("sha256").update(canonical(registry)).digest("hex");
}

const registry = JSON.parse(readFileSync(new URL("../../../protocol/ableton-live-v1.operations.json", import.meta.url), "utf8"));
const allIds = registry.operations.map((operation) => operation.id).sort();

const RESERVED = new Set([
  "arrangement.automation.create", "arrangement.automation.delete", "arrangement.automation.point.delete", "arrangement.automation.point.insert",
  "audio.comp.read",
  "browser.preview.start", "browser.preview.stop",
  "project.bounce", "project.collect", "project.export", "project.new", "project.open", "project.save", "project.save-as",
  "session.discover",
]);

const FAMILIES = [
  { family: "session-read", surface: "Song/Track/Scene/Clip/ClipSlot/Chain/Device/Parameter (LOM)", operations: ["status", "snapshot", "discover", "get", "reconnect", "session.playback", "audio.comp.read", "session.discover"], firstTested: "12.4.5b8 (phase 3 discovery; expanded surfaces pending exact candidate)" },
  { family: "transport-locators", surface: "Song transport, loop, metronome, punch, cue points, Link", operations: ["transport.set", "transport.action", "tempo.set", "locator.add", "locator.delete", "locator.rename", "locator.jump", "locator.jump-to"], firstTested: "12.4.5b8 phase 5a (actions pending exact candidate)" },
  { family: "session-structure", surface: "Track/Scene/ClipSlot/Scene lifecycle", operations: ["track.create", "track.delete", "track.rename", "scene.create", "scene.delete", "scene.rename", "scene.capture", "session.audition-stop", "session.emergency-stop", "session.clip-launch", "session.clip-stop", "session.capture-midi", "clip.create", "clip.delete", "clip.rename", "clip.duplicate", "clip.move", "clip.set", "clip.action", "arrangement.clip.create", "arrangement.clip.delete", "arrangement.clip.move"], firstTested: "12.4.5b8 phases 4-5 (expanded properties pending exact candidate)" },
  { family: "midi-notes", surface: "Clip MIDI notes", operations: ["note.add", "note.add-batch", "note.update", "note.delete", "note.duplicate", "note.quantize", "note.read-by-id", "note.read-selected"], firstTested: "12.4.5b8 phase 5 (targeted APIs pending exact candidate)" },
  { family: "audio-warp", surface: "Audio clips, warp markers, samples", operations: ["audio.clip.set", "audio.warp-marker.read", "audio.warp-marker.add", "audio.warp-marker.move", "audio.warp-marker.delete", "session.audio-clip.create", "arrangement.audio-clip.create", "audio.capture.inspect", "audio.capture.start", "audio.capture.stop", "audio.capture.status", "audio.capture.emergency-stop", "audio.capture.cleanup"], firstTested: "12.4.5b8 phase 8 capture (warp/sample editing pending exact candidate)" },
  { family: "take-lanes", surface: "Track.take_lanes and TakeLane clips", operations: ["audio.take-lane.read", "take-lane.create", "take-lane.rename", "take-lane.clip.create", "take-lane.audio-clip.create"], firstTested: "pending exact candidate (comp editing unsupported by public LOM)" },
  { family: "tuning-groove", surface: "Song.tuning_system, scale, GroovePool", operations: ["tuning.read", "tuning.set", "groove.read", "groove.set", "groove.edit"], firstTested: "pending exact candidate" },
  { family: "scenes-slots", surface: "Scene/ClipSlot properties and fire", operations: ["scene.set", "scene.fire-selected", "session.audition-launch"], firstTested: "12.4.5b8 phase 4 audition (properties pending exact candidate)" },
  { family: "song-link", surface: "Song state, Link, time conversion", operations: ["song.read", "song.time-convert"], firstTested: "pending exact candidate" },
  { family: "track-structure", surface: "Return tracks, duplication, Track.View", operations: ["track.create-return", "track.delete-return", "track.duplicate", "scene.duplicate", "track.view.set", "track.select-instrument"], firstTested: "pending exact candidate" },
  { family: "selection-views", surface: "Song.View, Clip.View, Device.View, Application.View, dialogs", operations: ["selection.set", "song.view.set", "clip.view.set", "device.view.set", "view.set", "view.control", "application.dialog"], firstTested: "pending exact candidate" },
  { family: "performance", surface: "Application usage, meters, latency", operations: ["performance.read"], firstTested: "pending exact candidate" },
  { family: "mixer-routing", surface: "MixerDevice, ChainMixerDevice, DeviceIO, sidechains", operations: ["mixer.set", "mixer.extended.set", "device-io.set", "compressor.sidechain.set", "routing.set"], firstTested: "12.4.5b8 phase 6 routing (extended surfaces pending exact candidate)" },
  { family: "devices-parameters", surface: "Device/Parameter metadata, banks, comparison, move", operations: ["device.insert", "device.delete", "device.enable", "device.move", "device.rename", "device.parameter.set", "device.bank.set", "device.comparison.save-to-slot", "parameter.re-enable-automation"], firstTested: "12.4.5b8 phase 6 devices (metadata/banks pending exact candidate)" },
  { family: "chains-racks-pads", surface: "Chain, DrumChain, DrumPad, RackDevice", operations: ["chain.set", "chain-mixer.set", "drum-pad.set", "drum-pad.delete-all-chains", "rack.set", "rack.action", "rack.view.set"], firstTested: "12.4.5b8 phase 6 discovery (edits pending exact candidate)" },
  { family: "specialized-devices", surface: "Drift/DrumCell/Eq8/HybridReverb/Looper/Max/Meld/Plugin/Simpler", operations: ["drift.set", "drum-cell.set", "eq8.set", "hybrid-reverb.set", "looper.action", "looper.set", "meld.set", "plugin.set", "simpler.replace-sample"], firstTested: "pending exact candidate (Live 12 device APIs)" },
  { family: "automation", surface: "Clip envelopes and points", operations: ["automation.envelope.read", "automation.envelope.create", "automation.envelope.delete", "automation.envelope.clear", "automation.point.insert", "automation.point.delete"], firstTested: "12.4.5b8 phase 5e (arrangement automation unsupported by public LOM)" },
  { family: "recording", surface: "Session/Arrangement recording", operations: ["recording.session", "recording.arrangement"], firstTested: "12.4.5b8 phase 6cd" },
  { family: "browser", surface: "Browser roots, search, load", operations: ["browser.roots", "browser.search", "browser.inspect", "browser.load", "browser.preview.start", "browser.preview.stop"], firstTested: "12.4.5b8 phase 6ab (preview declined; internal bindings never stable public APIs)" },
  { family: "observe", surface: "Negotiated bounded observer model", operations: ["observe.subscribe", "observe.poll", "observe.unsubscribe"], firstTested: "pending exact candidate" },
  { family: "authority", surface: "Transaction authority preflight/prepare/retire", operations: ["authority.preflight", "authority.prepare", "authority.retire"], firstTested: "internal transaction machinery (not a user-facing Live surface)" },
  { family: "realtime-subscriptions", surface: "Signed event subscriptions and realtime plane", operations: ["subscribe", "realtime.arm", "realtime.disarm", "realtime.stats"], firstTested: "12.4.5b8 phases 7b/7c" },
  { family: "projects", surface: "Project info and verified backup", operations: ["project.bounce", "project.collect", "project.export", "project.new", "project.open", "project.save", "project.save-as"], firstTested: "12.4.5b8 phase 7a info/backup (save/open/export stay reserved limitation reporters)" },
  { family: "arrangement-automation", surface: "Arrangement automation lanes (read-only discovery probe; writes reserved)", operations: ["arrangement.automation.read", "arrangement.automation.create", "arrangement.automation.delete", "arrangement.automation.point.delete", "arrangement.automation.point.insert"], firstTested: "read: shape-probed fake-Live contract and bounded registry schemas; exact real-Live candidate pending. Writes stay reserved and fail-closed" },
];

const operations = {};
for (const family of FAMILIES) {
  for (const id of family.operations) {
    if (!allIds.includes(id)) throw new Error(`manifest family ${family.family} references unknown operation ${id}`);
    if (operations[id]) throw new Error(`manifest assigns ${id} twice (${operations[id]} and ${family.family})`);
    operations[id] = family.family;
  }
}
const missing = allIds.filter((id) => !operations[id]);
if (missing.length > 0) throw new Error(`manifest is missing operations: ${missing.join(", ")}`);

const READ_PREFIXES = ["status", "snapshot", "discover", "get", "reconnect", "session.playback", "performance.read", "browser.roots", "browser.search", "browser.inspect"];
const OBSERVE_PREFIXES = ["observe.", "subscribe", "realtime."];
const READ_SUFFIXES = [".read", ".read-by-id", ".read-selected"];
function accessFor(id) {
  const access = [];
  if (READ_PREFIXES.some((prefix) => id === prefix || id.startsWith(prefix)) || READ_SUFFIXES.some((suffix) => id.endsWith(suffix)) || id.includes(".read")) access.push("read");
  if (OBSERVE_PREFIXES.some((prefix) => id.startsWith(prefix))) access.push("observe");
  if (id.includes(".set") || id.includes(".add") || id.includes(".delete") || id.includes(".create") || id.includes(".move") || id.includes(".rename") || id.includes(".update") || id.includes(".edit") || id.includes(".quantize") || id.includes(".duplicate") || id.includes(".insert") || id.includes(".replace-sample") || id.includes(".save-to-slot") || id.includes(".re-enable-automation")) access.push("write");
  if (!access.includes("write") && !access.includes("read") && !access.includes("observe")) access.push("call");
  else if (id.includes(".action") || id.includes(".jump") || id.includes(".jump-to") || id.includes(".fire-selected") || id.includes(".load") || id.includes(".capture") || id.includes(".audition") || id.includes(".emergency-stop") || id.includes(".capture-midi") || id.includes("recording.") || id.includes(".time-convert") || id.includes(".bank.set") || id.includes(".dialog") || id.includes(".control") || id.includes(".view.set") || id.includes(".enable") || id.includes(".duplicate") || id.includes(".prepare") || id.includes(".preflight") || id.includes(".retire") || id.includes(".clip-launch") || id.includes(".clip-stop") || id.includes("transport.action") || id.includes("locator.jump")) access.push("call");
  return access;
}

const families = FAMILIES.map((family) => ({
  ...family,
  operations: family.operations.map((id) => ({ id, status: RESERVED.has(id) ? "reserved-fail-closed" : "executable-negotiated", access: accessFor(id) })),
}));

const manifest = {
  schema: "ableton-mcp-capability-manifest/v1",
  registryHash: canonicalRegistryHash(registry),
  operationCount: allIds.length,
  coverageRules: [
    "Covered means reachable end to end from MCP through the negotiated bridge with a verified response.",
    "Read, write, call, and observe access are tracked separately per family notes.",
    "Generic DeviceParameter access never counts as semantic coverage of specialized device members.",
    "Simulator, fake-Live, and packaged-contract evidence is never real-Live evidence.",
    "Executable operations are negotiated at connect time; reserved operations fail closed and report the actual limitation.",
  ],
  families,
};

const target = outputPath ?? new URL("../../../docs/evidence/capability-manifest.json", import.meta.url);
writeFileSync(target, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ schema: manifest.schema, operationCount: manifest.operationCount, families: families.length, reserved: allIds.filter((id) => RESERVED.has(id)).length }));
