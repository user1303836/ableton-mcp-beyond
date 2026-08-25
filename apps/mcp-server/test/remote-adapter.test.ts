import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { READ_ONLY_INVOKES, RemoteScriptLiveAdapter } from "../src/bridge/remote-adapter.js";
import { LIVE_REGISTRY_HASH } from "../src/live.js";

const secret = "0123456789abcdef0123456789abcdef";
const bridgeEpoch = "bridge-epoch-0123456789abcdef";
const challenge = "connection-challenge-0123456789abcdef";
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") { const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`; }
  return JSON.stringify(value);
};
const signed = (value: Record<string, unknown>): string => createHmac("sha256", secret).update(canonical(value)).digest("base64url");
const response = (id: string, result: unknown, ok = true) => {
  const base = { version: "ableton-loopback/v1", id, ok, bridgeEpoch, connectionChallenge: challenge, ...(ok ? { result } : { error: String(result) }) };
  return { ...base, mac: signed(base) };
};
const hello = () => response("hello", { protocol: "ableton-live/v1", registryHash: LIVE_REGISTRY_HASH, maxDeadlineMs: 60_000 });
const requiredOperations = ["status", "snapshot", "discover", "get", "reconnect", "session.playback"];
const status = (overrides: Record<string, unknown> = {}) => ({ connected: true, adapter: "remote-script", epoch: 1, protocol: "ableton-live/v1", capabilities: [], registryHash: LIVE_REGISTRY_HASH, operations: requiredOperations, provenance: "fake-live", ...overrides });

function framedServer(handler: (request: Record<string, unknown>, socket: Socket) => void) {
  return createServer((socket) => {
    socket.write(`${JSON.stringify(hello())}\n`);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (line) handler(JSON.parse(line) as Record<string, unknown>, socket);
      }
    });
  });
}
async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port;
}
async function close(server: ReturnType<typeof createServer>): Promise<void> { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }


test("remote adapter fails closed before opening non-loopback or weakly authenticated endpoints", async () => {
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "192.168.1.10", port: 9000, secret }), /loopback/);
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.999.0.1", port: 9000, secret }), /loopback/);
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.2", port: 9000, secret }), /loopback/);
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: 9000, secret: "short" }), /strong secret/);
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: 0, secret }), /loopback/);
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "localhost", port: 9000, secret }), /loopback/);
});

test("remote adapter requires an authenticated registry-bound server hello", async () => {
  const server = createServer((socket) => {
    const invalid = { ...hello(), connectionChallenge: "forged-connection-challenge" };
    socket.write(`${JSON.stringify(invalid)}\n`);
  });
  const port = await listen(server);
  try { await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 200 }), /authentication|hello/); }
  finally { await close(server); }
});

test("remote adapter rejects an invalid negotiated status", async () => {
  const server = framedServer((request, socket) => socket.write(`${JSON.stringify(response(request.id as string, status({ epoch: -1, capabilities: [42] })))}\n`));
  const port = await listen(server);
  try { await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 200 }), /registry|handshake|type|bounds/); }
  finally { await close(server); }
});

test("remote adapter rejects forged or operation-inconsistent capabilities", async () => {
  for (const capabilities of [["session.write"], ["max"], ["transport"], ["warp"], ["takes"]]) {
    const server = framedServer((request, socket) => socket.write(`${JSON.stringify(response(request.id as string, status({ capabilities })))}\n`));
    const port = await listen(server);
    try { await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 200 }), /handshake or negotiation/); }
    finally { await close(server); }
  }
});

test("remote adapter accepts locator-derived arrangement capabilities with canonical operation names", async () => {
  const server = framedServer((request, socket) => socket.write(`${JSON.stringify(response(request.id as string, status({ capabilities: ["arrangement.read", "arrangement.write"], operations: [...requiredOperations, "locator.add", "locator.delete"] })))}\n`));
  const port = await listen(server);
  let adapter: RemoteScriptLiveAdapter | undefined;
  try { adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 200 }); assert.equal(adapter.status().connected, true); }
  finally { await adapter?.close(); await close(server); }
});

