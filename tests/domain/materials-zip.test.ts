import { describe, expect, it } from 'vitest';
import { extractZipManifest } from '../../src/domain/materials/zip';

function zipEntry(name: string, data: string, mode = 0o100644): Buffer {
  const filename = Buffer.from(name);
  const content = Buffer.from(data);
  const crc = crc32(content);
  const local = Buffer.alloc(30 + filename.length + content.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30);
  content.copy(local, 30 + filename.length);
  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE((mode << 16) >>> 0, 38);
  filename.copy(central, 46);
  return Buffer.concat([local, central]);
}

function zip(...entries: Buffer[]): Buffer {
  const local = Buffer.concat(entries.map((entry) => entry.subarray(0, entry.readUInt32LE(0) === 0x04034b50 ? entry.readUInt16LE(26) + entry.readUInt16LE(28) + 30 + entry.readUInt32LE(18) : 0)));
  const centralEntries = entries.map((entry) => {
    let offset = 0;
    while (entry.readUInt32LE(offset) !== 0x02014b50) offset += 1;
    return entry.subarray(offset);
  });
  const central = Buffer.concat(centralEntries);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('safe ZIP manifest', () => {
  it('returns normalized files with sizes and SHA-256 hashes', async () => {
    await expect(extractZipManifest(zip(zipEntry('lesson/a.txt', 'hello')))).resolves.toEqual([
      { path: 'lesson/a.txt', size: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' },
    ]);
  });

  it.each(['../escape.txt', '/absolute.txt', 'C:/absolute.txt'])('rejects unsafe path %s', async (path) => {
    await expect(extractZipManifest(zip(zipEntry(path, 'x')))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects symlinks and nested archives', async () => {
    await expect(extractZipManifest(zip(zipEntry('link', 'target', 0o120777)))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(extractZipManifest(zip(zipEntry('nested.zip', 'x')))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects oversized entries and total expanded size', async () => {
    await expect(extractZipManifest(zip(zipEntry('big.txt', '1234')), { maxEntryBytes: 3 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(extractZipManifest(zip(zipEntry('a.txt', '12'), zipEntry('b.txt', '34')), { maxTotalBytes: 3 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
