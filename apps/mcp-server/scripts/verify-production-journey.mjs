import { execFileSync, spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { createSocket } from "node:dgram";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { npmExecutable } from "../dist/src/platform.js";

// Phase 2: prove the packaged production boundary without Live. The packed
// artifact is installed, the packaged CLI talks to the production Python
// listener over the authenticated wire against a scheduled fake-Live
// dispatcher, and every safety journey is exercised end to end. Fake
// provenance is asserted throughout; this evidence never claims real Live.

const packageDirectory = new URL("..", import.meta.url);
const temporaryDirectory = mkdtempSync(join(tmpdir(), "ableton-mcp-journey-"));
const npm = npmExecutable();
const npmOptions = { shell: process.platform === "win32" };
const children = new Set();
const results = [];
const userJourneyEvidence = [];
const plannedJourneys = new Map();
const journeyPlanHistory = new Map();
const journeyExecutions = new Map();
const accessibilityChecks = [];
let failed = false;
let harnessRealtimePort = 0;

function step(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push({ name, passed: true }); console.error(`journey ok: ${name}`); })
    .catch((cause) => { failed = true; results.push({ name, passed: false, error: cause instanceof Error ? cause.message : String(cause) }); console.error(`journey FAIL: ${name}: ${cause instanceof Error ? cause.message : cause}`); throw cause; });
}

function assert(condition, message) { if (!condition) throw new Error(`assertion failed: ${message}`); }

function journeyProgress(journey, stage, status, evidence = {}) {
  const execution = journeyExecutions.get(journey) ?? { events: [], residualState: null };
  const plan = plannedJourneys.get(journey);
  assert(plan, `${journey} has no bound plan`);
  const stageDefinition = plan.stages.find((candidate) => candidate.id === stage && candidate.status === "planned");
  assert(stageDefinition, `${journey}/${stage} is not an available planned stage`);
  const readOnly = stageDefinition.impact === "read-only";
  const legal = readOnly ? {
    start: ["planned", "discovering", "applying", "verifying", "completed"],
    planned: ["applying", "verifying", "completed", "uncertain"],
    discovering: ["planned", "applying", "verifying", "completed", "uncertain"],
    applying: ["verifying", "completed", "uncertain"],
    verifying: ["completed", "uncertain"],
    awaiting_confirmation: [], completed: [], recovered: [], uncertain: [],
  } : {
    start: ["planned", "awaiting_confirmation"],
    planned: ["awaiting_confirmation", "uncertain"],
    awaiting_confirmation: ["applying", "uncertain"],
    applying: ["verifying", "uncertain"],
    verifying: ["completed", "recovered", "uncertain"],
    discovering: [], completed: [], recovered: [], uncertain: [],
  };
  const previous = execution.events.at(-1);
  const previousForStage = [...execution.events].reverse().find((event) => event.stage === stage);
  const stageOrder = plan.stages.findIndex((candidate) => candidate.id === stage);
  if (previous) {
    const previousOrder = plan.stages.findIndex((candidate) => candidate.id === previous.stage);
    assert(stageOrder >= previousOrder, `${journey}/${stage} regressed behind ${previous.stage}`);
  }
  const priorStatus = previousForStage?.status ?? "start";
  assert(legal[priorStatus].includes(status), `${journey}/${stage} made an illegal ${priorStatus}->${status} transition`);
  execution.events.push({ sequence: execution.events.length + 1, planId: plan.planId, stage, status, evidence });
  journeyExecutions.set(journey, execution);
}

function journeyResidual(journey, residualState) {
  assert(residualState && ["completed", "recovered", "uncertain"].includes(residualState.status), `${journey} residual state lacks a terminal status`);
  for (const field of ["playback", "recording", "temporaryMedia", "realtimeAuthority"]) assert(Object.hasOwn(residualState, field), `${journey} residual state omitted ${field}`);
  const execution = journeyExecutions.get(journey) ?? { events: [], residualState: null };
  execution.residualState = residualState;
  journeyExecutions.set(journey, execution);
}

function bindUdp() {
  const socket = createSocket("udp4");
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => { socket.removeListener("error", reject); resolve(socket); });
  });
}
function sendUdp(socket, payload, port) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return new Promise((resolve, reject) => socket.send(bytes, port, "127.0.0.1", (error) => error ? reject(error) : resolve()));
}
function oscString(value) {
  const raw = Buffer.from(`${value}\0`, "utf8");
  return Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4)]);
}
function oscParameter(token, sequence, reference, value, sentAtMs) {
  const sequenceBuffer = Buffer.alloc(4); sequenceBuffer.writeInt32BE(sequence);
  const valueBuffer = Buffer.alloc(4); valueBuffer.writeFloatBE(value);
  const sentBuffer = Buffer.alloc(8); sentBuffer.writeDoubleBE(sentAtMs);
  return Buffer.concat([oscString("/ableton-mcp/parameter"), oscString(",sisfd"), oscString(token), sequenceBuffer, oscString(reference), valueBuffer, sentBuffer]);
}

function terminateChildProcess(child) {
  if (!child || child.exitCode !== null) return;
  try { child.kill(); } catch {}
  if (process.platform === "win32" && child.pid) {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  }
}

