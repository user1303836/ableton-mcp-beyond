/**
 * Minimal dependency-free read-only SQLite 3 file reader.
 *
 * Scope (deliberately bounded for the Live library-database surface, issue #54):
 * - Parses the 100-byte database header ("SQLite format 3"), the schema table
 *   (sqlite_master), and table b-trees (interior 0x05 / leaf 0x0d pages) with
 *   full record decoding (varints, serial types 0-9, text/blob payloads) and
 *   overflow-page chains.
 * - Full table scans only; indexes, freelist handling, and pointer-map pages
 *   are not needed and not implemented.
 * - WAL: a database whose read version is 2 (WAL mode) is only read when its
 *   -wal file is absent or empty (fully checkpointed); otherwise the caller
 *   must fail closed. This reader never writes, never creates journals, and
 *   never replays WAL frames.
 * - Every structural bound (page count, cells per page, payload size, b-tree
 *   depth, row count) is enforced so malformed or hostile files fail closed
 *   with explicit errors instead of crashing or looping.
 */

export interface SqliteTable {
  name: string;
  rootPage: number;
  sql: string;
}

export type SqliteValue = null | number | string | Uint8Array;
export type SqliteRow = SqliteValue[];

const SQLITE_HEADER_MAGIC = "SQLite format 3\0";
const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const MAX_PAGES = 1_000_000;
const MAX_CELLS_PER_PAGE = 500;
const MAX_BTREE_DEPTH = 64;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 1_000_000;

function readVarint(buffer: Uint8Array, offset: number): { value: number; bytes: number } {
  let value = 0;
  for (let index = 0; index < 9; index += 1) {
    const byte = buffer[offset + index];
    if (byte === undefined) throw new Error("sqlite varint extends past the buffer");
    if (index === 8) { value = value * 256 + byte; return { value, bytes: 9 }; }
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, bytes: index + 1 };
  }
  throw new Error("sqlite varint is malformed");
}

/** Convert a possibly >2^53 varint read defensively (SQLite ints are signed 64-bit;
 *  values beyond Number.MAX_SAFE_INTEGER fail closed rather than losing precision). */
function toSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error("sqlite integer exceeds the safe JavaScript range");
  // Reinterpret unsigned accumulator as signed 64-bit when the sign bit is set.
  return value >= 2 ** 63 ? value - 2 ** 64 : value;
}

export class SqliteReader {
  private readonly pages: Uint8Array;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly walMode: boolean;
  private readonly tables = new Map<string, SqliteTable>();

  constructor(bytes: Uint8Array) {
    if (bytes.length > MAX_DATABASE_BYTES) throw new Error("sqlite database exceeds the 512 MiB bound");
    if (bytes.length < 100) throw new Error("sqlite database is truncated");
    const magic = Buffer.from(bytes.subarray(0, 16)).toString("latin1");
    if (magic !== SQLITE_HEADER_MAGIC) throw new Error("not a SQLite 3 database (bad header magic)");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pageSizeRaw = view.getUint16(16);
    this.pageSize = pageSizeRaw === 1 ? 65536 : pageSizeRaw;
    if (this.pageSize < 512 || this.pageSize > 65536 || (this.pageSize & (this.pageSize - 1)) !== 0) throw new Error("sqlite page size is invalid");
    const writeVersion = view.getUint8(18);
    const readVersion = view.getUint8(19);
    if (writeVersion !== 1 && writeVersion !== 2) throw new Error("sqlite file-format write version is unsupported");
    if (readVersion !== 1 && readVersion !== 2) throw new Error("sqlite file-format read version is unsupported");
    this.walMode = readVersion === 2;
    this.pageCount = view.getUint32(28);
    if (this.pageCount < 1 || this.pageCount > MAX_PAGES) throw new Error("sqlite page count is invalid");
    const expected = this.pageCount * this.pageSize;
    if (bytes.length < expected) throw new Error("sqlite database is truncated relative to its header page count");
    this.pages = bytes.subarray(0, expected);
    for (const table of this.readSchema()) this.tables.set(table.name, table);
  }

  tableNames(): string[] { return [...this.tables.keys()].sort(); }

  table(name: string): SqliteTable | undefined { return this.tables.get(name); }

  private pageOffset(page: number): number {
    if (!Number.isInteger(page) || page < 1 || page > this.pageCount) throw new Error(`sqlite page ${page} is outside the database`);
    return (page - 1) * this.pageSize;
  }