test("remote adapter rejects a registry operation outside the canonical set", async () => {
  const server = framedServer((request, socket) => socket.write(`${JSON.stringify(response(request.id as string, status({ operations: [...requiredOperations, "forged.operation"] })))}\n`));
  const port = await listen(server);
  try { await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 200 }), /handshake or negotiation/); }
  finally { await close(server); }
});

test("remote adapter delegates discovery with exhaustive kind translation and schema validation", async () => {
  const seen: Record<string, unknown>[] = [];
  const server = framedServer((request, socket) => {
    seen.push(request);
    if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status()))}\n`);
    else socket.write(`${JSON.stringify(response(request.id as string, { epoch: 1, items: [], truncated: false, revision: "1:return_track:0", kind: "return_track" }))}\n`);
  });
  const port = await listen(server);
  try {
    const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 });
    const result = await adapter.discoverAsync({ kind: "return-track", parent: "set:one", filter: { name: "A" }, fields: ["name"], budget: 50, limit: 4, cursor: "cursor" });
    assert.equal(result.kind, "return-track");
    assert.deepEqual(seen[1]?.args, { kind: "return_track", parent: "set:one", filters: { name: "A" }, requestedFields: ["name"], traversalBudget: 50, limit: 4, cursor: "cursor" });
    await adapter.close();
  } finally { await close(server); }
});

test("remote adapter obtains mutation preflight authority with stable transaction idempotency", async () => {
  const seen: Record<string, unknown>[] = []; const idempotencyKeys: unknown[] = [];
  const server = framedServer((request, socket) => {
    seen.push(request);
    if (request.method === "status") { socket.write(`${JSON.stringify(response(request.id as string, status({ operations: [...requiredOperations, "scene.capture"] })))}\n`); return; }
    const argsDigest = createHash("sha256").update(canonical(request.args ?? {})).digest("hex");
    if (request.method === "preflight") socket.write(`${JSON.stringify(response(request.id as string, { preflightToken: "p".repeat(32), confirmation: "c".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), impact: "mutates-live", expiresAt: Date.now() + 5000 }))}\n`);
    else if (request.method === "prepare") { idempotencyKeys.push(request.idempotencyKey); socket.write(`${JSON.stringify(response(request.id as string, { authorityToken: "t".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), expiresAt: Date.now() + 5000 }))}\n`); }
    else socket.write(`${JSON.stringify(response(request.id as string, { captured: true, ref: "1:scene:captured", objectIdentity: "live:captured-scene", createdFingerprint: "f".repeat(64), ownershipToken: "o".repeat(48) }))}\n`);
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 });
    const context = { deadlineMs: Date.now() + 5000, idempotencyKey: "scene-capture-apply-key", transactionId: "host-scene-capture-transaction" };
    await adapter.invokeAsync({ operation: "scene.capture", args: { expectedStateRevision: "a".repeat(64) } }, context); await adapter.invokeAsync({ operation: "scene.capture", args: { expectedStateRevision: "a".repeat(64) } }, context);
    await adapter.invokeAsync({ operation: "scene.capture", args: { expectedStateRevision: "a".repeat(64) } }, { ...context, transactionId: "second-scene-capture-transaction" });
    assert.deepEqual(seen.map((item) => item.method), ["status", "preflight", "prepare", "invoke", "preflight", "prepare", "invoke", "preflight", "prepare", "invoke"]);
    assert.equal(idempotencyKeys.length, 3); assert.equal(idempotencyKeys[0], idempotencyKeys[1]); assert.notEqual(idempotencyKeys[1], idempotencyKeys[2]);
  } finally { await adapter?.close(); await close(server); }
});

test("remote adapter hides cleanup tokens and binds destructive cleanup to the creating transaction", async () => {
  const seen: Record<string, unknown>[] = []; const token = "o".repeat(48);
  const server = framedServer((request, socket) => { seen.push(request); if (request.method === "status") { socket.write(`${JSON.stringify(response(request.id as string, status({ operations: [...requiredOperations, "track.create", "track.delete"] })))}\n`); return; } if (request.method === "retire") { socket.write(`${JSON.stringify(response(request.id as string, { retired: 1 }))}\n`); return; } const argsDigest = createHash("sha256").update(canonical(request.args ?? {})).digest("hex"); if (request.method === "preflight") socket.write(`${JSON.stringify(response(request.id as string, { preflightToken: "p".repeat(32), confirmation: "c".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), impact: "mutates-live", expiresAt: Date.now() + 5000 }))}\n`); else if (request.method === "prepare") socket.write(`${JSON.stringify(response(request.id as string, { authorityToken: "t".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), expiresAt: Date.now() + 5000 }))}\n`); else if (request.operation === "track.create") socket.write(`${JSON.stringify(response(request.id as string, { ref: "1:track:1", objectIdentity: "live:track:1", name: "Owned", kind: "midi", index: 1, createdFingerprint: "f".repeat(64), ownershipToken: token }))}\n`); else { assert.equal(request.ownershipToken, token); socket.write(`${JSON.stringify(response(request.id as string, { deleted: "1:track:1" }))}\n`); } });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined; const transactionId = "creating-structure-transaction";
  try { adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 }); const created = await adapter.invokeAsync({ operation: "track.create", args: { name: "Owned", kind: "midi", index: 1, expectedStructureRevision: "a".repeat(64) } }, { deadlineMs: Date.now() + 1000, idempotencyKey: "create-owned-track", transactionId }) as Record<string, unknown>; assert.equal(created.ownershipToken, undefined); await adapter.retireTransactionAsync(transactionId, { deadlineMs: Date.now() + 1000 }); const deleteInvocation = { operation: "track.delete" as const, args: { ref: "1:track:1", expectedStructureRevision: "b".repeat(64), expectedObjectIdentity: "live:track:1" } }; await assert.rejects(adapter.invokeAsync(deleteInvocation, { deadlineMs: Date.now() + 1000, idempotencyKey: "foreign-delete", transactionId: "foreign-structure-transaction" }), /lacks transaction-owned authority/); const beforeDelete = seen.length; assert.deepEqual(await adapter.invokeAsync(deleteInvocation, { deadlineMs: Date.now() + 1000, idempotencyKey: "owned-delete", transactionId }), { deleted: "1:track:1" }); assert.equal(seen.slice(beforeDelete).filter((row) => ["preflight", "prepare", "invoke"].includes(String(row.method))).every((row) => row.ownershipToken === token), true); }
  finally { await adapter?.close(); await close(server); }
});

test("remote adapter retains and strips audio-clip creation tokens across create, replay, and owned undo", async () => {
  const seen: Record<string, unknown>[] = []; const token = "a".repeat(48);
  const server = framedServer((request, socket) => {
    seen.push(request);
    if (request.method === "status") { socket.write(`${JSON.stringify(response(request.id as string, status({ operations: [...requiredOperations, "session.audio-clip.create", "clip.delete"] })))}\n`); return; }
    if (request.method === "retire") { socket.write(`${JSON.stringify(response(request.id as string, { retired: 1 }))}\n`); return; }
    const argsDigest = createHash("sha256").update(canonical(request.args ?? {})).digest("hex");
    if (request.method === "preflight") socket.write(`${JSON.stringify(response(request.id as string, { preflightToken: "p".repeat(32), confirmation: "c".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), impact: "mutates-live", expiresAt: Date.now() + 5000 }))}\n`);
    else if (request.method === "prepare") socket.write(`${JSON.stringify(response(request.id as string, { authorityToken: "t".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), expiresAt: Date.now() + 5000 }))}\n`);
    else if (request.operation === "session.audio-clip.create") { socket.write(`${JSON.stringify(response(request.id as string, { ref: "1:clip:0:1", objectIdentity: "live:clip:0:1", name: "Imported", length: 4, filePath: "/tmp/staged.wav", createdFingerprint: "f".repeat(64), ownershipToken: token }))}\n`); }
    else { assert.equal(request.ownershipToken, token); socket.write(`${JSON.stringify(response(request.id as string, { deleted: "1:clip:0:1" }))}\n`); }
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined; const transactionId = "creating-audio-import-transaction";
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 });
    const createArgs = { trackRef: "1:track:0", sceneIndex: 1, filePath: "/tmp/staged.wav", expectedTrackIdentity: "live:track:0", expectedSlotRef: "1:clip_slot:0:1", expectedSlotIdentity: "live:slot:0:1", expectedSceneRef: "1:scene:1", expectedSceneIdentity: "live:scene:1" };
    const created = await adapter.invokeAsync({ operation: "session.audio-clip.create", args: createArgs }, { deadlineMs: Date.now() + 1000, idempotencyKey: "create-owned-audio-clip", transactionId }) as Record<string, unknown>;
    assert.equal(created.ownershipToken, undefined, "the cleanup token is never leaked into results");
    const replayed = await adapter.invokeAsync({ operation: "session.audio-clip.create", args: createArgs }, { deadlineMs: Date.now() + 1000, idempotencyKey: "create-owned-audio-clip", transactionId }) as Record<string, unknown>;
    assert.equal(replayed.ownershipToken, undefined);
    const deleteInvocation = { operation: "clip.delete" as const, args: { ref: "1:clip:0:1", expectedObjectIdentity: "live:clip:0:1", expectedTrackRef: "1:track:0", expectedTrackIdentity: "live:track:0", expectedSlotRef: "1:clip_slot:0:1", expectedSlotIdentity: "live:slot:0:1", expectedSceneRef: "1:scene:1", expectedSceneIdentity: "live:scene:1" } };
    await assert.rejects(adapter.invokeAsync(deleteInvocation, { deadlineMs: Date.now() + 1000, idempotencyKey: "foreign-clip-delete", transactionId: "foreign-audio-transaction" }), /lacks transaction-owned authority/);
    const beforeDelete = seen.length;
    assert.deepEqual(await adapter.invokeAsync(deleteInvocation, { deadlineMs: Date.now() + 1000, idempotencyKey: "owned-clip-delete", transactionId }), { deleted: "1:clip:0:1" });
    assert.equal(seen.slice(beforeDelete).filter((row) => ["preflight", "prepare", "invoke"].includes(String(row.method))).every((row) => row.ownershipToken === token), true);
  }
  finally { await adapter?.close(); await close(server); }
});

test("remote adapter reconnects to the same bridge epoch and reconciles a lost mutation acknowledgement", async () => {
  let executed = false; let executions = 0; let dropFirst = true;
  const result = { captured: true, ref: "1:scene:captured", objectIdentity: "live:captured-scene", createdFingerprint: "f".repeat(64) }; const wireResult = { ...result, ownershipToken: "o".repeat(48) };
  const server = framedServer((request, socket) => {
    if (request.method === "status") { socket.write(`${JSON.stringify(response(request.id as string, status({ operations: [...requiredOperations, "scene.capture"] })))}\n`); return; }
    if (request.method === "retire") { assert.equal(request.transactionId, "lost-ack-transaction"); socket.write(`${JSON.stringify(response(request.id as string, { retired: 1 }))}\n`); return; }
    const argsDigest = createHash("sha256").update(canonical(request.args ?? {})).digest("hex");
    if (request.method === "preflight") { socket.write(`${JSON.stringify(response(request.id as string, { preflightToken: "p".repeat(32), confirmation: "c".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), impact: "mutates-live", expiresAt: Date.now() + 5000 }))}\n`); return; }
    if (request.method === "prepare") { socket.write(`${JSON.stringify(response(request.id as string, { authorityToken: "t".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), expiresAt: Date.now() + 5000 }))}\n`); return; }
    if (!executed) { executed = true; executions += 1; }
    if (dropFirst) { dropFirst = false; socket.destroy(); return; }
    socket.write(`${JSON.stringify(response(request.id as string, wireResult))}\n`);
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 }); const context = { deadlineMs: Date.now() + 5000, idempotencyKey: "lost-ack-key", transactionId: "lost-ack-transaction" }; const invocation = { operation: "scene.capture" as const, args: { expectedStateRevision: "a".repeat(64) } };
    await assert.rejects(adapter.invokeAsync(invocation, context), /disconnected|uncertain/);
    const reconciled = await adapter.invokeAsync(invocation, { ...context, deadlineMs: Date.now() + 5000 }); assert.deepEqual(reconciled, result); assert.equal(executions, 1); assert.deepEqual(await adapter.retireTransactionAsync("lost-ack-transaction", { deadlineMs: Date.now() + 5000 }), { retired: 1 });
  } finally { await adapter?.close(); await close(server); }
});

test("remote adapter refuses reconciliation after the Live epoch changes", async () => {
  let connection = 0;
  const server = createServer((socket) => {
    connection += 1; const generation = connection; socket.write(`${JSON.stringify(hello())}\n`); let buffer = "";
    socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); while (buffer.includes("\n")) { const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue; const request = JSON.parse(line) as Record<string, unknown>;
      if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status({ epoch: generation })))}\n`); else if (generation === 1) socket.destroy(); else socket.write(`${JSON.stringify(response(request.id as string, { set: {}, tracks: [], scenes: [], arrangement: {}, playback: {} }))}\n`);
    } });
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try { adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 }); await assert.rejects(adapter.snapshotAsync({ deadlineMs: Date.now() + 2000 }), /disconnected|uncertain/); await assert.rejects(adapter.snapshotAsync({ deadlineMs: Date.now() + 2000 }), /Live epoch changed/); assert.equal(adapter.status().connected, false); await assert.rejects(adapter.snapshotAsync({ deadlineMs: Date.now() + 2000 }), /poisoned/); }
  finally { await adapter?.close(); await close(server); }
});

