import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_FRAME_BYTES, NdjsonFramer } from "../src/framing.js";

test("frames arbitrary chunks, CRLF, multiple records, and EOF", () => {
  const framer = new NdjsonFramer();
  const events = [
    ...framer.push(Buffer.from('{"a":')),
    ...framer.push(Buffer.from('1}\r\n{"b":2}\n')),
    ...framer.end(),
  ];
  assert.deepEqual(events, [
    { type: "record", value: '{"a":1}' },
    { type: "record", value: '{"b":2}' },
  ]);
});

test("reports invalid UTF-8 and discards exactly one oversized record", () => {
  const framer = new NdjsonFramer();
  assert.deepEqual(framer.push(Uint8Array.from([0xc3, 0x28, 10])), [{ type: "error", message: "invalid-utf8" }]);
  const oversized = new Uint8Array(MAX_FRAME_BYTES + 2);
  oversized.fill(97);
  oversized[MAX_FRAME_BYTES + 1] = 10;
  assert.deepEqual(framer.push(oversized), [{ type: "error", message: "oversized" }]);
  assert.deepEqual(framer.push(Buffer.from("ok\n")), [{ type: "record", value: "ok" }]);
  assert.equal(framer.retainedBytes, 0);
});