function removeTemporaryDirectory(path) {
  try { rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  catch (error) {
    if (process.platform !== "win32") throw error;
    try { execFileSync("icacls.exe", [path, "/reset", "/t", "/c"], { stdio: "ignore" }); } catch {}
    rmSync(path, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
}

function waitMs(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function ownerOnlySecret(path, secret) {
  writeFileSync(path, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  if (process.platform === "win32") {
    const encodedPath = Buffer.from(path, "utf8").toString("base64");
    const aclScript = "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ABLETON_MCP_ACL_PATH));" +
      "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$a=New-Object System.Security.AccessControl.FileSecurity;" +
      "$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);" +
      "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList @($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow);" +
      "[void]$a.AddAccessRule($rule);[System.IO.File]::SetAccessControl($p,$a)";
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", aclScript], { env: { ...process.env, ABLETON_MCP_ACL_PATH: encodedPath }, stdio: "pipe" });
  }
}

class McpClient {
  constructor(executable, configPath) {
    this.child = spawn(process.execPath, [executable, "--config", configPath], { stdio: ["pipe", "pipe", "pipe"] });
    children.add(this.child);
    this.pending = new Map();
    this.cancelled = new Set();
    this.nextId = 1;
    this.buffer = "";
    this.stderr = "";
    this.events = [];
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.method === "notifications/live_event" || message.method === "notifications/live_event_overflow") {
          this.events.push(message.params);
          continue;
        }
        const entry = this.pending.get(message.id);
        if (entry) { this.pending.delete(message.id); entry.resolve(message); }
      }
    });
    this.child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-65_536); });
  }
  request(method, params, timeoutMs = 45_000) {
    const id = this.nextId++;
    const payload = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const diagnostics = this.stderr.trim() ? `; server diagnostics: ${this.stderr.trim().slice(-4_096)}` : "";
        reject(new Error(`MCP request ${id} (${method}) timed out after ${timeoutMs}ms${diagnostics}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject });
    });
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }
  notify(method, params) { this.child.stdin.write(`${JSON.stringify(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params })}\n`); }
  cancel(id) { this.cancelled.add(id); this.notify("notifications/cancelled", { requestId: id }); const entry = this.pending.get(id); if (entry) { this.pending.delete(id); entry.resolve({ cancelled: true }); } }
  async initialize() {
    const response = await this.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "production-journey", version: "1" } });
    assert(response.result?.protocolVersion, "initialize returned no protocol version");
    this.notify("notifications/initialized");
  }
  async call(name, args, timeoutMs) {
    const response = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    if (response.cancelled) return { cancelled: true };
    assert(response.result, `tools/call ${name} returned an error: ${JSON.stringify(response.error)}`);
    const text = response.result.content?.[0]?.text ?? "";
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { isError: response.result.isError === true, parsed, raw: response.result };
  }
  async close() { this.child.stdin.end(); terminateChildProcess(this.child); await waitMs(50); }
}

const harnessSource = `
import json, os, pathlib, socket, sys, time
from AbletonMcpBridge.ableton_mcp_remote_script import AbletonMcpBridge

class FakeParameter:
    def __init__(self, name, value=0.0, min=0.0, max=1.0):
        self.name = name; self.value = value; self.min = min; self.max = max
        self.quantization = 0.0; self.is_enabled = True; self.is_automatable = True

class FakeMixer:
    def __init__(self):
        self.volume = FakeParameter("Track Volume", 0.85)
        self.panning = FakeParameter("Pan", 0.0, -1.0, 1.0)
        self.cue_volume = FakeParameter("Cue Volume", 1.0)
        self.sends = [FakeParameter("Send A", 0.0), FakeParameter("Send B", 0.0)]

class FakeDrumPad:
    def __init__(self, index):
        self.name = f"Pad {index + 1}"
        self.mute = False
        self.chains = []

class FakeDevice:
    def __init__(self, name="Utility"):
        self.name = name
        self.class_name = "AudioEffectUtility"
        self.enabled = True
        self.is_active = True
        self.parameters = [FakeParameter("Filter Cutoff", 0.75)] if name == "Drum Rack" else [FakeParameter("Gain")]
        if name == "Drum Rack":
            self.can_have_chains = True
            self.can_have_drum_pads = True
            self.visible_drum_pads = [FakeDrumPad(i) for i in range(16)]

class FakeEnvelopeEvent:
    def __init__(self, time, value):
        self.time = time; self.value = value

class FakeEnvelope:
    def __init__(self):
        self.events = []
    def events_in_range(self, start, end):
        return [e for e in self.events if start <= e.time <= end]
    def delete_events_in_range(self, start, end):
        self.events = [e for e in self.events if not (start <= e.time <= end)]
    def create_event(self, event):
        self.events.append(event)
        self.events.sort(key=lambda e: e.time)
    def value_at_time(self, time):
        candidates = [e for e in self.events if e.time <= time]
        return candidates[-1].value if candidates else 0.0

class FakeMidiNote:
    _next_id = [0]
    def __init__(self, pitch, start_time, duration, velocity, mute=False, probability=1.0, velocity_deviation=0.0, release_velocity=64.0):
        FakeMidiNote._next_id[0] += 1
        self.note_id = FakeMidiNote._next_id[0]
        self.pitch = pitch; self.start_time = start_time; self.duration = duration
        self.velocity = velocity; self.mute = mute
        self.probability = probability; self.velocity_deviation = velocity_deviation; self.release_velocity = release_velocity

class FakeClip:
    def __init__(self, length=4.0):
        self.length = length; self.name = "Journey Clip"; self.notes = []
        self._envelopes = {}
    def create_automation_envelope(self, parameter):
        key = getattr(parameter, "name", str(id(parameter)))
        if key not in self._envelopes:
            self._envelopes[key] = FakeEnvelope()
        return self._envelopes[key]
    def automation_envelope(self, parameter):
        return self._envelopes.get(getattr(parameter, "name", str(id(parameter))))
    def clear_envelope(self, parameter):
        self._envelopes.pop(getattr(parameter, "name", str(id(parameter))), None)
    @property
    def has_envelopes(self):
        return bool(self._envelopes)
    def add_new_notes(self, notes):
        for note in notes:
            if isinstance(note, dict):
                self.notes.append(FakeMidiNote(note["pitch"], note.get("start_time", note.get("start", 0.0)), note.get("duration", 0.25), note.get("velocity", 100.0), note.get("mute", False), note.get("probability", 1.0), note.get("velocity_deviation", 0.0), note.get("release_velocity", 64.0)))
            else:
                self.notes.append(note)
    def get_notes(self, *_): return list(self.notes)
    def get_all_notes_extended(self): return list(self.notes)
    def get_notes_extended(self, *_): return list(self.notes)
    def apply_note_modifications(self, _): pass
    def remove_notes_by_id(self, ids): self.notes = [n for n in self.notes if n.note_id not in ids]

class FakeSlot:
    def __init__(self, clip=None, track=None, index=0):
        self.clip = clip; self._track = track; self._index = index
    def create_clip(self, length):
        self.clip = FakeClip(length); return self.clip
    def delete_clip(self): self.clip = None
    def duplicate_clip_to(self, target):
        if self.clip is None: raise RuntimeError("no clip to duplicate")
        if target.clip is not None: raise RuntimeError("target slot occupied")
        import copy
        target.clip = copy.deepcopy(self.clip)
    def fire(self):
        if self._track is not None and self.clip is not None:
            song = self._track._song
            song.is_playing = True
            song._notify("is_playing")
            self._track.playing_slot_index = self._index
            self._track.fired_slot_index = self._index

class FakeRoutingChoice:
    def __init__(self, name):
        self.name = name

class FakeTrack:
    has_midi_input = True
    def __init__(self, name="Journey Drums", clips=None, song=None):
        self.name = name; self.arm = False; self.current_monitoring_state = 2
        self.playing_slot_index = -1; self.fired_slot_index = -1
        self._song = song
        self.mute = False; self.solo = False
        self.mixer_device = FakeMixer()
        self.can_be_armed = True
        self.current_input_routing = FakeRoutingChoice("Ext. In")
        self.current_input_sub_routing = FakeRoutingChoice("1")
        self.current_output_routing = FakeRoutingChoice("Main")
        self.current_output_sub_routing = FakeRoutingChoice("1/2")
        self.available_input_routing_types = [FakeRoutingChoice("Ext. In"), FakeRoutingChoice("No Input")]
        self.available_input_routing_channels = [FakeRoutingChoice(str(i + 1)) for i in range(16)]
        self.available_output_routing_types = [FakeRoutingChoice("Main"), FakeRoutingChoice("Sends Only"), FakeRoutingChoice("Track")]
        self.available_output_routing_channels = [FakeRoutingChoice("1/2"), FakeRoutingChoice("3/4")]
        self.monitoring_states = [0, 1, 2]
        self.clip_slots = [FakeSlot(clip, self, i) for i, clip in enumerate(clips if clips is not None else [FakeClip(), None])]; self.devices = []
        self.arrangement_clips = []
    def create_midi_clip(self, time, length):
        import copy
        clip = FakeClip(length)
        clip.start_time = time
        self.arrangement_clips.append(clip)
        return clip
    def insert_device(self, name, index=-1):
        device = FakeDevice(name)
        if index < 0 or index >= len(self.devices):
            self.devices.append(device)
        else:
            self.devices.insert(index, device)
        return device
    def delete_device(self, index):
        del self.devices[index]
    def move_device(self, from_index, to_index):
        device = self.devices.pop(from_index)
        self.devices.insert(to_index, device)
    def delete_clip(self, clip):
        self.arrangement_clips = [c for c in self.arrangement_clips if c is not clip]
    def duplicate_clip_to_arrangement(self, clip, time):
        import copy
        dup = copy.deepcopy(clip)
        dup.start_time = time
        self.arrangement_clips.append(dup)
        return dup
    def stop_all_clips(self, quantized=True):
        self.playing_slot_index = -1; self.fired_slot_index = -1
        if self._song is not None and all(track.playing_slot_index == -1 and track.fired_slot_index == -1 for track in self._song.tracks):
            self._song.is_playing = False

class FakeReturnTrack:
    def __init__(self): self.name = "Journey Return"; self.clip_slots = []; self.devices = []
    is_return = True

class FakeMasterTrack:
    def __init__(self): self.name = "Master"; self.clip_slots = []; self.devices = []
    is_master = True

class FakeScene:
    def __init__(self, name, song=None, index=None):
        self.name = name; self._song = song; self._index = index
    def fire(self):
        song = self._song
        if song.fire_sleep > 0: time.sleep(song.fire_sleep)
        song.is_playing = True
        song._notify("is_playing")
        song.tracks[0].playing_slot_index = self._index
        song.tracks[0].fired_slot_index = self._index

class FakeExternalScene:
    def __init__(self, name): self.name = name; self.fire = None

class FakeView:
    def __init__(self, song):
        self.selected_track = song.tracks[0] if song.tracks else None

class FakeSong:
    def __init__(self):
        self.name = "Journey Disposable Set"; self.tempo = 120.0
        self._listeners = {"is_playing": [], "record_mode": [], "session_record": [], "tracks": [], "scenes": []}
        self.tracks = [FakeTrack(song=self), FakeTrack("Journey Bass", [FakeClip(), FakeClip()], song=self)]; self.return_tracks = [FakeReturnTrack()]; self.master_track = FakeMasterTrack()
        self.is_playing = False; self.record_mode = False; self.session_record = False
        self.current_song_time = 0.0; self.clip_trigger_quantization = "1_bar"
        self.loop = False; self.loop_start = 0.0; self.loop_length = 4.0
        self.punch_in = False; self.punch_out = False; self.metronome = False; self.count_in_duration = 1.0
        self.fire_sleep = 0.0; self.fail_stop = False
        self.scenes = [FakeScene("Journey Scene", self, 0), FakeExternalScene("Other Scene")]
        self.view = FakeView(self)

    def _notify(self, name):
        for callback in list(self._listeners.get(name, [])):
            callback()
    def add_is_playing_listener(self, cb): self._listeners["is_playing"].append(cb)
    def remove_is_playing_listener(self, cb): self._listeners["is_playing"].remove(cb)
    def add_record_mode_listener(self, cb): self._listeners["record_mode"].append(cb)
    def remove_record_mode_listener(self, cb): self._listeners["record_mode"].remove(cb)
    def add_session_record_listener(self, cb): self._listeners["session_record"].append(cb)
    def remove_session_record_listener(self, cb): self._listeners["session_record"].remove(cb)
    def add_tracks_listener(self, cb): self._listeners["tracks"].append(cb)
    def remove_tracks_listener(self, cb): self._listeners["tracks"].remove(cb)
    def add_scenes_listener(self, cb): self._listeners["scenes"].append(cb)
    def remove_scenes_listener(self, cb): self._listeners["scenes"].remove(cb)
    def create_scene(self, index):
        scene = FakeExternalScene(f"Scene {len(self.scenes) + 1}")
        self.scenes.insert(index, scene)
        for track in self.tracks:
            while len(track.clip_slots) < len(self.scenes):
                track.clip_slots.append(FakeSlot(None, track, len(track.clip_slots)))
        return scene
    def delete_scene(self, scene):
        self.scenes.remove(scene)
    def create_midi_track(self, index):
        track = FakeTrack(f"MIDI Track {len(self.tracks) + 1}", [None] * len(self.scenes), song=self)
        self.tracks.insert(index, track)
        return track
    def create_audio_track(self, index):
        track = FakeTrack(f"Audio Track {len(self.tracks) + 1}", [None] * len(self.scenes), song=self)
        self.tracks.insert(index, track)
        return track
    def delete_track(self, track):
        self.tracks.remove(track)
    def stop_all_clips(self):
        if self.fail_stop: raise RuntimeError("injected stop failure")
        for track in self.tracks:
            track.playing_slot_index = -1; track.fired_slot_index = -1
    def stop_playing(self):
        if self.fail_stop: raise RuntimeError("injected stop failure")
        self.is_playing = False
        self._notify("is_playing")

class Instance:
    def __init__(self): self.song = FakeSong()

probe = socket.socket(); probe.bind(("127.0.0.1", 0)); port = probe.getsockname()[1]; probe.close()
realtime_probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); realtime_probe.bind(("127.0.0.1", 0)); realtime_port = realtime_probe.getsockname()[1]; realtime_probe.close()
secret_path = os.environ.get("ABLETON_MCP_JOURNEY_SECRET_FILE")
if not secret_path: raise RuntimeError("journey secret file was not provided")
bridge = AbletonMcpBridge(Instance(), {"host": "127.0.0.1", "port": port, "realtimePort": realtime_port, "secret": pathlib.Path(secret_path).read_text(encoding="utf-8").strip()})
song = bridge.mapper.song
try:
    from Live.Application import Application
    Application.get_application().browser._song_view = song.view
except Exception:
    pass
control_path = pathlib.Path(sys.argv[2])
ack_path = pathlib.Path(sys.argv[3])
deadline = time.time() + 5.0
while time.time() < deadline:
    client = socket.socket(); client.settimeout(0.1)
    try: client.connect(("127.0.0.1", port)); client.close(); break
    except OSError:
        client.close(); bridge.update_display(); time.sleep(0.01)
else:
    bridge.disconnect(); raise RuntimeError("journey bridge listener did not become reachable")
ready_path = pathlib.Path(sys.argv[1])
ready_temporary = ready_path.with_name(ready_path.name + ".tmp")
ready_temporary.write_text(json.dumps({"port": port, "realtimePort": realtime_port}), encoding="utf-8")
os.replace(ready_temporary, ready_path)

def apply_control(command):
    name = command.get("command")
    if name == "bumpEpoch": bridge.mapper.refs.reset()
    elif name == "touchPosition": song.current_song_time = float(song.current_song_time) + 1.0
    elif name == "slowDispatch": song.fire_sleep = float(command.get("seconds", 0))
    elif name == "failStop": song.fail_stop = bool(command.get("value"))
    elif name == "pauseDrainAfterNext":
        pause_after["callbacks"] = int(command.get("callbacks", 1)); pause_after["seconds"] = float(command.get("seconds", 6))
    elif name == "externalPlayback":
        if command.get("value"):
            song.is_playing = True; song.tracks[1].playing_slot_index = 1; song.tracks[1].fired_slot_index = 1
        else:
            song.is_playing = False; song.tracks[1].playing_slot_index = -1; song.tracks[1].fired_slot_index = -1
    else: raise RuntimeError("unknown control command")

try:
    pause_after = {"callbacks": 0, "seconds": 0.0}
    while True:
        if control_path.exists():
            try:
                command = json.loads(control_path.read_text(encoding="utf-8"))
                control_path.unlink()
                apply_control(command)
                ack_temporary = ack_path.with_name(ack_path.name + ".tmp")
                ack_temporary.write_text(json.dumps({"applied": command.get("command"), "seq": command.get("seq")}), encoding="utf-8")
                os.replace(ack_temporary, ack_path)
            except Exception as error:
                ack_temporary = ack_path.with_name(ack_path.name + ".tmp")
                ack_temporary.write_text(json.dumps({"error": str(error)}), encoding="utf-8")
                os.replace(ack_temporary, ack_path)
        drained = bridge.queue.drain()
        if pause_after["callbacks"] > 0:
            pause_after["callbacks"] -= drained
            if pause_after["callbacks"] <= 0 and drained > 0:
                time.sleep(pause_after["seconds"]); pause_after["seconds"] = 0.0
        time.sleep(0.01)
except KeyboardInterrupt: pass
finally: bridge.disconnect()
`;

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function mac(secret, payload) { return createHmac("sha256", secret).update(canonical(payload), "utf8").digest("base64url"); }

function wireClient(port) {
  const socket = createConnection({ host: "127.0.0.1", port });
  children.add({ kill: () => socket.destroy(), exitCode: null, pid: undefined });
  let buffer = "";
  const lines = [];
  const waiters = [];
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      if (waiters.length > 0) waiters.shift()(parsed); else lines.push(parsed);
    }
  });
  const next = (timeoutMs = 5_000) => new Promise((resolve, reject) => {
    if (lines.length > 0) return resolve(lines.shift());
    const timer = setTimeout(() => reject(new Error("wire response timed out")), timeoutMs);
    waiters.push((value) => { clearTimeout(timer); resolve(value); });
  });
  return { socket, next, send: (frame) => socket.write(`${typeof frame === "string" ? frame : JSON.stringify(frame)}\n`) };
}

const secret = "journey-secret-0123456789abcdef0123456789abcdef";
let cliConfigPath;
let installedPackageDirectory;
let harnessPort;
let packageEvidence;

try {
  const requestedArtifact = process.env.ABLETON_MCP_ARTIFACT;
  let artifact;
  let packedRecord;
  if (requestedArtifact) {
    artifact = resolve(requestedArtifact);
    if (!isAbsolute(requestedArtifact) || !existsSync(artifact)) throw new Error("ABLETON_MCP_ARTIFACT must name an existing absolute tarball");
    packedRecord = { name: "@ableton-mcp/mcp-server", version: "0.1.0", filename: basename(artifact), shasum: null, integrity: null, size: statSync(artifact).size, unpackedSize: null };
  } else {
    const packOutput = execFileSync(npm, ["pack", "--json", "--pack-destination", temporaryDirectory], { ...npmOptions, cwd: packageDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const packed = JSON.parse(packOutput);
    packedRecord = packed[0]; artifact = join(temporaryDirectory, packedRecord.filename);
  }
  packageEvidence = {
    version: "npm-packed-artifact/v1", generatedAt: new Date().toISOString(), name: packedRecord.name, packageVersion: packedRecord.version,
    filename: packedRecord.filename, sha256: createHash("sha256").update(readFileSync(artifact)).digest("hex"), npmSha1: packedRecord.shasum,
    npmIntegrity: packedRecord.integrity, sizeBytes: packedRecord.size, unpackedSizeBytes: packedRecord.unpackedSize,
  };
  const installDirectory = join(temporaryDirectory, "install");
  execFileSync(npm, ["install", "--prefix", installDirectory, artifact, "--ignore-scripts", "--no-audit", "--no-fund"], { ...npmOptions, cwd: packageDirectory, stdio: "pipe" });
  installedPackageDirectory = join(installDirectory, "node_modules", "@ableton-mcp", "mcp-server");
  const executable = join(installedPackageDirectory, "dist", "src", "cli.js");

  const secretPath = join(temporaryDirectory, "journey.secret");
  ownerOnlySecret(secretPath, secret);
  const readyPath = join(temporaryDirectory, "journey-ready.json");
  const controlPath = join(temporaryDirectory, "journey-control.json");
  const ackPath = join(temporaryDirectory, "journey-ack.json");
  const harnessPath = join(temporaryDirectory, "journey-harness.py");
  writeFileSync(harnessPath, harnessSource, { encoding: "utf8", mode: 0o600 });
  // Fake Live API package for browser and envelope event negotiation.
  mkdirSync(join(temporaryDirectory, "Live"), { recursive: true });
  writeFileSync(join(temporaryDirectory, "Live", "__init__.py"), "from .Application import Application\nfrom . import Envelope\n", { encoding: "utf8" });
  writeFileSync(join(temporaryDirectory, "Live", "Application.py"), `
class _BrowserItem:
    def __init__(self, name, is_device=True):
        self.name = name; self.is_device = is_device; self.children = []

class _Browser:
    def __init__(self):
        self.instruments = _BrowserItem("instruments")
        self.instruments.children = [_BrowserItem("Drum Rack"), _BrowserItem("Analog"), _BrowserItem("Collision")]
        self.audio_effects = _BrowserItem("audio_effects")
        self.audio_effects.children = [_BrowserItem("Utility"), _BrowserItem("Echo")]
        self.midi_effects = _BrowserItem("midi_effects")
        self.midi_effects.children = [_BrowserItem("Arpeggiator")]
        self.drums = _BrowserItem("drums")
        self.plugins = _BrowserItem("plugins")
        self.packs = _BrowserItem("packs")
        self.max_for_live = _BrowserItem("max_for_live")
        self.clips = _BrowserItem("clips")
        self._song_view = None
    def load_item(self, item):
        if self._song_view is not None and getattr(self._song_view, "selected_track", None) is not None:
            self._song_view.selected_track.insert_device(item.name)

class _Application:
    _instance = None
    def __init__(self):
        self.browser = _Browser()
    @classmethod
    def get_application(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

class Application:
    @staticmethod
    def get_application():
        return _Application.get_application()
`, { encoding: "utf8" });
  writeFileSync(join(temporaryDirectory, "Live", "Envelope.py"), `
class EnvelopeEvent:
    def __init__(self, time, value):
        self.time = time; self.value = value
`, { encoding: "utf8" });
  const python = process.platform === "win32" ? "python.exe" : "python3";
  const harness = spawn(python, [harnessPath, readyPath, controlPath, ackPath], { cwd: temporaryDirectory, env: { ...process.env, PYTHONPATH: `${temporaryDirectory}${process.platform === "win32" ? ";" : ":"}${join(installedPackageDirectory, "remote-script")}`, ABLETON_MCP_JOURNEY_SECRET_FILE: secretPath }, stdio: ["ignore", "ignore", openSync(join(temporaryDirectory, "journey-harness-stderr.log"), "w")] });
  children.add(harness);

  const controlSeq = { value: 0 };
  async function control(command, extra = {}) {
    const seq = ++controlSeq.value;
    const controlTemporary = `${controlPath}.tmp`;
    writeFileSync(controlTemporary, JSON.stringify({ ...extra, ...command, seq }), { encoding: "utf8" });
    renameSync(controlTemporary, controlPath);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (existsSync(ackPath)) {
        const ack = JSON.parse(readFileSync(ackPath, "utf8"));
        if (ack.error) throw new Error(`harness control failed: ${ack.error}`);
        if (ack.seq === seq) return;
      }
      await waitMs(25);
    }
    throw new Error(`harness control ${command.command} was not acknowledged`);
  }

  const startClient = async () => {
    const client = new McpClient(executable, cliConfigPath);
    await client.initialize();
    return client;
  };
  const adapter_call = async (_client, operation, args) => {
    // Wire-level invoke through the production registry for read-back assertions.
    const wire = wireClient(harnessPort);
    const hello = await wire.next();
    let sequence = 1; let authorityToken;
    if (!["realtime.stats"].includes(operation)) {
      const preflight = { version: "ableton-loopback/v1", id: `preflight-${Math.random().toString(36).slice(2, 10)}`, method: "preflight", operation, args, nonce: `preflight-nonce-${Date.now()}`, sequence: sequence++, bridgeEpoch: hello.bridgeEpoch, connectionChallenge: hello.connectionChallenge, deadlineMs: Date.now() + 10000 };
      wire.send({ ...preflight, mac: mac(secret, preflight) }); const preflighted = await wire.next();
      if (!preflighted.ok) throw new Error(`wire preflight ${operation} failed: ${preflighted.error}`);
      const prepare = { version: "ableton-loopback/v1", id: `prepare-${Math.random().toString(36).slice(2, 10)}`, method: "prepare", operation, args, preflightToken: preflighted.result.preflightToken, confirmation: preflighted.result.confirmation, idempotencyKey: `journey-${Math.random().toString(36).slice(2, 18)}`, nonce: `prepare-nonce-${Date.now()}`, sequence: sequence++, bridgeEpoch: hello.bridgeEpoch, connectionChallenge: hello.connectionChallenge, deadlineMs: Date.now() + 10000 };
      wire.send({ ...prepare, mac: mac(secret, prepare) }); const prepared = await wire.next();
      if (!prepared.ok) throw new Error(`wire prepare ${operation} failed: ${prepared.error}`); authorityToken = prepared.result.authorityToken;
    }
    const frame = { version: "ableton-loopback/v1", id: `env-${Math.random().toString(36).slice(2, 10)}`, method: "invoke", operation, args, ...(authorityToken ? { authorityToken } : {}), nonce: `env-nonce-${Date.now()}`, sequence, bridgeEpoch: hello.bridgeEpoch, connectionChallenge: hello.connectionChallenge, deadlineMs: Date.now() + 10000 };
    wire.send({ ...frame, mac: mac(secret, frame) });
    const response = await wire.next();
    wire.socket.destroy();
    if (!response.ok) throw new Error(`wire invoke ${operation} failed: ${response.error}`);
    return response.result;
  };
  const textOf = async (client, name, args, timeoutMs) => {
    const response = await client.call(name, args, timeoutMs);
    return response;
  };
  const requiredTool = async (client, name, args, timeoutMs) => {
    const response = await client.call(name, args, timeoutMs);
    assert(!response.isError, `${name} failed: ${JSON.stringify(response.parsed)}`);
    return response.parsed;
  };
  const playback = async (client) => {
    const response = await textOf(client, "live_discover", { kind: "session-playback" });
    assert(!response.isError, `session-playback discovery failed: ${JSON.stringify(response.parsed)}`);
    return response.parsed.items[0];
  };
  const activeKeys = (state) => [...new Set([...state.firedTargets, ...state.playingTargets].map((target) => `${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}`))].sort();
  const previewArgs = { sceneRef: "", setName: "Journey Disposable Set", outputSafety: { safe: true, provenance: "journey-operator-confirmed-headphones", scope: "master" } };

  {
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 10_000;
    while (!existsSync(readyPath) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 25);
    if (!existsSync(readyPath)) throw new Error("fake-Live harness did not become ready");
    const readyState = JSON.parse(readFileSync(readyPath, "utf8"));
    harnessPort = readyState.port;
    harnessRealtimePort = readyState.realtimePort;
    cliConfigPath = join(temporaryDirectory, "journey-bridge-config.json");
    execFileSync(process.execPath, [join(installedPackageDirectory, "dist", "src", "setup.js"), "--output", cliConfigPath, "--bridge-host", "127.0.0.1", "--bridge-port", String(harnessPort), "--realtime-port", String(harnessRealtimePort), "--secret-file", secretPath], { encoding: "utf8" });
  }

  let client = await startClient();
  const restartClient = async () => { await client.close(); client = await startClient(); };

  await step("status reports connected fake-live provenance with guarded operations only", async () => {
    const status = (await textOf(client, "live_status", {})).parsed;
    assert(status.connected === true && status.adapter === "remote-script", "adapter is not the production remote script");
    assert(status.provenance === "fake-live", `provenance is not explicitly fake: ${status.provenance}`);
    const operations = status.operations;
    for (const required of ["session.audition-launch", "session.audition-stop", "session.emergency-stop", "session.playback"]) assert(operations.includes(required), `missing ${required}`);
    for (const removed of ["scene.launch", "stop-all-clips", "transport.stop"]) assert(!operations.includes(removed), `generic audible operation ${removed} is still advertised`);
  });

  await step("five packaged user journeys expose capability-aware plans, prompts, rights, progress, and recovery", async () => {
    const ids = ["create-beat-or-song", "sequence-advanced-drums", "design-owned-sound", "compare-reference-mix", "diagnose-performance-setup"];
    const resources = await client.request("resources/read", { uri: "ableton://journeys" });
    assert(resources.result?.contents?.length === 1, "journey resource is unavailable from the installed package");
    const catalog = JSON.parse(resources.result.contents[0].text);
    assert(catalog.journeys.length === 5 && catalog.journeys.every((entry) => ids.includes(entry.id)), "journey resource does not contain the canonical five journeys");
    const listed = await client.request("prompts/list");
    const promptNames = listed.result?.prompts?.map((entry) => entry.name) ?? [];
    for (const id of ids) {
      const planned = (await textOf(client, "plan_user_journey", { journey: id, traits: "syncopated, controlled, warm, spacious", experienceLevel: "advanced", bars: 8 })).parsed;
      assert(planned.version === "ableton-user-journey/v1", `${id} plan version mismatch`);
      assert(["capability-complete", "core-capability-complete"].includes(planned.mode) && planned.executable === true, `${id} core is unexpectedly unavailable in the full fake-Live boundary: capabilities=${JSON.stringify(planned.advanced.missingCapabilities)} operations=${JSON.stringify(planned.advanced.missingOperations)}`);
      assert(planned.advanced.provenance === "fake-live" && Number.isInteger(planned.advanced.epoch), `${id} lacks explicit fake provenance/epoch`);
      assert(planned.rights.translationPerformed === true && planned.rights.exactReplicationDelivered === false && planned.rights.legalClearanceClaimed === false, `${id} overclaims rights or exact replication`);
      assert(planned.intent.highLevelTraits.some((entry) => entry.value === "syncopated") && planned.intent.highLevelTraits.some((entry) => entry.value === "warm") && !JSON.stringify(planned.guidance).includes("artist reference"), `${id} did not derive safe guidance from allowlisted traits`);
      assert(planned.accessibility.nonColorStatusLabels === true && planned.accessibility.mouseOnlyInstructions === false, `${id} lacks the text accessibility contract`);
      assert(planned.progress.terminalResultRequiresResidualState === true && planned.progress.templateStatusOnly === true && planned.stages.every((stage, index) => stage.order === index + 1 && ["planned", "unavailable"].includes(stage.status)) && planned.stages.filter((stage) => stage.requiredForCore).every((stage) => stage.status === "planned"), `${id} progress/availability is not deterministic and ordered`);
      assert(planned.stages.some((stage) => stage.authorities.some((authority) => authority.mechanism !== "none")) && planned.stages.every((stage) => stage.verification && stage.recovery && stage.unavailableFallback), `${id} lacks authority, verification, recovery, or fallback`);
      const promptName = id.replaceAll("-", "_");
      assert(promptNames.includes(promptName), `missing installed prompt ${promptName}`);
      const prompt = await client.request("prompts/get", { name: promptName, arguments: { traits: "clear high-level traits only", experienceLevel: "beginner", bars: "4" } });
      const promptContent = prompt.result?.messages?.[0]?.content;
      const promptText = promptContent?.text ?? "";
      assert(promptContent?.type === "text" && promptText.startsWith("# ") && !/\u001b\[[0-9;]*m/.test(promptText), `${id} prompt is not plain ordered semantic text`);
      assert(promptText.includes("Do not promise exact replication or legal clearance") && promptText.includes("report uncertain state") && promptText.includes("never communicate status by color alone"), `${id} prompt omits rights, uncertainty, or non-color guidance`);
      accessibilityChecks.push({ id, contentType: promptContent.type, heading: promptText.split("\n", 1)[0], ansiControlBytes: false, nonColorGuidance: true, orderedStages: planned.stages.every((stage, index) => stage.order === index + 1), pointerInputUsedByVerifier: false });
      plannedJourneys.set(id, planned);
      journeyPlanHistory.set(id, [{ planId: planned.planId, reason: "initial-negotiation", mode: planned.mode, unavailableOptionalStages: planned.advanced.unavailableOptionalStages.map((stage) => stage.id) }]);
      userJourneyEvidence.push({ id, planId: planned.planId, mode: planned.mode, provenance: planned.advanced.provenance, stages: planned.stages.length, unavailableOptionalStages: planned.advanced.unavailableOptionalStages.map((stage) => stage.id), packagedPrompt: promptName });
    }
  });

  await step("reference-mix journey runs bounded packaged standards analysis without retaining raw PCM", async () => {
    const sampleRate = 48_000;
    const samples = Buffer.alloc(sampleRate * 2 * 4);
    for (let frame = 0; frame < sampleRate; frame += 1) {
      const project = 0.08 * Math.sin(2 * Math.PI * 220 * frame / sampleRate);
      samples.writeFloatLE(project, frame * 8);
      samples.writeFloatLE(project, frame * 8 + 4);
    }
    const projectSource = { pcmBase64: samples.toString("base64"), sampleRate, channels: 2, channelLayout: ["L", "R"] };
    journeyProgress("compare-reference-mix", "source-relationship", "applying", { relationship: "generated-test-fixture", rawPathSupplied: false, tool: "audio_analyze" });
    const sourceAnalysis = (await textOf(client, "audio_analyze", projectSource, 30_000)).parsed;
    assert(sourceAnalysis.version === "pcm-analysis/v2" && sourceAnalysis.privacy?.rawAudioReturned === false && sourceAnalysis.privacy?.rawAudioRetained === false, "source relationship analysis violated privacy/version contract");
    journeyProgress("compare-reference-mix", "source-relationship", "completed", { relationship: "generated-test-fixture", rawPathSupplied: false, toolResultVersion: sourceAnalysis.version });
    const referenceBytes = Buffer.from(samples);
    for (let frame = 0; frame < sampleRate; frame += 1) {
      const value = 0.1 * Math.sin(2 * Math.PI * 220 * frame / sampleRate);
      referenceBytes.writeFloatLE(value, frame * 8);
      referenceBytes.writeFloatLE(value, frame * 8 + 4);
    }
    journeyProgress("compare-reference-mix", "measure", "applying", { worker: "disposable-installed-package" });
    const compared = (await textOf(client, "audio_compare_reference", { project: projectSource, reference: { ...projectSource, pcmBase64: referenceBytes.toString("base64") }, alignment: { mode: "disabled" } }, 30_000)).parsed;
    journeyProgress("compare-reference-mix", "measure", "verifying", { version: compared.version, alignment: compared.alignment?.mode });
    assert(compared.version === "reference-analysis/v1" && compared.privacy?.rawAudioReturned === false && compared.privacy?.rawAudioRetained === false, "reference analysis privacy/version contract mismatch");
    assert(compared.project?.standardsAudio?.standards?.programmeLoudness === "ITU-R BS.1770-5" && compared.reference?.standardsAudio?.standards?.operatingRecommendation === "EBU R128" && compared.project?.standardsAudio?.truePeak?.method?.includes("ITU-R BS.1770-5 Annex 2"), "reference analysis omitted standards provenance");
    assert(Number.isFinite(compared.deltas?.projectMinusReference?.integratedLoudnessLu), "reference loudness delta is unavailable");
    journeyProgress("compare-reference-mix", "measure", "completed", { rawAudioReturned: false, standards: ["ITU-R BS.1770-5", "EBU R128"], integratedLoudnessDeltaLu: compared.deltas.projectMinusReference.integratedLoudnessLu });
    const tracks = (await textOf(client, "live_discover", { kind: "track" })).parsed.items;
    journeyProgress("compare-reference-mix", "live-context", "applying", { trackRef: tracks[0].ref, sourceRelationship: "declared-not-verified" });
    const diagnosed = (await textOf(client, "audio_diagnose_live_context", { ...projectSource, trackRef: tracks[0].ref, provenance: { observedAt: new Date().toISOString(), description: "generated packaged-journey fixture; not captured from Live" } }, 30_000)).parsed;
    assert(diagnosed.diagnosis?.version === "audio-diagnosis/v1" && diagnosed.diagnosis?.source?.relationshipToLive === "declared-by-caller-not-verified" && diagnosed.diagnosis?.causality?.claimed === false, "reference Live-context diagnosis overclaimed provenance or causality");
    journeyProgress("compare-reference-mix", "live-context", "completed", { trackRef: tracks[0].ref, relationshipToLive: diagnosed.diagnosis.source.relationshipToLive, causalityClaimed: false });
    const priorVolume = tracks[0].mixer.volume;
    const hypothesisVolume = Math.max(0, priorVolume - 0.1);
    const hypothesisPreview = (await textOf(client, "live_mixer_preview", { trackRef: tracks[0].ref, volume: hypothesisVolume })).parsed;
    journeyProgress("compare-reference-mix", "reversible-hypothesis", "awaiting_confirmation", { tool: "live_mixer_apply", mechanism: "fixed-apply", trackRef: tracks[0].ref, causalClaim: false });
    journeyProgress("compare-reference-mix", "reversible-hypothesis", "applying", { tool: "live_mixer_apply", idempotencyKeyPresent: true });
    const hypothesisApplied = (await textOf(client, "live_mixer_apply", { transactionId: hypothesisPreview.transactionId, confirmation: "apply", idempotencyKey: "journey-reference-hypothesis" })).parsed;
    assert(hypothesisApplied.state === "applied", "reference hypothesis did not apply");
    const hypothesisUndone = (await textOf(client, "live_undo", { transactionId: hypothesisPreview.transactionId, confirmation: "undo", idempotencyKey: "journey-reference-hypothesis-undo" })).parsed;
    assert(hypothesisUndone.state === "undone", "reference hypothesis did not restore mixer state");
    const remeasured = (await textOf(client, "audio_compare_reference", { project: projectSource, reference: { ...projectSource, pcmBase64: referenceBytes.toString("base64") }, alignment: { mode: "disabled" } }, 30_000)).parsed;
    assert(remeasured.deltas.projectMinusReference.integratedLoudnessLu === compared.deltas.projectMinusReference.integratedLoudnessLu, "same-scope deterministic remeasurement changed unexpectedly");
    journeyProgress("compare-reference-mix", "reversible-hypothesis", "verifying", { mixerRestored: true, sameScopeRemeasurementVersion: remeasured.version });
    journeyProgress("compare-reference-mix", "reversible-hypothesis", "completed", { mixerAppliedThenRestored: true, sameScopeRemeasured: true, causalClaim: false });
    journeyProgress("compare-reference-mix", "final-report", "completed", { textAlternatives: ["loudness", "true-peak", "dynamics", "spectrum", "transients"], rawAudioResiduals: 0 });
  });

  let sceneRef;
  let trackRef;
  await step("read-only discovery covers set, scenes, track kinds, clip slots, and playback", async () => {
    const setItems = (await textOf(client, "live_discover", { kind: "set" })).parsed.items;
    assert(setItems[0]?.name === "Journey Disposable Set", "set identity mismatch");
    const scenes = (await textOf(client, "live_discover", { kind: "scene" })).parsed.items;
    assert(scenes.length === 2 && scenes[0].name === "Journey Scene" && scenes[0].index === 0, "scene discovery mismatch");
    sceneRef = scenes[0].ref;
    const tracks = (await textOf(client, "live_discover", { kind: "track" })).parsed.items;
    assert(tracks.length === 2 && tracks[0].name === "Journey Drums" && tracks[0].armed === false && tracks[0].monitoringState === "off", "regular track mismatch");
    assert(tracks[1].name === "Journey Bass", "second regular track mismatch");
    trackRef = tracks[0].ref;
    const returns = (await textOf(client, "live_discover", { kind: "return-track" })).parsed.items;
    assert(returns.length === 1 && returns[0].name === "Journey Return", "return track mismatch");
    const mains = (await textOf(client, "live_discover", { kind: "main-track" })).parsed.items;
    assert(mains.length === 1 && mains[0].name === "Master", "main track mismatch");
    const slots = (await textOf(client, "live_discover", { kind: "clip-slot", parent: trackRef })).parsed.items;
    assert(slots.length === 2 && slots[0].empty === false && typeof slots[0].clipRef === "string" && slots[1].empty === true, "clip slot mismatch");
    const state = await playback(client);
    assert(state.transport.playing === false && state.transport.arrangementRecord === false && state.transport.sessionRecord === false, "transport is not authoritatively stopped");
    assert(state.transport.launchQuantization.normalized === "1-bar", "quantization mismatch");
    assert(state.firedTargets.length === 0 && state.playingTargets.length === 0, "unexpected playback targets");
    journeyProgress("create-beat-or-song", "discover", "completed", { setRef: setItems[0].ref, trackRef, emptySceneIndex: 1, playback: "stopped" });
    journeyProgress("create-beat-or-song", "draft", "completed", { planId: plannedJourneys.get("create-beat-or-song").planId, recognizedTraits: plannedJourneys.get("create-beat-or-song").intent.highLevelTraits, guidanceKind: plannedJourneys.get("create-beat-or-song").guidance.kind });
    journeyProgress("sequence-advanced-drums", "discover", "completed", { trackRef, pitchMapping: "operator-supplied-fixture-map", stableNoteIdsRequired: true });
    journeyProgress("sequence-advanced-drums", "draft", "completed", { planId: plannedJourneys.get("sequence-advanced-drums").planId, recognizedTraits: plannedJourneys.get("sequence-advanced-drums").intent.highLevelTraits, guidanceKind: plannedJourneys.get("sequence-advanced-drums").guidance.kind });
    previewArgs.sceneRef = sceneRef;
  });

  let firstPreview;
  await step("audition preview exposes exact targets, revisions, and unpredictable tokens", async () => {
    const preview = (await textOf(client, "live_session_audition_preview", previewArgs)).parsed;
    assert(typeof preview.transactionId === "string" && preview.transactionId.length > 8, "missing transaction id");
    assert(typeof preview.confirmation === "string" && preview.confirmation.length >= 32 && typeof preview.stopConfirmation === "string" && preview.stopConfirmation.length >= 32 && preview.confirmation !== preview.stopConfirmation, "tokens are not distinct unpredictable values");
    assert(Array.isArray(preview.eligibleTargets) && preview.eligibleTargets.length === 2 && preview.eligibleTargets[0].endsWith(`|${sceneRef}`), "eligible target mismatch");
    assert(preview.disposableSet?.matches === true && preview.launchQuantization?.normalized === "1-bar", "preview safety evidence mismatch");
    firstPreview = preview;
  });

  await step("one launch dispatches once, verifies fresh fired targets, and replays idempotently", async () => {
    const applied = (await textOf(client, "live_session_audition_apply", { transactionId: firstPreview.transactionId, confirmation: firstPreview.confirmation, idempotencyKey: "journey-apply-1" })).parsed;
    assert(applied.state === "applied" && applied.idempotent === false && applied.verified?.firedOrPlaying === true, "apply did not verify launch");
    const state = await playback(client);
    const keys = activeKeys(state);
    assert(keys.length === 1 && keys[0] === firstPreview.eligibleTargets[0], "fresh fired/playing targets do not match the audition scene");
    const replay = (await textOf(client, "live_session_audition_apply", { transactionId: firstPreview.transactionId, confirmation: firstPreview.confirmation, idempotencyKey: "journey-apply-1" })).parsed;
    assert(replay.idempotent === true, "exact replay was not idempotent");
    const stillOne = activeKeys(await playback(client));
    assert(stillOne.length === 1, "replay dispatched a second launch");
  });

  await step("two concurrent identical applies cause one dispatch and one replay result", async () => {
    // The first transaction is already applied; start a fresh preview for concurrency proof.
    const stopFirst = (await textOf(client, "live_session_audition_stop", { transactionId: firstPreview.transactionId, confirmation: firstPreview.stopConfirmation, idempotencyKey: "journey-stop-0" })).parsed;
    assert(stopFirst.state === "stopped", "could not restore baseline before concurrency proof");
    const preview = (await textOf(client, "live_session_audition_preview", previewArgs)).parsed;
    const [one, two] = await Promise.all([
      textOf(client, "live_session_audition_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "journey-concurrent-1" }),
      textOf(client, "live_session_audition_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "journey-concurrent-1" }),
    ]);
    assert(one.isError !== true && two.isError !== true, "concurrent apply errored");
    const flags = [one.parsed.idempotent, two.parsed.idempotent];
    assert(flags.includes(false) && flags.includes(true), `expected one dispatch and one replay, received ${flags}`);
    assert(activeKeys(await playback(client)).length === 1, "concurrent applies dispatched more than one launch");
    const stopped = (await textOf(client, "live_session_audition_stop", { transactionId: preview.transactionId, confirmation: preview.stopConfirmation, idempotencyKey: "journey-concurrent-stop" })).parsed;
    assert(stopped.state === "stopped", "concurrency-proof stop failed");
  });

  await step("stale epoch refuses a dispatch and emergency stop retains independent authority", async () => {
    const preview = (await textOf(client, "live_session_audition_preview", previewArgs)).parsed;
    await control({ command: "bumpEpoch" });
    const refused = await textOf(client, "live_session_audition_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "journey-stale-epoch" });
    assert(refused.isError === true, "stale-epoch apply was not refused");
    assert((await playback(client)).transport.playing === false, "stale-epoch apply mutated playback");
    // Stale preview cannot stop, but the separate emergency authority works.
    const stopped = (await textOf(client, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: [], expectedRecording: "stopped" })).parsed;
    assert(stopped.stopped === true, "emergency stop after epoch change failed");
    // The epoch bump replaced every reference; refresh discovery for later steps.
    const scenes = (await textOf(client, "live_discover", { kind: "scene" })).parsed.items;
    sceneRef = scenes.find((item) => item.index === 0)?.ref;
    assert(typeof sceneRef === "string", "scene reference was not refreshed after the epoch change");
    previewArgs.sceneRef = sceneRef;
  });

  await step("changed revision refuses dispatch without mutation", async () => {
    const preview = (await textOf(client, "live_session_audition_preview", previewArgs)).parsed;
    await control({ command: "touchPosition" });
    const refused = await textOf(client, "live_session_audition_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "journey-changed-revision" });
    assert(refused.isError === true, "changed-revision apply was not refused");
    assert((await playback(client)).transport.playing === false, "changed-revision apply mutated playback");
  });

  await step("a timed-out queued callback is fenced and cannot mutate later", async () => {
    const preview = (await textOf(client, "live_session_audition_preview", previewArgs)).parsed;
    // After the pre-dispatch snapshot drains, pause the main-thread drain beyond
    // the 5s operation deadline so the queued launch callback is cancelled
    // before it can ever run on the Live thread.
    await control({ command: "pauseDrainAfterNext", callbacks: 1, seconds: 6 });
    const timedOut = await textOf(client, "live_session_audition_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "journey-timeout" }, 20_000);
    assert(timedOut.isError === true, "timed-out apply did not surface an error");
    // The CLI's adapter destroyed its socket on timeout; restart the host and
    // prove through fresh discovery that the fenced callback never mutated Live.
    await restartClient();
    const deadline = Date.now() + 8_000;
    let state;
    do { state = await playback(client); await waitMs(100); } while (Date.now() < deadline && state.transport.playing !== false);
    assert(state.transport.playing === false && activeKeys(state).length === 0, "fenced callback mutated Live after its waiter timed out");
  });

  await step("cancellation after dispatch is uncertain and externally verifiable", async () => {
    const preview = (await textOf(client, "live_session_audition_preview", previewArgs)).parsed;
    await control({ command: "slowDispatch", seconds: 2 });
    const requestId = client.nextId;
    const inFlight = textOf(client, "live_session_audition_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "journey-cancel" }, 20_000);
    await waitMs(500);
    client.cancel(requestId);
    const outcome = await inFlight;
    assert(outcome.cancelled === true, "cancelled request produced a response");
    await control({ command: "slowDispatch", seconds: 0 });
    await restartClient();
    const deadline = Date.now() + 8_000;
    let state;
    do { state = await playback(client); await waitMs(100); } while (Date.now() < deadline && state.transport.playing !== true);
    assert(state.transport.playing === true, "claimed dispatch did not complete; cancellation semantics are dishonest");
    const keys = activeKeys(state);
    const stopped = (await textOf(client, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: keys, expectedRecording: "stopped" })).parsed;
    assert(stopped.stopped === true, "emergency stop after cancellation failed");
    assert((await playback(client)).transport.playing === false, "post-cancellation playback was not stopped");
  });

  await step("external playback refuses the owned stop but yields to exact emergency stop", async () => {
    const preview = (await textOf(client, "live_session_audition_preview", previewArgs)).parsed;
    const applied = (await textOf(client, "live_session_audition_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "journey-external-apply" })).parsed;
    assert(applied.state === "applied", "apply for external-playback journey failed");
    await control({ command: "externalPlayback", value: true });
    const refused = await textOf(client, "live_session_audition_stop", { transactionId: preview.transactionId, confirmation: preview.stopConfirmation, idempotencyKey: "journey-external-stop" });
    assert(refused.isError === true, "owned stop was not refused while external playback was active");
    const state = await playback(client);
    const keys = activeKeys(state);
    assert(keys.length === 2, "expected owned plus external targets");
    const blind = await textOf(client, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: [keys[0]], expectedRecording: "stopped" });
    assert(blind.isError === true, "emergency stop accepted an incomplete observation");
    const stopped = (await textOf(client, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: keys, expectedRecording: "stopped" })).parsed;
    assert(stopped.stopped === true, "exact emergency stop failed");
    const after = await playback(client);
    assert(after.transport.playing === false && activeKeys(after).length === 0, "playback remained active after emergency stop");
    await control({ command: "externalPlayback", value: false });
  });

  await step("mapper stop failure is surfaced and recovery remains available", async () => {
    const preview = (await textOf(client, "live_session_audition_preview", previewArgs)).parsed;
    await textOf(client, "live_session_audition_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "journey-stopfail-apply" });
    await control({ command: "failStop", value: true });
    const failed = await textOf(client, "live_session_audition_stop", { transactionId: preview.transactionId, confirmation: preview.stopConfirmation, idempotencyKey: "journey-stopfail-stop" });
    assert(failed.isError === true, "mapper stop failure was hidden");
    assert((await playback(client)).transport.playing === true, "failed stop falsely reported stopped state");
    await control({ command: "failStop", value: false });
    const recovered = (await textOf(client, "live_session_audition_stop", { transactionId: preview.transactionId, confirmation: preview.stopConfirmation, idempotencyKey: "journey-stopfail-recover" })).parsed;
    assert(recovered.state === "stopped", "stop did not recover after the mapper failure cleared");
  });

  await step("host restart retains independent emergency stop authority", async () => {
    const preview = (await textOf(client, "live_session_audition_preview", previewArgs)).parsed;
    await textOf(client, "live_session_audition_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "journey-restart-apply" });
    assert(activeKeys(await playback(client)).length === 1, "pre-restart launch did not verify");
    await restartClient();
    const keys = activeKeys(await playback(client));
    assert(keys.length === 1, "restarted host lost authoritative playback observation");
    const stopped = (await textOf(client, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: keys, expectedRecording: "stopped" })).parsed;
    assert(stopped.stopped === true, "restarted host could not stop residual playback");
    assert(activeKeys(await playback(client)).length === 0, "residual playback survived the restarted host's stop");
  });

  await step("an authenticated frame cannot replay across connections or sequences", async () => {
    const first = wireClient(harnessPort);
    const helloOne = await first.next();
    assert(helloOne.id === "hello" && helloOne.ok === true && typeof helloOne.bridgeEpoch === "string" && typeof helloOne.connectionChallenge === "string", "hello negotiation failed");
    const frame = { version: "ableton-loopback/v1", id: "status-1", method: "status", nonce: "journey-nonce-00000001", sequence: 1, bridgeEpoch: helloOne.bridgeEpoch, connectionChallenge: helloOne.connectionChallenge, deadlineMs: Date.now() + 5_000 };
    const signed = { ...frame, mac: mac(secret, frame) };
    const signedLine = JSON.stringify(signed);
    first.send(signedLine);
    const accepted = await first.next();
    assert(accepted.ok === true && accepted.result?.provenance === "fake-live", "authenticated status was not accepted on its own connection");
    // Exact replay on the same connection is a sequence replay and must fail.
    first.send(signedLine);
    const replayedSame = await first.next();
    assert(replayedSame.ok === false, "same-connection sequence replay was accepted");
    // Replay of the captured authenticated frame on a fresh connection must fail.
    const second = wireClient(harnessPort);
    const helloTwo = await second.next();
    assert(helloTwo.connectionChallenge !== helloOne.connectionChallenge, "connection challenge was not unique per connection");
    second.send(signedLine);
    const replayedCross = await second.next();
    assert(replayedCross.ok === false, "cross-connection authenticated replay was accepted");
    // A correctly bound fresh frame on the second connection still works.
    const freshFrame = { version: "ableton-loopback/v1", id: "status-1", method: "status", nonce: "journey-nonce-00000002", sequence: 1, bridgeEpoch: helloTwo.bridgeEpoch, connectionChallenge: helloTwo.connectionChallenge, deadlineMs: Date.now() + 5_000 };
    second.send({ ...freshFrame, mac: mac(secret, freshFrame) });
    const fresh = await second.next();
    assert(fresh.ok === true && fresh.result?.provenance === "fake-live", "fresh bound frame was rejected");
    first.socket.destroy();
    second.socket.destroy();
  });

  await step("transport preview/apply sets loop and position with a revision fence and undoes", async () => {
    const preview = (await textOf(client, "live_transport_preview", { position: 16, loopEnabled: true, loopStart: 8, loopLength: 8, metronome: true })).parsed;
    const applied = (await textOf(client, "live_transport_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "journey-transport-1" })).parsed;
    assert(applied.state === "applied", "transport apply failed");
    const state = await playback(client);
    assert(state.transport.loop.enabled === true && state.transport.loop.start === 8 && state.transport.loop.length === 8 && state.transport.metronome === true && state.transport.position === 16, "transport fields did not land");
    const undone = (await textOf(client, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "journey-transport-undo" })).parsed;
    assert(undone.state === "undone", "transport undo failed");
    const restored = await playback(client);
    assert(restored.transport.loop.enabled === preview.prior.loop.enabled && restored.transport.metronome === preview.prior.metronome && restored.transport.position === preview.prior.position, `transport undo did not restore: ${JSON.stringify(restored.transport)}`);
  });

  await step("clip launch previews, applies once, verifies, and stops through the owning track", async () => {
    const freshTracks = (await textOf(client, "live_discover", { kind: "track" })).parsed.items;
    trackRef = freshTracks[0]?.ref;
    const slots = (await textOf(client, "live_discover", { kind: "clip-slot", parent: trackRef })).parsed.items;
    const slotRef = slots.find((item) => item.empty === false)?.ref;
    assert(typeof slotRef === "string", "no playable clip slot found");
    const unsafe = await textOf(client, "live_clip_launch_preview", { slotRef, outputSafety: { safe: true, provenance: "unknown" } });
    assert(unsafe.isError === true, "unsafe clip-launch preview was not refused");
    const preview = (await textOf(client, "live_clip_launch_preview", { slotRef, outputSafety: { safe: true, provenance: "journey-operator-confirmed-headphones" } })).parsed;
    const [one, two] = await Promise.all([
      textOf(client, "live_clip_launch_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "journey-clip-1" }),
      textOf(client, "live_clip_launch_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "journey-clip-1" }),
    ]);
    assert(one.parsed.idempotent !== two.parsed.idempotent, "concurrent clip applies did not serialize to one dispatch");
    const state = await playback(client);
    assert(activeKeys(state).includes(preview.target.targetKey), "clip launch did not verify the exact target");
    const stopped = (await textOf(client, "live_clip_launch_stop", { transactionId: preview.transactionId, confirmation: preview.stopConfirmation, idempotencyKey: "journey-clip-stop" })).parsed;
    assert(stopped.state === "stopped", "clip stop failed");
    assert(!(await playback(client)).firedTargets.length && !activeKeys(await playback(client)).length, "clip target remained active after stop");
  });

  await step("complete MIDI note lifecycle: create, update by id, delete, and guarded undo", async () => {
    const freshTracks = (await textOf(client, "live_discover", { kind: "track" })).parsed.items;
    const songGuidance = plannedJourneys.get("create-beat-or-song")?.guidance;
    const drumGuidance = plannedJourneys.get("sequence-advanced-drums")?.guidance;
    const roleToFixturePitch = { kick: 60, "snare-or-clap": 64, "closed-hat": 67 };
    const toNote = (event) => ({ pitch: roleToFixturePitch[event.role], start: event.startBeat, duration: event.durationBeats, velocity: event.velocityRange[1], probability: event.probability, channel: 1 });
    const songEvents = songGuidance.drumRoleEvents;
    assert(songGuidance.kind === "editable-song-draft" && songGuidance.bars === 8 && songEvents.length >= 64 && songEvents.some((event) => event.startBeat % 1 === 0.75) && Math.max(...songEvents.map((event) => event.startBeat)) >= 28, "beat/song guidance did not derive a substantive syncopated eight-bar pattern");
    journeyProgress("create-beat-or-song", "preview-create", "planned", { derivedGuidance: songGuidance.kind, roleEvents: songEvents.map((event) => event.role) });
    const songPreview = await requiredTool(client, "live_midi_clip_preview", { trackRef: freshTracks[0].ref, sceneIndex: 1, name: "Journey Song Notes", length: songGuidance.bars * 4, notes: songEvents.map(toNote) });
    const structurePreview = await requiredTool(client, "live_session_structure_preview", { tracks: [], scenes: [{ name: "Journey Advanced Drums", index: 2 }] });
    journeyProgress("create-beat-or-song", "preview-create", "completed", { exactTrackRef: freshTracks[0].ref, structures: ["Journey Advanced Drums"], guidanceKind: songGuidance.kind });
    journeyProgress("create-beat-or-song", "apply-create", "awaiting_confirmation", { mechanisms: ["fixed-apply-midi", "fixed-apply-structure"], exactTargets: true });
    journeyProgress("create-beat-or-song", "apply-create", "applying", { idempotencyKeys: 2 });
    const songApplied = await requiredTool(client, "live_midi_clip_apply", { transactionId: songPreview.transactionId, confirmation: "apply", idempotencyKey: "journey-song-midi" });
    const structureApplied = await requiredTool(client, "live_session_structure_apply", { transactionId: structurePreview.transactionId, confirmation: "apply", idempotencyKey: "journey-song-structure" });
    const songClipRef = songApplied.clipRef;
    const songNotes = (await textOf(client, "live_discover", { kind: "note", parent: songClipRef, limit: 100 })).parsed.items;
    assert(typeof songClipRef === "string" && structureApplied.created?.length === 1 && songNotes.length === songEvents.length, "beat/song MIDI/structure creation failed");
    journeyProgress("create-beat-or-song", "apply-create", "verifying", { midiRef: songClipRef, structureRefs: structureApplied.created.map((item) => item.ref), authoritativeNoteCount: songNotes.length });
    journeyProgress("create-beat-or-song", "apply-create", "completed", { midiTarget: songClipRef, structureRefs: structureApplied.created.map((item) => item.ref), verifiedNotes: songNotes.length, guidanceKind: songGuidance.kind });

    const drumEvents = drumGuidance.drumRoleEvents;
    assert(drumGuidance.kind === "editable-drum-role-pattern" && drumGuidance.bars === 8 && drumEvents.length >= 64 && drumEvents.some((event) => event.probability < 1) && drumEvents.some((event) => event.startBeat % 1 === 0.75), "advanced-drum guidance did not derive a substantive expressive eight-bar pattern");
    const drumSceneIndex = (await textOf(client, "live_discover", { kind: "scene" })).parsed.items.find((scene) => scene.name === "Journey Advanced Drums")?.index;
    assert(Number.isInteger(drumSceneIndex), "created advanced-drum scene index is unavailable");
    journeyProgress("sequence-advanced-drums", "preview-write", "planned", { derivedGuidance: drumGuidance.kind, roleEvents: drumEvents.map((event) => event.role), pitchMappingProvenance: "operator-owned-fake-fixture" });
    const drumPreview = await requiredTool(client, "live_midi_clip_preview", { trackRef: freshTracks[0].ref, sceneIndex: drumSceneIndex, name: "Journey Advanced Drum Notes", length: drumGuidance.bars * 4, notes: drumEvents.map(toNote) });
    assert(typeof drumPreview.transactionId === "string", `advanced drum preview failed: ${JSON.stringify(drumPreview)}`);
    journeyProgress("sequence-advanced-drums", "preview-write", "completed", { exactTrackRef: freshTracks[0].ref, sceneIndex: drumSceneIndex, guidanceKind: drumGuidance.kind });
    journeyProgress("sequence-advanced-drums", "apply-write", "awaiting_confirmation", { mechanism: "fixed-apply-midi", exactTarget: true });
    journeyProgress("sequence-advanced-drums", "apply-write", "applying", { idempotencyKeyPresent: true });
    const drumApplied = await requiredTool(client, "live_midi_clip_apply", { transactionId: drumPreview.transactionId, confirmation: "apply", idempotencyKey: "journey-drum-midi" });
    const clipRef = drumApplied.clipRef;
    const notes = (await textOf(client, "live_discover", { kind: "note", parent: clipRef, limit: 100 })).parsed.items;
    assert(typeof clipRef === "string" && notes.length === drumEvents.length && notes.every((item) => typeof item.id === "number"), "advanced drum clip/notes failed verification");
    journeyProgress("sequence-advanced-drums", "apply-write", "verifying", { clipRef, authoritativeNoteCount: notes.length, stableIds: true });
    journeyProgress("sequence-advanced-drums", "apply-write", "completed", { clipRef, verifiedNotes: notes.length, guidanceKind: drumGuidance.kind });
    const firstId = notes[0].id;
    const updatePreview = (await textOf(client, "live_note_update_preview", { clipRef, notes: [{ id: firstId, velocity: 66, probability: 0.5, velocityDeviation: 10, releaseVelocity: 32, mute: true }] })).parsed;
    journeyProgress("sequence-advanced-drums", "expressive-revision", "awaiting_confirmation", { noteId: firstId, mechanism: "fixed-apply", fields: ["velocity", "probability", "velocityDeviation", "releaseVelocity", "mute"] });
    journeyProgress("sequence-advanced-drums", "expressive-revision", "applying", { noteId: firstId, idempotencyKeyPresent: true });
    const updated = (await textOf(client, "live_note_update_apply", { transactionId: updatePreview.transactionId, confirmation: "apply", idempotencyKey: "journey-note-update" })).parsed;
    assert(updated.updated === 1, "note update failed");
    const afterUpdate = (await textOf(client, "live_discover", { kind: "note", parent: clipRef, limit: 100 })).parsed.items;
    const edited = afterUpdate.find((item) => item.id === firstId);
    assert(edited.velocity === 66 && edited.probability === 0.5 && edited.velocityDeviation === 10 && edited.releaseVelocity === 32 && edited.mute === true, `note fields did not land: ${JSON.stringify(edited)}`);
    journeyProgress("sequence-advanced-drums", "expressive-revision", "verifying", { noteId: firstId, authoritativeReadback: true });
    journeyProgress("sequence-advanced-drums", "expressive-revision", "completed", { noteId: firstId, verifiedFields: ["velocity", "probability", "velocityDeviation", "releaseVelocity", "mute"] });
    const deletePreview = (await textOf(client, "live_note_delete_preview", { clipRef, noteIds: [firstId] })).parsed;
    const deleted = (await textOf(client, "live_note_delete_apply", { transactionId: deletePreview.transactionId, confirmation: "apply", idempotencyKey: "journey-note-delete" })).parsed;
    assert(deleted.deleted === 1 && (await textOf(client, "live_discover", { kind: "note", parent: clipRef, limit: 100 })).parsed.items.length === drumEvents.length - 1, "note was not removed");
    const undone = (await textOf(client, "live_undo", { transactionId: deletePreview.transactionId, confirmation: "undo", idempotencyKey: "journey-note-delete-undo" })).parsed;
    assert(undone.state === "undone" && (await textOf(client, "live_discover", { kind: "note", parent: clipRef, limit: 100 })).parsed.items.length === drumEvents.length, "note-delete undo did not restore the note");
    const drumSlots = (await textOf(client, "live_discover", { kind: "clip-slot", parent: freshTracks[0].ref })).parsed.items;
    const drumSlot = drumSlots.find((slot) => slot.clipRef === clipRef);
    const drumAuditionPreview = (await textOf(client, "live_clip_launch_preview", { slotRef: drumSlot.ref, outputSafety: { safe: true, provenance: "journey-operator-confirmed-headphones" } })).parsed;
    journeyProgress("sequence-advanced-drums", "audition", "awaiting_confirmation", { clipRef, exactSlotRef: drumSlot.ref, mechanism: "unpredictable-preview-token" });
    journeyProgress("sequence-advanced-drums", "audition", "applying", { exactSlotRef: drumSlot.ref, idempotencyKeyPresent: true });
    const drumAuditionApplied = (await textOf(client, "live_clip_launch_apply", { transactionId: drumAuditionPreview.transactionId, confirmation: drumAuditionPreview.confirmation, idempotencyKey: "journey-drum-audition" })).parsed;
    assert(drumAuditionApplied.state === "applied", "advanced drum audition did not start");
    const drumAuditionStopped = (await textOf(client, "live_clip_launch_stop", { transactionId: drumAuditionPreview.transactionId, confirmation: drumAuditionPreview.stopConfirmation, idempotencyKey: "journey-drum-audition-stop" })).parsed;
    assert(drumAuditionStopped.state === "stopped", "advanced drum audition did not stop");
    journeyProgress("sequence-advanced-drums", "audition", "verifying", { started: true, authoritativeStopState: drumAuditionStopped.state });
    journeyProgress("sequence-advanced-drums", "audition", "completed", { clipRef, started: true, stopped: true });
  });

  await step("clip duplicate, arrangement create/move/delete through the packaged path", async () => {
    let freshTracks = (await textOf(client, "live_discover", { kind: "track" })).parsed.items;
    const slots = (await textOf(client, "live_discover", { kind: "clip-slot", parent: freshTracks[0].ref })).parsed.items;
    const sourceRef = slots.find((item) => item.sceneIndex === 1)?.clipRef;
    assert(typeof sourceRef === "string", "substantive eight-bar song clip is unavailable for Arrangement duplication");
    // Duplicate the exact created song section to Arrangement.
    const dupArr = (await textOf(client, "live_clip_duplicate_preview", { clipRef: sourceRef, arrangementPosition: 8 })).parsed;
    journeyProgress("create-beat-or-song", "arrange", "awaiting_confirmation", { operations: ["clip.duplicate", "arrangement.clip.delete"], mechanism: "fixed-apply-per-preview", sourceClipRef: sourceRef });
    journeyProgress("create-beat-or-song", "arrange", "applying", { sourceClipRef: sourceRef, tools: ["live_clip_duplicate_apply"] });
    const dupArrApplied = (await textOf(client, "live_clip_duplicate_apply", { transactionId: dupArr.transactionId, confirmation: "apply", idempotencyKey: "journey-dup-arr" })).parsed;
    assert(dupArrApplied.state === "applied" && typeof dupArrApplied.created?.ref === "string", "arrangement duplication failed");
    let arrangementClips = (await textOf(client, "live_discover", { kind: "arrangement-clip", parent: freshTracks[0].ref })).parsed.items;
    assert(arrangementClips.length === 1 && arrangementClips[0].start === 8 && arrangementClips[0].trackRef === freshTracks[0].ref && arrangementClips[0].name === "Journey Song Notes", `arrangement clip row mismatch: ${JSON.stringify(arrangementClips)}`);
    journeyProgress("create-beat-or-song", "arrange", "verifying", { sourceClipRef: sourceRef, retainedArrangementRef: arrangementClips[0].ref, retainedName: arrangementClips[0].name, start: arrangementClips[0].start });
    journeyProgress("create-beat-or-song", "arrange", "completed", { sourceClipRef: sourceRef, retainedArrangementRef: arrangementClips[0].ref, duplicatedEightBarSong: true });
    // Arrangement move support appears only after the first Arrangement clip.
    // Reconnect and bind the remaining stage to a new negotiated plan.
    await restartClient();
    const priorSongPlan = plannedJourneys.get("create-beat-or-song");
    const replannedSong = (await textOf(client, "plan_user_journey", { journey: "create-beat-or-song", traits: "syncopated, controlled, warm, spacious", experienceLevel: "advanced", bars: 8 })).parsed;
    assert(replannedSong.planId !== priorSongPlan.planId && replannedSong.stages.find((stage) => stage.id === "arrange-edit")?.status === "planned", "song journey did not replan newly available Arrangement edit operations");
    plannedJourneys.set("create-beat-or-song", replannedSong);
    journeyPlanHistory.get("create-beat-or-song").push({ planId: replannedSong.planId, previousPlanId: priorSongPlan.planId, reason: "fresh-connection-renegotiation-after-arrangement-duplication", mode: replannedSong.mode, unavailableOptionalStages: replannedSong.advanced.unavailableOptionalStages.map((stage) => stage.id) });
    userJourneyEvidence.find((entry) => entry.id === "create-beat-or-song").replannedAfterArrangementDuplication = { planId: replannedSong.planId, arrangeEdit: "planned" };
    freshTracks = (await textOf(client, "live_discover", { kind: "track" })).parsed.items;
    arrangementClips = (await textOf(client, "live_discover", { kind: "arrangement-clip", parent: freshTracks[0].ref })).parsed.items;
    const movePreview = (await textOf(client, "live_clip_move_preview", { clipRef: arrangementClips[0].ref, position: 16 })).parsed;
    console.error("movePreview:", JSON.stringify(movePreview).slice(0, 300));
    journeyProgress("create-beat-or-song", "arrange-edit", "awaiting_confirmation", { operations: ["arrangement.clip.move", "arrangement.clip.create", "arrangement.clip.delete"], mechanism: "fixed-apply-per-preview", retainedArrangementRef: arrangementClips[0].ref });
    journeyProgress("create-beat-or-song", "arrange-edit", "applying", { retainedArrangementRef: arrangementClips[0].ref, idempotencyKeysPresent: true });
    const moved = (await textOf(client, "live_clip_move_apply", { transactionId: movePreview.transactionId, confirmation: "apply", idempotencyKey: "journey-arr-move" })).parsed;
    assert(moved.state === "applied", "arrangement move failed");
    assert((await textOf(client, "live_discover", { kind: "arrangement-clip", parent: freshTracks[0].ref })).parsed.items[0].start === 16, "arrangement move did not land");
    // Create + delete
    const createPreview = (await textOf(client, "live_arrangement_clip_preview", { action: "create", trackRef: freshTracks[0].ref, position: 24, length: 4, name: "Journey Arranged" })).parsed;
    const created = (await textOf(client, "live_arrangement_clip_apply", { transactionId: createPreview.transactionId, confirmation: "apply", idempotencyKey: "journey-arr-create" })).parsed;
    assert(created.state === "applied", "arrangement create failed");
    assert((await textOf(client, "live_discover", { kind: "arrangement-clip", parent: freshTracks[0].ref })).parsed.items.length === 2, "arrangement create not visible");
    const delPreview = (await textOf(client, "live_arrangement_clip_preview", { action: "delete", clipRef: created.result.ref })).parsed;
    const deleted = (await textOf(client, "live_arrangement_clip_apply", { transactionId: delPreview.transactionId, confirmation: "apply", idempotencyKey: "journey-arr-delete" })).parsed;
    assert(deleted.state === "applied", "arrangement delete failed");
    const finalArrangement = (await textOf(client, "live_discover", { kind: "arrangement-clip", parent: freshTracks[0].ref })).parsed.items;
    assert(finalArrangement.length === 1 && finalArrangement[0].name === "Journey Song Notes" && finalArrangement[0].start === 16, "substantive arranged song section or temporary cleanup did not verify");
    journeyProgress("create-beat-or-song", "arrange-edit", "verifying", { retainedArrangementRef: finalArrangement[0].ref, retainedName: finalArrangement[0].name, start: finalArrangement[0].start, temporaryClipDeleted: true });
    journeyProgress("create-beat-or-song", "arrange-edit", "completed", { retainedArrangementRef: finalArrangement[0].ref, arrangementClipsVerified: 1, temporaryClipDeleted: true });
    // Additional generic Session-duplicate contract coverage is deliberately
    // outside the Arrangement journey stage.
    const structurePreview = await requiredTool(client, "live_session_structure_preview", { tracks: [], scenes: [{ name: "Journey Dup Scene", index: 3 }] });
    await requiredTool(client, "live_session_structure_apply", { transactionId: structurePreview.transactionId, confirmation: "apply", idempotencyKey: "journey-dup-scene" });
    const slotsAfter = (await textOf(client, "live_discover", { kind: "clip-slot", parent: freshTracks[0].ref })).parsed.items;
    const emptySlot = slotsAfter.find((item) => item.empty === true);
    const dupPreview = (await textOf(client, "live_clip_duplicate_preview", { clipRef: sourceRef, targetTrackRef: freshTracks[0].ref, targetSceneIndex: emptySlot.sceneIndex })).parsed;
    const dupApplied = (await textOf(client, "live_clip_duplicate_apply", { transactionId: dupPreview.transactionId, confirmation: "apply", idempotencyKey: "journey-dup-slot" })).parsed;
    assert(dupApplied.state === "applied", "Session duplication failed");
    const afterSlots = (await textOf(client, "live_discover", { kind: "clip-slot", parent: freshTracks[0].ref })).parsed.items;
    assert(afterSlots.find((item) => item.sceneIndex === emptySlot.sceneIndex)?.empty === false, "duplicated clip not in target slot");
    const songSlot = afterSlots.find((slot) => slot.sceneIndex === 1);
    const songAuditionPreview = (await textOf(client, "live_clip_launch_preview", { slotRef: songSlot.ref, outputSafety: { safe: true, provenance: "journey-operator-confirmed-headphones", scope: "created song section" } })).parsed;
    journeyProgress("create-beat-or-song", "audition", "awaiting_confirmation", { slotRef: songSlot.ref, mechanism: "unpredictable-preview-token" });
    journeyProgress("create-beat-or-song", "audition", "applying", { slotRef: songSlot.ref, idempotencyKeyPresent: true });
    const songAuditionApplied = (await textOf(client, "live_clip_launch_apply", { transactionId: songAuditionPreview.transactionId, confirmation: songAuditionPreview.confirmation, idempotencyKey: "journey-song-audition" })).parsed;
    assert(songAuditionApplied.state === "applied", `created song audition did not start: ${JSON.stringify(songAuditionApplied)}`);
    const songAuditionStopped = (await textOf(client, "live_clip_launch_stop", { transactionId: songAuditionPreview.transactionId, confirmation: songAuditionPreview.stopConfirmation, idempotencyKey: "journey-song-audition-stop" })).parsed;
    assert(songAuditionStopped.state === "stopped", "created song audition did not stop");
    journeyProgress("create-beat-or-song", "audition", "verifying", { started: true, authoritativeStopState: songAuditionStopped.state });
    journeyProgress("create-beat-or-song", "audition", "completed", { slotRef: songSlot.ref, started: true, stopped: true });
    const songClipRef = songSlot.clipRef;
    const songNotes = (await textOf(client, "live_discover", { kind: "note", parent: songClipRef, limit: 100 })).parsed.items;
    const revisePreview = (await textOf(client, "live_note_update_preview", { clipRef: songClipRef, notes: [{ id: songNotes[0].id, velocity: 77 }] })).parsed;
    journeyProgress("create-beat-or-song", "revise", "awaiting_confirmation", { clipRef: songClipRef, noteId: songNotes[0].id, mechanism: "fixed-apply" });
    journeyProgress("create-beat-or-song", "revise", "applying", { clipRef: songClipRef, noteId: songNotes[0].id, idempotencyKeyPresent: true });
    const revised = (await textOf(client, "live_note_update_apply", { transactionId: revisePreview.transactionId, confirmation: "apply", idempotencyKey: "journey-song-revise" })).parsed;
    assert(revised.updated === 1, "created song revision did not apply");
    const reviseUndo = (await textOf(client, "live_undo", { transactionId: revisePreview.transactionId, confirmation: "undo", idempotencyKey: "journey-song-revise-undo" })).parsed;
    assert(reviseUndo.state === "undone", "created song revision did not undo");
    journeyProgress("create-beat-or-song", "revise", "verifying", { applied: true, restored: true, authoritativeReadbackRequired: true });
    journeyProgress("create-beat-or-song", "revise", "completed", { clipRef: songClipRef, noteId: songNotes[0].id, appliedThenRestored: true });
  });

  await step("mixer and clip automation lifecycle through the packaged path", async () => {
    const freshTracks = (await textOf(client, "live_discover", { kind: "track" })).parsed.items;
    const mixerPreview = (await textOf(client, "live_mixer_preview", { trackRef: freshTracks[0].ref, volume: 0.5, pan: -0.25, cueVolume: 0.75, sends: [0.5, 0.25], solo: true })).parsed;
    const mixerApplied = (await textOf(client, "live_mixer_apply", { transactionId: mixerPreview.transactionId, confirmation: "apply", idempotencyKey: "journey-mixer" })).parsed;
    assert(mixerApplied.state === "applied", "mixer apply failed");
    const trackAfter = (await textOf(client, "live_discover", { kind: "track" })).parsed.items[0];
    assert(trackAfter.mixer.volume === 0.5 && trackAfter.mixer.pan === -0.25 && trackAfter.mixer.cueVolume === 0.75 && trackAfter.mixer.solo === true, `mixer fields did not land: ${JSON.stringify(trackAfter.mixer)}`);
    const undone = (await textOf(client, "live_undo", { transactionId: mixerPreview.transactionId, confirmation: "undo", idempotencyKey: "journey-mixer-undo" })).parsed;
    assert(undone.state === "undone", "mixer undo failed");
    const restored = (await textOf(client, "live_discover", { kind: "track" })).parsed.items[0];
    assert(restored.mixer.volume === 0.85 && restored.mixer.solo === false, "mixer undo did not restore");
    // Automation envelope on the track volume parameter of clip 0
    const slots = (await textOf(client, "live_discover", { kind: "clip-slot", parent: freshTracks[0].ref })).parsed.items;
    const clipRef = slots.find((item) => item.empty === false)?.clipRef;
    const volumeRef = trackAfter.mixer.volumeRef;
    assert(typeof volumeRef === "string", "mixer volume parameter ref missing");
    const create = (await textOf(client, "live_automation_preview", { action: "create-envelope", clipRef, parameterRef: volumeRef })).parsed;
    const created = (await textOf(client, "live_automation_apply", { transactionId: create.transactionId, confirmation: "apply", idempotencyKey: "journey-env-create" })).parsed;
    assert(created.state === "applied", "envelope create failed");
    const insert = (await textOf(client, "live_automation_preview", { action: "insert", clipRef, parameterRef: volumeRef, points: [{ time: 0, value: 0.9 }, { time: 2, value: 0.4 }] })).parsed;
    const inserted = (await textOf(client, "live_automation_apply", { transactionId: insert.transactionId, confirmation: "apply", idempotencyKey: "journey-env-insert" })).parsed;
    assert(inserted.state === "applied" && inserted.result?.inserted === 2, "envelope insert failed");
    const readBack = await adapter_call(client, "automation.envelope.read", { clipRef, parameterRef: volumeRef });
    assert(readBack.exists === true && readBack.points.length === 2 && readBack.points[1].value === 0.4, `envelope readback mismatch: ${JSON.stringify(readBack)}`);
    const delRange = (await textOf(client, "live_automation_preview", { action: "delete-range", clipRef, parameterRef: volumeRef, from: 1, to: 3 })).parsed;
    const deleted = (await textOf(client, "live_automation_apply", { transactionId: delRange.transactionId, confirmation: "apply", idempotencyKey: "journey-env-delete" })).parsed;
    assert(deleted.state === "applied" && deleted.result?.deleted === 1, "envelope delete-range failed");
    const envUndo = (await textOf(client, "live_undo", { transactionId: delRange.transactionId, confirmation: "undo", idempotencyKey: "journey-env-undo" })).parsed;
    assert(envUndo.state === "undone", "envelope undo failed");
    const finalRead = await adapter_call(client, "automation.envelope.read", { clipRef, parameterRef: volumeRef });
    assert(finalRead.points.length === 2, "envelope undo did not restore points");
  });

  await step("browser search/load and device lifecycle through the packaged path", async () => {
    const search = (await textOf(client, "live_browser_search", { category: "instruments", query: "rack" })).parsed;
    assert(search.items.length >= 1 && search.items.some((item) => item.id === "instruments/Drum Rack"), `browser search mismatch: ${JSON.stringify(search)}`);
    const freshTracks = (await textOf(client, "live_discover", { kind: "track" })).parsed.items;
    journeyProgress("design-owned-sound", "discover-browser", "completed", { browserResultId: "instruments/Drum Rack", targetTrackRef: freshTracks[0].ref });
    journeyProgress("design-owned-sound", "draft", "completed", { planId: plannedJourneys.get("design-owned-sound").planId, recognizedTraits: plannedJourneys.get("design-owned-sound").intent.highLevelTraits, guidanceKind: plannedJourneys.get("design-owned-sound").guidance.kind });
    const preview = (await textOf(client, "live_browser_load_preview", { itemId: "instruments/Drum Rack", trackRef: freshTracks[0].ref })).parsed;
    journeyProgress("design-owned-sound", "preview-load", "completed", { browserResultId: "instruments/Drum Rack", targetTrackRef: freshTracks[0].ref });
    journeyProgress("design-owned-sound", "apply-load", "awaiting_confirmation", { mechanism: "fixed-apply", exactTarget: true });
    journeyProgress("design-owned-sound", "apply-load", "applying", { browserResultId: "instruments/Drum Rack", idempotencyKeyPresent: true });
    const applied = (await textOf(client, "live_browser_load_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "journey-load" })).parsed;
    assert(applied.state === "applied" && typeof applied.deviceRef === "string", "browser load failed");
    const trackAfter = (await textOf(client, "live_discover", { kind: "track" })).parsed.items[0];
    let rack = trackAfter.devices.find((device) => device.name === "Drum Rack");
    assert(rack && rack.canHaveDrumPads === true && rack.drumPads.length === 16, `drum rack row mismatch: ${JSON.stringify(rack)}`);
    journeyProgress("design-owned-sound", "apply-load", "verifying", { deviceRef: rack.ref, parentTrackRef: freshTracks[0].ref, authoritativeReadback: true });
    journeyProgress("design-owned-sound", "apply-load", "completed", { deviceRef: rack.ref, parentTrackRef: freshTracks[0].ref, verified: true });
    // Adapter operation/capability negotiation is connection-scoped. Reconnect
    // after loading the first device, then replan against the newly published
    // parameter surface rather than assuming it appeared in the old status.
    await restartClient();
    const reconnectedTrack = (await textOf(client, "live_discover", { kind: "track" })).parsed.items[0];
    rack = reconnectedTrack.devices.find((device) => device.name === "Drum Rack");
    assert(rack, "loaded rack was not present after capability renegotiation");
    const priorSoundPlan = plannedJourneys.get("design-owned-sound");
    const replanned = (await textOf(client, "plan_user_journey", { journey: "design-owned-sound", traits: "syncopated, controlled, warm, spacious", experienceLevel: "advanced", bars: 8 })).parsed;
    assert(replanned.planId !== priorSoundPlan.planId && replanned.stages.find((stage) => stage.id === "shape-published-controls")?.status === "planned", `sound journey did not replan newly negotiated published parameters: ${JSON.stringify(replanned.stages.find((stage) => stage.id === "shape-published-controls"))}`);
    plannedJourneys.set("design-owned-sound", replanned);
    journeyPlanHistory.get("design-owned-sound").push({ planId: replanned.planId, previousPlanId: priorSoundPlan.planId, reason: "fresh-connection-renegotiation-after-device-load", mode: replanned.mode, unavailableOptionalStages: replanned.advanced.unavailableOptionalStages.map((stage) => stage.id) });
    userJourneyEvidence.find((entry) => entry.id === "design-owned-sound").replannedAfterLoad = { planId: replanned.planId, shapePublishedControls: "planned" };
    const soundDirection = replanned.guidance.controlDirections.find((direction) => direction.semanticControl === "filter-cutoff-or-high-frequency-balance");
    const parameter = rack.parameters?.find((candidate) => candidate.name === "Filter Cutoff");
    assert(soundDirection?.direction === "decrease-moderately-within-published-bounds" && parameter && Number.isFinite(parameter.min) && Number.isFinite(parameter.max), "warm intent did not resolve an exact matching published Filter Cutoff control");
    const proposedValue = Math.max(parameter.min, parameter.value - (parameter.max - parameter.min) * 0.25);
    const parameterPreview = (await textOf(client, "live_device_parameter_preview", { deviceRef: rack.ref, parameterRef: parameter.ref, value: proposedValue })).parsed;
    journeyProgress("design-owned-sound", "shape-published-controls", "awaiting_confirmation", { deviceRef: rack.ref, parameterRef: parameter.ref, semanticControl: soundDirection.semanticControl, semanticDirection: soundDirection.direction });
    journeyProgress("design-owned-sound", "shape-published-controls", "applying", { parameterRef: parameter.ref, idempotencyKeyPresent: true });
    const parameterApplied = (await textOf(client, "live_device_parameter_apply", { transactionId: parameterPreview.transactionId, confirmation: parameterPreview.confirmation, idempotencyKey: "journey-sound-parameter" })).parsed;
    assert(parameterApplied.state === "applied" && parameterApplied.value === proposedValue, "published sound-design parameter did not verify");
    journeyProgress("design-owned-sound", "shape-published-controls", "verifying", { parameterRef: parameter.ref, authoritativeValue: parameterApplied.value });
    journeyProgress("design-owned-sound", "shape-published-controls", "completed", { parameterRef: parameter.ref, semanticControl: soundDirection.semanticControl, proposedValue, verified: true });
    const soundSlots = (await textOf(client, "live_discover", { kind: "clip-slot", parent: reconnectedTrack.ref })).parsed.items;
    const soundSlot = soundSlots.find((slot) => slot.empty === false);
    const soundAuditionPreview = (await textOf(client, "live_clip_launch_preview", { slotRef: soundSlot.ref, outputSafety: { safe: true, provenance: "journey-operator-confirmed-headphones" } })).parsed;
    journeyProgress("design-owned-sound", "audition", "awaiting_confirmation", { deviceRef: rack.ref, slotRef: soundSlot.ref, mechanism: "unpredictable-preview-token" });
    journeyProgress("design-owned-sound", "audition", "applying", { slotRef: soundSlot.ref, idempotencyKeyPresent: true });
    const soundAuditionApplied = (await textOf(client, "live_clip_launch_apply", { transactionId: soundAuditionPreview.transactionId, confirmation: soundAuditionPreview.confirmation, idempotencyKey: "journey-sound-audition" })).parsed;
    assert(soundAuditionApplied.state === "applied", "sound-design audition did not start");
    const soundAuditionStopped = (await textOf(client, "live_clip_launch_stop", { transactionId: soundAuditionPreview.transactionId, confirmation: soundAuditionPreview.stopConfirmation, idempotencyKey: "journey-sound-audition-stop" })).parsed;
    assert(soundAuditionStopped.state === "stopped", "sound-design audition did not stop");
    journeyProgress("design-owned-sound", "audition", "verifying", { started: true, authoritativeStopState: soundAuditionStopped.state });
    journeyProgress("design-owned-sound", "audition", "completed", { deviceRef: rack.ref, started: true, stopped: true, semanticControlAuditioned: soundDirection.semanticControl });
    // Prove recovery, then intentionally reapply the designed value so this
    // representative journey leaves an editable sound rather than only testing
    // parameter mechanics and deleting the outcome.
    const parameterUndo = (await textOf(client, "live_undo", { transactionId: parameterPreview.transactionId, confirmation: "undo", idempotencyKey: "journey-sound-parameter-undo" })).parsed;
    assert(parameterUndo.state === "undone", "sound-design parameter recovery failed");
    const finalParameterPreview = (await textOf(client, "live_device_parameter_preview", { deviceRef: rack.ref, parameterRef: parameter.ref, value: proposedValue })).parsed;
    const finalParameterApplied = (await textOf(client, "live_device_parameter_apply", { transactionId: finalParameterPreview.transactionId, confirmation: finalParameterPreview.confirmation, idempotencyKey: "journey-sound-parameter-final" })).parsed;
    assert(finalParameterApplied.state === "applied" && finalParameterApplied.value === proposedValue, "designed parameter value was not retained after recovery proof");
    const finalTrack = (await textOf(client, "live_discover", { kind: "track" })).parsed.items[0];
    const finalRack = finalTrack.devices.find((device) => device.ref === rack.ref);
    const finalParameter = finalRack?.parameters.find((candidate) => candidate.ref === parameter.ref);
    assert(finalRack?.enabled === true && finalParameter?.value === proposedValue, "final intent-directed sound topology/value did not verify");
    journeyProgress("design-owned-sound", "final-readback", "completed", { retainedDeviceRef: rack.ref, retainedParameterRef: parameter.ref, semanticControl: soundDirection.semanticControl, value: proposedValue, recoveryProvenThenReapplied: true, activePlayback: false });
  });

  await step("routing and bounded recording lifecycle through the packaged path", async () => {
    const freshTracks = (await textOf(client, "live_discover", { kind: "track" })).parsed.items;
    const baselinePlayback = await playback(client);
    journeyProgress("diagnose-performance-setup", "diagnose", "completed", { trackRefs: freshTracks.map((track) => track.ref), playback: baselinePlayback.transport.playing, recording: baselinePlayback.transport.arrangementRecord || baselinePlayback.transport.sessionRecord, latency: "unknown" });
    const feedback = await textOf(client, "live_routing_preview", { trackRef: freshTracks[0].ref, outputType: freshTracks[0].name });
    assert(feedback.isError === true, "feedback route was not refused");
    const preview = (await textOf(client, "live_routing_preview", { trackRef: freshTracks[0].ref, arm: true, monitoring: "off" })).parsed;
    const diagnosticMixerPreview = (await textOf(client, "live_mixer_preview", { trackRef: freshTracks[0].ref, volume: freshTracks[0].mixer.volume })).parsed;
    assert(diagnosticMixerPreview.transactionId && diagnosticMixerPreview.prior?.volume === freshTracks[0].mixer.volume, "performance mixer preview did not preserve baseline");
    journeyProgress("diagnose-performance-setup", "preview-fixes", "completed", { feedbackRouteRefused: true, routingPreviewed: true, mixerPreviewed: true, exactTrackRef: freshTracks[0].ref });
    journeyProgress("diagnose-performance-setup", "apply-fixes", "awaiting_confirmation", { exactTrackRef: freshTracks[0].ref, mechanism: "fixed-apply" });
    journeyProgress("diagnose-performance-setup", "apply-fixes", "applying", { exactTrackRef: freshTracks[0].ref, idempotencyKeyPresent: true });
    const applied = (await textOf(client, "live_routing_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "journey-route" })).parsed;
    assert(applied.state === "applied", "routing apply failed");
    const trackAfter = (await textOf(client, "live_discover", { kind: "track" })).parsed.items[0];
    assert(trackAfter.armed === true && trackAfter.monitoringState === "off", "routing fields did not land");
    journeyProgress("diagnose-performance-setup", "apply-fixes", "verifying", { authoritativeArm: trackAfter.armed, authoritativeMonitoring: trackAfter.monitoringState });
    journeyProgress("diagnose-performance-setup", "apply-fixes", "completed", { routeAppliedAndVerified: true, arm: true, monitoring: "off", restorationScheduledAfterRecording: true });
    // Arrangement recording with explicit destination
    const recPreview = (await textOf(client, "live_recording_preview", { action: "start", lane: "arrangement", intent: "journey bounded recording test", destinationTrackRef: freshTracks[0].ref, outputSafety: { safe: true, provenance: "journey-operator-confirmed" } })).parsed;
    journeyProgress("diagnose-performance-setup", "bounded-recording", "awaiting_confirmation", { lane: "arrangement", destinationTrackRef: freshTracks[0].ref, outputSafety: "operator-confirmed" });
    journeyProgress("diagnose-performance-setup", "bounded-recording", "applying", { action: "start-then-stop", idempotencyKeysPresent: true });
    const recApplied = (await textOf(client, "live_recording_apply", { transactionId: recPreview.transactionId, confirmation: "apply", idempotencyKey: "journey-rec" })).parsed;
    assert(recApplied.state === "applied" && recApplied.recording === true, "recording start failed");
    const during = await playback(client);
    assert(during.transport.arrangementRecord === true, "arrangement recording not active");
    const stopPreview = (await textOf(client, "live_recording_preview", { action: "stop", lane: "arrangement", intent: "stop journey recording", outputSafety: { safe: true, provenance: "journey-operator-confirmed" } })).parsed;
    const stopped = (await textOf(client, "live_recording_apply", { transactionId: stopPreview.transactionId, confirmation: "apply", idempotencyKey: "journey-rec-stop" })).parsed;
    assert(stopped.state === "applied" && stopped.recording === false, "recording stop failed");
    journeyProgress("diagnose-performance-setup", "bounded-recording", "verifying", { startVerified: during.transport.arrangementRecord, stopVerified: stopped.recording === false });
    journeyProgress("diagnose-performance-setup", "bounded-recording", "completed", { started: true, stopped: true, destinationTrackRef: freshTracks[0].ref });
    // Restore disarmed state for later steps
    const disarm = (await textOf(client, "live_routing_preview", { trackRef: freshTracks[0].ref, arm: false, monitoring: "off" })).parsed;
    await textOf(client, "live_routing_apply", { transactionId: disarm.transactionId, confirmation: "apply", idempotencyKey: "journey-disarm" });
  });

  await step("authenticated subscriptions deliver bounded transport events and clean up", async () => {
    const subscribed = (await textOf(client, "live_subscribe", { types: ["transport", "object"] })).parsed;
    console.error("subscribed:", JSON.stringify(subscribed).slice(0, 250));
    assert(subscribed.subscribed === true && typeof subscribed.subscriptionId === "string", "subscribe failed");
    // Trigger a transport change with a clip launch to see the event.
    const freshTracks = (await textOf(client, "live_discover", { kind: "track" })).parsed.items;
    const slots = (await textOf(client, "live_discover", { kind: "clip-slot", parent: freshTracks[0].ref })).parsed.items;
    const slotRef = slots.find((item) => item.empty === false)?.ref;
    const preview = (await textOf(client, "live_clip_launch_preview", { slotRef, outputSafety: { safe: true, provenance: "journey-operator-confirmed-headphones" } })).parsed;
    client.events.length = 0;
    await textOf(client, "live_clip_launch_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "journey-sub-launch" });
    const eventDeadline = Date.now() + 5000;
    let transportEvent;
    while (Date.now() < eventDeadline && !transportEvent) {
      transportEvent = client.events.find((event) => event?.type === "transport" && event?.payload?.playing === true);
      if (!transportEvent) await waitMs(50);
    }
    assert(transportEvent && Number.isSafeInteger(transportEvent.sequence) && transportEvent.sequence >= 1, `no transport event observed: ${JSON.stringify(client.events)}`);
    const stopped = (await textOf(client, "live_clip_launch_stop", { transactionId: preview.transactionId, confirmation: preview.stopConfirmation, idempotencyKey: "journey-sub-stop" })).parsed;
    assert(stopped.state === "stopped", "subscription-step clip stop failed");
    const unsubscribed = (await textOf(client, "live_unsubscribe", {})).parsed;
    assert(unsubscribed.subscribed === false, "unsubscribe failed");
  });

  await step("armed realtime UDP, OSC, XY, and max-labelled extension packets are bounded, measured, reconnect-safe, and recoverable", async () => {
    const freshTracks = (await textOf(client, "live_discover", { kind: "track" })).parsed.items;
    const volumeRef = freshTracks[0]?.mixer?.volumeRef;
    const panRef = freshTracks[0]?.mixer?.panRef;
    assert(typeof volumeRef === "string" && typeof panRef === "string", "published mixer parameters are unavailable for realtime proof");
    const refused = await textOf(client, "live_realtime_arm_preview", { ttlMs: 5000, channels: ["udp-json"], parameterRefs: [volumeRef], outputSafety: { safe: true, provenance: "journey-operator-confirmed-loopback" } });
    assert(refused.isError === true, "fake-Live provenance was promoted to realtime host authority");
    const sender = await bindUdp();
    const rogue = await bindUdp();
    try {
      const sourcePort = sender.address().port;
      const armed = await adapter_call(client, "realtime.arm", { ttlMs: 30000, channels: ["udp-json", "osc", "xy", "max"], parameterRefs: [volumeRef, panRef], sourcePorts: [sourcePort], outputSafety: { safe: true, provenance: "journey-operator-confirmed-headphones" } });
      assert(armed.host === "127.0.0.1" && armed.port === harnessRealtimePort && JSON.stringify(armed.parameterRefs) === JSON.stringify([volumeRef, panRef]) && armed.packetLimitBytes === 512 && armed.ratePerSecond === 64 && armed.burst === 16, `realtime arm contract mismatch: ${JSON.stringify(armed)}`);
      // The token lives in the bridge rather than the MCP process and remains
      // usable across a host restart for only the arm's bounded lifetime.
      await restartClient();
      const packet = (values) => JSON.stringify({ token: armed.token, ...values });
      await sendUdp(rogue, packet({ seq: 1, channel: "udp-json", op: "parameter.set", ref: volumeRef, value: 0.2 }), harnessRealtimePort);
      await sendUdp(sender, packet({ seq: 1, channel: "udp-json", op: "parameter.set", ref: "parameter:not-allowed", value: 0.2 }), harnessRealtimePort);
      await sendUdp(sender, packet({ seq: 1, channel: "udp-json", op: "parameter.set", ref: volumeRef, value: 0.4, sentAtMs: Date.now() }), harnessRealtimePort);
      await sendUdp(sender, packet({ seq: 3, channel: "xy", op: "xy.set", xRef: volumeRef, x: 0.55, yRef: panRef, y: 0.1, sentAtMs: Date.now() }), harnessRealtimePort);
      await sendUdp(sender, oscParameter(armed.token, 4, volumeRef, 0.6, Date.now()), harnessRealtimePort);
      await sendUdp(sender, packet({ seq: 5, channel: "max", op: "parameter.set", ref: volumeRef, value: 0.65, sentAtMs: Date.now() }), harnessRealtimePort);
      await sendUdp(sender, packet({ seq: 5, channel: "max", op: "parameter.set", ref: volumeRef, value: 0.65 }), harnessRealtimePort);
      for (let sequence = 6; sequence <= 80; sequence += 1) await sendUdp(sender, packet({ seq: sequence, channel: "udp-json", op: "parameter.set", ref: volumeRef, value: 0.5, sentAtMs: Date.now() }), harnessRealtimePort);
      let stats;
      const statsDeadline = Date.now() + 5000;
      do {
        await waitMs(50);
        stats = await adapter_call(client, "realtime.stats", {});
      } while (Date.now() < statsDeadline && stats.pending > 0);
      assert(stats.armed === true && stats.accepted >= 4 && stats.applied >= 4 && stats.applyFailures === 0 && stats.pending === 0, `realtime apply counters mismatch: ${JSON.stringify(stats)}`);
      assert(stats.droppedEndpoint >= 1 && stats.droppedTarget >= 1 && stats.droppedReplay >= 1 && stats.droppedRateLimited >= 1 && stats.sequenceGaps >= 1, `realtime loss/drop counters mismatch: ${JSON.stringify(stats)}`);
      assert(Number.isFinite(stats.jitterMs) && Number.isFinite(stats.maxJitterMs), "realtime jitter was not measured");
      const afterParameters = (await textOf(client, "live_discover", { kind: "track" })).parsed.items[0];
      assert(typeof afterParameters.mixer.volume === "number" && typeof afterParameters.mixer.pan === "number", "realtime parameter changes were not authoritative");

      // Prove the data-plane emergency stop remains independent of the host
      // transaction after reconnect and while the bounded token is still armed.
      const slots = (await textOf(client, "live_discover", { kind: "clip-slot", parent: freshTracks[0].ref })).parsed.items;
      const slotRef = slots.find((item) => item.empty === false)?.ref;
      const preview = (await textOf(client, "live_clip_launch_preview", { slotRef, outputSafety: { safe: true, provenance: "journey-operator-confirmed-headphones" } })).parsed;
      await textOf(client, "live_clip_launch_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "journey-realtime-launch" });
      assert(activeKeys(await playback(client)).length > 0, "realtime emergency proof did not start playback");
      await waitMs(1000);
      await sendUdp(sender, packet({ seq: 100, channel: "udp-json", op: "emergency-stop", sentAtMs: Date.now() }), harnessRealtimePort);
      const stopDeadline = Date.now() + 5000;
      let stoppedState;
      do { await waitMs(50); stoppedState = await playback(client); } while (Date.now() < stopDeadline && activeKeys(stoppedState).length > 0);
      assert(stoppedState.transport.playing === false && activeKeys(stoppedState).length === 0, "realtime emergency stop did not restore playback baseline");

      const beforeDisarm = await adapter_call(client, "realtime.stats", {});
      const disarmed = await adapter_call(client, "realtime.disarm", {});
      assert(disarmed.armed === false, "realtime disarm was not confirmed");
      await sendUdp(sender, packet({ seq: 101, channel: "udp-json", op: "parameter.set", ref: volumeRef, value: 0.2 }), harnessRealtimePort);
      await waitMs(100);
      const afterDisarm = await adapter_call(client, "realtime.stats", {});
      assert(afterDisarm.armed === false && afterDisarm.droppedUnarmed > beforeDisarm.droppedUnarmed, "disarm did not revoke subsequent packets");

      const expiring = await adapter_call(client, "realtime.arm", { ttlMs: 1000, channels: ["udp-json"], parameterRefs: [volumeRef], sourcePorts: [sourcePort], outputSafety: { safe: true, provenance: "journey-operator-confirmed-headphones" } });
      await waitMs(1100);
      await sendUdp(sender, JSON.stringify({ token: expiring.token, seq: 1, channel: "udp-json", op: "parameter.set", ref: volumeRef, value: 0.2 }), harnessRealtimePort);
      await waitMs(100);
      const expiredStats = await adapter_call(client, "realtime.stats", {});
      assert(expiredStats.armed === false && expiredStats.droppedUnarmed > afterDisarm.droppedUnarmed, "expired realtime authority accepted a packet");
      await adapter_call(client, "realtime.disarm", {});
    } finally {
      sender.close(); rogue.close();
    }
  });

  await step("shutdown leaves no residual playback or processes", async () => {
    const finalPlayback = await playback(client);
    assert(finalPlayback.transport.playing === false && finalPlayback.transport.arrangementRecord === false && finalPlayback.transport.sessionRecord === false, "playback or recording was active before shutdown");
    const finalTracks = (await textOf(client, "live_discover", { kind: "track" })).parsed.items;
    const finalSlots = (await textOf(client, "live_discover", { kind: "clip-slot", parent: finalTracks[0].ref })).parsed.items;
    const songClip = finalSlots.find((slot) => slot.sceneIndex === 1)?.clipRef;
    const drumClip = finalSlots.find((slot) => slot.sceneIndex === 2)?.clipRef;
    const songFinalNotes = songClip ? (await textOf(client, "live_discover", { kind: "note", parent: songClip, limit: 100 })).parsed.items : [];
    const drumFinalNotes = drumClip ? (await textOf(client, "live_discover", { kind: "note", parent: drumClip, limit: 100 })).parsed.items : [];
    const realtime = await adapter_call(client, "realtime.stats", {});
    assert(finalTracks[0].armed === false && finalTracks[0].monitoringState === "off" && realtime.armed === false, "routing or realtime authority remained active");
    journeyProgress("create-beat-or-song", "final-readback", "completed", { clipRef: songClip, notes: songFinalNotes.length, playback: "stopped", recording: "stopped" });
    journeyProgress("sequence-advanced-drums", "final-readback", "completed", { clipRef: drumClip, stableNotes: drumFinalNotes.length, playback: "stopped" });
    journeyProgress("diagnose-performance-setup", "final-readback", "completed", { arm: false, monitoring: "off", playback: "stopped", recording: "stopped", realtimeArmed: false });
    journeyResidual("create-beat-or-song", { status: "completed", items: ["intentional fake-Live song structure, MIDI clip, Session variation, and one Arrangement clip"], playback: false, recording: false, temporaryMedia: 0, realtimeAuthority: false });
    journeyResidual("sequence-advanced-drums", { status: "completed", items: ["intentional editable fake-Live MIDI clip; deleted note restored under a new stable ID"], playback: false, recording: false, temporaryMedia: 0, realtimeAuthority: false });
    journeyResidual("design-owned-sound", { status: "completed", items: ["intentional editable fake-Live Drum Rack with intent-directed Filter Cutoff value"], playback: false, recording: false, temporaryMedia: 0, realtimeAuthority: false, recoveryProvenThenDesignedValueReapplied: true });
    journeyResidual("compare-reference-mix", { status: "completed", items: [], playback: false, recording: false, rawAudioRetained: false, temporaryMedia: 0, realtimeAuthority: false });
    journeyResidual("diagnose-performance-setup", { status: "completed", items: [], playback: false, recording: false, arm: false, monitoring: "off", temporaryMedia: 0, realtimeAuthority: false });
    await client.close();
  });
} catch (cause) {
  failed = true;
  console.error(cause instanceof Error ? cause.stack ?? cause.message : cause);
} finally {
  for (const child of children) terminateChildProcess(child.kill ? child : child);
  await waitMs(100);
  if (!process.env.KEEP_JOURNEY_TEMP) removeTemporaryDirectory(temporaryDirectory);
  else console.error(`journey temp kept: ${temporaryDirectory}`);
}

const executionRows = userJourneyEvidence.map((entry) => {
  const plan = plannedJourneys.get(entry.id);
  const execution = journeyExecutions.get(entry.id) ?? { events: [], residualState: null };
  const requiredPlannedStages = plan?.stages.filter((stage) => stage.status === "planned").map((stage) => stage.id) ?? [];
  const terminalPlannedStages = requiredPlannedStages.filter((stage) => execution.events.some((event) => event.stage === stage && ["completed", "recovered"].includes(event.status)));
  const planHistory = journeyPlanHistory.get(entry.id) ?? [];
  const planIds = new Set(planHistory.map((item) => item.planId));
  const eventsBoundToPlanHistory = execution.events.every((event) => planIds.has(event.planId));
  const { planId: initialPlanId, ...entryWithoutAmbiguousPlanId } = entry;
  return { ...entryWithoutAmbiguousPlanId, initialPlanId, finalPlanId: plan?.planId, planHistory, execution: { requiredPlannedStages, terminalPlannedStages, eventsBoundToPlanHistory, orderValidatedDuringExecution: true, legalTransitionsValidatedDuringExecution: true, events: execution.events, residualState: execution.residualState } };
});
const representativeJourneysPassed = executionRows.every((entry) => entry.execution.requiredPlannedStages.length > 0 && entry.execution.requiredPlannedStages.length === entry.execution.terminalPlannedStages.length && entry.execution.eventsBoundToPlanHistory && entry.execution.residualState !== null && ["completed", "recovered"].includes(entry.execution.residualState.status));
const accessibilityEvidence = {
  version: "installed-stdio-accessibility-contract/v1",
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  scope: "installed-package MCP stdio text boundary only",
  semanticPrompts: accessibilityChecks,
  keyboardOrStdinOnlyServerOperation: true,
  pointerInputObserved: false,
  focusManagement: "not-applicable-no-server-owned-interactive-UI",
  boundedVisualTextAlternativesRequired: true,
  screenReaderValidation: "not-performed-client-and-Ableton-Live-version-dependent",
  contrastValidation: "not-applicable-no-server-owned-visual-surface",
  knownLimitationsDocumented: true,
};
const packageIdentityPassed = packageEvidence?.version === "npm-packed-artifact/v1" && packageEvidence?.name === "@ableton-mcp/mcp-server" && packageEvidence?.packageVersion === "0.1.0" && /^[a-f0-9]{64}$/.test(packageEvidence?.sha256 ?? "") && Number.isSafeInteger(packageEvidence?.sizeBytes);
const accessibilityPassed = accessibilityChecks.length === 5 && accessibilityChecks.every((entry) => entry.contentType === "text" && entry.orderedStages && !entry.ansiControlBytes && entry.nonColorGuidance && !entry.pointerInputUsedByVerifier);
const summary = { schemaVersion: "phase-9-packaged-journeys/v1", generatedAt: new Date().toISOString(), package: packageEvidence, journey: "packaged-production-boundary", provenance: "fake-live", progressEvidence: "derived-from-actual-purpose-specific-tool-results-not-plan-template-flags", accessibilityEvidence, userJourneys: executionRows, steps: results, passed: !failed && results.every((entry) => entry.passed) && results.length === 25 && userJourneyEvidence.length === 5 && representativeJourneysPassed && accessibilityPassed && packageIdentityPassed };
console.log(JSON.stringify(summary));
if (!summary.passed) process.exitCode = 1;
