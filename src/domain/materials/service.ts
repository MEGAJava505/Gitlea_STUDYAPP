import { createHash } from 'node:crypto';
import { errors, type Clock, type SessionPrincipal, type UserId } from '../../shared/contracts';
import { extractZipManifest } from './zip';

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
  uploadedBy: UserId;
  createdAt: number;
}

export interface MaterialView {
  id: string;
  lessonId: string;
  filename: string;
  contentType: string;
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
  uploadedBy: UserId;
  createdAt?: number;
}

export interface BlobStorage {
  store(bytes: Uint8Array, expectedSha256: string): Promise<{ storedPath: string }>;
  retrieve(storedPath: string): Promise<Uint8Array>;
}

export interface MaterialsRepository {
  getLesson(lessonId: string): Promise<LessonForMaterials | null>;
  insertMaterial(input: NewMaterial): Promise<MaterialRecord>;
  getMaterial(materialId: string): Promise<MaterialRecord | null>;
  listForLesson(lessonId: string): Promise<MaterialRecord[]>;
  isPublishedForStudent(lessonId: string, studentId: UserId): Promise<boolean>;
}

const MAX_BYTES = 50 * 1024 * 1024;

export class MaterialsService {
  constructor(private readonly deps: { repo: MaterialsRepository; blobs: BlobStorage; now: Clock }) {}

  async uploadBlob(input: {
    actor: SessionPrincipal;
    lessonId: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }): Promise<MaterialView> {
    const lesson = await this.deps.repo.getLesson(input.lessonId);
    if (!lesson) throw errors.notFound('lesson');
    if (!this.canManageLesson(input.actor, lesson)) throw errors.forbidden('Only the lesson owner or an admin may upload materials');
    const filename = this.validateFilename(input.filename);
    const contentType = input.contentType.trim();
    if (!contentType || contentType.length > 255 || /[\r\n]/.test(contentType)) throw errors.invalidInput('contentType is invalid');
    const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
    if (bytes.byteLength > MAX_BYTES) throw errors.invalidInput('file exceeds the 50 MiB limit');
    if (contentType.toLowerCase() === 'application/zip' || filename.toLowerCase().endsWith('.zip')) await extractZipManifest(bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const stored = await this.deps.blobs.store(bytes, sha256);
    const record = await this.deps.repo.insertMaterial({
      lessonId: lesson.id, filename, contentType, storedPath: stored.storedPath,
      size: bytes.byteLength, sha256, uploadedBy: input.actor.userId, createdAt: this.deps.now(),
    });
    return this.view(record);
  }

  async list(actor: SessionPrincipal, lessonId: string): Promise<MaterialView[]> {
    const lesson = await this.deps.repo.getLesson(lessonId);
    if (!lesson) throw errors.notFound('lesson');
    if (actor.roles.includes('student')) {
      if (!(await this.deps.repo.isPublishedForStudent(lessonId, actor.userId))) throw errors.forbidden('Lesson is not published to your group');
    } else if (!this.canManageLesson(actor, lesson)) throw errors.forbidden();
    return (await this.deps.repo.listForLesson(lessonId)).map((record) => this.view(record));
  }

  async openDownload(input: { actor: SessionPrincipal; materialId: string }): Promise<{
    filename: string; contentType: string; size: number; sha256: string; bytes: Uint8Array;
  }> {
    const material = await this.deps.repo.getMaterial(input.materialId);
    if (!material) throw errors.notFound('material');
    const lesson = await this.deps.repo.getLesson(material.lessonId);
    if (!lesson) throw errors.notFound('lesson');
    if (!this.canManageLesson(input.actor, lesson) &&
      !(input.actor.roles.includes('student') && await this.deps.repo.isPublishedForStudent(lesson.id, input.actor.userId))) {
      throw errors.forbidden('Material is not available to this user');
    }
    let bytes: Uint8Array;
    try { bytes = await this.deps.blobs.retrieve(material.storedPath); }
    catch { throw errors.integration('Material blob could not be read'); }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== material.sha256 || bytes.byteLength !== material.size) throw errors.integration('Material blob integrity check failed');
    return { filename: material.filename, contentType: material.contentType, size: material.size, sha256: material.sha256, bytes };
  }

  private view(record: MaterialRecord): MaterialView {
    return { id: record.id, lessonId: record.lessonId, filename: record.filename, contentType: record.contentType, size: record.size, sha256: record.sha256, createdAt: record.createdAt };
  }

  private validateFilename(raw: string): string {
    const filename = raw.trim();
    if (!filename || filename === '.' || filename === '..' || /[\\/\u0000-\u001f\u007f]/.test(filename) || filename.length > 255) throw errors.invalidInput('filename must be a plain file name');
    return filename;
  }

  private canManageLesson(actor: SessionPrincipal, lesson: LessonForMaterials): boolean {
    return actor.userId === lesson.ownerId || actor.roles.includes('admin') || actor.roles.includes('owner');
  }
}
