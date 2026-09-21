import assert from "node:assert/strict";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator } from "../src/live.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

const RANKING_CATALOG = [
  { id: "drums/Kick 909 Core", objectIdentity: "simulator:browser:drums/Kick 909 Core", name: "Kick 909 Core", category: "drums", path: "drums/Kick 909 Core", isDevice: false },
  { id: "drums/Core Kick Vintage", objectIdentity: "simulator:browser:drums/Core Kick Vintage", name: "Core Kick Vintage", category: "drums", path: "drums/Core Kick Vintage", isDevice: false },
  { id: "drums/Snare Tight", objectIdentity: "simulator:browser:drums/Snare Tight", name: "Snare Tight", category: "drums", path: "drums/Snare Tight", isDevice: false },
  { id: "drums/Keys of the Vintage", objectIdentity: "simulator:browser:drums/Keys of the Vintage", name: "Keys of the Vintage", category: "drums", path: "drums/Keys of the Vintage", isDevice: false },
  { id: "instruments/Kick Synth", objectIdentity: "simulator:browser:instruments/Kick Synth", name: "Kick Synth", category: "instruments", path: "instruments/Kick Synth", isDevice: true },
];

function connectedHost(catalog?: unknown[]) {
  const simulator = new DeterministicLiveSimulator();
  if (catalog) (simulator as any).browserCatalog = () => catalog;
  const host = new McpHost(simulator);
  host.handle(initialize); host.handle(initialized);
  let requestId = 900;
  const call = (name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } });
  const parse = async (promise: Promise<unknown>) => {
    const frame = (await promise) as any;
    if (frame.error) throw new Error(`unexpected protocol error: ${JSON.stringify(frame.error)}`);
    return JSON.parse(frame.result.content[0].text);
  };
  return { simulator, host, call, parse };
}

test("ranked search matches multi-term queries order-independently with documented scores", async () => {
  const { call, parse } = connectedHost(RANKING_CATALOG);
  const forward = await parse(call("live_browser_search", { category: "drums", query: "909 kick" }));
  const reversed = await parse(call("live_browser_search", { category: "drums", query: "kick 909" }));
  assert.equal(forward.matchMode, "ranked");
  assert.deepEqual(forward.tokens, ["909", "kick"]);
  assert.equal(forward.items[0].id, "drums/Kick 909 Core");
  // exact name-word matches (30+30) + path presence (4+4) + full coverage (25)
  assert.equal(forward.items[0].score, 93);
  assert.deepEqual(forward.items[0].match.matchedTokens, ["909", "kick"]);
  assert.equal(forward.items[0].match.exactNameMatch, false);
  // tokenization is order-independent, so the same items rank in the same order;
  // the reversed wording additionally wins the exact-phrase boost (100) because
  // "kick 909" is a literal substring of "Kick 909 Core"
  assert.deepEqual(reversed.items.map((item: any) => item.id), forward.items.map((item: any) => item.id));
  assert.equal(reversed.items[0].score, 193);
  // word-order variant: "vintage keys" matches "Keys of the Vintage"
  const vintage = await parse(call("live_browser_search", { category: "drums", query: "vintage keys" }));
  assert.equal(vintage.items[0].id, "drums/Keys of the Vintage");
  assert.deepEqual(vintage.items[0].match.matchedTokens, ["vintage", "keys"]);
  // the exact phrase wins over scattered token matches
  const phrase = await parse(call("live_browser_search", { category: "drums", query: "core kick" }));
  assert.equal(phrase.items[0].id, "drums/Core Kick Vintage");
  assert.equal(phrase.items[0].match.exactNameMatch, true);
  assert.equal(phrase.items[0].score, 100 + 30 + 30 + 4 + 4 + 25);
  // unmatched items are excluded; a prefix-only token ranks below an exact word match
  const prefix = await parse(call("live_browser_search", { category: "drums", query: "kick" }));
  assert.ok(prefix.items.every((item: any) => item.name.toLowerCase().includes("kick")));
  assert.equal(prefix.items[0].score, 100 + 30 + 4 + 25, "exact word + phrase boost + coverage");
  const prefixOnly = await parse(call("live_browser_search", { category: "drums", query: "vin" }));
  assert.equal(prefixOnly.items.length, 2);
  assert.equal(prefixOnly.items[0].score, 100 + 18 + 4 + 25, "name-word prefix + phrase boost + coverage, below an exact word match");
});

