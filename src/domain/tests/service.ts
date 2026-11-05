import { createHash } from 'node:crypto';
import { errors, type Clock, type SessionPrincipal, type UserId } from '../../shared/contracts';
import { extractZipManifest } from '../materials/zip';
import type { BlobStorage } from '../materials/service';

export type TestVisibility = 'visible' | 'hidden';

export interface TestDefinitionRecord {
  id: string;
  groupAssignmentId: string;
  name: string;
  sourceRef: string;
  visibility: TestVisibility;
  uploadedBy: UserId;
  createdAt: number;
}

export interface TestDefinitionsRepository {
  getGroupAssignment(groupAssignmentId: string): Promise<{ id: string; authorId: UserId } | null>;
  insert(input: Omit<TestDefinitionRecord, 'id' | 'createdAt'> & { createdAt?: number }): Promise<TestDefinitionRecord>;
}

export interface TestDefinitionView {
  id: string;
  groupAssignmentId: string;
  name: string;
  visibility: TestVisibility;
  sha256: string;
  createdAt: number;
}

const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

export class TestDefinitionsService {
  constructor(private readonly deps: { repo: TestDefinitionsRepository; blobs: BlobStorage; now: Clock }) {}

  async upload(input: {
    actor: SessionPrincipal;
    groupAssignmentId: string;
    name: string;
    filename: string;
    visibility: TestVisibility;
    bytes: Uint8Array;
  }): Promise<TestDefinitionView> {
    const assignment = await this.deps.repo.getGroupAssignment(input.groupAssignmentId);
    if (!assignment) throw errors.notFound('assignment');
    if (!input.actor.roles.includes('teacher') || input.actor.userId !== assignment.authorId) throw errors.forbidden('Only the assignment teacher may upload tests');
    const name = input.name.trim();
    const filename = input.filename.trim();
    if (!name || name.length > 120) throw errors.invalidInput('name must contain 1 to 120 characters');
    if (filename.toLowerCase().split('.').pop() !== 'zip') throw errors.invalidInput('Python tests must be uploaded as a ZIP archive');
    if (input.visibility !== 'visible' && input.visibility !== 'hidden') throw errors.invalidInput('visibility must be visible or hidden');
    const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
    if (!bytes.byteLength || bytes.byteLength > MAX_BUNDLE_BYTES) throw errors.invalidInput('test bundle must be between 1 byte and 50 MiB');
    const manifest = await extractZipManifest(bytes, { maxEntryBytes: MAX_BUNDLE_BYTES, maxTotalBytes: MAX_BUNDLE_BYTES });
    if (!manifest.some((entry) => /(^|\/)test_[^/]+\.py$/i.test(entry.path))) throw errors.invalidInput('ZIP archive must contain at least one test_*.py file');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const stored = await this.deps.blobs.store(bytes, sha256);
    const record = await this.deps.repo.insert({
      groupAssignmentId: assignment.id, name, sourceRef: stored.storedPath,
      visibility: input.visibility, uploadedBy: input.actor.userId, createdAt: this.deps.now(),
    });
    return { id: record.id, groupAssignmentId: record.groupAssignmentId, name: record.name, visibility: record.visibility, sha256, createdAt: record.createdAt };
  }
}
