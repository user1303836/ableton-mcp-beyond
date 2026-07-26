import assert from "node:assert/strict";
import { test } from "node:test";
import { RemoteScriptLiveAdapter } from "../src/bridge/remote-adapter.js";

test("remote adapter fails closed before opening non-loopback or weakly authenticated endpoints", async () => {
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "192.168.1.10", port: 9000, secret: "0123456789abcdef0123456789abcdef" }), /loopback/);
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.999.0.1", port: 9000, secret: "0123456789abcdef0123456789abcdef" }), /loopback/);
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: 9000, secret: "short" }), /strong secret/);
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: 0, secret: "0123456789abcdef0123456789abcdef" }), /loopback/);
});

test("remote adapter reports connection refusal as unavailable evidence", async () => {
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: 65534, secret: "0123456789abcdef0123456789abcdef", timeoutMs: 25 }), /ECONNREFUSED|connect/);
});
