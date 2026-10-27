import { describe, expect, it } from 'vitest';
import { MaterialsService, type MaterialRecord } from '../../src/domain/materials/service';
import { errors, type GroupId, type SessionPrincipal, type UserId } from '../../src/shared/contracts';

const teacher: SessionPrincipal = { userId: 'teacher' as UserId, login: 't', displayName: 'T', roles: ['teacher'] };
const student: SessionPrincipal = { userId: 'student' as UserId, login: 's', displayName: 'S', roles: ['student'] };

class Repo {
  materials: MaterialRecord[] = [];
  lesson = { id: 'lesson-1', courseId: 'course-1', ownerId: 'teacher' as UserId };
  published = false;
  async getLesson() { return this.lesson; }
  async insertMaterial(input: Omit<MaterialRecord, 'id' | 'createdAt'>) { const row = { ...input, id: `m-${this.materials.length + 1}`, createdAt: 100 }; this.materials.push(row); return row; }
  async getMaterial(id: string) { return this.materials.find((m) => m.id === id) ?? null; }
  async listForLesson(id: string) { return this.materials.filter((m) => m.lessonId === id); }
  async isPublishedForStudent() { return this.published; }
}

class Blobs {
  values = new Map<string, Uint8Array>();
  async store(bytes: Uint8Array, sha256: string) { const storedPath = `materials/${sha256}`; this.values.set(storedPath, bytes); return { storedPath }; }
  async retrieve(storedPath: string) { return this.values.get(storedPath)!; }
}

describe('materials service', () => {
  it('uploads bytes for a lesson owner', async () => {
    const repo = new Repo();
    const service = new MaterialsService({ repo, blobs: new Blobs(), now: () => 100 });
    const material = await service.uploadBlob({ actor: teacher, lessonId: 'lesson-1', filename: 'slides.pdf', contentType: 'application/pdf', bytes: new TextEncoder().encode('slides') });
    expect(material).toMatchObject({ lessonId: 'lesson-1', filename: 'slides.pdf', size: 6 });
  });

  it('only lists and downloads materials published to the student group', async () => {
    const repo = new Repo();
    const service = new MaterialsService({ repo, blobs: new Blobs(), now: () => 100 });
    await service.uploadBlob({ actor: teacher, lessonId: 'lesson-1', filename: 'a.txt', contentType: 'text/plain', bytes: new Uint8Array([1]) });
    await expect(service.list(student, 'lesson-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    repo.published = true;
    expect(await service.list(student, 'lesson-1')).toHaveLength(1);
    await expect(service.openDownload({ actor: student, materialId: 'm-1' })).resolves.toMatchObject({ filename: 'a.txt' });
  });

  it('rejects invalid metadata and non-owner attachment', async () => {
    const service = new MaterialsService({ repo: new Repo(), blobs: new Blobs(), now: () => 100 });
    await expect(service.uploadBlob({ actor: student, lessonId: 'lesson-1', filename: 'a', contentType: 'text/plain', bytes: new Uint8Array([1]) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.uploadBlob({ actor: teacher, lessonId: 'lesson-1', filename: '../a', contentType: 'text/plain', bytes: new Uint8Array([1]) })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