test("remote adapter remains poisoned after a replacement bridge reports the same Live epoch", async () => {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1; const generation = connections; const epoch = `bridge-epoch-generation-${generation}-0123456789`; const send = (id: string, result: unknown) => { const base = { version: "ableton-loopback/v1", id, ok: true, bridgeEpoch: epoch, connectionChallenge: challenge, result }; socket.write(`${JSON.stringify({ ...base, mac: signed(base) })}\n`); }; send("hello", { protocol: "ableton-live/v1", registryHash: LIVE_REGISTRY_HASH, maxDeadlineMs: 60_000 }); let buffer = "";
    socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); while (buffer.includes("\n")) { const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue; const request = JSON.parse(line) as Record<string, unknown>; if (request.method === "status") send(request.id as string, status({ epoch: 1 })); else if (generation === 1) socket.destroy(); else send(request.id as string, { set: {}, tracks: [], scenes: [], arrangement: {}, playback: {} }); } });
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try { adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 }); await assert.rejects(adapter.snapshotAsync({ deadlineMs: Date.now() + 2000 }), /disconnected|uncertain/); await assert.rejects(adapter.snapshotAsync({ deadlineMs: Date.now() + 2000 }), /bridge or Live epoch changed/); await assert.rejects(adapter.snapshotAsync({ deadlineMs: Date.now() + 2000 }), /poisoned/); assert.equal(connections, 2); }
  finally { await adapter?.close(); await close(server); }
});

