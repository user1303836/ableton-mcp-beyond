import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { serveStdio, type RecordContext } from "../src/stdio.js";

test("stdio preserves order across a backpressured writable", async () => {
  const input = new PassThrough();
  const received: string[] = [];
  let writes = 0;
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      received.push(String(chunk).trim());
      writes += 1;
      if (writes === 1) { setTimeout(callback, 5); return false; }
      callback();
    },
  });
  const done = serveStdio(input, output, (record) => record);
  input.end("1\n2\n3\n");
  await done;
  assert.deepEqual(received, ["1", "2", "3"]);
});

test("stdio runs bounded concurrent work but writes responses in request order", async () => {
  const input = new PassThrough();
  const received: string[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) { received.push(String(chunk).trim()); callback(); } });
  let active = 0;
  let peak = 0;
  const done = serveStdio(input, output, async (record) => {
    const id = (JSON.parse(record) as { id: number }).id;
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, id === 1 ? 20 : 1));
    active -= 1;
    return record;
  }, { maxInFlight: 2 });
  input.end('{"jsonrpc":"2.0","id":1}\n{"jsonrpc":"2.0","id":2}\n{"jsonrpc":"2.0","id":3}\n');
  await done;
  assert.equal(peak, 2);
  assert.deepEqual(received, ["{\"jsonrpc\":\"2.0\",\"id\":1}", "{\"jsonrpc\":\"2.0\",\"id\":2}", "{\"jsonrpc\":\"2.0\",\"id\":3}"]);
});

test("stdio saturation refuses excess work without stranding cancellation behind backpressure", async () => {
  const input = new PassThrough(); const received: string[] = []; let aborted = false; let releaseWrite: (() => void) | undefined; let writes = 0;
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { received.push(String(chunk).trim()); writes += 1; if (writes === 1) releaseWrite = callback; else callback(); } });
  const done = serveStdio(input, output, async (record: string, context?: RecordContext) => {
    const id = (JSON.parse(record) as { id: number }).id;
    if (id === 1) await new Promise<void>((resolve) => context!.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    return record;
  }, { maxInFlight: 1 });
  input.end(Array.from({ length: 15 }, (_, index) => index + 1).map((id) => JSON.stringify({ jsonrpc: "2.0", id, method: "work" })).join("\n") + '\n' + JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }) + '\n');
  for (let index = 0; index < 50 && !aborted; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(aborted, true);
  assert.ok(received.some((value) => JSON.parse(value).id === 5 && JSON.parse(value).error?.code === -32000));
  releaseWrite?.(); await done;
  assert.ok(received.some((value) => JSON.parse(value).id === 15 && JSON.parse(value).error?.code === -32000));
});

