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

describe('materials service', () => {
  it('attaches metadata and stored path for a lesson owner', async () => {
    const repo = new Repo();
    const service = new MaterialsService({ repo, now: () => 100 });
    const material = await service.attach({ actor: teacher, lessonId: 'lesson-1', filename: 'slides.pdf', contentType: 'application/pdf', storedPath: '/data/m-1', size: 12, sha256: 'a'.repeat(64) });
    expect(material).toMatchObject({ lessonId: 'lesson-1', filename: 'slides.pdf', storedPath: '/data/m-1', size: 12 });
  });

  it('only lists and downloads materials published to the student group', async () => {
    const repo = new Repo();
    const service = new MaterialsService({ repo, now: () => 100 });
    await service.attach({ actor: teacher, lessonId: 'lesson-1', filename: 'a.txt', contentType: 'text/plain', storedPath: '/data/a', size: 1, sha256: 'a'.repeat(64) });
    await expect(service.listForStudent(student, 'lesson-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    repo.published = true;
    expect(await service.listForStudent(student, 'lesson-1')).toHaveLength(1);
    expect(await service.authorizeDownload(student, 'm-1')).toMatchObject({ id: 'm-1' });
  });

  it('rejects invalid metadata and non-owner attachment', async () => {
    const service = new MaterialsService({ repo: new Repo(), now: () => 100 });
    await expect(service.attach({ actor: student, lessonId: 'lesson-1', filename: 'a', contentType: 'text/plain', storedPath: '/x', size: 1, sha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.attach({ actor: teacher, lessonId: 'lesson-1', filename: '../a', contentType: 'text/plain', storedPath: '/x', size: 1, sha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