test("remote adapter restores subscriptions with a reset after same-epoch reconnect", async () => {
  let connections = 0; let subscriptions = 0; const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket); connections += 1; const generation = connections; socket.write(`${JSON.stringify(hello())}\n`); let buffer = "";
    socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); while (buffer.includes("\n")) { const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue; const request = JSON.parse(line) as Record<string, unknown>;
      if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status({ capabilities: ["subscriptions"], operations: [...requiredOperations, "subscribe"] })))}\n`);
      else if (request.method === "subscribe") { subscriptions += 1; const subscribed = response(request.id as string, { subscribed: true, subscriptionId: `subscription-${subscriptions}` }); const event = response("event", { event: { epoch: 1, sequence: 1, type: "reset", payload: { resnapshot: true } } }); socket.write(`${JSON.stringify(subscribed)}\n${JSON.stringify(event)}\n`); if (generation === 1) setTimeout(() => socket.destroy(), 5); }
    } });
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 }); const events: unknown[] = []; adapter.subscribe((event) => events.push(event)); const statusChanges: string[] = []; const adapterWithStatus = adapter as unknown as { subscribeStatus?: (listener: (status: { connected: boolean }) => void) => void }; adapterWithStatus.subscribeStatus?.((status) => statusChanges.push(String(status.connected))); await adapter.invokeAsync({ operation: "subscribe", args: { types: ["transport"] } }, { deadlineMs: Date.now() + 1000 }); await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(adapter.status().connected, false);
    assert.deepEqual(statusChanges, ["false"], "the internal status channel reports the disconnect without manufacturing a LiveEvent");
    const refreshed = await adapter.refreshStatusAsync({ deadlineMs: Date.now() + 1000 }); assert.equal(refreshed.connected, true); await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(subscriptions, 2); assert.equal(events.length, 2); assert.deepEqual(events.map((event) => (event as { type: string }).type), ["reset", "reset"]); assert.deepEqual(statusChanges, ["false", "true"]);
  } finally { await adapter?.close(); for (const socket of sockets) socket.destroy(); await close(server); }
});

test("remote adapter reconnect obeys caller cancellation and absolute deadline", async () => {
  let connections = 0; const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); connections += 1; const generation = connections; if (generation === 1) socket.write(`${JSON.stringify(hello())}\n`); let buffer = ""; socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); while (buffer.includes("\n")) { const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue; const request = JSON.parse(line) as Record<string, unknown>; if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status()))}\n`); else socket.destroy(); } }); });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 1000 }); await assert.rejects(adapter.snapshotAsync({ deadlineMs: Date.now() + 1000 }), /disconnected|uncertain/); const started = Date.now(); await assert.rejects(adapter.refreshStatusAsync({ deadlineMs: Date.now() + 50 }), /deadline|timed out/); assert.ok(Date.now() - started < 500);
    const controller = new AbortController(); const cancelled = adapter.refreshStatusAsync({ deadlineMs: Date.now() + 1000, signal: controller.signal }); controller.abort(); await assert.rejects(cancelled, /cancelled/);
  } finally { await adapter?.close(); for (const socket of sockets) socket.destroy(); await close(server); }
});

