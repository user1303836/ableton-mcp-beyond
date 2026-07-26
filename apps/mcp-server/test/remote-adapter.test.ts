import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { test } from "node:test";
import { RemoteScriptLiveAdapter } from "../src/bridge/remote-adapter.js";
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
const requiredOperations = ["status", "snapshot", "discover", "get", "set", "reconnect", "session.playback"];
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

test("remote adapter closes the session on timeout and reports post-dispatch uncertainty", async () => {
  const sockets = new Set<Socket>();
  const server = framedServer((request, socket) => { sockets.add(socket); if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status()))}\n`); });
  const port = await listen(server);
  try {
    const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 50 });
    await assert.rejects(adapter.snapshotAsync(), /uncertain after dispatch timeout|disconnected/);
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
    const after = new AbortController(); const pending = adapter.snapshotAsync({ signal: after.signal, deadlineMs: Date.now() + 500 }); after.abort();
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
