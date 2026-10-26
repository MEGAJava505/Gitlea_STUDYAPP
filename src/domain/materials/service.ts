import { errors, type Clock, type SessionPrincipal, type UserId } from '../../shared/contracts';

export interface LessonForMaterials {
  id: string;
  courseId: string;
  ownerId: UserId;
}

export interface MaterialRecord {
  id: string;
  lessonId: string;
  filename: string;
  contentType: string;
  storedPath: string;
  size: number;
  sha256: string;
  createdAt: number;
}

export interface NewMaterial {
  lessonId: string;
  filename: string;
  contentType: string;
  storedPath: string;
  size: number;
  sha256: string;
}

export interface MaterialsRepository {
  getLesson(lessonId: string): Promise<LessonForMaterials | null>;
  insertMaterial(input: NewMaterial): Promise<MaterialRecord>;
  getMaterial(materialId: string): Promise<MaterialRecord | null>;
  listForLesson(lessonId: string): Promise<MaterialRecord[]>;
  isPublishedForStudent(lessonId: string, studentId: UserId): Promise<boolean>;
}

export interface AttachMaterialInput extends NewMaterial {
  actor: SessionPrincipal;
}

export class MaterialsService {
  constructor(private readonly deps: { repo: MaterialsRepository; now: Clock }) {}

  async attach(input: AttachMaterialInput): Promise<MaterialRecord> {
    const lesson = await this.deps.repo.getLesson(input.lessonId);
    if (!lesson) throw errors.notFound('lesson');
    if (!this.canManageLesson(input.actor, lesson)) throw errors.forbidden('Only the lesson owner or an admin may attach materials');
    const filename = input.filename.trim();
    if (!filename || filename === '.' || filename === '..' || /[\\/\u0000-\u001f]/.test(filename)) {
      throw errors.invalidInput('filename must be a plain file name');
    }
    if (!input.contentType.trim() || input.contentType.length > 255) throw errors.invalidInput('contentType is invalid');
    if (!input.storedPath.trim() || input.storedPath.includes('..') || input.storedPath.includes('\0')) {
      throw errors.invalidInput('storedPath is invalid');
    }
    if (!Number.isSafeInteger(input.size) || input.size < 0) throw errors.invalidInput('size must be a non-negative integer');
    if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw errors.invalidInput('sha256 must be a SHA-256 hex digest');
    return this.deps.repo.insertMaterial({
      lessonId: lesson.id,
      filename,
      contentType: input.contentType.trim(),
      storedPath: input.storedPath,
      size: input.size,
      sha256: input.sha256.toLowerCase(),
    });
  }

  async listForStudent(actor: SessionPrincipal, lessonId: string): Promise<MaterialRecord[]> {
    if (!actor.roles.includes('student')) throw errors.forbidden('Student access required');
    const lesson = await this.deps.repo.getLesson(lessonId);
    if (!lesson) throw errors.notFound('lesson');
    if (!(await this.deps.repo.isPublishedForStudent(lessonId, actor.userId))) throw errors.forbidden('Lesson is not published to your group');
    return this.deps.repo.listForLesson(lessonId);
  }

  async list(actor: SessionPrincipal, lessonId: string): Promise<MaterialRecord[]> {
    const lesson = await this.deps.repo.getLesson(lessonId);
    if (!lesson) throw errors.notFound('lesson');
    if (actor.roles.includes('student')) return this.listForStudent(actor, lessonId);
    if (!this.canManageLesson(actor, lesson)) throw errors.forbidden();
    return this.deps.repo.listForLesson(lessonId);
  }

  async authorizeDownload(actor: SessionPrincipal, materialId: string): Promise<MaterialRecord> {
    const material = await this.deps.repo.getMaterial(materialId);
    if (!material) throw errors.notFound('material');
    const lesson = await this.deps.repo.getLesson(material.lessonId);
    if (!lesson) throw errors.notFound('lesson');
    if (this.canManageLesson(actor, lesson)) return material;
    if (actor.roles.includes('student') && await this.deps.repo.isPublishedForStudent(lesson.id, actor.userId)) return material;
    throw errors.forbidden('Material is not available to this user');
  }

  private canManageLesson(actor: SessionPrincipal, lesson: LessonForMaterials): boolean {
    return actor.userId === lesson.ownerId || actor.roles.includes('admin') || actor.roles.includes('owner');
  }
}
