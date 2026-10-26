import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ProvisioningAssignment, ProvisioningRepository } from '../domain/git/provisioning';
import type { AssignmentId, GroupId, RepositoryLinkRecord, UserId } from '../shared/contracts';
import { courseAssignments, groupAssignments, groupMembers, repositoryLinks } from '../db/schema';
import * as relations from '../db/relations';
import { toLinkRecord } from './db-assignment-repository';

type Db = BetterSQLite3Database<typeof relations>;

/** SQLite-backed ProvisioningRepository; AssignmentId is the group_assignments.id. */
export class DbProvisioningRepository implements ProvisioningRepository {
  constructor(private readonly db: Db) {}

  async getPublishedAssignment(id: AssignmentId): Promise<ProvisioningAssignment | null> {
    const row = this.db
      .select({
        id: groupAssignments.id,
        groupId: groupAssignments.groupId,
        publishedAt: groupAssignments.publishedAt,
        templateOwner: courseAssignments.templateOwner,
        templateRepo: courseAssignments.templateRepo,
      })
      .from(groupAssignments)
      .innerJoin(courseAssignments, eq(groupAssignments.courseAssignmentId, courseAssignments.id))
      .where(eq(groupAssignments.id, id))
      .get();
    if (!row) return null;
    return {
      id: row.id as AssignmentId,
      groupId: row.groupId as GroupId,
      publishedAt: row.publishedAt,
      template: row.templateOwner && row.templateRepo ? { owner: row.templateOwner, repo: row.templateRepo } : null,
    };
  }

  async isAssignedToStudent(id: AssignmentId, studentId: UserId): Promise<boolean> {
    const row = this.db
      .select({ id: groupMembers.id })
      .from(groupAssignments)
      .innerJoin(groupMembers, eq(groupMembers.groupId, groupAssignments.groupId))
      .where(and(eq(groupAssignments.id, id), eq(groupMembers.userId, studentId), eq(groupMembers.state, 'active')))
      .get();
    return row !== undefined;
  }

  async getRepositoryLink(id: AssignmentId, studentId: UserId): Promise<RepositoryLinkRecord | null> {
    const row = this.db
      .select()
      .from(repositoryLinks)
      .where(and(eq(repositoryLinks.groupAssignmentId, id), eq(repositoryLinks.studentId, studentId)))
      .get();
    return row ? toLinkRecord(row) : null;
  }

  async insertRepositoryLink(input: Omit<RepositoryLinkRecord, 'id'>): Promise<RepositoryLinkRecord> {
    if (input.giteaRepoId === null) throw new Error('Gitea repository id is required');
    const row = this.db
      .insert(repositoryLinks)
      .values({
        id: randomUUID(),
        groupAssignmentId: input.groupAssignmentId,
        studentId: input.studentId,
        giteaRepositoryId: input.giteaRepoId,
        fullName: input.giteaRepoFullName,
        isPrivate: input.isPrivate,
      })
      .returning()
      .get();
    return toLinkRecord(row);
  }
}