test("concurrent reconnect callers retain independent deadlines", async () => {
  let connections = 0; const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); connections += 1; const generation = connections; const start = () => { socket.write(`${JSON.stringify(hello())}\n`); let buffer = ""; socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); while (buffer.includes("\n")) { const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue; const request = JSON.parse(line) as Record<string, unknown>; if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status()))}\n`); else socket.destroy(); } }); }; if (generation === 1) start(); else setTimeout(start, 100); });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try { adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 1000 }); await assert.rejects(adapter.snapshotAsync({ deadlineMs: Date.now() + 1000 }), /disconnected|uncertain/); const short = adapter.refreshStatusAsync({ deadlineMs: Date.now() + 40 }); const long = adapter.refreshStatusAsync({ deadlineMs: Date.now() + 500 }); await assert.rejects(short, /deadline/); assert.equal((await long).connected, true); assert.equal(connections, 2); }
  finally { await adapter?.close(); for (const socket of sockets) socket.destroy(); await close(server); }
});

test("a rejected subscribe attempt preserves the active event sequence", async () => {
  let activeSocket: Socket | undefined; const server = framedServer((request, socket) => { activeSocket = socket; if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status({ capabilities: ["subscriptions"], operations: [...requiredOperations, "subscribe"] })))}\n`); else if (request.method === "subscribe") { const subscribed = response(request.id as string, { subscribed: true, subscriptionId: "subscription-one" }); const reset = response("event", { event: { epoch: 1, sequence: 1, type: "reset", payload: { resnapshot: true } } }); socket.write(`${JSON.stringify(subscribed)}\n${JSON.stringify(reset)}\n`); } });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try { adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 }); const events: unknown[] = []; let receivedTransport!: () => void; const transportReceived = new Promise<void>((resolve) => { receivedTransport = resolve; }); adapter.subscribe((event) => { events.push(event); if (event.type === "transport") receivedTransport(); }); await adapter.invokeAsync({ operation: "subscribe", args: { types: ["transport"] } }, { deadlineMs: Date.now() + 500 }); await assert.rejects(adapter.invokeAsync({ operation: "subscribe", args: { types: ["transport"] } }, { deadlineMs: Date.now() - 1 }), /deadline/); activeSocket?.write(`${JSON.stringify(response("event", { event: { epoch: 1, sequence: 2, type: "transport", payload: { playing: false } } }))}\n`); let timeout: NodeJS.Timeout | undefined; try { await Promise.race([transportReceived, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("transport event was not delivered")), 500); })]); } finally { if (timeout) clearTimeout(timeout); } assert.equal(events.length, 2); assert.equal((events[1] as { type: string }).type, "transport"); assert.equal(adapter.status().connected, true); }
  finally { await adapter?.close(); await close(server); }
});

