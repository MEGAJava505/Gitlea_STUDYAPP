import { describe, expect, it } from 'vitest';
import { TestDefinitionsService, type TestDefinitionRecord } from '../../src/domain/tests/service';
import type { SessionPrincipal, UserId } from '../../src/shared/contracts';

const teacher: SessionPrincipal = { userId: 'teacher' as UserId, login: 't', displayName: 'Teacher', roles: ['teacher'] };
const student: SessionPrincipal = { userId: 'student' as UserId, login: 's', displayName: 'Student', roles: ['student'] };

function zipEntry(name: string, content: string): Uint8Array {
  const filename = Buffer.from(name);
  const bytes = Buffer.from(content);
  const crc = crc32(bytes);
  const local = Buffer.alloc(30 + filename.length + bytes.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30); bytes.copy(local, 30 + filename.length);
  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt16LE(20, 4);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(filename.length, 28); filename.copy(central, 46);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

class Repo {
  inserted: TestDefinitionRecord[] = [];
  assignment: { id: string; authorId: UserId } | null = { id: 'ga-1', authorId: 'teacher' as UserId };
  async getGroupAssignment() { return this.assignment; }
  async canTeachGroup() { return false; }
  async insert(input: Omit<TestDefinitionRecord, 'id' | 'createdAt'>) {
    const record = { ...input, id: 'td-1', createdAt: 100 }; this.inserted.push(record); return record;
  }
}

class Blobs {
  stored: Uint8Array | null = null;
  async store(bytes: Uint8Array, sha256: string) { this.stored = bytes; return { storedPath: `materials/${sha256.slice(0, 2)}/${sha256}` }; }
}

describe('test definition uploads', () => {
  it('stores a safe Python test bundle with selected visibility for the assignment teacher', async () => {
    const repo = new Repo(); const blobs = new Blobs();
    const service = new TestDefinitionsService({ repo, blobs, now: () => 100 });
    const result = await service.upload({ actor: teacher, groupAssignmentId: 'ga-1', name: 'Hidden checks', visibility: 'hidden', filename: 'checks.zip', bytes: zipEntry('test_main.py', 'assert True') });
    expect(result).toMatchObject({ id: 'td-1', name: 'Hidden checks', visibility: 'hidden' });
    expect(repo.inserted[0]).toMatchObject({ groupAssignmentId: 'ga-1', visibility: 'hidden', sourceRef: expect.stringMatching(/^materials\//) });
    expect(blobs.stored).not.toBeNull();
  });

  it('rejects non-teachers and archives without Python tests', async () => {
    const service = new TestDefinitionsService({ repo: new Repo(), blobs: new Blobs(), now: () => 100 });
    await expect(service.upload({ actor: student, groupAssignmentId: 'ga-1', name: 'Tests', visibility: 'visible', filename: 'checks.zip', bytes: zipEntry('test_main.py', 'assert True') })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.upload({ actor: teacher, groupAssignmentId: 'ga-1', name: 'Tests', visibility: 'visible', filename: 'checks.zip', bytes: zipEntry('readme.txt', 'no tests') })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('requires the assignment author even when the actor has a teacher role', async () => {
    const repo = new Repo();
    repo.assignment = { id: 'ga-1', authorId: 'another-teacher' as UserId };
    const blobs = new Blobs();
    const service = new TestDefinitionsService({ repo, blobs, now: () => 100 });
    await expect(service.upload({ actor: teacher, groupAssignmentId: 'ga-1', name: 'Tests', visibility: 'visible', filename: 'checks.zip', bytes: zipEntry('test_main.py', 'assert True') })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(blobs.stored).toBeNull();
    expect(repo.inserted).toHaveLength(0);
  });

  it('rejects unsafe archives and invalid metadata before storing them', async () => {
    const repo = new Repo(); const blobs = new Blobs();
    const service = new TestDefinitionsService({ repo, blobs, now: () => 100 });
    const valid = zipEntry('test_main.py', 'assert True');
    await expect(service.upload({ actor: teacher, groupAssignmentId: 'ga-1', name: 'Tests', visibility: 'visible', filename: 'checks.txt', bytes: valid })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.upload({ actor: teacher, groupAssignmentId: 'ga-1', name: 'Tests', visibility: 'other' as 'visible', filename: 'checks.zip', bytes: valid })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.upload({ actor: teacher, groupAssignmentId: 'ga-1', name: 'Tests', visibility: 'visible', filename: 'checks.zip', bytes: zipEntry('../test_main.py', 'assert True') })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(blobs.stored).toBeNull();
    expect(repo.inserted).toHaveLength(0);
  });

  it('returns not found for an unknown assignment', async () => {
    const repo = new Repo(); repo.assignment = null;
    const service = new TestDefinitionsService({ repo, blobs: new Blobs(), now: () => 100 });
    await expect(service.upload({ actor: teacher, groupAssignmentId: 'missing', name: 'Tests', visibility: 'visible', filename: 'checks.zip', bytes: zipEntry('test_main.py', 'assert True') })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
