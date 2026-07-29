#!/usr/bin/env node
// Zero-config MCP demo: drives dist/src/cli.js over stdio with the default
// fail-closed adapter (no Ableton Live required). Run `npm run build` first.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/src/cli.js");

// --- synthesize 2 s of a 440 Hz sine at 48 kHz (mono float32 LE) ---
const sr = 48000;
const n = sr * 2;
const buf = Buffer.alloc(n * 4);
for (let i = 0; i < n; i++) buf.writeFloatLE(0.5 * Math.sin((2 * Math.PI * 440 * i) / sr), i * 4);
const pcmBase64 = buf.toString("base64");

const server = spawn(process.execPath, [cli], { stdio: ["pipe", "pipe", "inherit"] });
let nextId = 1;
const pending = new Map();
let lineBuf = "";

server.stdout.on("data", (chunk) => {
  lineBuf += chunk;
  let idx;
  while ((idx = lineBuf.indexOf("\n")) !== -1) {
    const line = lineBuf.slice(0, idx).trim();
    lineBuf = lineBuf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

const send = (msg) => server.stdin.write(JSON.stringify(msg) + "\n");
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
const callTool = (name, args) => request("tools/call", { name, arguments: args });
const toolJson = (res) => JSON.parse(res.result.content[0].text);

const step = (title) => console.log(`\n\x1b[1m▶ ${title}\x1b[0m`);
const show = (label, obj) => console.log(`  ${label}:`, JSON.stringify(obj));

// --- 1. handshake -----------------------------------------------------------
step("initialize (MCP protocol 2025-11-25)");
const init = await request("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "demo", version: "1.0.0" },
});
show("server", init.result.serverInfo);
send({ jsonrpc: "2.0", method: "notifications/initialized" });

// --- 2. tool catalog --------------------------------------------------------
step("tools/list");
const tools = (await request("tools/list", {})).result.tools;
show("tools exposed", tools.length);
console.log("  " + tools.map((t) => t.name).join(", "));

// --- 3. status without Live (fail-closed) -----------------------------------
step("server_status + live_status (no Live configured → fail-closed)");
show("server_status", toolJson(await callTool("server_status", {})));
show("live_status.adapter", toolJson(await callTool("live_status", {})).adapter);

// --- 4. real audio analysis (no Live needed) --------------------------------
step("audio_analyze: 2 s 440 Hz sine @ 48 kHz → BS.1770-5 loudness, true peak, spectra");
const analysis = toolJson(await callTool("audio_analyze", { pcmBase64, sampleRate: sr, channels: 1 }));
const bs1770 = analysis.standardsAudio;
show("peak / rms", `${analysis.peakDbfs.toFixed(2)} dBFS / ${analysis.rmsDbfs.toFixed(2)} dBFS`);
show("BS.1770-5 integrated loudness", `${bs1770.loudness.integratedLufs.toFixed(2)} LUFS (standardsCompliant: ${bs1770.loudness.standardsCompliant})`);
show("BS.1770-5 Annex 2 true peak", `${bs1770.truePeak.aggregateDbtp.toFixed(3)} dBTP (${bs1770.truePeak.method})`);

// --- 5. capability-aware journey plan ---------------------------------------
step("plan_user_journey: beat-making plan");
const plan = toolJson(
  await callTool("plan_user_journey", { journey: "create-beat-or-song", traits: "dusty lo-fi hip hop groove", experienceLevel: "beginner", bars: 4 }),
);
show("journey", plan.journey ?? plan.id);
show("stages", Array.isArray(plan.stages) ? plan.stages.map((s) => s.id ?? s.title) : "(see full output)");

step("done — no Live instance was read or changed");
server.kill();
