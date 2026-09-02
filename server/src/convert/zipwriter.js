import zlib from 'node:zlib';

// Minimal ZIP writer with per-entry compression control, so the EPUB
// `mimetype` entry can be written first and STORED as the OCF spec requires.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date =
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export class ZipWriter {
  constructor() {
    this.entries = [];
  }

  // store: true => no compression (for the EPUB mimetype entry)
  add(name, content, { store = false } = {}) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const compressed = store ? data : zlib.deflateRawSync(data, { level: 9 });
    this.entries.push({
      name: Buffer.from(name, 'utf8'),
      method: store ? 0 : 8,
      crc,
      compSize: compressed.length,
      uncompSize: data.length,
      compressed,
    });
    return this;
  }

  toBuffer() {
    const { time, date } = dosDateTime();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const e of this.entries) {
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0, 6); // flags
      local.writeUInt16LE(e.method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(e.crc, 14);
      local.writeUInt32LE(e.compSize, 18);
      local.writeUInt32LE(e.uncompSize, 22);
      local.writeUInt16LE(e.name.length, 26);
      local.writeUInt16LE(0, 28); // extra len
      localParts.push(local, e.name, e.compressed);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4); // version made by
      central.writeUInt16LE(20, 6); // version needed
      central.writeUInt16LE(0, 8);
      central.writeUInt16LE(e.method, 10);
      central.writeUInt16LE(time, 12);
      central.writeUInt16LE(date, 14);
      central.writeUInt32LE(e.crc, 16);
      central.writeUInt32LE(e.compSize, 20);
      central.writeUInt32LE(e.uncompSize, 24);
      central.writeUInt16LE(e.name.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE(0, 38);
      central.writeUInt32LE(offset, 42);
      centralParts.push(central, e.name);

      offset += local.length + e.name.length + e.compressed.length;
    }

    const centralBuf = Buffer.concat(centralParts);
    const localBuf = Buffer.concat(localParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(localBuf.length, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([localBuf, centralBuf, end]);
  }
}