test("remote adapter authenticates a maximum 512-note canonical batch and result", async () => {
  const notes = Array.from({ length: 512 }, (_, index) => ({ pitch: index % 128, start: index, duration: 0.25, velocity: 100, channel: 1 }));
  const noteIds = Array.from({ length: 512 }, (_, index) => index);
  const server = framedServer((request, socket) => {
    if (request.method === "status") { socket.write(`${JSON.stringify(response(request.id as string, status({ operations: [...requiredOperations, "note.add-batch"] })))}\n`); return; }
    const argsDigest = createHash("sha256").update(canonical(request.args ?? {})).digest("hex");
    if (request.method === "preflight") socket.write(`${JSON.stringify(response(request.id as string, { preflightToken: "p".repeat(32), confirmation: "c".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), impact: "mutates-live", expiresAt: Date.now() + 5000 }))}\n`);
    else if (request.method === "prepare") socket.write(`${JSON.stringify(response(request.id as string, { authorityToken: "t".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), expiresAt: Date.now() + 5000 }))}\n`);
    else socket.write(`${JSON.stringify(response(request.id as string, { added: 512, noteIds, notesRevision: "b".repeat(64) }))}\n`);
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 1000 });
    const result = await adapter.invokeAsync({ operation: "note.add-batch", args: { ref: "1:clip:0:0", notes, expectedClipAuthority: { expectedObjectIdentity: "live:clip:0", expectedTrackRef: "1:track:0", expectedTrackIdentity: "live:track:0", expectedSlotRef: "1:clip_slot:0:0", expectedSlotIdentity: "live:slot:0", expectedSceneRef: "1:scene:0", expectedSceneIdentity: "live:scene:0" }, expectedNotesRevision: "a".repeat(64) } }, { deadlineMs: Date.now() + 5000, idempotencyKey: "maximum-note-batch", transactionId: "maximum-note-batch-transaction" }) as { added: number; noteIds: number[] };
    assert.equal(result.added, 512); assert.equal(result.noteIds.length, 512);
  } finally { await adapter?.close(); await close(server); }
});

