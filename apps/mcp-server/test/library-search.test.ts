import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator } from "../src/live.js";
import { FIXTURE_FILES_DB_BASE64, FIXTURE_PLUGINS_DB_BASE64, FIXTURE_UNSUPPORTED_DB_BASE64 } from "./library-fixtures.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

function connectedHost() {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  host.handle(initialize); host.handle(initialized);
  let requestId = 3100;
  const call = (name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } });
  const parse = async (promise: Promise<unknown>) => {
    const frame = (await promise) as any;
    if (frame.error) throw new Error(`unexpected protocol error: ${JSON.stringify(frame.error)}`);
    return JSON.parse(frame.result.content[0].text);
  };
  const parseError = async (promise: Promise<unknown>) => {
    const frame = (await promise) as any;
    if (frame.error) return { protocolError: frame.error };
    return { toolError: frame.result.isError === true ? JSON.parse(frame.result.content[0].text) : undefined, result: frame.result.isError === true ? undefined : JSON.parse(frame.result.content[0].text) };
  };
  const root = mkdtempSync(join(tmpdir(), "library-search-"));
  const filesDb = join(root, "Live-files-12300.db");
  const pluginsDb = join(root, "Live-plugins-1.db");
  const unsupportedDb = join(root, "Live-files-99999.db");
  writeFileSync(filesDb, Buffer.from(FIXTURE_FILES_DB_BASE64, "base64"));
  writeFileSync(pluginsDb, Buffer.from(FIXTURE_PLUGINS_DB_BASE64, "base64"));
  writeFileSync(unsupportedDb, Buffer.from(FIXTURE_UNSUPPORTED_DB_BASE64, "base64"));
  const filesArgs = { database: filesDb, allowlistRoot: root };
  return { simulator, host, call, parse, parseError, root, filesDb, pluginsDb, unsupportedDb, filesArgs };
}

test("files mode classifies kinds with evidence and sorts by usage count", async (t) => {
  const { call, parse, root, filesArgs } = connectedHost();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const response = await parse(call("live_library_search", filesArgs));
  assert.equal(response.schema, "ableton-mcp-library-search/v1");
  assert.equal(response.mode, "files");
  assert.equal(response.databaseVersion, 12300);
  assert.deepEqual(response.supportedVersions, [12300]);
  const names = response.items.map((item: any) => item.name);
  assert.deepEqual(names, ["Kick 909 Core.wav", "Wavetable", "My Set.als", "FX Rack.adg", "Envelope MIDI.amxd", "Operator", "Dusty Rhodes.aif"]);
  const kinds = Object.fromEntries(response.items.map((item: any) => [item.name, item.kind]));
  assert.equal(kinds["Kick 909 Core.wav"], "audio");
  assert.equal(kinds["Wavetable"], "device");
  assert.equal(kinds["My Set.als"], "set");
  assert.equal(kinds["FX Rack.adg"], "device-group");
  assert.equal(kinds["Envelope MIDI.amxd"], "max-device");
  assert.match(response.items.find((item: any) => item.name === "Kick 909 Core.wav").kindEvidence, /file_type 'wav'/);
  assert.equal(response.items.every((item: any) => item.kind !== "other" || item.kindEvidence.includes("not classified")), true);
  assert.equal(response.unavailable.similarity !== undefined, true);
  assert.equal(response.unavailable.duplicates !== undefined, true);
  // folder and tag-vocabulary rows never appear as content
  assert.equal(names.includes("Samples"), false);
  assert.equal(names.includes("Delay"), false);
});

test("name, wildcard, kind, source, and sort filters compose", async (t) => {
  const { call, parse, root, filesArgs } = connectedHost();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const substring = await parse(call("live_library_search", { ...filesArgs, query: "kick" }));
  assert.deepEqual(substring.items.map((item: any) => item.name), ["Kick 909 Core.wav"]);
  const wildcard = await parse(call("live_library_search", { ...filesArgs, query: "*.a*" }));
  assert.deepEqual(wildcard.items.map((item: any) => item.name).sort(), ["Dusty Rhodes.aif", "FX Rack.adg", "Envelope MIDI.amxd", "My Set.als"].sort());
  const audio = await parse(call("live_library_search", { ...filesArgs, kinds: ["audio"] }));
  assert.deepEqual(audio.items.map((item: any) => item.name), ["Kick 909 Core.wav", "Dusty Rhodes.aif"]);
  const userLibrary = await parse(call("live_library_search", { ...filesArgs, sources: ["User Library"] }));
  assert.deepEqual(userLibrary.items.map((item: any) => item.name), ["Kick 909 Core.wav", "Dusty Rhodes.aif"]);
  const byModified = await parse(call("live_library_search", { ...filesArgs, sort: "modified" }));
  assert.equal(byModified.items[0].name, "My Set.als");
  const byName = await parse(call("live_library_search", { ...filesArgs, sort: "name" }));
  assert.deepEqual(byName.items.map((item: any) => item.name), [...byName.items.map((item: any) => item.name)].sort());
});

