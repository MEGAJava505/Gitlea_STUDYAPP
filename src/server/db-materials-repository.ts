import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client';
import { courseGroups, courses, groupMembers, lessonPublications, lessons, materials } from '../db/schema';
import type { LessonForMaterials, MaterialRecord, MaterialsRepository, NewMaterial } from '../domain/materials/service';
import type { UserId } from '../shared/contracts';

export class DbMaterialsRepository implements MaterialsRepository {
  constructor(private readonly db: Db) {}

  async getLesson(lessonId: string): Promise<LessonForMaterials | null> {
    const lesson = this.db.select({ id: lessons.id, courseId: lessons.courseId })
      .from(lessons).where(eq(lessons.id, lessonId)).get();
    if (!lesson) return null;
    const course = this.db.select({ ownerId: courses.ownerId })
      .from(courses).where(eq(courses.id, lesson.courseId)).get();
    return course ? { ...lesson, ownerId: course.ownerId as UserId } : null;
  }

  async insertMaterial(input: NewMaterial): Promise<MaterialRecord> {
    const row = this.db.insert(materials).values({
      id: randomUUID(), lessonId: input.lessonId, filename: input.filename, contentType: input.contentType,
      storedPath: input.storedPath, sizeBytes: input.size, sha256: input.sha256, uploadedBy: input.uploadedBy,
      createdAt: input.createdAt, updatedAt: input.createdAt,
    }).returning().get();
    return this.toRecord(row);
  }

  async getMaterial(materialId: string): Promise<MaterialRecord | null> {
    const row = this.db.select().from(materials).where(eq(materials.id, materialId)).get();
    return row ? this.toRecord(row) : null;
  }

  async listForLesson(lessonId: string): Promise<MaterialRecord[]> {
    return this.db.select().from(materials).where(eq(materials.lessonId, lessonId)).all().map((row) => this.toRecord(row));
  }

  async isPublishedForStudent(lessonId: string, studentId: UserId): Promise<boolean> {
    return this.db.select({ id: lessonPublications.id }).from(lessonPublications)
      .innerJoin(lessons, eq(lessons.id, lessonPublications.lessonId))
      .innerJoin(courseGroups, and(eq(courseGroups.courseId, lessons.courseId), eq(courseGroups.groupId, lessonPublications.groupId)))
      .innerJoin(groupMembers, and(eq(groupMembers.groupId, lessonPublications.groupId), eq(groupMembers.userId, studentId)))
      .where(and(eq(lessonPublications.lessonId, lessonId), eq(groupMembers.state, 'active'))).get() !== undefined;
  }

  private toRecord(row: typeof materials.$inferSelect): MaterialRecord {
    return { id: row.id, lessonId: row.lessonId, filename: row.filename, contentType: row.contentType, storedPath: row.storedPath, size: row.sizeBytes, sha256: row.sha256, uploadedBy: row.uploadedBy as UserId, createdAt: row.createdAt };
  }
}