  /** Parse one b-tree cell's record payload, following the overflow chain. */
  private readCellPayload(page: number, cellOffset: number): { payload: Uint8Array; rowId: number } {
    const base = this.pageOffset(page);
    const usable = this.pageSize;
    let cursor = base + cellOffset;
    const payloadLength = readVarint(this.pages, cursor);
    cursor += payloadLength.bytes;
    const rowId = readVarint(this.pages, cursor);
    cursor += rowId.bytes;
    const length = payloadLength.value;
    if (length > MAX_PAYLOAD_BYTES) throw new Error("sqlite cell payload exceeds its bound");
    // SQLite file-format table leaf rule: payloads up to maxLocal stay inline;
    // larger payloads keep K = minLocal + (P - minLocal) % (usable - 4) bytes
    // inline when K <= maxLocal, else minLocal, and overflow the rest.
    const maxLocal = usable - 35;
    const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
    let local = length;
    if (length > maxLocal) {
      const k = minLocal + ((length - minLocal) % (usable - 4));
      local = k <= maxLocal ? k : minLocal;
    }
    if ((cursor - base) + local > usable) throw new Error("sqlite cell payload overruns its page");
    const chunks: Uint8Array[] = [this.pages.subarray(cursor, cursor + local)];
    let remaining = length - local;
    if (remaining > 0) {
      const view = new DataView(this.pages.buffer, this.pages.byteOffset, this.pages.byteLength);
      let overflowPage = view.getUint32(cursor + local);
      let guard = 0;
      while (remaining > 0) {
        if (overflowPage === 0 || guard > this.pageCount) throw new Error("sqlite overflow chain is malformed");
        guard += 1;
        const overflowBase = this.pageOffset(overflowPage);
        const next = view.getUint32(overflowBase);
        const take = Math.min(remaining, usable - 4);
        chunks.push(this.pages.subarray(overflowBase + 4, overflowBase + 4 + take));
        remaining -= take;
        overflowPage = next;
      }
    }
    const payload = new Uint8Array(length);
    let written = 0;
    for (const chunk of chunks) { payload.set(chunk, written); written += chunk.length; }
    return { payload, rowId: toSafeInteger(rowId.value) };
  }

  private decodeRecord(payload: Uint8Array): SqliteRow {
    const headerLength = readVarint(payload, 0);
    if (headerLength.value < 1 || headerLength.value > payload.length) throw new Error("sqlite record header is invalid");
    const serialTypes: number[] = [];
    let cursor = headerLength.bytes;
    while (cursor < headerLength.value) {
      const serial = readVarint(payload, cursor);
      cursor += serial.bytes;
      serialTypes.push(serial.value);
    }
    const row: SqliteRow = [];
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let body = headerLength.value;
    for (const serial of serialTypes) {
      const take = (bytes: number): void => {
        if (body + bytes > payload.length) throw new Error("sqlite record body is truncated");
      };
      switch (serial) {
        case 0: row.push(null); break;
        case 1: take(1); row.push(view.getInt8(body)); body += 1; break;
        case 2: take(2); row.push(view.getInt16(body)); body += 2; break;
        case 3: take(3); { const value = (payload[body]! << 16) | (payload[body + 1]! << 8) | payload[body + 2]!; row.push(value >= 2 ** 23 ? value - 2 ** 24 : value); body += 3; break; }
        case 4: take(4); row.push(view.getInt32(body)); body += 4; break;
        case 5: take(6); { const high = view.getInt32(body); const low = view.getUint32(body + 2); const value = high * 2 ** 32 + low; row.push(toSafeInteger(value < 0 ? value + 2 ** 64 : value)); body += 6; break; }
        case 6: take(8); { const high = view.getInt32(body); const low = view.getUint32(body + 4); const value = high * 2 ** 32 + low; row.push(toSafeInteger(value < 0 ? value + 2 ** 64 : value)); body += 8; break; }
        case 7: take(8); row.push(view.getFloat64(body)); body += 8; break;
        case 8: row.push(0); break;
        case 9: row.push(1); break;
        default: {
          if (serial < 12) throw new Error(`sqlite serial type ${serial} is reserved`);
          const length = serial >= 13 && serial % 2 === 1 ? (serial - 13) / 2 : (serial - 12) / 2;
          take(length);
          const slice = payload.subarray(body, body + length);
          row.push(serial % 2 === 1 ? Buffer.from(slice).toString("utf8") : new Uint8Array(slice));
          body += length;
          break;
        }
      }
    }
    return row;
  }

