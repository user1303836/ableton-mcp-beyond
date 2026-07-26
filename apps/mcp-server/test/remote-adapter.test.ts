import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { test } from "node:test";
import { RemoteScriptLiveAdapter } from "../src/bridge/remote-adapter.js";

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
        const base = { version: "ableton-loopback/v1", id: request.method === "status" ? request.id : "unknown", ok: true, result: request.method === "status" ? { connected: true, adapter: "remote-script", epoch: 1, protocol: "ableton-live/v1", capabilities: [] } : {} };
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