test("an explicit bounded deadline extends the configured default request timeout", async () => {
  let requests = 0;
  const server = framedServer((request, socket) => {
    const send = () => socket.write(`${JSON.stringify(response(request.id as string, status()))}\n`);
    if (requests++ === 0) send(); else setTimeout(send, 80);
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 30 });
    const started = Date.now(); const refreshed = await adapter.refreshStatusAsync({ deadlineMs: Date.now() + 500 });
    assert.equal(refreshed.connected, true); assert.ok(Date.now() - started >= 60);
  } finally { await adapter?.close(); await close(server); }
});

test("remote adapter closes the session on timeout and reports post-dispatch uncertainty", async () => {
  const sockets = new Set<Socket>();
  const server = framedServer((request, socket) => { sockets.add(socket); if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status()))}\n`); });
  const port = await listen(server);
  try {
    const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 50 });
    await assert.rejects(adapter.snapshotAsync(), /uncertain after dispatch timeout|disconnected/); assert.equal(adapter.status().connected, false);
  } finally { for (const socket of sockets) socket.destroy(); await close(server); }
});

test("remote adapter distinguishes pre-dispatch cancellation from post-dispatch ambiguity", async () => {
  const sockets = new Set<Socket>();
  const server = framedServer((request, socket) => { sockets.add(socket); if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status()))}\n`); });
  const port = await listen(server);
  try {
    const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 });
    const before = new AbortController(); before.abort();
    await assert.rejects(adapter.snapshotAsync({ signal: before.signal, deadlineMs: Date.now() + 500 }), /cancelled before dispatch/);
    const after = new AbortController(); const pending = adapter.snapshotAsync({ signal: after.signal, deadlineMs: Date.now() + 500 }); await new Promise((resolve) => setImmediate(resolve)); after.abort();
    await assert.rejects(pending, /uncertain after dispatch cancellation/);
  } finally { for (const socket of sockets) socket.destroy(); await close(server); }
});

