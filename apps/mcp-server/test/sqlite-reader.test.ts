import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteReader } from "../src/sqlite-reader.js";

// Two small SQLite table-leaf pages, built from the public file format.
function database(serial: number, body: Buffer, rowId = Buffer.from([1]), reserved = 0): Buffer {
  const bytes = Buffer.alloc(1024);
  bytes.write("SQLite format 3\0", 0, "latin1");
  bytes.writeUInt16BE(512, 16); bytes[18] = 1; bytes[19] = 1; bytes[20] = reserved;
  bytes.writeUInt32BE(2, 28); bytes.writeUInt32BE(1, 56);
  const leaf = (base: number, header: number, record: Buffer, id: Buffer) => {
    const cell = Buffer.concat([Buffer.from([record.length]), id, record]);
    const offset = 512 - reserved - cell.length;
    bytes[base + header] = 0x0d; bytes.writeUInt16BE(1, base + header + 3);
    bytes.writeUInt16BE(offset, base + header + 5); bytes.writeUInt16BE(offset, base + header + 8);
    cell.copy(bytes, base + offset);
  };
  const sql = "CREATE TABLE t(v)";
  const schema = Buffer.concat([Buffer.from([6, 23, 15, 15, 1, 13 + sql.length * 2]), Buffer.from("tablett"), Buffer.from([2]), Buffer.from(sql)]);
  leaf(0, 100, schema, Buffer.from([1]));
  leaf(512, 0, Buffer.concat([Buffer.from([2, serial]), body]), rowId);
  return bytes;
}

test("SQLite decodes signed 48-bit and 64-bit integers without overlapping words or rounding", () => {
  for (const value of [2 ** 40 + 123, -(2 ** 40) + 123, 2 ** 47 - 1, -(2 ** 47)]) {
    const body = Buffer.alloc(6); body.writeIntBE(value, 0, 6);
    assert.equal(new SqliteReader(database(5, body)).scanTable("t")[0]!.row[0], value);
  }
  for (const value of [2 ** 48 + 123, -(2 ** 48) + 123, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
    const body = Buffer.alloc(8); body.writeBigInt64BE(BigInt(value));
    assert.equal(new SqliteReader(database(6, body)).scanTable("t")[0]!.row[0], value);
  }
  for (const value of [2n ** 53n, -(2n ** 53n), 2n ** 63n - 1n, -(2n ** 63n)]) {
    const body = Buffer.alloc(8); body.writeBigInt64BE(value);
    assert.throws(() => new SqliteReader(database(6, body)).scanTable("t"), /safe JavaScript range/);
  }
  assert.equal(new SqliteReader(database(9, Buffer.alloc(0), Buffer.alloc(9, 0xff))).scanTable("t")[0]!.rowId, -1);
});

test("SQLite honors reserved page bytes and refuses unsupported text encodings", () => {
  assert.equal(new SqliteReader(database(9, Buffer.alloc(0), Buffer.from([1]), 12)).scanTable("t")[0]!.row[0], 1);
  const reserved = database(9, Buffer.alloc(0)); reserved[20] = 33;
  assert.throws(() => new SqliteReader(reserved), /invalid usable page size/);
  for (const encoding of [0, 2, 3]) {
    const bytes = database(9, Buffer.alloc(0)); bytes.writeUInt32BE(encoding, 56);
    assert.throws(() => new SqliteReader(bytes), /text encoding/);
  }
});

test("SQLite rejects repeated b-tree pages and cross-page cell pointers", () => {
  const cycle = database(9, Buffer.alloc(0)); cycle[512] = 0x05;
  cycle.writeUInt16BE(0, 515); cycle.writeUInt32BE(2, 520);
  assert.throws(() => new SqliteReader(cycle).scanTable("t"), /repeated page/);
  const pointers = database(9, Buffer.alloc(0)); pointers.writeUInt16BE(300, 515);
  assert.throws(() => new SqliteReader(pointers).scanTable("t"), /pointer array overruns/);
  const cell = database(9, Buffer.alloc(0)); cell.writeUInt16BE(511, 520);
  assert.throws(() => new SqliteReader(cell).scanTable("t"), /cell pointer/);
});