test("tag conjunction filters accept leaf names and full paths", async (t) => {
  const { call, parse, root, filesArgs } = connectedHost();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const kick = await parse(call("live_library_search", { ...filesArgs, tags: ["Kick"] }));
  assert.deepEqual(kick.items.map((item: any) => item.name), ["Kick 909 Core.wav"]);
  const conjunction = await parse(call("live_library_search", { ...filesArgs, tags: ["Drums", "Kick"] }));
  assert.deepEqual(conjunction.items.map((item: any) => item.name), ["Kick 909 Core.wav"]);
  const path = await parse(call("live_library_search", { ...filesArgs, tags: ["Devices|Synthesizer|FM"] }));
  assert.deepEqual(path.items.map((item: any) => item.name), ["Wavetable"]);
  const none = await parse(call("live_library_search", { ...filesArgs, tags: ["Synthesizer", "Kick"] }));
  assert.equal(none.items.length, 0);
  const item = kick.items[0];
  assert.deepEqual(item.tags.map((tag: any) => tag.path).sort(), ["Drums", "Drums|Kick"]);
  assert.equal(item.tags.every((tag: any) => tag.isAuto === false), true);
  const autoTagged = (await parse(call("live_library_search", { ...filesArgs, tags: ["Keys"] }))).items[0];
  assert.equal(autoTagged.tags[0].isAuto, true, "auto-assigned tags are labeled");
});

test("paging is revision-bound and honest about truncation", async (t) => {
  const { call, parse, parseError, root, filesArgs } = connectedHost();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = await parse(call("live_library_search", { ...filesArgs, limit: 3 }));
  assert.equal(first.paging.returned, 3);
  assert.equal(first.paging.total, 7);
  assert.equal(first.paging.complete, false);
  assert.equal(first.paging.truncated, false);
  const second = await parse(call("live_library_search", { ...filesArgs, limit: 3, cursor: first.paging.nextCursor }));
  assert.equal(second.paging.returned, 3);
  const third = await parse(call("live_library_search", { ...filesArgs, limit: 3, cursor: second.paging.nextCursor }));
  assert.equal(third.paging.returned, 1);
  assert.equal(third.paging.complete, true);
  const all = [...first.items, ...second.items, ...third.items].map((item: any) => item.name);
  assert.equal(new Set(all).size, 7, "pages are disjoint and cover the match set");
  const stale = await parseError(call("live_library_search", { ...filesArgs, query: "kick", limit: 3, cursor: first.paging.nextCursor }));
  assert.equal(stale.toolError.unavailable, true, "a cursor from a different query is stale");
  const garbage = await parseError(call("live_library_search", { ...filesArgs, cursor: "!!not-a-cursor!!" }));
  assert.equal(garbage.toolError.unavailable, true);
});

test("browser candidates resolve only with device-class evidence; everything else is discovery-only", async (t) => {
  const { call, parse, root, filesArgs } = connectedHost();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const response = await parse(call("live_library_search", filesArgs));
  const wavetable = response.items.find((item: any) => item.name === "Wavetable");
  assert.equal(wavetable.browserCandidate.itemId, "instruments/Wavetable");
  assert.equal(wavetable.discoveryOnly, false);
  assert.match(wavetable.browserCandidate.resolution, /live_browser_inspect/);
  const sample = response.items.find((item: any) => item.name === "Kick 909 Core.wav");
  assert.equal(sample.browserCandidate, null);
  assert.equal(sample.discoveryOnly, true);
});

test("plug-in inventory covers vendor and format filters with redacted paths", async (t) => {
  const { call, parse, parseError, root, filesArgs, pluginsDb } = connectedHost();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inventory = await parse(call("live_library_search", { ...filesArgs, mode: "plugins", pluginsDatabase: pluginsDb }));
  const byName = Object.fromEntries(inventory.items.map((item: any) => [item.name, item]));
  assert.equal(byName["Serum"].format, "vst3");
  assert.equal(byName["Serum"].vendor, "Xfer Records");
  assert.equal(byName["Diva FX"].format, "au");
  assert.equal(byName["OldSynth"].format, "vst2");
  assert.equal(byName["OldSynth"].enabled, false);
  assert.equal(byName["OldSynth"].scanned, false);
  assert.equal(byName["Serum"].moduleBasename, "Serum.vst3");
  assert.equal(JSON.stringify(inventory).includes("/Library/Audio"), false, "raw filesystem paths are redacted");
  const vendor = await parse(call("live_library_search", { ...filesArgs, mode: "plugins", pluginsDatabase: pluginsDb, vendors: ["u-he"] }));
  assert.deepEqual(vendor.items.map((item: any) => item.name), ["Diva FX"]);
  const format = await parse(call("live_library_search", { ...filesArgs, mode: "plugins", pluginsDatabase: pluginsDb, formats: ["vst3"] }));
  assert.deepEqual(format.items.map((item: any) => item.name), ["Serum"]);
  const missingPluginsPath = await parseError(call("live_library_search", { ...filesArgs, mode: "plugins" }));
  assert.equal(missingPluginsPath.toolError.unavailable, true);
});

