// A store-only (uncompressed) ZIP writer. Runs in the browser so a big documents export never
// touches the Worker's CPU or memory limits; files are fetched one at a time.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export class ZipWriter {
  private parts: BlobPart[] = [];
  private central: Uint8Array[] = [];
  private offset = 0;
  private count = 0;

  add(name: string, data: Uint8Array, when = new Date()) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const { time, date } = dosTime(when);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    this.parts.push(local.buffer, nameBytes as BlobPart, data as BlobPart);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, time, true);
    cen.setUint16(14, date, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, this.offset, true);
    const entry = new Uint8Array(46 + nameBytes.length);
    entry.set(new Uint8Array(cen.buffer), 0);
    entry.set(nameBytes, 46);
    this.central.push(entry);
    this.offset += 30 + nameBytes.length + data.length;
    this.count++;
  }

  finish(): Blob {
    const size = this.central.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.count, true);
    end.setUint16(10, this.count, true);
    end.setUint32(12, size, true);
    end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...(this.central as BlobPart[]), end.buffer], {
      type: 'application/zip',
    });
  }
}

/** Reads a store-only ZIP (ours) back into files, for restoring documents. */
export function readStoredZip(buf: ArrayBuffer): { name: string; data: Uint8Array }[] {
  const v = new DataView(buf);
  const out: { name: string; data: Uint8Array }[] = [];
  let p = 0;
  while (p + 30 <= buf.byteLength && v.getUint32(p, true) === 0x04034b50) {
    const method = v.getUint16(p + 8, true);
    const size = v.getUint32(p + 18, true);
    const nameLen = v.getUint16(p + 26, true);
    const extraLen = v.getUint16(p + 28, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 30, nameLen));
    const start = p + 30 + nameLen + extraLen;
    if (method === 0) out.push({ name, data: new Uint8Array(buf.slice(start, start + size)) });
    p = start + size;
  }
  return out;
}