  private walkTableBtree(rootPage: number, visit: (row: SqliteRow, rowId: number) => void, maxRows: number): number {
    let visited = 0;
    const walkPage = (page: number, depth: number): void => {
      if (depth > MAX_BTREE_DEPTH) throw new Error("sqlite b-tree depth exceeds its bound");
      const base = this.pageOffset(page);
      const headerOffset = page === 1 ? 100 : 0;
      const type = this.pages[base + headerOffset];
      const view = new DataView(this.pages.buffer, this.pages.byteOffset, this.pages.byteLength);
      const cellCount = view.getUint16(base + headerOffset + 3);
      if (cellCount > MAX_CELLS_PER_PAGE) throw new Error("sqlite page cell count exceeds its bound");
      const pointerArray = base + headerOffset + (type === 0x05 ? 12 : 8);
      if (type === 0x05) {
        for (let index = 0; index < cellCount; index += 1) {
          const cellOffset = view.getUint16(pointerArray + index * 2);
          const childPage = view.getUint32(base + cellOffset);
          walkPage(childPage, depth + 1);
          // interior cells carry a key (varint rowid) that separates subtrees; no payload to visit
        }
        const rightmost = view.getUint32(base + headerOffset + 8);
        walkPage(rightmost, depth + 1);
      } else if (type === 0x0d) {
        for (let index = 0; index < cellCount; index += 1) {
          if (visited >= maxRows) throw new Error(`sqlite table scan exceeds its ${maxRows}-row bound`);
          const cellOffset = view.getUint16(pointerArray + index * 2);
          const { payload, rowId } = this.readCellPayload(page, cellOffset);
          visit(this.decodeRecord(payload), rowId);
          visited += 1;
        }
      } else throw new Error(`sqlite page ${page} is not a table b-tree page (type ${String(type)})`);
    };
    walkPage(rootPage, 0);
    return visited;
  }

  private readSchema(): SqliteTable[] {
    const tables: SqliteTable[] = [];
    this.walkTableBtree(1, (row) => {
      if (row.length < 5) throw new Error("sqlite schema row is malformed");
      const [type, name, , rootPage, sql] = row;
      if (type === "table" && typeof name === "string" && typeof rootPage === "number" && typeof sql === "string") tables.push({ name, rootPage, sql });
    }, MAX_ROWS);
    return tables;
  }

  /** Column names parsed from a table's CREATE TABLE statement (best-effort:
   *  top-level comma split, first token of each definition; table constraints
   *  are skipped). Used for fail-closed schema-profile checks. */
  tableColumns(name: string): string[] | undefined {
    const table = this.tables.get(name);
    if (!table) return undefined;
    const open = table.sql.indexOf("(");
    const close = table.sql.lastIndexOf(")");
    if (open < 0 || close <= open) return undefined;
    const body = table.sql.slice(open + 1, close);
    const columns: string[] = [];
    let depth = 0; let current = "";
    for (const char of body) {
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (char === "," && depth === 0) { columns.push(current); current = ""; } else current += char;
    }
    if (current.trim().length > 0) columns.push(current);
    const names = columns.map((definition) => definition.trim().split(/\s+/)[0]?.replace(/^["'`[]|["'`\]"]$/g, "")).filter((name): name is string => typeof name === "string" && name.length > 0 && !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/i.test(name));
    return names;
  }

  /** Full bounded table scan. Rows are raw positional values matching the
   *  CREATE TABLE column order (see tableColumns); the cell rowid is surfaced
   *  separately because INTEGER PRIMARY KEY alias columns read as NULL. */
  scanTable(name: string, maxRows = 100_000): Array<{ row: SqliteRow; rowId: number }> {
    const table = this.tables.get(name);
    if (!table) throw new Error(`sqlite table is not present: ${name}`);
    const rows: Array<{ row: SqliteRow; rowId: number }> = [];
    this.walkTableBtree(table.rootPage, (row, rowId) => { rows.push({ row, rowId }); }, maxRows);
    if (rows.length > maxRows) throw new Error(`sqlite table ${name} exceeds its scan bound`);
    return rows;
  }
}
