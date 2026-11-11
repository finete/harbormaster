// Minimal ZIP (PKZIP 2.0) writer for "Export diagnostics": deflate via
// node:zlib, no native or third-party dependency. Writes a flat archive of
// in-memory entries; no ZIP64, so each entry and the whole archive must stay
// under 4 GiB (diagnostics are a few MB at most).
import { deflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Path inside the archive, `/`-separated (e.g. `logs/wake.log`). */
  name: string;
  data: Buffer | string;
  /** Modification time recorded in the archive; defaults to now. */
  mtime?: Date;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const UTF8_FLAG = 0x0800;
const DEFLATE = 8;
const STORE = 0;
const VERSION = 20;

/** Builds a complete ZIP archive from `entries`. */
export function createZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/^\/+/, ""), "utf8");
    const raw =
      typeof entry.data === "string"
        ? Buffer.from(entry.data, "utf8")
        : entry.data;
    const deflated = deflateRawSync(raw);
    // Deflate can grow incompressible data; store it as-is then.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? DEFLATE : STORE;
    const crc = crc32(raw);
    const { time, date } = dosDateTime(entry.mtime ?? new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(VERSION, 4); // version made by
    header.writeUInt16LE(VERSION, 6); // version needed
    header.writeUInt16LE(UTF8_FLAG, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(name.length, 28);
    // extra length, comment length, disk start, internal attrs: all 0
    header.writeUInt32LE(0, 38); // external attrs
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuffer, end]);
}