test("tag vocabulary mode lists the tag tree with usage counts", async (t) => {
  const { call, parse, root, filesArgs } = connectedHost();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const response = await parse(call("live_library_search", { ...filesArgs, mode: "tags" }));
  const byPath = Object.fromEntries(response.items.map((item: any) => [item.path, item]));
  assert.equal(byPath["Devices|Synthesizer"].usageCount, 2);
  assert.equal(byPath["Devices|Synthesizer|FM"].usageCount, 1);
  assert.equal(byPath["Drums|Kick"].usageCount, 1);
  assert.equal(byPath["Devices|Delay"].usageCount, 1);
  assert.equal(byPath["Keys"].usageCount, 1);
  const filtered = await parse(call("live_library_search", { ...filesArgs, mode: "tags", query: "synth" }));
  assert.deepEqual(filtered.items.map((item: any) => item.path), ["Devices|Synthesizer", "Devices|Synthesizer|FM"]);
});

test("schema gating is fail-closed: unsupported versions, missing databases, and non-databases", async (t) => {
  const { call, parseError, root, filesArgs, unsupportedDb } = connectedHost();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const unsupported = await parseError(call("live_library_search", { ...filesArgs, database: unsupportedDb }));
  assert.equal(unsupported.toolError.unavailable, true);
  assert.equal(unsupported.toolError.observedVersion, 99999);
  assert.deepEqual(unsupported.toolError.supportedVersions, [12300]);
  const missing = await parseError(call("live_library_search", { ...filesArgs, database: join(root, "absent.db") }));
  assert.equal(missing.toolError.unavailable, true);
  const garbagePath = join(root, "garbage.db");
  writeFileSync(garbagePath, "this is not a sqlite database at all");
  const garbage = await parseError(call("live_library_search", { ...filesArgs, database: garbagePath }));
  assert.equal(garbage.toolError.unavailable, true);
});

test("allowlist containment and path rules are enforced exactly", async (t) => {
  const { call, parseError, root, filesDb } = connectedHost();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = await parseError(call("live_library_search", { database: filesDb, allowlistRoot: join(root, "sub", "elsewhere") }));
  assert.equal(outside.toolError.unavailable, true);
  const relative = await parseError(call("live_library_search", { database: "relative/Live-files-12300.db", allowlistRoot: root }));
  assert.equal(relative.toolError.unavailable, true);
  const directory = await parseError(call("live_library_search", { database: root, allowlistRoot: root }));
  assert.equal(directory.toolError.unavailable, true);
});

test("a database with uncheckpointed WAL frames is refused; an empty WAL is checkpoint-equivalent", async (t) => {
  const { call, parse, parseError, root, filesDb, filesArgs } = connectedHost();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = readFileSync(filesDb);
  // byte 19 is the file-format read version: 2 means WAL
  const walBytes = Buffer.from(bytes);
  walBytes[19] = 2;
  const walDb = join(root, "wal.db");
  writeFileSync(walDb, walBytes);
  writeFileSync(`${walDb}-wal`, Buffer.from([1, 2, 3, 4]));
  const refused = await parseError(call("live_library_search", { ...filesArgs, database: walDb }));
  assert.equal(refused.toolError.unavailable, true);
  assert.match(refused.toolError.reason, /WAL/);
  writeFileSync(`${walDb}-wal`, Buffer.alloc(0));
  const allowed = await parse(call("live_library_search", { ...filesArgs, database: walDb }));
  assert.equal(allowed.databaseVersion, 12300, "a fully checkpointed WAL-mode database reads from the main file");
});

test("library search never writes to any Live file", async (t) => {
  const { call, parse, root, filesDb, pluginsDb, filesArgs } = connectedHost();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { readdirSync } = await import("node:fs");
  const beforeFiles = readFileSync(filesDb);
  const beforePlugins = readFileSync(pluginsDb);
  const beforeListing = readdirSync(root).sort();
  await parse(call("live_library_search", filesArgs));
  await parse(call("live_library_search", { ...filesArgs, mode: "tags" }));
  await parse(call("live_library_search", { ...filesArgs, mode: "plugins", pluginsDatabase: pluginsDb }));
  assert.deepEqual(readFileSync(filesDb), beforeFiles, "the files database is byte-identical after queries");
  assert.deepEqual(readFileSync(pluginsDb), beforePlugins, "the plug-ins database is byte-identical after queries");
  assert.deepEqual(readdirSync(root).sort(), beforeListing, "no journals, WAL files, or other artifacts are created");
});

test("results redact the database path and owner allowlist root", async (t) => {
  const { call, parse, root, filesArgs } = connectedHost();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const response = await parse(call("live_library_search", filesArgs));
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes(root), false, "the allowlist root never appears in results");
  assert.equal(serialized.includes("Live-files-12300.db"), false, "the database path never appears in results");
  assert.deepEqual(response.privacy.redacted, ["database", "allowlistRoot", "pluginsDatabase", "plugin_modules.path"]);
});
