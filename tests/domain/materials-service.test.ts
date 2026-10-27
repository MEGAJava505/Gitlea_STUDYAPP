import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MaterialsService, type MaterialRecord, type MaterialsRepository } from '../../src/domain/materials/service';
import { errors, type SessionPrincipal, type UserId } from '../../src/shared/contracts';

const teacher: SessionPrincipal = { userId: 'teacher' as UserId, login: 'teacher', displayName: 'Teacher', roles: ['teacher'] };
const student: SessionPrincipal = { userId: 'student' as UserId, login: 'student', displayName: 'Student', roles: ['student'] };
const bytes = new TextEncoder().encode('real material bytes');

class Repo implements MaterialsRepository {
  lesson = { id: 'lesson-1', courseId: 'course-1', ownerId: 'teacher' as UserId };
  published = false;
  rows: MaterialRecord[] = [];
  async getLesson() { return this.lesson; }
  async insertMaterial(input: Parameters<MaterialsRepository['insertMaterial']>[0]) {
    const row: MaterialRecord = { ...input, id: `m-${this.rows.length + 1}`, createdAt: 100 };
    this.rows.push(row);
    return row;
  }
  async getMaterial(id: string) { return this.rows.find((row) => row.id === id) ?? null; }
  async listForLesson(lessonId: string) { return this.rows.filter((row) => row.lessonId === lessonId); }
  async isPublishedForStudent() { return this.published; }
}

class Blobs {
  values = new Map<string, Uint8Array>();
  async store(input: Uint8Array, expectedSha256: string) {
    expect(createHash('sha256').update(input).digest('hex')).toBe(expectedSha256);
    const storedPath = `materials/${expectedSha256.slice(0, 2)}/${expectedSha256}`;
    this.values.set(storedPath, input.slice());
    return { storedPath };
  }
  async retrieve(storedPath: string) {
    const value = this.values.get(storedPath);
    if (!value) throw new Error('missing blob');
    return value.slice();
  }
}

describe('MaterialsService byte pipeline', () => {
  it('uploads bytes, stores content-addressed metadata, and downloads the exact bytes', async () => {
    const repo = new Repo();
    const blobs = new Blobs();
    const service = new MaterialsService({ repo, blobs, now: () => 100 });
    const uploaded = await service.uploadBlob({ actor: teacher, lessonId: 'lesson-1', filename: 'notes.txt', contentType: 'text/plain', bytes });
    expect(uploaded).toEqual({
      id: 'm-1', lessonId: 'lesson-1', filename: 'notes.txt', contentType: 'text/plain',
      size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: 100,
    });
    const downloaded = await service.openDownload({ actor: teacher, materialId: uploaded.id });
    expect(downloaded.bytes).toEqual(bytes);
    expect(downloaded.sha256).toBe(uploaded.sha256);
  });

  it('denies unpublished student downloads and permits enrolled published students', async () => {
    const repo = new Repo();
    const blobs = new Blobs();
    const service = new MaterialsService({ repo, blobs, now: () => 100 });
    await service.uploadBlob({ actor: teacher, lessonId: 'lesson-1', filename: 'notes.txt', contentType: 'text/plain', bytes });
    await expect(service.openDownload({ actor: student, materialId: 'm-1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    repo.published = true;
    await expect(service.openDownload({ actor: student, materialId: 'm-1' })).resolves.toMatchObject({ filename: 'notes.txt' });
  });

  it('rejects invalid filenames and reports storage integrity failures', async () => {
    const repo = new Repo();
    const blobs = new Blobs();
    const service = new MaterialsService({ repo, blobs, now: () => 100 });
    await expect(service.uploadBlob({ actor: teacher, lessonId: 'lesson-1', filename: '../notes.txt', contentType: 'text/plain', bytes })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await service.uploadBlob({ actor: teacher, lessonId: 'lesson-1', filename: 'notes.txt', contentType: 'text/plain', bytes });
    blobs.values.set('materials/2d/2d' + '0'.repeat(62), new Uint8Array([1]));
    repo.rows[0].storedPath = 'materials/2d/' + '2d' + '0'.repeat(62);
    await expect(service.openDownload({ actor: teacher, materialId: 'm-1' })).rejects.toMatchObject({ code: 'INTEGRATION_ERROR' });
  });
});
