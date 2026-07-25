import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { serveStdio } from "../src/stdio.js";

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
