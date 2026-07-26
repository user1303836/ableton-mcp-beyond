import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
let failed = false;

function step(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push({ name, passed: true }); console.error(`journey ok: ${name}`); })
    .catch((cause) => { failed = true; results.push({ name, passed: false, error: cause instanceof Error ? cause.message : String(cause) }); console.error(`journey FAIL: ${name}: ${cause instanceof Error ? cause.message : cause}`); throw cause; });
}

function assert(condition, message) { if (!condition) throw new Error(`assertion failed: ${message}`); }

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
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        const entry = this.pending.get(message.id);
        if (entry) { this.pending.delete(message.id); entry.resolve(message); }
      }
    });
    this.child.stderr.on("data", () => undefined);
  }
  request(method, params, timeoutMs = 15_000) {
    const id = this.nextId++;
    const payload = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP request ${id} (${method}) timed out`)); }, timeoutMs);
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

class FakeClip:
    def __init__(self, length=4.0):
        self.length = length; self.name = "Journey Clip"; self.notes = []
    def add_new_notes(self, notes): self.notes.extend(notes)
    def get_notes(self, *_): return list(self.notes)

class FakeSlot:
    def __init__(self, clip=None): self.clip = clip
    def create_clip(self, length):
        self.clip = FakeClip(length); return self.clip
    def delete_clip(self): self.clip = None

class FakeTrack:
    has_midi_input = True
    def __init__(self, name="Journey Drums", clips=None):
        self.name = name; self.arm = False; self.current_monitoring_state = 2
        self.playing_slot_index = -1; self.fired_slot_index = -1
        self.clip_slots = [FakeSlot(clip) for clip in (clips if clips is not None else [FakeClip(), None])]; self.devices = []

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
        song.tracks[0].playing_slot_index = self._index
        song.tracks[0].fired_slot_index = self._index

class FakeExternalScene:
    def __init__(self, name): self.name = name; self.fire = None

class FakeSong:
    def __init__(self):
        self.name = "Journey Disposable Set"; self.tempo = 120.0
        self.tracks = [FakeTrack(), FakeTrack("Journey Bass", [FakeClip(), FakeClip()])]; self.return_tracks = [FakeReturnTrack()]; self.master_track = FakeMasterTrack()
        self.is_playing = False; self.record_mode = False; self.session_record = False
        self.current_song_time = 0.0; self.clip_trigger_quantization = "1_bar"
        self.fire_sleep = 0.0; self.fail_stop = False
        self.scenes = [FakeScene("Journey Scene", self, 0), FakeExternalScene("Other Scene")]
    def stop_all_clips(self):
        if self.fail_stop: raise RuntimeError("injected stop failure")
        for track in self.tracks:
            track.playing_slot_index = -1; track.fired_slot_index = -1
    def stop_playing(self):
        if self.fail_stop: raise RuntimeError("injected stop failure")
        self.is_playing = False

class Instance:
    def __init__(self): self.song = FakeSong()

probe = socket.socket(); probe.bind(("127.0.0.1", 0)); port = probe.getsockname()[1]; probe.close()
secret_path = os.environ.get("ABLETON_MCP_JOURNEY_SECRET_FILE")
if not secret_path: raise RuntimeError("journey secret file was not provided")
bridge = AbletonMcpBridge(Instance(), {"host": "127.0.0.1", "port": port, "secret": pathlib.Path(secret_path).read_text(encoding="utf-8").strip()})
song = bridge.mapper.song
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
pathlib.Path(sys.argv[1]).write_text(json.dumps({"port": port}), encoding="utf-8")

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
                ack_path.write_text(json.dumps({"applied": command.get("command"), "seq": command.get("seq")}), encoding="utf-8")
            except Exception as error:
                ack_path.write_text(json.dumps({"error": str(error)}), encoding="utf-8")
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

try {
  const packOutput = execFileSync(npm, ["pack", "--json", "--pack-destination", temporaryDirectory], { ...npmOptions, cwd: packageDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const packed = JSON.parse(packOutput);
  const artifact = join(temporaryDirectory, packed[0].filename);
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
  const python = process.platform === "win32" ? "python.exe" : "python3";
  const harness = spawn(python, [harnessPath, readyPath, controlPath, ackPath], { cwd: temporaryDirectory, env: { ...process.env, PYTHONPATH: join(installedPackageDirectory, "remote-script"), ABLETON_MCP_JOURNEY_SECRET_FILE: secretPath }, stdio: "ignore" });
  children.add(harness);

  const controlSeq = { value: 0 };
  async function control(command, extra = {}) {
    const seq = ++controlSeq.value;
    writeFileSync(controlPath, JSON.stringify({ ...extra, ...command, seq }), { encoding: "utf8" });
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
  const textOf = async (client, name, args, timeoutMs) => {
    const response = await client.call(name, args, timeoutMs);
    return response;
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
    harnessPort = JSON.parse(readFileSync(readyPath, "utf8")).port;
    cliConfigPath = join(temporaryDirectory, "journey-bridge-config.json");
    execFileSync(process.execPath, [join(installedPackageDirectory, "dist", "src", "setup.js"), "--output", cliConfigPath, "--bridge-host", "127.0.0.1", "--bridge-port", String(harnessPort), "--secret-file", secretPath], { encoding: "utf8" });
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
    const stopped = (await textOf(client, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: [] })).parsed;
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
    const stopped = (await textOf(client, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: keys })).parsed;
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
    const blind = await textOf(client, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: [keys[0]] });
    assert(blind.isError === true, "emergency stop accepted an incomplete observation");
    const stopped = (await textOf(client, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: keys })).parsed;
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
    const stopped = (await textOf(client, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: keys })).parsed;
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

  await step("shutdown leaves no residual playback or processes", async () => {
    assert((await playback(client)).transport.playing === false, "playback was active before shutdown");
    await client.close();
  });
} catch (cause) {
  failed = true;
  console.error(cause instanceof Error ? cause.stack ?? cause.message : cause);
} finally {
  for (const child of children) terminateChildProcess(child.kill ? child : child);
  await waitMs(100);
  removeTemporaryDirectory(temporaryDirectory);
}

const summary = { journey: "packaged-production-boundary", provenance: "fake-live", steps: results, passed: !failed && results.every((entry) => entry.passed) && results.length === 14 };
console.log(JSON.stringify(summary));
if (!summary.passed) process.exitCode = 1;
