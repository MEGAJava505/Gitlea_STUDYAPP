import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { errors, type DomainError } from '../../shared/contracts';

export interface ZipManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface ZipLimits {
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  maxEntries?: number;
}

const defaults = { maxEntryBytes: 50 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024, maxEntries: 10_000 };

function invalid(message: string): DomainError {
  return errors.invalidInput(`Unsafe ZIP archive: ${message}`);
}

function safePath(raw: string): string {
  const path = raw.replaceAll('\\', '/');
  if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path)) throw invalid('absolute path');
  const parts = path.split('/');
  if (parts.some((part) => part === '..' || part === '')) throw invalid('path traversal');
  if (path.toLowerCase().endsWith('.zip')) throw invalid('nested archive');
  return parts.join('/');
}

function u32(buf: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > buf.length) throw invalid('truncated archive');
  return buf.readUInt32LE(offset);
}

export async function extractZipManifest(input: Uint8Array, limits: ZipLimits = {}): Promise<ZipManifestEntry[]> {
  const data = Buffer.from(input);
  const policy = { ...defaults, ...limits };
  const eocd = findEndOfCentralDirectory(data);
  const count = data.readUInt16LE(eocd + 10);
  const centralSize = u32(data, eocd + 12);
  const centralOffset = u32(data, eocd + 16);
  if (count > policy.maxEntries || centralOffset + centralSize > data.length) throw invalid('archive limits exceeded');
  const result: ZipManifestEntry[] = [];
  let cursor = centralOffset;
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (u32(data, cursor) !== 0x02014b50) throw invalid('invalid central directory');
    const flags = data.readUInt16LE(cursor + 8);
    const method = data.readUInt16LE(cursor + 10);
    const compressedSize = u32(data, cursor + 20);
    const size = u32(data, cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const externalAttributes = u32(data, cursor + 38);
    const localOffset = u32(data, cursor + 42);
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    if ((flags & 1) !== 0 || (flags & 0x08) !== 0) throw invalid('encrypted or data-descriptor entry');
    if ((externalAttributes >>> 16 & 0xf000) === 0xa000) throw invalid('symlink entry');
    const path = safePath(name);
    if (size > policy.maxEntryBytes || total + size > policy.maxTotalBytes) throw invalid('expanded size limit exceeded');
    if (localOffset + 30 > data.length || u32(data, localOffset) !== 0x04034b50) throw invalid('invalid local entry');
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const end = start + compressedSize;
    if (end > data.length) throw invalid('truncated entry');
    const compressed = data.subarray(start, end);
    let content: Buffer;
    try {
      content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed, { maxOutputLength: policy.maxEntryBytes }) : (() => { throw invalid(`compression method ${method}`); })();
    } catch (error) {
      if (error instanceof Error && error.name === 'DomainError') throw error;
      throw invalid('invalid compressed entry');
    }
    if (content.length !== size) throw invalid('entry size mismatch');
    total += content.length;
    result.push({ path, size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  }
  return result;
}

function findEndOfCentralDirectory(data: Buffer): number {
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 65_557); offset -= 1) {
    if (u32(data, offset) === 0x06054b50) {
      const commentLength = data.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength <= data.length) return offset;
    }
  }
  throw invalid('missing central directory');
}