test("ranked search reports cache provenance, refresh semantics, and epoch invalidation", async () => {
  const { simulator, call, parse } = connectedHost(RANKING_CATALOG);
  let traversals = 0;
  const original = simulator.invokeAsync.bind(simulator);
  simulator.invokeAsync = async (invocation: any) => { if (invocation.operation === "browser.search") traversals += 1; return original(invocation); };
  const first = await parse(call("live_browser_search", { category: "drums", query: "kick" }));
  assert.equal(first.fromCache, false);
  assert.equal(first.cacheTtlSeconds, 60);
  assert.equal(first.candidates, 4);
  assert.equal(first.candidateBound, 100);
  assert.equal(first.candidateBoundReached, false);
  assert.deepEqual(first.searchedRoots, ["drums"]);
  assert.equal(traversals, 1);
  const second = await parse(call("live_browser_search", { category: "drums", query: "snare" }));
  assert.equal(second.fromCache, true);
  assert.equal(second.cacheAgeSeconds, 0);
  assert.equal(traversals, 1, "a second root-equivalent search inside the TTL reuses the cached traversal");
  const refreshed = await parse(call("live_browser_search", { category: "drums", query: "snare", refresh: true }));
  assert.equal(refreshed.fromCache, false);
  assert.equal(traversals, 2, "refresh forces a fresh traversal");
  const otherRoot = await parse(call("live_browser_search", { category: "instruments", query: "kick" }));
  assert.equal(otherRoot.fromCache, false, "a different root has its own cache entry");
  assert.equal(traversals, 3);
  simulator.reconnect();
  const afterReconnect = await parse(call("live_browser_search", { category: "drums", query: "snare" }));
  assert.equal(afterReconnect.fromCache, false, "an epoch change invalidates every cached root");
  assert.equal(afterReconnect.epoch, 2);
  assert.equal(traversals, 4);
});

test("ranked search cache stays bounded and truncation is reported honestly", async () => {
  const { host, call, parse } = connectedHost(RANKING_CATALOG);
  const cache = (host as any).browserSearchCache as Map<string, unknown>;
  for (let index = 0; index < 16; index += 1) cache.set(`seed-${index}`, { items: [], fetchedAt: Date.now(), epoch: 1 });
  await parse(call("live_browser_search", { category: "drums", query: "kick" }));
  assert.ok(cache.size <= 16, `cache exceeded its bound: ${cache.size}`);
  const truncated = await parse(call("live_browser_search", { category: "drums", query: "kick", limit: 1, refresh: true }));
  assert.equal(truncated.items.length, 1);
  assert.equal(truncated.truncated, true, "matches beyond the limit are reported");
  const complete = await parse(call("live_browser_search", { category: "drums", query: "kick" }));
  assert.equal(complete.truncated, false);
  // a full candidate bound is reported as reached when the adapter returns the maximum
  const huge = Array.from({ length: 100 }, (_, index) => ({ id: `drums/Pad ${index}`, objectIdentity: `simulator:browser:drums/Pad ${index}`, name: `Pad ${index}`, category: "drums", path: `drums/Pad ${index}`, isDevice: false }));
  const bounded = connectedHost(huge);
  const reached = await bounded.parse(bounded.call("live_browser_search", { category: "drums", query: "pad" }));
  assert.equal(reached.candidates, 100);
  assert.equal(reached.candidateBoundReached, true);
});

test("substring mode preserves the legacy pass-through behavior exactly", async () => {
  const { call, parse } = connectedHost(RANKING_CATALOG);
  const legacy = await parse(call("live_browser_search", { category: "drums", query: "kick", matchMode: "substring" }));
  assert.deepEqual(Object.keys(legacy), ["items"]);
  assert.equal(legacy.items.length, 2);
  assert.equal(legacy.items[0].score, undefined, "substring results carry no host ranking metadata");
  // word-order variants still miss in substring mode, documenting the fallback
  const missed = await parse(call("live_browser_search", { category: "drums", query: "909 kick", matchMode: "substring" }));
  assert.equal(missed.items.length, 0);
  const ranked = await parse(call("live_browser_search", { category: "drums", query: "909 kick" }));
  assert.ok(ranked.items.length > 0, "ranked mode finds the word-order variant");
});

test("ranked search with an empty query returns the bounded candidate set deterministically", async () => {
  const { call, parse } = connectedHost(RANKING_CATALOG);
  const all = await parse(call("live_browser_search", { category: "drums", query: "" }));
  assert.equal(all.items.length, 4);
  assert.deepEqual(all.tokens, []);
  assert.ok(all.items.every((item: any) => item.score === 0));
  const again = await parse(call("live_browser_search", { category: "drums" }));
  assert.deepEqual(again.items.map((item: any) => item.id), all.items.map((item: any) => item.id));
});

test("browser search argument validation covers the new fields", async () => {
  const { call } = connectedHost(RANKING_CATALOG);
  for (const args of [
    { matchMode: "fuzzy" },
    { refresh: "yes" },
    { category: "sounds" },
    { limit: 0 },
    { query: "x".repeat(257) },
  ]) {
    const frame = (await call("live_browser_search", args)) as any;
    assert.equal(frame.error?.code, -32602, JSON.stringify(args));
  }
});

test("ranked search never weakens inspect/load identity fencing", async () => {
  const { call, parse } = connectedHost();
  const search = await parse(call("live_browser_search", { category: "instruments", query: "rack" }));
  assert.equal(search.items[0].id, "instruments/Drum Rack");
  const inspect = await parse(call("live_browser_inspect", { itemId: search.items[0].id }));
  const preview = await parse(call("live_browser_load_preview", { itemId: inspect.item.id, trackRef: "track:track-1" }));
  assert.ok(typeof preview.transactionId === "string");
  // non-device and unknown items remain non-loadable after ranked search
  const nonDevice = (await call("live_browser_load_preview", { itemId: "drums/Kick Core", trackRef: "track:track-1" })) as any;
  assert.equal(nonDevice.result.isError, true);
  const unknown = (await call("live_browser_load_preview", { itemId: "instruments/Nonexistent", trackRef: "track:track-1" })) as any;
  assert.equal(unknown.result.isError, true);
});