test("stdio rechecks cancellation after a completed reply waits in the output queue", { timeout: 5000 }, async () => {
  for (const rejects of [false, true]) {
    const input = new PassThrough(); const received: number[] = [];
    let releaseFirst!: () => void; let releaseBusy: (() => void) | undefined; let busyWritten!: () => void;
    let signal: AbortSignal | undefined;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const busy = new Promise<void>((resolve) => { busyWritten = resolve; });
    const output = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        const frame = JSON.parse(String(chunk)); received.push(frame.id);
        if (frame.id === 5) { releaseBusy = callback; busyWritten(); }
        else callback();
      },
    });
    const done = serveStdio(input, output, async (record, context) => {
      const id = JSON.parse(record).id;
      if (id === 1) {
        signal = context!.signal;
        await gate;
        if (rejects) throw new Error("completed handler failed before output drained");
      }
      return JSON.stringify({ jsonrpc: "2.0", id, result: {} });
    }, { maxInFlight: 1 });
    try {
      input.write(Array.from({ length: 5 }, (_, index) => JSON.stringify({ jsonrpc: "2.0", id: index + 1, method: "work" })).join("\n") + "\n");
      await busy;
      releaseFirst();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(received, [5], "the busy reply holds stdout while request 1 is queued to write");
      assert.equal(signal!.aborted, false);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })}\n`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(signal!.aborted, true, "completed but un-emitted replies retain cancellation ownership");
    } finally {
      releaseFirst(); releaseBusy?.(); input.end(); await done;
    }
    assert.deepEqual(received, [5, 2, 3, 4], "cancelled success/error replies are omitted without blocking later responses");
  }
});

test("stdio emitted-response cleanup preserves a reused ID's cancellation ownership", { timeout: 5000 }, async () => {
  for (const highWaterMark of [1, 65536]) {
    const input = new PassThrough(); const received: number[] = []; const signals: AbortSignal[] = [];
    let releaseWrite: (() => void) | undefined; let firstWritten!: () => void; let releaseSecond!: () => void;
    const first = new Promise<void>((resolve) => { firstWritten = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const output = new Writable({
      highWaterMark,
      write(chunk, _encoding, callback) {
        received.push(JSON.parse(String(chunk)).id);
        if (received.length === 1) { releaseWrite = callback; firstWritten(); }
        else callback();
      },
    });
    const finishWrite = (): void => { const callback = releaseWrite; releaseWrite = undefined; callback?.(); };
    const done = serveStdio(input, output, async (record, context) => {
      signals.push(context!.signal);
      if (signals.length === 2) await secondGate;
      return JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(record).id, result: {} });
    });
    try {
      input.write('{"jsonrpc":"2.0","id":7,"method":"work"}\n');
      await first;
      input.write('{"jsonrpc":"2.0","id":7,"method":"work-again"}\n');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(signals.length, 2, "an emitted reply frees its ID even before the write callback/drain");
      finishWrite();
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}\n');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(signals[1]!.aborted, true, "old-response cleanup must not delete the replacement controller");
      assert.equal(signals[0]!.aborted, false);
    } finally {
      finishWrite(); releaseSecond(); input.end(); await done;
    }
    assert.deepEqual(received, [7]);
  }
});

test("stdio output failure closes authority and contains writable callback errors", async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("injected output failure")); } });
  let emit: ((value: string) => Promise<void>) | undefined;
  let calls = 0;
  const done = serveStdio(input, output, () => { calls += 1; return "must-not-run"; }, { notifier: (registered) => { emit = registered; } });
  const terminated = assert.rejects(done, /injected output failure|Premature close|output/);
  await assert.rejects(emit!("event"), /injected output failure/);
  await terminated;
  assert.equal(calls, 0);
  assert.equal(input.destroyed, true);
  assert.equal(output.destroyed, true);
});

test("stdio treats callback-only writable errors as authoritative output failure", async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  output.write = ((_chunk: unknown, callback: (cause?: Error | null) => void): boolean => {
    queueMicrotask(() => callback(new Error("callback-only failure")));
    return true;
  }) as typeof output.write;
  let emit: ((value: string) => Promise<void>) | undefined;
  const done = serveStdio(input, output, () => "must-not-run", { notifier: (registered) => { emit = registered; } });
  const terminated = assert.rejects(done, /callback-only failure|Premature close/);
  await assert.rejects(emit!("event"), /callback-only failure/);
  await terminated;
  assert.equal(input.destroyed, true);
  assert.equal(output.destroyed, true);
});

test("stdio fail-closes when a framing response saturates the output queue", async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, _callback) { /* hold the first write indefinitely */ } });
  let emit: ((value: string) => Promise<void>) | undefined;
  const done = serveStdio(input, output, () => null, { maxInFlight: 1, notifier: (registered) => { emit = registered; } });
  const queued = Array.from({ length: 16 }, (_, index) => emit!(`queued-${index}`).catch(() => undefined));
  input.end(Buffer.from([0xff, 0x0a]));
  await assert.rejects(done, /bounded output queue is saturated/);
  await Promise.all(queued);
  assert.equal(input.destroyed, true);
  assert.equal(output.destroyed, true);
});

test("stdio fail-closes when a notification error response saturates the output queue", async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, _callback) { /* hold the first write indefinitely */ } });
  let emit: ((value: string) => Promise<void>) | undefined;
  let calls = 0;
  const done = serveStdio(input, output, () => { calls += 1; throw new Error("notification failure"); }, { maxInFlight: 1, notifier: (registered) => { emit = registered; } });
  const queued = Array.from({ length: 16 }, (_, index) => emit!(`queued-${index}`).catch(() => undefined));
  input.end('{"jsonrpc":"2.0","method":"notification"}\n');
  await assert.rejects(done, /bounded output queue is saturated/);
  await Promise.all(queued);
  assert.equal(calls, 1);
  assert.equal(input.destroyed, true);
  assert.equal(output.destroyed, true);
});

test("stdio cancellation aborts the matching request and emits no response", async () => {
  const input = new PassThrough();
  const received: string[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) { received.push(String(chunk).trim()); callback(); } });
  let aborted = false;
  const done = serveStdio(input, output, async (record: string, context?: RecordContext) => {
    if ((JSON.parse(record) as { method?: string }).method !== "work") return record;
    await new Promise<void>((resolve) => {
      context!.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
    });
    return "should-not-be-written";
  });
  input.write('{"jsonrpc":"2.0","id":7,"method":"work"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}\n');
  input.end();
  await done;
  assert.equal(aborted, true);
  assert.deepEqual(received, []);
});

test("stdio rejects a duplicate in-flight id without replacing cancellation ownership", async () => {
  const input = new PassThrough(); const received: string[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) { received.push(String(chunk).trim()); callback(); } });
  let calls = 0; let firstAborted = false;
  const done = serveStdio(input, output, async (_record: string, context?: RecordContext) => {
    calls += 1;
    await new Promise<void>((resolve) => context!.signal.addEventListener("abort", () => { firstAborted = true; resolve(); }, { once: true }));
    return "must-not-be-written";
  });
  input.write('{"jsonrpc":"2.0","id":7,"method":"work"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  input.write('{"jsonrpc":"2.0","id":7,"method":"work-again"}\n');
  input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}\n');
  input.end();
  await done;
  assert.equal(calls, 1);
  assert.equal(firstAborted, true);
  assert.equal(received.length, 1);
  assert.deepEqual(JSON.parse(received[0]!), { jsonrpc: "2.0", id: 7, error: { code: -32600, message: "Duplicate in-flight request identifier" } });
});

test("stdio contains delayed handler rejection and correlates it to its own request id", async () => {
  const input = new PassThrough(); const received: string[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) { received.push(String(chunk).trim()); callback(); } });
  let releaseFirst: (() => void) | undefined;
  const done = serveStdio(input, output, async (record: string) => {
    const id = (JSON.parse(record) as { id: number }).id;
    if (id === 1) { await new Promise<void>((resolve) => { releaseFirst = resolve; }); return record; }
    throw new Error("delayed failure");
  }, { maxInFlight: 2 });
  input.write('{"jsonrpc":"2.0","id":1,"method":"slow"}\n{"jsonrpc":"2.0","id":2,"method":"fail"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirst?.(); input.end(); await done;
  assert.deepEqual(received.map((line) => JSON.parse(line)), [
    { jsonrpc: "2.0", id: 1, method: "slow" },
    { jsonrpc: "2.0", id: 2, error: { code: -32603, message: "Internal error" } },
  ]);
});
