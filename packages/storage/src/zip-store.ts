export interface ZipStoreEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

const localHeaderSignature = 0x04034b50;
const centralHeaderSignature = 0x02014b50;
const endSignature = 0x06054b50;
const utf8Flag = 0x0800;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value = (value >>> 8) ^ (crcTable[(value ^ byte) & 0xff] ?? 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function assertEntryName(name: string): void {
  if (
    !name ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    name.split('/').some((part) => part === '..')
  ) {
    throw new Error(`Unsafe ZIP entry path: ${name || '(empty)'}`);
  }
}

function dateFields(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

export function createStoredZip(
  entries: readonly ZipStoreEntry[],
  modifiedAt = new Date(),
): Uint8Array {
  if (entries.length > 65_535) {
    throw new Error('The backup contains too many ZIP entries.');
  }

  const seen = new Set<string>();
  const prepared = entries.map((entry) => {
    assertEntryName(entry.name);
    if (seen.has(entry.name)) {
      throw new Error(`Duplicate ZIP entry: ${entry.name}`);
    }
    seen.add(entry.name);
    const name = encoder.encode(entry.name);
    if (name.byteLength > 65_535 || entry.data.byteLength > 0xffffffff) {
      throw new Error(`ZIP entry is too large: ${entry.name}`);
    }
    return { ...entry, encodedName: name, crc: crc32(entry.data) };
  });
  const localSize = prepared.reduce(
    (total, entry) => total + 30 + entry.encodedName.byteLength + entry.data.byteLength,
    0,
  );
  const centralSize = prepared.reduce(
    (total, entry) => total + 46 + entry.encodedName.byteLength,
    0,
  );
  const totalSize = localSize + centralSize + 22;
  if (totalSize > 0xffffffff) {
    throw new Error('The backup is too large for the ZIP32 format.');
  }

  const output = new Uint8Array(totalSize);
  const view = new DataView(output.buffer);
  const dos = dateFields(modifiedAt);
  const offsets: number[] = [];
  let cursor = 0;

  for (const entry of prepared) {
    offsets.push(cursor);
    writeUint32(view, cursor, localHeaderSignature);
    writeUint16(view, cursor + 4, 20);
    writeUint16(view, cursor + 6, utf8Flag);
    writeUint16(view, cursor + 8, 0);
    writeUint16(view, cursor + 10, dos.time);
    writeUint16(view, cursor + 12, dos.date);
    writeUint32(view, cursor + 14, entry.crc);
    writeUint32(view, cursor + 18, entry.data.byteLength);
    writeUint32(view, cursor + 22, entry.data.byteLength);
    writeUint16(view, cursor + 26, entry.encodedName.byteLength);
    writeUint16(view, cursor + 28, 0);
    output.set(entry.encodedName, cursor + 30);
    output.set(entry.data, cursor + 30 + entry.encodedName.byteLength);
    cursor += 30 + entry.encodedName.byteLength + entry.data.byteLength;
  }

  const centralOffset = cursor;
  prepared.forEach((entry, index) => {
    writeUint32(view, cursor, centralHeaderSignature);
    writeUint16(view, cursor + 4, 20);
    writeUint16(view, cursor + 6, 20);
    writeUint16(view, cursor + 8, utf8Flag);
    writeUint16(view, cursor + 10, 0);
    writeUint16(view, cursor + 12, dos.time);
    writeUint16(view, cursor + 14, dos.date);
    writeUint32(view, cursor + 16, entry.crc);
    writeUint32(view, cursor + 20, entry.data.byteLength);
    writeUint32(view, cursor + 24, entry.data.byteLength);
    writeUint16(view, cursor + 28, entry.encodedName.byteLength);
    writeUint16(view, cursor + 30, 0);
    writeUint16(view, cursor + 32, 0);
    writeUint16(view, cursor + 34, 0);
    writeUint16(view, cursor + 36, 0);
    writeUint32(view, cursor + 38, 0);
    writeUint32(view, cursor + 42, offsets[index] ?? 0);
    output.set(entry.encodedName, cursor + 46);
    cursor += 46 + entry.encodedName.byteLength;
  });

  writeUint32(view, cursor, endSignature);
  writeUint16(view, cursor + 4, 0);
  writeUint16(view, cursor + 6, 0);
  writeUint16(view, cursor + 8, prepared.length);
  writeUint16(view, cursor + 10, prepared.length);
  writeUint32(view, cursor + 12, centralSize);
  writeUint32(view, cursor + 16, centralOffset);
  writeUint16(view, cursor + 20, 0);
  return output;
}

function findEndRecord(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === endSignature) {
      return offset;
    }
  }
  throw new Error('The file is not a supported ZIP backup.');
}

function checkedSlice(data: Uint8Array, start: number, length: number): Uint8Array {
  const end = start + length;
  if (start < 0 || length < 0 || end > data.byteLength || end < start) {
    throw new Error('The ZIP backup is truncated.');
  }
  return data.slice(start, end);
}

export function readStoredZip(input: ArrayBuffer | Uint8Array): ReadonlyMap<string, Uint8Array> {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const endOffset = findEndRecord(view);
  const disk = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  const commentLength = view.getUint16(endOffset + 20, true);

  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    view.getUint16(endOffset + 8, true) !== entryCount ||
    endOffset + 22 + commentLength !== data.byteLength ||
    centralOffset + centralSize !== endOffset
  ) {
    throw new Error('Multi-disk, ZIP64, or appended ZIP data is not supported.');
  }

  const result = new Map<string, Uint8Array>();
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset || view.getUint32(cursor, true) !== centralHeaderSignature) {
      throw new Error('The ZIP central directory is invalid.');
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const expectedCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const fileCommentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(checkedSlice(data, cursor + 46, nameLength));
    assertEntryName(name);

    if (
      (flags & 0x0001) !== 0 ||
      (flags & 0x0008) !== 0 ||
      method !== 0 ||
      compressedSize !== uncompressedSize ||
      result.has(name)
    ) {
      throw new Error(`Unsupported or duplicate ZIP entry: ${name}`);
    }
    if (
      localOffset + 30 > centralOffset ||
      view.getUint32(localOffset, true) !== localHeaderSignature ||
      view.getUint16(localOffset + 8, true) !== 0
    ) {
      throw new Error(`Invalid local ZIP header: ${name}`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localName = decoder.decode(checkedSlice(data, localOffset + 30, localNameLength));
    const content = checkedSlice(
      data,
      localOffset + 30 + localNameLength + localExtraLength,
      uncompressedSize,
    );

    if (localName !== name || crc32(content) !== expectedCrc) {
      throw new Error(`ZIP integrity check failed: ${name}`);
    }
    result.set(name, content);
    cursor += 46 + nameLength + extraLength + fileCommentLength;
  }

  if (cursor !== endOffset) {
    throw new Error('The ZIP central directory has unexpected data.');
  }
  return result;
}
