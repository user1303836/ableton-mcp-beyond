import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { test } from "node:test";
import { RemoteScriptLiveAdapter } from "../src/bridge/remote-adapter.js";
import { LIVE_REGISTRY_HASH } from "../src/live.js";

const secret = "0123456789abcdef0123456789abcdef";
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") { const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`; }
  return JSON.stringify(value);
};
const signed = (value: Record<string, unknown>): string => createHmac("sha256", secret).update(canonical(value)).digest("base64url");

test("remote adapter fails closed before opening non-loopback or weakly authenticated endpoints", async () => {
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "192.168.1.10", port: 9000, secret: "0123456789abcdef0123456789abcdef" }), /loopback/);
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.999.0.1", port: 9000, secret: "0123456789abcdef0123456789abcdef" }), /loopback/);
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: 9000, secret: "short" }), /strong secret/);
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: 0, secret: "0123456789abcdef0123456789abcdef" }), /loopback/);
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "localhost", port: 9000, secret }), /loopback/);
});

test("remote adapter rejects an invalid negotiated status", async () => {
  const server = createServer((socket) => socket.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString("utf8")) as { id: string };
    const base = { version: "ableton-loopback/v1", id: request.id, ok: true, result: { connected: true, adapter: "remote-script", epoch: -1, protocol: "ableton-live/v1", capabilities: [42], registryHash: LIVE_REGISTRY_HASH, operations: ["status"] } };
    socket.write(`${JSON.stringify({ ...base, mac: signed(base) })}\n`);
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: address.port, secret, timeoutMs: 200 }), /handshake or negotiation/); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("remote adapter rejects a registry operation outside the canonical set", async () => {
  const server = createServer((socket) => socket.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString("utf8")) as { id: string };
    const base = { version: "ableton-loopback/v1", id: request.id, ok: true, result: { connected: true, adapter: "remote-script", epoch: 1, protocol: "ableton-live/v1", capabilities: [], registryHash: LIVE_REGISTRY_HASH, operations: ["status", "discover", "get", "set", "reconnect", "forged.operation"] } };
    socket.write(`${JSON.stringify({ ...base, mac: signed(base) })}\n`);
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: address.port, secret, timeoutMs: 200 }), /handshake or negotiation/); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("remote adapter closes the session on timeout instead of continuing a sequenced stream", async () => {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: address.port, secret, timeoutMs: 25 }), /timed out|disconnected/); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("remote adapter reports connection refusal as unavailable evidence", async () => {
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: 65534, secret, timeoutMs: 25 }), /ECONNREFUSED|connect/);
});

test("remote adapter tears down on an authenticated unknown response", async () => {
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const request = JSON.parse(buffer.slice(0, index)) as { id: string; method: string };
        buffer = buffer.slice(index + 1);
        const base = { version: "ableton-loopback/v1", id: request.method === "status" ? request.id : "unknown", ok: true, result: request.method === "status" ? { connected: true, adapter: "remote-script", epoch: 1, protocol: "ableton-live/v1", capabilities: [], registryHash: LIVE_REGISTRY_HASH, operations: ["status", "discover", "get", "set", "reconnect"] } : {} };
        socket.write(`${JSON.stringify({ ...base, mac: signed(base) })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: address.port, secret, timeoutMs: 200 });
    await assert.rejects(adapter.snapshotAsync(), /unknown or duplicate remote response|malformed remote response|disconnected/);
    await adapter.close();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