test("remote adapter reports connection refusal as unavailable evidence", async () => {
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: 65534, secret, timeoutMs: 25 }), /ECONNREFUSED|connect/);
});

test("remote adapter tears down on an authenticated unknown response", async () => {
  const server = framedServer((request, socket) => {
    const id = request.method === "status" ? request.id as string : "unknown";
    socket.write(`${JSON.stringify(response(id, request.method === "status" ? status() : {}))}\n`);
  });
  const port = await listen(server);
  try {
    const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 200 });
    await assert.rejects(adapter.snapshotAsync(), /unknown or duplicate remote response|disconnected/);
    await adapter.close();
  } finally { await close(server); }
});

test("read-only invoke classification is identical across the TS adapter and the Python mapper", () => {
  // The two classifiers decide whether an invoke needs mutation authority
  // preflight/prepare; drift strands prepared authorities in the bridge ledger
  // and eventually exhausts it.
  const pythonPath = ["../../../remote-script/ableton_mcp_remote_script.py", "../../../../remote-script/ableton_mcp_remote_script.py"].map((candidate) => fileURLToPath(new URL(candidate, import.meta.url))).find((candidate) => { try { readFileSync(candidate); return true; } catch { return false; } });
  const python = readFileSync(pythonPath!, "utf8");
  const match = python.match(/_READ_ONLY_INVOKES = \{([^}]*)\}/);
  assert.ok(match, "python read-only invoke set not found");
  const pythonSet = new Set([...match[1]!.matchAll(/"([^"]+)"/g)].map((item) => item[1]));
  assert.deepEqual([...pythonSet].sort(), [...READ_ONLY_INVOKES].sort());
});
