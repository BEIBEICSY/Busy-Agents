import fs from 'node:fs';
import path from 'node:path';

// Read selected Chromium localStorage keys without opening/locking its live DB.
// LevelDB formats: https://github.com/google/leveldb/tree/main/doc
const MAX_BYTES = 64 * 1024 * 1024;
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0x82f63b78 : 0);
  return value >>> 0;
});

function maskedCrc(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

function requireValid(condition) {
  if (!condition) throw new Error('Invalid LevelDB snapshot');
}

function cursor(bytes) {
  return {
    bytes, offset: 0,
    number() {
      let value = 0;
      for (let shift = 0; shift <= 49; shift += 7) {
        requireValid(this.offset < bytes.length);
        const byte = bytes[this.offset++];
        value += (byte & 127) * 2 ** shift;
        requireValid(Number.isSafeInteger(value));
        if (byte < 128) return value;
      }
      throw new Error('Oversized LevelDB integer');
    },
    take(size) {
      requireValid(size >= 0 && this.offset + size <= bytes.length);
      const result = bytes.subarray(this.offset, this.offset + size);
      this.offset += size;
      return result;
    },
    slice() { return this.take(this.number()); }
  };
}

function snappy(bytes) {
  const input = cursor(bytes);
  const size = input.number();
  requireValid(size <= MAX_BYTES);
  const output = Buffer.alloc(size);
  let at = 0;
  while (input.offset < bytes.length) {
    const tag = input.take(1)[0];
    const type = tag & 3;
    let length;
    let distance;
    if (type === 0) {
      length = tag >>> 2;
      if (length >= 60) {
        const count = length - 59;
        const encoded = input.take(count);
        length = encoded.readUIntLE(0, count);
      }
      length += 1;
      requireValid(at + length <= size);
      input.take(length).copy(output, at);
    } else {
      if (type === 1) {
        length = 4 + ((tag >>> 2) & 7);
        distance = ((tag & 224) << 3) + input.take(1)[0];
      } else {
        length = 1 + (tag >>> 2);
        distance = input.take(type === 2 ? 2 : 4).readUIntLE(0, type === 2 ? 2 : 4);
      }
      requireValid(distance > 0 && distance <= at && at + length <= size);
      for (let i = 0; i < length; i += 1) output[at + i] = output[at + i - distance];
    }
    at += length;
  }
  requireValid(at === size);
  return output;
}

function* logRecords(bytes) {
  let fragments = [];
  for (let block = 0; block < bytes.length; block += 32768) {
    const end = Math.min(block + 32768, bytes.length);
    let at = block;
    while (at + 7 <= end) {
      const length = bytes.readUInt16LE(at + 4);
      const type = bytes[at + 6];
      if (length === 0 && type === 0) break; // Block padding.
      if (at + 7 + length > end && end === bytes.length) return; // Live append, incomplete tail.
      requireValid(at + 7 + length <= end && type >= 1 && type <= 4);
      requireValid(maskedCrc(bytes.subarray(at + 6, at + 7 + length)) === bytes.readUInt32LE(at));
      const data = bytes.subarray(at + 7, at + 7 + length);
      if (type === 1) {
        requireValid(fragments.length === 0);
        yield data;
      } else if (type === 2) {
        requireValid(fragments.length === 0);
        fragments = [data];
      } else {
        requireValid(fragments.length > 0);
        fragments.push(data);
        if (type === 4) {
          yield Buffer.concat(fragments);
          fragments = [];
        }
      }
      at += 7 + length;
    }
  }
  // An unfinished fragmented record is an uncommitted live tail.
}

function manifestVersion(bytes) {
  const tables = new Set();
  let logNumber;
  let previousLog = 0;
  for (const record of logRecords(bytes)) {
    const input = cursor(record);
    while (input.offset < record.length) {
      const tag = input.number();
      if (tag === 1) requireValid(input.slice().toString() === 'leveldb.BytewiseComparator');
      else if (tag === 2) logNumber = input.number();
      else if (tag === 9) previousLog = input.number();
      else if (tag === 3 || tag === 4) input.number();
      else if (tag === 5) { input.number(); input.slice(); }
      else if (tag === 6) { input.number(); tables.delete(input.number()); }
      else if (tag === 7) {
        input.number();
        tables.add(input.number());
        input.number(); input.slice(); input.slice();
      } else throw new Error('Unsupported LevelDB manifest');
    }
  }
  requireValid(logNumber !== undefined);
  return { tables, logNumber, previousLog };
}

function* blockEntries(bytes) {
  requireValid(bytes.length >= 4);
  const restarts = bytes.readUInt32LE(bytes.length - 4);
  const end = bytes.length - 4 - restarts * 4;
  requireValid(restarts > 0 && end >= 0);
  const input = cursor(bytes.subarray(0, end));
  let key = Buffer.alloc(0);
  while (input.offset < end) {
    const shared = input.number();
    const unshared = input.number();
    const valueLength = input.number();
    requireValid(shared <= key.length);
    key = Buffer.concat([key.subarray(0, shared), input.take(unshared)]);
    yield { key, value: input.take(valueLength) };
  }
}

function* tableEntries(bytes) {
  requireValid(bytes.length >= 48 && bytes.subarray(-8).toString('hex') === '57fb808b247547db');
  const footer = cursor(bytes.subarray(-48, -8));
  footer.number(); footer.number(); // Meta-index handle.
  const indexOffset = footer.number();
  const indexSize = footer.number();
  const block = (offset, size) => {
    requireValid(offset + size + 5 <= bytes.length - 48);
    const encoded = bytes.subarray(offset, offset + size + 1);
    requireValid(maskedCrc(encoded) === bytes.readUInt32LE(offset + size + 1));
    const type = encoded[size];
    requireValid(type === 0 || type === 1);
    return type === 1 ? snappy(encoded.subarray(0, size)) : encoded.subarray(0, size);
  };
  for (const entry of blockEntries(block(indexOffset, indexSize))) {
    const handle = cursor(entry.value);
    yield* blockEntries(block(handle.number(), handle.number()));
  }
}

function decodeChromiumString(bytes) {
  requireValid(bytes.length > 0 && (bytes[0] === 0 || bytes[0] === 1));
  if (bytes[0] === 0) requireValid(bytes.length % 2 === 1);
  return bytes.subarray(1).toString(bytes[0] === 0 ? 'utf16le' : 'latin1');
}

export function readChromiumLocalStorage(directory, keys, options = {}) {
  const read = options.readFileSync || fs.readFileSync;
  const list = options.readdirSync || fs.readdirSync;
  const wanted = new Set(keys);
  const origins = (options.origins || ['file://']).map((origin) => Buffer.from(`_${origin}\0`));
  const keyPrefixes = options.keyPrefixes || [];
  // Retry once if compaction removes a table between the manifest and file read.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const current = read(path.join(directory, 'CURRENT')).toString().trim();
      requireValid(/^MANIFEST-\d+$/.test(current));
      const version = manifestVersion(read(path.join(directory, current)));
      const files = list(directory);
      const latest = new Map();
      let totalBytes = 0;
      const readBounded = (name) => {
        const bytes = read(path.join(directory, name));
        totalBytes += bytes.length;
        requireValid(bytes.length <= MAX_BYTES && totalBytes <= MAX_BYTES * 4);
        return bytes;
      };
      const accept = (key, value, sequence, type) => {
        // Origin is part of the key: never mix a preview/remote site's storage.
        const origin = origins.find((candidate) => key.subarray(0, candidate.length).equals(candidate));
        if (!origin) return;
        const name = decodeChromiumString(key.subarray(origin.length));
        if (!wanted.has(name) && !keyPrefixes.some((prefix) => name.startsWith(prefix))) return;
        if (!latest.has(name) || sequence > latest.get(name).sequence) {
          latest.set(name, { value, sequence, type });
        }
      };
      for (const number of version.tables) {
        const name = files.find((file) => /\.(ldb|sst)$/.test(file) && Number(file.split('.')[0]) === number);
        requireValid(name !== undefined);
        for (const { key, value } of tableEntries(readBounded(name))) {
          requireValid(key.length >= 8);
          const trailer = key.readBigUInt64LE(key.length - 8);
          const type = Number(trailer & 255n);
          requireValid(type === 0 || type === 1);
          accept(key.subarray(0, -8), value, trailer >> 8n, type);
        }
      }
      for (const name of files) {
        if (!/^\d+\.log$/.test(name)) continue;
        const number = Number(name.split('.')[0]);
        if (number < version.logNumber && number !== version.previousLog) continue;
        for (const record of logRecords(readBounded(name))) {
          requireValid(record.length >= 12);
          const sequence = record.readBigUInt64LE(0);
          const count = record.readUInt32LE(8);
          const input = cursor(record);
          input.offset = 12;
          for (let index = 0; index < count; index += 1) {
            const type = input.take(1)[0];
            requireValid(type === 0 || type === 1);
            const key = input.slice();
            accept(key, type === 1 ? input.slice() : null, sequence + BigInt(index), type);
          }
          requireValid(input.offset === record.length);
        }
      }
      requireValid(read(path.join(directory, 'CURRENT')).toString().trim() === current);
      const values = new Map();
      for (const [key, entry] of latest) {
        if (entry.type === 1) values.set(key, decodeChromiumString(entry.value));
      }
      return { available: true, values };
    } catch {
      // No raw byte search fallback: a stale or unrelated JSON array isn't evidence.
    }
  }
  return { available: false, values: new Map() };
}
